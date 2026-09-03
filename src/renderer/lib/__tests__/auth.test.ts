// @vitest-environment jsdom
/**
 * Tests for the renderer-side auth + subscription module.
 *
 * Focus areas:
 *   - mapUser correctly resolves displayName/avatarUrl across provider metadata
 *     shapes (Google vs Facebook vs email-only).
 *   - Fail-closed paths return useful flags without throwing (no session, RLS
 *     blocked, missing subscription row).
 *   - getManagedKeys NEVER returns the anthropic key to the renderer — that's
 *     a deliberate security boundary (Claude calls go through the proxy).
 *   - Subscription tier maps to the right features object.
 *
 * Mocks: supabase client + the Tauri shell `open` (so OAuth/checkout don't
 * actually hit a browser during tests).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Force production mode BEFORE auth.ts loads, since DEV_MODE is a module-level
// const captured at import time. Per-test overrides use vi.resetModules + a
// dynamic import (see the dev-mode block below).
vi.hoisted(() => {
  if (typeof import.meta.env === 'object' && import.meta.env) {
    (import.meta.env as Record<string, unknown>).VITE_DEV_MODE = 'false'
  }
})

const { mockSupabase, mockOpen } = vi.hoisted(() => {
  const mockGetSession = vi.fn()
  const mockSignInWithPassword = vi.fn()
  const mockSignUp = vi.fn()
  const mockSignOut = vi.fn()
  const mockSignInWithOAuth = vi.fn()
  const mockResetPasswordForEmail = vi.fn()
  const mockFrom = vi.fn()
  const mockFunctionsInvoke = vi.fn()

  return {
    mockOpen: vi.fn(),
    mockSupabase: {
      auth: {
        getSession: mockGetSession,
        signInWithPassword: mockSignInWithPassword,
        signUp: mockSignUp,
        signOut: mockSignOut,
        signInWithOAuth: mockSignInWithOAuth,
        resetPasswordForEmail: mockResetPasswordForEmail,
      },
      from: mockFrom,
      functions: { invoke: mockFunctionsInvoke },
    },
  }
})

vi.mock('../supabase', () => ({ supabase: mockSupabase }))
vi.mock('@tauri-apps/plugin-shell', () => ({ open: mockOpen }))

import * as auth from '../auth'

// ── Helpers ──────────────────────────────────────────────────────────────────

function fakeSupabaseUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    email: 'test@example.com',
    user_metadata: {},
    app_metadata: { provider: 'email' },
    ...overrides,
  }
}

function setSession(user: object | null) {
  mockSupabase.auth.getSession.mockResolvedValue({
    data: { session: user ? { user } : null },
  })
}

function singleResolves(data: unknown, error: unknown = null) {
  return {
    select: () => ({
      eq: () => ({ single: () => Promise.resolve({ data, error }) }),
    }),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  // Force production-mode branches by default; per-test overrides toggle DEV.
  vi.stubEnv('VITE_DEV_MODE', 'false')
})

afterEach(() => { vi.unstubAllEnvs() })

// ── getUser ──────────────────────────────────────────────────────────────────

describe('getUser', () => {
  it('returns success:false when there is no session', async () => {
    setSession(null)
    const r = await auth.getUser()
    expect(r.success).toBe(false)
    expect(r.user).toBeUndefined()
  })

  it('maps an email-only user (no displayName metadata)', async () => {
    setSession(fakeSupabaseUser({
      email: 'alice@example.com',
      user_metadata: {},
      app_metadata: { provider: 'email' },
    }))
    const r = await auth.getUser()
    expect(r.success).toBe(true)
    expect(r.user).toEqual({
      id: 'user-1',
      email: 'alice@example.com',
      // mapUser falls back to email when no full_name/name is present.
      displayName: 'alice@example.com',
      avatarUrl: null,
      authMethod: 'email',
    })
  })

  it('maps a Google OAuth user with full_name and avatar', async () => {
    setSession(fakeSupabaseUser({
      user_metadata: { full_name: 'Alice Anderson', avatar_url: 'https://avatars/alice.png' },
      app_metadata: { provider: 'google' },
    }))
    const r = await auth.getUser()
    expect(r.user?.displayName).toBe('Alice Anderson')
    expect(r.user?.avatarUrl).toBe('https://avatars/alice.png')
    expect(r.user?.authMethod).toBe('google')
  })

  it('maps a Facebook OAuth user using `name` and `picture` keys', async () => {
    setSession(fakeSupabaseUser({
      user_metadata: { name: 'Bob Brown', picture: 'https://avatars/bob.png' },
      app_metadata: { provider: 'facebook' },
    }))
    const r = await auth.getUser()
    expect(r.user?.displayName).toBe('Bob Brown')
    expect(r.user?.avatarUrl).toBe('https://avatars/bob.png')
    expect(r.user?.authMethod).toBe('facebook')
  })

  it('treats unknown providers as email auth', async () => {
    setSession(fakeSupabaseUser({ app_metadata: { provider: 'apple' } }))
    const r = await auth.getUser()
    expect(r.user?.authMethod).toBe('email')
  })

  it('handles missing user_metadata / app_metadata gracefully', async () => {
    setSession({ id: 'u', email: null }) // no _metadata fields at all
    const r = await auth.getUser()
    expect(r.success).toBe(true)
    expect(r.user?.email).toBeNull()
    expect(r.user?.displayName).toBeNull()
  })

  it('returns the dev user without touching supabase when VITE_DEV_MODE=true', async () => {
    // DEV_MODE is captured at module load. Re-import with the env flipped.
    vi.resetModules()
    ;(import.meta.env as Record<string, unknown>).VITE_DEV_MODE = 'true'
    const devAuth = await import('../auth')
    const r = await devAuth.getUser()
    expect(r.success).toBe(true)
    expect(r.user?.id).toBe('dev-local-user')
    ;(import.meta.env as Record<string, unknown>).VITE_DEV_MODE = 'false'
  })
})

// ── signInEmail / signUpEmail / signOut ──────────────────────────────────────

describe('email auth surface', () => {
  it('signInEmail surfaces supabase error messages verbatim', async () => {
    mockSupabase.auth.signInWithPassword.mockResolvedValue({ error: { message: 'Invalid login' } })
    const r = await auth.signInEmail('a@b.c', 'pw')
    expect(r).toEqual({ success: false, error: 'Invalid login' })
  })

  it('signInEmail returns success on a clean response', async () => {
    mockSupabase.auth.signInWithPassword.mockResolvedValue({ error: null })
    expect(await auth.signInEmail('a@b.c', 'pw')).toEqual({ success: true })
  })

  it('signUpEmail with no session asks the user to confirm by email', async () => {
    mockSupabase.auth.signUp.mockResolvedValue({ data: { session: null }, error: null })
    const r = await auth.signUpEmail('a@b.c', 'pw')
    expect(r.success).toBe(true)
    expect(r.error).toMatch(/confirm/i)
  })

  it('signUpEmail with a session is a clean success', async () => {
    mockSupabase.auth.signUp.mockResolvedValue({ data: { session: { access_token: 't' } }, error: null })
    expect(await auth.signUpEmail('a@b.c', 'pw')).toEqual({ success: true })
  })

  it('signOut surfaces supabase errors', async () => {
    mockSupabase.auth.signOut.mockResolvedValue({ error: { message: 'sign-out failed' } })
    const r = await auth.signOut()
    expect(r).toEqual({ success: false, error: 'sign-out failed' })
  })
})

// ── signInWithOAuth ──────────────────────────────────────────────────────────

describe('signInWithOAuth', () => {
  it('opens the provider URL in the system browser', async () => {
    mockSupabase.auth.signInWithOAuth.mockResolvedValue({
      data: { url: 'https://accounts.google.com/oauth' }, error: null,
    })
    const r = await auth.signInWithOAuth('google')
    expect(r.success).toBe(true)
    expect(mockOpen).toHaveBeenCalledWith('https://accounts.google.com/oauth')
  })

  it('fails closed when supabase does not return a URL', async () => {
    mockSupabase.auth.signInWithOAuth.mockResolvedValue({ data: { url: null }, error: null })
    const r = await auth.signInWithOAuth('google')
    expect(r.success).toBe(false)
    expect(mockOpen).not.toHaveBeenCalled()
  })

  it('does not open the browser if supabase errored', async () => {
    mockSupabase.auth.signInWithOAuth.mockResolvedValue({
      data: { url: null }, error: { message: 'oauth refused' },
    })
    const r = await auth.signInWithOAuth('google')
    expect(r).toEqual({ success: false, error: 'oauth refused' })
    expect(mockOpen).not.toHaveBeenCalled()
  })
})

// ── getSubscription ──────────────────────────────────────────────────────────

describe('getSubscription', () => {
  it('returns the dev pro subscription when VITE_DEV_MODE=true', async () => {
    vi.resetModules()
    ;(import.meta.env as Record<string, unknown>).VITE_DEV_MODE = 'true'
    const devAuth = await import('../auth')
    const r = await devAuth.getSubscription()
    expect(r.subscription?.status).toBe('pro')
    ;(import.meta.env as Record<string, unknown>).VITE_DEV_MODE = 'false'
  })

  it('errors when there is no session', async () => {
    setSession(null)
    expect(await auth.getSubscription()).toEqual({ success: false, error: 'Not signed in' })
  })

  it('falls back to free defaults when the user has no subscription row', async () => {
    setSession(fakeSupabaseUser())
    mockSupabase.from.mockReturnValue(singleResolves(null, { code: 'PGRST116' }))
    const r = await auth.getSubscription()
    expect(r.subscription?.status).toBe('free')
    expect(r.subscription?.features.managedApiKeys).toBe(false)
  })

  it('maps the pro tier to managed-keys features', async () => {
    setSession(fakeSupabaseUser())
    mockSupabase.from.mockReturnValue(
      singleResolves({ status: 'pro', expires_at: '2030-01-01' }),
    )
    const r = await auth.getSubscription()
    expect(r.subscription?.status).toBe('pro')
    expect(r.subscription?.features.managedApiKeys).toBe(true)
    expect(r.subscription?.features.voiceMinutes).toBe(600)
  })

  it('maps the team tier to higher quotas than pro', async () => {
    setSession(fakeSupabaseUser())
    mockSupabase.from.mockReturnValue(
      singleResolves({ status: 'team', expires_at: null }),
    )
    const r = await auth.getSubscription()
    expect(r.subscription?.features.voiceMinutes).toBeGreaterThan(600)
    expect(r.subscription?.features.aiRequests).toBeGreaterThan(500)
  })
})

// ── getManagedKeys ───────────────────────────────────────────────────────────

describe('getManagedKeys', () => {
  it('NEVER returns a key to the renderer, only whether the user is entitled', async () => {
    // Hard-coded boundary. Claude calls go through the proxy, and Deepgram
    // streaming now uses a short-lived token from the deepgram-grant function,
    // so neither key has any business being in this process.
    setSession(fakeSupabaseUser())
    mockSupabase.from.mockReturnValue(
      singleResolves({ user_id: 'user-1' }),
    )
    const r = await auth.getManagedKeys()
    expect(r.deepgramKey).toBeNull()
    expect(r.anthropicKey).toBeNull()
    expect(r.hasManagedKeys).toBe(true)
  })

  it('does not even ask the database for the key column', async () => {
    // This used to select `deepgram_key` and return it, which transported the
    // secret in order to do the work of a boolean. That is how the managed key
    // ended up on every subscriber's machine. Selecting the id instead is the
    // fix, so it is worth a test that fails if anyone widens it again.
    setSession(fakeSupabaseUser())
    const select = vi.fn().mockReturnValue({
      eq: () => ({ single: () => Promise.resolve({ data: { user_id: 'user-1' }, error: null }) }),
    })
    mockSupabase.from.mockReturnValue({ select })

    await auth.getManagedKeys()

    expect(select).toHaveBeenCalledWith('user_id')
    expect(select).not.toHaveBeenCalledWith(expect.stringContaining('key'))
  })

  it('returns hasManagedKeys=false when there is no session', async () => {
    setSession(null)
    const r = await auth.getManagedKeys()
    expect(r.hasManagedKeys).toBe(false)
    expect(r.deepgramKey).toBeUndefined()
  })

  it('returns hasManagedKeys=false when the user has no managed-keys row', async () => {
    setSession(fakeSupabaseUser())
    mockSupabase.from.mockReturnValue(singleResolves(null, { code: 'PGRST116' }))
    const r = await auth.getManagedKeys()
    expect(r.hasManagedKeys).toBe(false)
    expect(r.deepgramKey).toBeNull()
    expect(r.anthropicKey).toBeNull()
  })

  it('treats the row existing as the entitlement', async () => {
    // Whether the key column is populated is the server's problem now. The
    // renderer cannot see it, which is the entire point of the change.
    setSession(fakeSupabaseUser())
    mockSupabase.from.mockReturnValue(singleResolves({ user_id: 'user-1' }))
    const r = await auth.getManagedKeys()
    expect(r.hasManagedKeys).toBe(true)
    expect(r.deepgramKey).toBeNull()
  })
})

// ── checkout / billingPortal ─────────────────────────────────────────────────

describe('billing flows', () => {
  it('checkout requires a session', async () => {
    setSession(null)
    expect(await auth.checkout('pro')).toEqual({ success: false, error: 'Not signed in' })
    expect(mockOpen).not.toHaveBeenCalled()
  })

  it('checkout opens the Stripe URL on success', async () => {
    setSession(fakeSupabaseUser())
    mockSupabase.functions.invoke.mockResolvedValue({
      data: { url: 'https://stripe/checkout' }, error: null,
    })
    const r = await auth.checkout('pro')
    expect(r.success).toBe(true)
    expect(mockOpen).toHaveBeenCalledWith('https://stripe/checkout')
  })

  it('checkout reports backend errors without opening anything', async () => {
    setSession(fakeSupabaseUser())
    mockSupabase.functions.invoke.mockResolvedValue({
      data: null, error: { message: 'stripe down' },
    })
    const r = await auth.checkout('pro')
    expect(r).toEqual({ success: false, error: 'stripe down' })
    expect(mockOpen).not.toHaveBeenCalled()
  })

  it('billingPortal requires a session', async () => {
    setSession(null)
    expect(await auth.billingPortal()).toEqual({ success: false, error: 'Not signed in' })
  })

  it('billingPortal opens the portal URL on success', async () => {
    setSession(fakeSupabaseUser())
    mockSupabase.functions.invoke.mockResolvedValue({
      data: { url: 'https://stripe/portal' }, error: null,
    })
    expect((await auth.billingPortal()).success).toBe(true)
    expect(mockOpen).toHaveBeenCalledWith('https://stripe/portal')
  })
})
