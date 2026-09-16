import { billingPriceConfig, entitlementStatus, planForPrice, priceForPlan } from './billing.ts'

function assertEquals(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

Deno.test('billing plans map only to configured prices', () => {
  const prices = { pro: 'price_pro', team: 'price_team' }
  assertEquals(priceForPlan('pro', prices), 'price_pro')
  assertEquals(priceForPlan('team', prices), 'price_team')
  assertEquals(priceForPlan('unknown', prices), null)
  assertEquals(planForPrice('price_team', prices), 'team')
  assertEquals(planForPrice('price_unknown', prices), null)
})

Deno.test('legacy price fallback cannot create Team entitlement', () => {
  const prices = billingPriceConfig({ STRIPE_PRICE_ID: 'price_legacy' })
  assertEquals(prices, { pro: 'price_legacy' })
  assertEquals(priceForPlan('team', prices), null)
})

Deno.test('duplicate plan prices are rejected', () => {
  let rejected = false
  try {
    billingPriceConfig({
      STRIPE_PRO_PRICE_ID: 'price_same',
      STRIPE_TEAM_PRICE_ID: 'price_same',
    })
  } catch {
    rejected = true
  }
  assertEquals(rejected, true)
})

Deno.test('inactive Stripe states resolve to free', () => {
  assertEquals(entitlementStatus('active', 'pro'), 'pro')
  assertEquals(entitlementStatus('trialing', 'team'), 'team')
  assertEquals(entitlementStatus('past_due', 'pro'), 'free')
  assertEquals(entitlementStatus('canceled', 'team'), 'free')
})
