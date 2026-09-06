/**
 * Supabase Edge Function — stripe-webhook
 *
 * Handles Stripe webhook events to keep subscription state in sync.
 * Events handled:
 *   checkout.session.completed       — provision managed API keys for new subscriber
 *   customer.subscription.updated    — sync subscription status changes
 *   customer.subscription.deleted    — deprovision keys on cancellation
 *   charge.refunded                  — deprovision keys on refund
 *
 * Required environment variables (set in Supabase dashboard → Settings → Edge Functions):
 *   STRIPE_SECRET_KEY         — Stripe secret key
 *   STRIPE_WEBHOOK_SECRET     — Webhook signing secret (whsec_...)
 *   DEEPGRAM_MANAGED_KEY      — Deepgram API key to provision for Pro users
 *   ANTHROPIC_MANAGED_KEY     — Anthropic API key to provision for Pro users
 *
 * Webhook endpoint URL: https://<project>.supabase.co/functions/v1/stripe-webhook
 * Register this URL in Stripe Dashboard → Developers → Webhooks.
 */

import Stripe from 'npm:stripe@17'
import { createClient } from 'npm:@supabase/supabase-js@2'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!)
const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)

Deno.serve(async (req) => {
  const signature = req.headers.get('stripe-signature')
  if (!signature) {
    return new Response('Missing stripe-signature', { status: 400 })
  }

  const body = await req.text()
  let event: Stripe.Event

  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      signature,
      Deno.env.get('STRIPE_WEBHOOK_SECRET')!,
    )
  } catch (err) {
    console.error('[stripe-webhook] Signature verification failed')
    return new Response('Webhook signature verification failed', { status: 400 })
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session
        await handleCheckoutCompleted(session)
        break
      }
      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription
        await handleSubscriptionUpdated(sub)
        break
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription
        await handleSubscriptionDeleted(sub)
        break
      }
      case 'charge.refunded': {
        const charge = event.data.object as Stripe.Charge
        await handleChargeRefunded(charge)
        break
      }
      default:
        console.log(`[stripe-webhook] Unhandled event type: ${event.type}`)
    }
  } catch (err) {
    console.error('[stripe-webhook] Handler error:', err instanceof Error ? err.message : 'unknown')
    return new Response('Handler error', { status: 500 })
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
})

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  const userId = session.metadata?.userId
  const plan = (session.metadata?.plan ?? 'pro') as 'pro' | 'team'
  if (!userId) {
    console.error('[stripe-webhook] checkout.session.completed missing userId metadata')
    return
  }

  const customerId = typeof session.customer === 'string'
    ? session.customer
    : session.customer?.id

  const subscriptionId = typeof session.subscription === 'string'
    ? session.subscription
    : session.subscription?.id

  // Defensive check: if this Stripe customer is already bound to a different
  // user in our DB, refuse to re-bind. The create-checkout function already
  // enforces user.id === metadata.userId at session-creation time, but this
  // belt-and-braces guard means a future regression in create-checkout can't
  // be exploited to provision keys to a different account.
  if (customerId) {
    const { data: existing } = await supabase
      .from('subscriptions')
      .select('user_id')
      .eq('stripe_customer_id', customerId)
      .maybeSingle()
    if (existing && existing.user_id !== userId) {
      console.error('[stripe-webhook] checkout customerId already bound to another user — refusing to upsert')
      return
    }
  }

  // Upsert subscription row
  const { error: subError } = await supabase
    .from('subscriptions')
    .upsert({
      user_id: userId,
      status: plan,
      stripe_customer_id: customerId,
      stripe_subscription_id: subscriptionId,
      expires_at: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' })

  if (subError) {
    console.error('[stripe-webhook] Failed to upsert subscription')
    return
  }

  // Nothing to provision. The subscription row above IS the entitlement, and
  // it is what every server-side gate already reads.
  //
  // This used to copy DEEPGRAM_MANAGED_KEY and ANTHROPIC_MANAGED_KEY into a
  // `managed_api_keys` row, which a user could then read back with their own
  // session. That put one shared vendor credential in reach of every
  // subscriber. Both keys now stay in the functions that use them:
  // ANTHROPIC_MANAGED_KEY in claude-proxy, DEEPGRAM_MANAGED_KEY in
  // deepgram-grant, which exchanges it for a token that expires in a minute.
  //
  // Do not reintroduce a table that holds a key a client can reach. If a
  // future vendor needs one, give it a grant endpoint like deepgram-grant.
  console.log(`[stripe-webhook] Subscription active (${plan})`)
}

async function handleSubscriptionUpdated(sub: Stripe.Subscription) {
  // Map Stripe subscription status to our internal status
  const stripeStatus = sub.status
  const isActive = stripeStatus === 'active' || stripeStatus === 'trialing'

  if (!isActive) {
    // Suspension (past_due, unpaid, etc.) — deprovision keys
    await deprovisionByStripeCustomer(sub.customer as string)
    return
  }

  // If active, ensure the subscription row reflects the correct plan
  // (plan changes would come through here as well)
  const { data: existing } = await supabase
    .from('subscriptions')
    .select('user_id')
    .eq('stripe_customer_id', sub.customer as string)
    .single()

  if (existing?.user_id) {
    await supabase
      .from('subscriptions')
      .update({ status: 'pro', updated_at: new Date().toISOString() })
      .eq('user_id', existing.user_id)
  }
}

async function handleSubscriptionDeleted(sub: Stripe.Subscription) {
  await deprovisionByStripeCustomer(sub.customer as string)
}

async function handleChargeRefunded(charge: Stripe.Charge) {
  const customerId = typeof charge.customer === 'string'
    ? charge.customer
    : charge.customer?.id

  if (!customerId) {
    console.error('[stripe-webhook] charge.refunded missing customer')
    return
  }

  await deprovisionByStripeCustomer(customerId)
  console.log('[stripe-webhook] Deprovisioned after refund')
}

async function deprovisionByStripeCustomer(customerId: string) {
  const { data: subRow } = await supabase
    .from('subscriptions')
    .select('user_id')
    .eq('stripe_customer_id', customerId)
    .single()

  if (!subRow?.user_id) return

  const userId = subRow.user_id

  // Downgrade subscription status
  await supabase
    .from('subscriptions')
    .update({
      status: 'free',
      stripe_subscription_id: null,
      expires_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', userId)

  // Remove managed API keys
  await supabase
    .from('managed_api_keys')
    .delete()
    .eq('user_id', userId)

  console.log('[stripe-webhook] Deprovisioned keys')
}
