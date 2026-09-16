import Stripe from 'npm:stripe@17.7.0'
import { createClient } from 'npm:@supabase/supabase-js@2.101.1'
import { type BillingPlan, billingPriceConfig, planForPrice } from '../_shared/billing.ts'
import { selectCurrentSubscription } from '../_shared/webhook.ts'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!)
const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)

interface VerifiedEntitlement {
  kind: 'entitlement'
  userId: string
  customerId: string
  subscriptionId: string
  subscriptionCreated: number
  stripeStatus: string
  plan: BillingPlan
  trialUsed: boolean
  observedAt: string
}

interface VerifiedRefund {
  kind: 'refund'
  userId: string
  customerId: string
  subscriptionId: string
  chargeId: string
}

type ResolvedEvent = VerifiedEntitlement | VerifiedRefund

function customerIdOf(
  value: string | Stripe.Customer | Stripe.DeletedCustomer | null,
): string | null {
  if (!value) return null
  return typeof value === 'string' ? value : value.id
}

function subscriptionIdOf(value: string | Stripe.Subscription | null): string | null {
  if (!value) return null
  return typeof value === 'string' ? value : value.id
}

function planFromSubscription(subscription: Stripe.Subscription): BillingPlan | null {
  const prices = billingPriceConfig({
    STRIPE_PRO_PRICE_ID: Deno.env.get('STRIPE_PRO_PRICE_ID') ?? undefined,
    STRIPE_TEAM_PRICE_ID: Deno.env.get('STRIPE_TEAM_PRICE_ID') ?? undefined,
    STRIPE_PRICE_ID: Deno.env.get('STRIPE_PRICE_ID') ?? undefined,
  })
  const plans = new Set(
    subscription.items.data
      .map((item) => planForPrice(item.price.id, prices))
      .filter((plan): plan is BillingPlan => plan !== null),
  )
  if (plans.size !== 1) return null
  return [...plans][0]
}

async function userIdForBinding(
  metadataUserId: string | undefined,
  subscriptionId: string | null,
  customerId: string,
): Promise<string> {
  if (metadataUserId) return metadataUserId

  if (subscriptionId) {
    const { data, error } = await supabase
      .from('subscriptions')
      .select('user_id')
      .eq('stripe_subscription_id', subscriptionId)
      .maybeSingle()
    if (error) throw new Error(`Subscription binding lookup failed: ${error.message}`)
    if (data?.user_id) return data.user_id
  }

  const { data, error } = await supabase
    .from('subscriptions')
    .select('user_id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle()
  if (error) throw new Error(`Customer binding lookup failed: ${error.message}`)
  if (!data?.user_id) throw new Error('Stripe object is not bound to a MacroVox user')
  return data.user_id
}

async function currentEntitlement(
  customerId: string,
  expectedUserId: string,
): Promise<VerifiedEntitlement> {
  const observedAt = new Date().toISOString()
  const listed = await stripe.subscriptions.list({
    customer: customerId,
    status: 'all',
    limit: 100,
  })
  if (listed.has_more) throw new Error('Stripe subscription list exceeded reconciliation limit')
  const selected = selectCurrentSubscription(listed.data, expectedUserId, planFromSubscription)

  return {
    kind: 'entitlement',
    userId: expectedUserId,
    customerId,
    subscriptionId: selected.subscription.id,
    subscriptionCreated: selected.subscription.created,
    stripeStatus: selected.subscription.status,
    plan: selected.plan,
    trialUsed: selected.subscription.trial_start !== null,
    observedAt,
  }
}

async function resolveEvent(event: Stripe.Event): Promise<ResolvedEvent | null> {
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session
    if (session.mode !== 'subscription') return null
    const customerId = customerIdOf(session.customer)
    const subscriptionId = subscriptionIdOf(session.subscription)
    if (!customerId || !subscriptionId) {
      throw new Error('Completed checkout lacks customer or subscription')
    }
    const subscription = await stripe.subscriptions.retrieve(subscriptionId)
    const userId = await userIdForBinding(
      session.metadata?.userId || subscription.metadata.userId,
      subscriptionId,
      customerId,
    )
    return currentEntitlement(customerId, userId)
  }

  if (
    event.type === 'customer.subscription.created' ||
    event.type === 'customer.subscription.updated' ||
    event.type === 'customer.subscription.deleted'
  ) {
    const eventSubscription = event.data.object as Stripe.Subscription
    const customerId = customerIdOf(eventSubscription.customer)
    if (!customerId) throw new Error('Subscription event lacks customer')
    const userId = await userIdForBinding(
      eventSubscription.metadata.userId,
      eventSubscription.id,
      customerId,
    )
    return currentEntitlement(customerId, userId)
  }

  if (event.type === 'charge.refunded') {
    const charge = event.data.object as Stripe.Charge
    const customerId = customerIdOf(charge.customer)
    if (!customerId) throw new Error('Refunded charge lacks customer')
    if (!charge.invoice) throw new Error('Refunded charge lacks invoice')
    const invoice = typeof charge.invoice === 'string'
      ? await stripe.invoices.retrieve(charge.invoice)
      : charge.invoice
    const subscriptionId = subscriptionIdOf(invoice.subscription)
    if (!subscriptionId) throw new Error('Refunded charge is not tied to a subscription')
    const userId = await userIdForBinding(undefined, subscriptionId, customerId)
    return {
      kind: 'refund',
      userId,
      customerId,
      subscriptionId,
      chargeId: charge.id,
    }
  }

  return null
}

