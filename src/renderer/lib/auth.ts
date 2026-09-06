/**
 * MacroVox auth & subscription — renderer-side Supabase calls.
 *
 * Phase 6 replaces all Rust IPC auth stubs with direct Supabase JS SDK calls.
 * Function signatures intentionally mirror the old `tauri-ipc.ts` auth exports
 * so callers only need to change the import, not the call sites.
 *
 * Session persistence: Supabase JS SDK writes tokens to `localStorage`
 * automatically.  No Rust IPC required.
 *
 * OAuth note: `signInWithOAuth` opens the provider URL in the system browser
 * via `@tauri-apps/plugin-shell`.  Returning the session back to the app
 * requires deep-link support (`macrovox://auth/callback`); that wiring is
 * scheduled for a future phase.  Email auth is fully functional.
 */

import type { User } from '@supabase/supabase-js'
import { open } from '@tauri-apps/plugin-shell'
import { supabase } from './supabase'

// ── Types ─────────────────────────────────────────────────────────────────────

export type AuthMethod = 'email' | 'google' | 'facebook'
export type OAuthProvider = 'google' | 'facebook'
export type SubscriptionStatus = 'free' | 'pro' | 'team'

export interface AppUser {
  id: string
  email: string | null
  displayName: string | null
  avatarUrl: string | null
  authMethod: AuthMethod
}

export interface SubscriptionInfo {
  status: SubscriptionStatus
  expiresAt: string | null
  features: { managedApiKeys: boolean; voiceMinutes: number; aiRequests: number }
}

export interface OkResult {
  success: boolean
  error?: string
}

export interface GetUserResult {
  success: boolean
  user?: AppUser
  error?: string
}

/**
 * Plans that carry managed transcription. Matches the check the
 * `deepgram-grant` and `claude-proxy` functions make server-side; that one is
 * the real gate, this one only decides whether the mic is offered.
 */
const MANAGED_PLANS: SubscriptionStatus[] = ['pro', 'team']

export interface GetSubscriptionResult {
  success: boolean
  subscription?: SubscriptionInfo
  error?: string
}

/**
 * Whether the signed-in user may use managed transcription.
 *
 * Deliberately carries no key field of any kind. The predecessor of this type
 * had `deepgramKey` and `anthropicKey`, and a shape that can hold a secret is
 * a shape someone eventually fills.
 */
export interface ManagedEntitlementResult {
  success: boolean
  entitled: boolean
  error?: string
}

// ── Dev mode ─────────────────────────────────────────────────────────────────
// When running locally via `python run.py functions`, bypass Supabase auth
// and use API keys from .env directly. Never active in production builds.
const DEV_MODE = import.meta.env.DEV && import.meta.env.VITE_DEV_MODE === 'true'

const DEV_USER: AppUser = {
  id: 'dev-local-user',
  email: 'dev@localhost',
  displayName: 'Local Dev',
  avatarUrl: null,
  authMethod: 'email',
}

const DEV_SUBSCRIPTION: SubscriptionInfo = {
  status: 'pro',
  expiresAt: null,
  features: { managedApiKeys: true, voiceMinutes: 9999, aiRequests: 9999 },
}

// ── Internal helpers ──────────────────────────────────────────────────────────

const DEFAULT_SUBSCRIPTION: SubscriptionInfo = {
  status: 'free',
  expiresAt: null,
  features: { managedApiKeys: false, voiceMinutes: 15, aiRequests: 0 },
}

function mapUser(user: User): AppUser {
  const meta = user.user_metadata ?? {}
  const provider = user.app_metadata?.provider ?? 'email'
  return {
    id: user.id,
    email: user.email ?? null,
    displayName: meta.full_name || meta.name || user.email || null,
    avatarUrl: meta.avatar_url || meta.picture || null,
    authMethod: provider === 'google' ? 'google' : provider === 'facebook' ? 'facebook' : 'email',
  }
}

// ── Auth ──────────────────────────────────────────────────────────────────────

/**
 * Returns the currently authenticated user from the cached local session.
 * Uses `getSession()` (localStorage read) rather than `getUser()` (network call)
 * since this is polled on a 5-second interval by DictationMode.
 */
export async function getUser(): Promise<GetUserResult> {
  if (DEV_MODE) return { success: true, user: DEV_USER }
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.user) return { success: false }
  return { success: true, user: mapUser(session.user) }
}

export async function signInEmail(email: string, password: string): Promise<OkResult> {
  const { error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) return { success: false, error: error.message }
  return { success: true }
}

export async function signUpEmail(email: string, password: string): Promise<OkResult> {
  const { data, error } = await supabase.auth.signUp({ email, password })
  if (error) return { success: false, error: error.message }
  // No session means email confirmation is required
  if (!data.session) return { success: true, error: 'Check your email to confirm your account.' }
  return { success: true }
}

