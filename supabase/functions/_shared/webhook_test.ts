import { assertEquals, assertThrows } from 'jsr:@std/assert@1.0.19'
import type Stripe from 'npm:stripe@17.7.0'
import { selectCurrentSubscription } from './webhook.ts'

function subscription(
  id: string,
  status: Stripe.Subscription.Status,
  created: number,
  userId = 'user-1',
): Stripe.Subscription {
  return {
    id,
    status,
    created,
    metadata: { userId },
  } as unknown as Stripe.Subscription
}

Deno.test('empty current Stripe list fails instead of trusting an event snapshot', () => {
  assertThrows(
    () => selectCurrentSubscription([], 'user-1', () => 'pro'),
    Error,
    'No current subscription',
  )
})

Deno.test('current selection ignores subscriptions bound to another user', () => {
  const selected = selectCurrentSubscription(
    [
      subscription('sub-other', 'active', 200, 'user-2'),
      subscription('sub-current', 'active', 100),
    ],
    'user-1',
    () => 'pro',
  )
  assertEquals(selected.subscription.id, 'sub-current')
})
