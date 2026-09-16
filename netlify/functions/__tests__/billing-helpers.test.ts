import { describe, expect, it } from 'vitest'
import {
  billingPriceConfig,
  entitlementStatus,
  planForPrice,
  priceForPlan,
} from '../../../supabase/functions/_shared/billing'

describe('billing price trust boundary', () => {
  const prices = { pro: 'price_pro', team: 'price_team' }

  it('maps plans only to server-configured prices', () => {
    expect(priceForPlan('pro', prices)).toBe('price_pro')
    expect(priceForPlan('team', prices)).toBe('price_team')
    expect(priceForPlan('admin', prices)).toBeNull()
  })

  it('derives entitlement plans only from verified prices', () => {
    expect(planForPrice('price_pro', prices)).toBe('pro')
    expect(planForPrice('price_team', prices)).toBe('team')
    expect(planForPrice('price_attacker', prices)).toBeNull()
  })

  it('accepts the legacy price only as a Pro fallback', () => {
    expect(billingPriceConfig({ STRIPE_PRICE_ID: 'price_legacy' })).toEqual({
      pro: 'price_legacy',
    })
    expect(priceForPlan('team', { pro: 'price_legacy' })).toBeNull()
  })

  it('rejects one Stripe Price ID mapped to two plans', () => {
    expect(() => billingPriceConfig({
      STRIPE_PRO_PRICE_ID: 'price_same',
      STRIPE_TEAM_PRICE_ID: 'price_same',
    })).toThrow('must be distinct')
  })

  it('grants access only for current active or trialing subscriptions', () => {
    expect(entitlementStatus('active', 'team')).toBe('team')
    expect(entitlementStatus('trialing', 'pro')).toBe('pro')
    expect(entitlementStatus('canceled', 'team')).toBe('free')
    expect(entitlementStatus('unpaid', 'pro')).toBe('free')
  })
})
