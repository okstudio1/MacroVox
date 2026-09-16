export type BillingPlan = 'pro' | 'team'

export interface BillingPriceConfig {
  pro: string
  team?: string
}

export function billingPriceConfig(env: {
  STRIPE_PRO_PRICE_ID?: string
  STRIPE_TEAM_PRICE_ID?: string
  STRIPE_PRICE_ID?: string
}): BillingPriceConfig {
  const pro = (env.STRIPE_PRO_PRICE_ID || env.STRIPE_PRICE_ID)?.trim()
  if (!pro) throw new Error('STRIPE_PRO_PRICE_ID is not configured')
  const team = env.STRIPE_TEAM_PRICE_ID?.trim() || undefined
  if (team === pro) throw new Error('Stripe plan Price IDs must be distinct')
  return {
    pro,
    ...(team ? { team } : {}),
  }
}

export function priceForPlan(plan: string, prices: BillingPriceConfig): string | null {
  if (plan === 'pro') return prices.pro
  if (plan === 'team') return prices.team ?? null
  return null
}

export function planForPrice(priceId: string, prices: BillingPriceConfig): BillingPlan | null {
  if (priceId === prices.pro) return 'pro'
  if (prices.team && priceId === prices.team) return 'team'
  return null
}

export function grantsEntitlement(stripeStatus: string): boolean {
  return stripeStatus === 'active' || stripeStatus === 'trialing'
}

export function entitlementStatus(
  stripeStatus: string,
  plan: BillingPlan,
): BillingPlan | 'free' {
  return grantsEntitlement(stripeStatus) ? plan : 'free'
}