async function markFailed(eventId: string, message: string) {
  const { error } = await supabase.rpc('fail_stripe_webhook_event', {
    p_event_id: eventId,
    p_error: message,
  })
  if (error) console.error('[stripe-webhook] Failed to record event failure')
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  const signature = req.headers.get('stripe-signature')
  if (!signature) return new Response('Missing stripe-signature', { status: 400 })

  let event: Stripe.Event
  try {
    event = await stripe.webhooks.constructEventAsync(
      await req.text(),
      signature,
      Deno.env.get('STRIPE_WEBHOOK_SECRET')!,
    )
  } catch {
    console.error('[stripe-webhook] Signature verification failed')
    return new Response('Webhook signature verification failed', { status: 400 })
  }

  const { data: beginState, error: beginError } = await supabase.rpc(
    'begin_stripe_webhook_event',
    {
      p_event_id: event.id,
      p_event_type: event.type,
      p_event_created: event.created,
    },
  )
  if (beginError) {
    console.error('[stripe-webhook] Failed to reserve event')
    return new Response('Temporary webhook storage failure', { status: 500 })
  }
  if (beginState === 'duplicate') {
    return Response.json({ received: true, duplicate: true })
  }
  if (beginState === 'busy') {
    return new Response('Event is already processing', { status: 409 })
  }

  try {
    const entitlement = await resolveEvent(event)
    if (entitlement?.kind === 'entitlement') {
      const { data: applyState, error: applyError } = await supabase.rpc(
        'apply_stripe_entitlement',
        {
          p_event_id: event.id,
          p_event_created: event.created,
          p_observed_at: entitlement.observedAt,
          p_user_id: entitlement.userId,
          p_stripe_customer_id: entitlement.customerId,
          p_stripe_subscription_id: entitlement.subscriptionId,
          p_stripe_subscription_created: entitlement.subscriptionCreated,
          p_stripe_status: entitlement.stripeStatus,
          p_plan: entitlement.plan,
          p_trial_used: entitlement.trialUsed,
        },
      )
      if (applyError) throw new Error(`Entitlement transaction failed: ${applyError.message}`)
      console.log(`[stripe-webhook] ${event.type}: ${applyState}`)
    } else if (entitlement?.kind === 'refund') {
      const { data: applyState, error: applyError } = await supabase.rpc(
        'apply_stripe_refund_hold',
        {
          p_event_id: event.id,
          p_event_created: event.created,
          p_user_id: entitlement.userId,
          p_stripe_customer_id: entitlement.customerId,
          p_stripe_subscription_id: entitlement.subscriptionId,
          p_stripe_charge_id: entitlement.chargeId,
        },
      )
      if (applyError) throw new Error(`Refund transaction failed: ${applyError.message}`)
      console.log(`[stripe-webhook] ${event.type}: ${applyState}`)
    } else {
      const { error } = await supabase.rpc('apply_stripe_entitlement_noop', {
        p_event_id: event.id,
      })
      if (error) throw new Error(`Event completion failed: ${error.message}`)
    }

    return Response.json({ received: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown handler error'
    console.error('[stripe-webhook] Handler failed:', message)
    await markFailed(event.id, message)
    return new Response('Webhook handler failed', { status: 500 })
  }
})
