import Stripe from 'npm:stripe@17.7.0'
import { createClient } from 'npm:@supabase/supabase-js@2.101.1'
import { billingPriceConfig, priceForPlan } from '../_shared/billing.ts'
import { allowedOrigin } from '../_shared/origins.ts'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!)
const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)

interface CheckoutReservation {
  reservation_id: string | null
  stripe_customer_id: string | null
  trial_eligible: boolean
  pending_checkout_session_id: string | null
}

function corsHeaders(req: Request): Record<string, string> {
  const origin = allowedOrigin(req.headers.get('origin'))
  return {
    ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  }
}

function json(status: number, body: Record<string, unknown>, headers: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

async function reserveCheckout(userId: string, plan: string): Promise<CheckoutReservation> {
  const { data, error } = await supabase.rpc('begin_checkout', {
    p_user_id: userId,
    p_plan: plan,
  })
  if (error) throw new Error(`Checkout reservation failed: ${error.message}`)
  const reservation = (data as CheckoutReservation[] | null)?.[0]
  if (!reservation) throw new Error('Checkout reservation returned no row')
  return reservation
}

Deno.serve(async (req) => {
  const headers = corsHeaders(req)
  const origin = allowedOrigin(req.headers.get('origin'))
  if (!origin) return json(403, { error: 'Origin not allowed' }, headers)
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers })
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' }, headers)

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json(401, { error: 'Unauthorized' }, headers)

    const token = authHeader.replace(/^Bearer\s+/i, '')
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) return json(401, { error: 'Invalid token' }, headers)

    const body = await req.json() as { userId?: string; plan?: string }
    if (body.userId !== user.id) return json(403, { error: 'Forbidden' }, headers)

    const prices = billingPriceConfig({
      STRIPE_PRO_PRICE_ID: Deno.env.get('STRIPE_PRO_PRICE_ID') ?? undefined,
      STRIPE_TEAM_PRICE_ID: Deno.env.get('STRIPE_TEAM_PRICE_ID') ?? undefined,
      STRIPE_PRICE_ID: Deno.env.get('STRIPE_PRICE_ID') ?? undefined,
    })
    const priceId = priceForPlan(body.plan ?? '', prices)
    if (!priceId) return json(400, { error: 'Invalid or unavailable plan' }, headers)

    let reservation = await reserveCheckout(user.id, body.plan!)

    if (reservation.pending_checkout_session_id) {
      const existing = await stripe.checkout.sessions.retrieve(
        reservation.pending_checkout_session_id,
      )
      if (existing.status === 'open' && existing.url) {
        return json(200, { url: existing.url }, headers)
      }
      if (existing.status === 'complete') {
        return json(
          409,
          { error: 'Checkout already completed; subscription update pending' },
          headers,
        )
      }

      const { error: clearError } = await supabase
        .from('subscriptions')
        .update({ pending_checkout_session_id: null, pending_checkout_created_at: null })
        .eq('user_id', user.id)
        .eq('pending_checkout_session_id', reservation.pending_checkout_session_id)
      if (clearError) throw new Error(`Failed to clear expired checkout: ${clearError.message}`)
      reservation = await reserveCheckout(user.id, body.plan!)
    }

    if (!reservation.reservation_id) throw new Error('Checkout reservation ID is missing')
    const reservationId = reservation.reservation_id

    let customerId = reservation.stripe_customer_id
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { userId: user.id },
      }, { idempotencyKey: `macrovox-customer-${reservationId}` })
      customerId = customer.id

      const { error } = await supabase.rpc('attach_checkout_customer', {
        p_user_id: user.id,
        p_reservation_id: reservationId,
        p_stripe_customer_id: customerId,
      })
      if (error) throw new Error(`Failed to attach Stripe customer: ${error.message}`)
    }

    const siteUrl = Deno.env.get('SITE_URL') ?? 'https://macrovox.tech'
    const plan = body.plan as 'pro' | 'team'
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        ...(reservation.trial_eligible ? { trial_period_days: 7 } : {}),
        metadata: { userId: user.id, plan },
      },
      success_url: `${siteUrl}/success`,
      cancel_url: `${siteUrl}/cancel`,
      metadata: { userId: user.id, plan },
    }, { idempotencyKey: `macrovox-checkout-${reservationId}` })

    const { error: completeError } = await supabase.rpc('complete_checkout_reservation', {
      p_user_id: user.id,
      p_reservation_id: reservationId,
      p_checkout_session_id: session.id,
      p_trial_reserved: reservation.trial_eligible,
    })
    if (completeError) throw new Error(`Failed to finalize checkout: ${completeError.message}`)
    if (!session.url) throw new Error('Stripe checkout session has no URL')

    return json(200, { url: session.url }, headers)
  } catch (err) {
    console.error('[create-checkout]', err instanceof Error ? err.message : 'unknown')
    return json(500, { error: 'Checkout unavailable' }, headers)
  }
})
