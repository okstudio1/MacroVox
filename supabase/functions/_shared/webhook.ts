import type Stripe from 'npm:stripe@17.7.0'
import type { BillingPlan } from './billing.ts'

export interface SelectedSubscription {
  subscription: Stripe.Subscription
  plan: BillingPlan
}

export function selectCurrentSubscription(
  subscriptions: Stripe.Subscription[],
  expectedUserId: string,
  planFromSubscription: (subscription: Stripe.Subscription) => BillingPlan | null,
): SelectedSubscription {
  const verified = subscriptions
    .map((subscription) => ({ subscription, plan: planFromSubscription(subscription) }))
    .filter(({ subscription, plan }) =>
      plan !== null &&
      (!subscription.metadata.userId || subscription.metadata.userId === expectedUserId)
    ) as SelectedSubscription[]

  const byNewest = (a: SelectedSubscription, b: SelectedSubscription) =>
    b.subscription.created - a.subscription.created ||
    b.subscription.id.localeCompare(a.subscription.id)

  const selected = verified
    .filter(({ subscription }) =>
      subscription.status === 'active' || subscription.status === 'trialing'
    )
    .sort(byNewest)[0] ?? verified.sort(byNewest)[0]

  if (!selected) throw new Error('No current subscription with a configured Stripe price was found')
  return selected
}
