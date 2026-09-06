// @vitest-environment jsdom
/**
 * Tests for the renderer-side auth + subscription module.
 *
 * Focus areas:
 *   - mapUser correctly resolves displayName/avatarUrl across provider metadata
 *     shapes (Google vs Facebook vs email-only).
 *   - Fail-closed paths return useful flags without throwing (no session, RLS
 *     blocked, missing subscription row).
 *   - hasManagedTranscription answers from `subscriptions` and never touches
 *     `managed_api_keys`. Both are deliberate security boundaries: no managed
 *     key reaches this process, and the key table has no client read path.
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

// ── hasManagedTranscription ────────────────────────────────────────────────────────────

describe('hasManagedTranscription', () => {
  it('reads the subscription and never the key table', async () => {
    // The load-bearing assertion in this file. Narrowing the old select on
    // `managed_api_keys` to `user_id` closed nothing, because RLS is
    // row-level: a policy letting a user read their own row let them read
    // `deepgram_key` out of it whatever this module chose to ask for. Not
    // touching the table at all is what lets the migration drop that read
    // policy without taking dictation down with it.
    setSession(fakeSupabaseUser())
    mockSupabase.from.mockReturnValue(singleResolves({ status: 'pro' }))

    const r = await auth.hasManagedTranscription()

    expect(r.entitled).toBe(true)
    expect(mockSupabase.from).toHaveBeenCalledWith('subscriptions')
    expect(mockSupabase.from).not.toHaveBeenCalledWith('managed_api_keys')
  })

  it('has no field that a key could be returned in', async () => {
    // The predecessor returned `{ deepgramKey, anthropicKey, hasManagedKeys }`
    // with the first two pinned to null. A shape that can carry a secret is a
    // shape someone eventually fills, so the fields are gone rather than
    // nulled, and this fails if one comes back.
    setSession(fakeSupabaseUser())
    mockSupabase.from.mockReturnValue(singleResolves({ status: 'pro' }))

    const r = await auth.hasManagedTranscription()

    expect(Object.keys(r).sort()).toEqual(['entitled', 'success'])
  })

  it('entitles pro and team, and nothing else', async () => {
    // The negative half matters more than the positive one: this decides
    // whether the app offers the mic, and 'canceled' reading as entitled
    // would point every lapsed subscriber at the grant endpoint.
    const cases = [
      ['pro', true],
      ['team', true],
      ['free', false],
      ['canceled', false],
      ['past_due', false],
    ] as const

    for (const [status, expected] of cases) {
      vi.clearAllMocks()
      setSession(fakeSupabaseUser())
      mockSupabase.from.mockReturnValue(singleResolves({ status }))
      const r = await auth.hasManagedTranscription()
      expect(r.entitled, `status ${status}`).toBe(expected)
    }
  })

  it('is not entitled when there is no session', async () => {
    setSession(null)
    const r = await auth.hasManagedTranscription()
    expect(r.success).toBe(false)
    expect(r.entitled).toBe(false)
  })

  it('is not entitled when there is no subscription row', async () => {
    // Fails open into the free tier rather than throwing: an RLS refusal and
    // a brand-new account look identical here, and neither should break the
    // app for someone who has their own key in Settings.
    setSession(fakeSupabaseUser())
    mockSupabase.from.mockReturnValue(singleResolves(null, { code: 'PGRST116' }))
    const r = await auth.hasManagedTranscription()
    expect(r.success).toBe(true)
    expect(r.entitled).toBe(false)
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
