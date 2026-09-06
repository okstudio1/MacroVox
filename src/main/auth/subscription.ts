/**
 * Subscription management via Supabase
 *
 * Checks subscription status and managed API keys from the Supabase
 * `subscriptions` and `managed_api_keys` tables.
 */

import { getSupabaseClient } from './supabase-client'
import type { SubscriptionInfo, SubscriptionStatus } from './types'

const DEFAULT_SUBSCRIPTION: SubscriptionInfo = {
  status: 'free',
  expiresAt: null,
  features: { managedApiKeys: false, voiceMinutes: 15, aiRequests: 0 },
}

const PRO_FEATURES = { managedApiKeys: true, voiceMinutes: 600, aiRequests: 500 }
const TEAM_FEATURES = { managedApiKeys: true, voiceMinutes: 3000, aiRequests: 2000 }

/**
 * Fetch the current user's subscription from Supabase.
 * Returns free tier defaults if no subscription row exists.
 */
export async function getSubscription(userId: string): Promise<SubscriptionInfo> {
  try {
    const supabase = getSupabaseClient()
    const { data, error } = await supabase
      .from('subscriptions')
      .select('status, expires_at')
      .eq('user_id', userId)
      .single()

    if (error || !data) {
      console.log('[Subscription] No subscription found, using free tier')
      return DEFAULT_SUBSCRIPTION
    }

    const status = data.status as SubscriptionStatus
    const features = status === 'team' ? TEAM_FEATURES
      : status === 'pro' ? PRO_FEATURES
      : DEFAULT_SUBSCRIPTION.features

    return { status, expiresAt: data.expires_at, features }
  } catch (err) {
    console.error('[Subscription] Error fetching subscription:', err)
    return DEFAULT_SUBSCRIPTION
  }
}

/**
 * Always returns nulls. Kept as a stub so the IPC surface in `main.ts` and
 * `preload.ts` keeps its shape.
 *
 * This used to select `deepgram_key, anthropic_key` and return them. Those
 * columns are now revoked from the `authenticated` role and nulled, so the
 * select would fail rather than leak, but a reader that only fails because the
 * database refuses it is still a reader. Managed credentials never leave the
 * server now: Claude through claude-proxy, Deepgram through deepgram-grant.
 */
export async function getManagedApiKeys(
  _userId: string
): Promise<{ deepgramKey: string | null; anthropicKey: string | null }> {
  return { deepgramKey: null, anthropicKey: null }
}

/**
 * Open the Stripe billing portal or checkout page.
 * This calls a Supabase Edge Function that creates the Stripe session.
 */
export async function createCheckoutSession(userId: string, plan: 'pro' | 'team'): Promise<string | null> {
  try {
    const supabase = getSupabaseClient()
    const { data, error } = await supabase.functions.invoke('create-checkout', {
      body: { userId, plan },
    })

    if (error) {
      console.error('[Subscription] Checkout error:', error)
      return null
    }

    return data?.url || null
  } catch (err) {
    console.error('[Subscription] Failed to create checkout session:', err)
    return null
  }
}

export async function createBillingPortalSession(userId: string): Promise<string | null> {
  try {
    const supabase = getSupabaseClient()
    const { data, error } = await supabase.functions.invoke('billing-portal', {
      body: { userId },
    })

    if (error) {
      console.error('[Subscription] Billing portal error:', error)
      return null
    }

    return data?.url || null
  } catch (err) {
    console.error('[Subscription] Failed to create billing portal session:', err)
    return null
  }
}