export async function signOut(): Promise<OkResult> {
  const { error } = await supabase.auth.signOut()
  if (error) return { success: false, error: error.message }
  return { success: true }
}

/**
 * Opens the OAuth provider in the system browser via `@tauri-apps/plugin-shell`.
 * The session callback (deep-link `macrovox://auth/callback`) is not yet wired;
 * users will need to re-open the app after completing OAuth in the browser.
 */
export async function signInWithOAuth(provider: OAuthProvider): Promise<OkResult> {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: { skipBrowserRedirect: true },
  })
  if (error || !data.url) return { success: false, error: error?.message || 'Failed to get OAuth URL' }
  await open(data.url)
  return { success: true }
}

export async function resetPassword(email: string): Promise<OkResult> {
  const { error } = await supabase.auth.resetPasswordForEmail(email)
  if (error) return { success: false, error: error.message }
  return { success: true }
}

// ── Subscription ──────────────────────────────────────────────────────────────

/**
 * Fetches subscription info from the Supabase `subscriptions` table.
 * Returns free-tier defaults if the user has no subscription row.
 */
export async function getSubscription(): Promise<GetSubscriptionResult> {
  if (DEV_MODE) return { success: true, subscription: DEV_SUBSCRIPTION }
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.user) return { success: false, error: 'Not signed in' }

  const { data, error } = await supabase
    .from('subscriptions')
    .select('status, expires_at')
    .eq('user_id', session.user.id)
    .single()

  if (error || !data) {
    return { success: true, subscription: DEFAULT_SUBSCRIPTION }
  }

  const status = data.status as SubscriptionStatus
  const features =
    status === 'team' ? { managedApiKeys: true, voiceMinutes: 3000, aiRequests: 2000 }
    : status === 'pro' ? { managedApiKeys: true, voiceMinutes: 600, aiRequests: 500 }
    : DEFAULT_SUBSCRIPTION.features

  return { success: true, subscription: { status, expiresAt: data.expires_at, features } }
}

/**
 * Whether this user is entitled to managed transcription.
 *
 * Answered from `subscriptions`, which is where entitlement has always
 * actually lived: the Netlify functions gate on `status` in (`pro`, `team`)
 * and this now asks the same question of the same table.
 *
 * It deliberately does not read `managed_api_keys`. Narrowing that select to
 * `user_id` was the first half of the fix and it was never the load-bearing
 * half: RLS in Postgres is row-level, so a policy that let a user read their
 * own row let them read every column in it, whatever this file chose to ask
 * for. Anyone signed in could select `deepgram_key` from the browser console
 * and walk off with the shared vendor credential. The companion migration
 * drops that policy, revokes the columns and nulls them; this function is what
 * lets the migration land without taking dictation down with it, because the
 * answer it needs was never in that table to begin with.
 *
 * No key is returned, and there is no field to return one in. Claude goes
 * through claude-proxy; Deepgram goes through `lib/deepgramCredential.ts`,
 * which trades the Supabase session for a token that expires in a minute.
 */
export async function hasManagedTranscription(): Promise<ManagedEntitlementResult> {
  if (DEV_MODE) {
    // Dev-only: `import.meta.env.DEV` is false in production builds, so Vite
    // dead-code-eliminates this branch. A local `.env` key stands in for a
    // subscription so `npm run dev` works without Stripe.
    return { success: true, entitled: !!import.meta.env.VITE_DEEPGRAM_KEY }
  }

  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.user) return { success: false, entitled: false }

  const { data, error } = await supabase
    .from('subscriptions')
    .select('status')
    .eq('user_id', session.user.id)
    .single()

  if (error || !data) return { success: true, entitled: false }

  return { success: true, entitled: MANAGED_PLANS.includes(data.status as SubscriptionStatus) }
}

// ── Billing ───────────────────────────────────────────────────────────────────

/**
 * Creates a Stripe checkout session via a Supabase Edge Function and opens the
 * payment URL in the system browser.
 */
export async function checkout(plan: 'pro' | 'team'): Promise<OkResult> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.user) return { success: false, error: 'Not signed in' }

  const { data, error } = await supabase.functions.invoke('create-checkout', {
    body: { userId: session.user.id, plan },
  })
  if (error || !data?.url) return { success: false, error: error?.message || 'Checkout unavailable' }

  await open(data.url)
  return { success: true }
}

/**
 * Opens the Stripe billing portal via a Supabase Edge Function.
 */
export async function billingPortal(): Promise<OkResult> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.user) return { success: false, error: 'Not signed in' }

  const { data, error } = await supabase.functions.invoke('billing-portal', {
    body: { userId: session.user.id },
  })
  if (error || !data?.url) return { success: false, error: error?.message || 'Billing portal unavailable' }

  await open(data.url)
  return { success: true }
}
