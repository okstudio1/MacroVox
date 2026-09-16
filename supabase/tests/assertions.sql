BEGIN;

INSERT INTO auth.users (id)
VALUES
  ('00000000-0000-0000-0000-000000000101'),
  ('00000000-0000-0000-0000-000000000102');

INSERT INTO public.subscriptions (user_id, status)
VALUES
  ('00000000-0000-0000-0000-000000000101', 'free'),
  ('00000000-0000-0000-0000-000000000102', 'free');

DO $$
BEGIN
  IF NOT has_table_privilege('authenticated', 'public.subscriptions', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated must read subscription summaries';
  END IF;
  IF has_table_privilege('authenticated', 'public.api_usage', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated must not read quota records';
  END IF;
  IF to_regclass('public.managed_api_keys') IS NOT NULL THEN
    IF has_table_privilege('authenticated', 'public.managed_api_keys', 'SELECT')
       OR has_table_privilege('anon', 'public.managed_api_keys', 'SELECT') THEN
      RAISE EXCEPTION 'legacy managed key table must not be client-readable';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.managed_api_keys
      WHERE deepgram_key IS NOT NULL OR anthropic_key IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'legacy managed provider keys were not cleared';
    END IF;
  END IF;
  IF has_function_privilege(
    'authenticated',
    'public.reserve_api_quota(uuid,text,integer,integer)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'authenticated must not reserve backend quota directly';
  END IF;
  IF NOT has_function_privilege(
    'service_role',
    'public.reserve_api_quota(uuid,text,integer,integer)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'service_role must reserve backend quota';
  END IF;
END;
$$;

SET LOCAL request.jwt.claim.sub = '00000000-0000-0000-0000-000000000101';
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  IF (SELECT count(*) FROM public.subscriptions) <> 1 THEN
    RAISE EXCEPTION 'subscription RLS must expose only the authenticated user row';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.subscriptions
    WHERE user_id = '00000000-0000-0000-0000-000000000101'
  ) THEN
    RAISE EXCEPTION 'subscription RLS hid the authenticated user row';
  END IF;
END;
$$;
RESET ROLE;

INSERT INTO public.api_usage (user_id, service)
VALUES
  ('00000000-0000-0000-0000-000000000101', 'claude'),
  ('00000000-0000-0000-0000-000000000101', 'claude');

DO $$
BEGIN
  IF NOT public.reserve_api_quota(
    '00000000-0000-0000-0000-000000000101', 'claude', 3, 3600
  ) THEN
    RAISE EXCEPTION 'final quota slot should be reserved';
  END IF;
  IF public.reserve_api_quota(
    '00000000-0000-0000-0000-000000000101', 'claude', 3, 3600
  ) THEN
    RAISE EXCEPTION 'quota must deny after the limit';
  END IF;
END;
$$;

DO $$
DECLARE
  first_reservation UUID;
  retry_reservation UUID;
  first_trial BOOLEAN;
  retry_trial BOOLEAN;
BEGIN
  SELECT reservation_id, trial_eligible
  INTO first_reservation, first_trial
  FROM public.begin_checkout('00000000-0000-0000-0000-000000000101', 'pro');

  SELECT reservation_id, trial_eligible
  INTO retry_reservation, retry_trial
  FROM public.begin_checkout('00000000-0000-0000-0000-000000000101', 'pro');

  IF first_reservation IS NULL OR first_reservation IS DISTINCT FROM retry_reservation THEN
    RAISE EXCEPTION 'checkout retry must reuse its durable reservation';
  END IF;
  IF NOT first_trial OR NOT retry_trial THEN
    RAISE EXCEPTION 'trial reservation must remain stable across retries';
  END IF;

  BEGIN
    PERFORM public.begin_checkout('00000000-0000-0000-0000-000000000101', 'team');
    RAISE EXCEPTION 'plan change should not replace an in-flight reservation';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM = 'plan change should not replace an in-flight reservation' THEN
        RAISE;
      END IF;
  END;

  PERFORM public.complete_checkout_reservation(
    '00000000-0000-0000-0000-000000000101',
    first_reservation,
    'cs_test_first',
    true
  );

  UPDATE public.subscriptions
  SET pending_checkout_session_id = NULL,
      pending_checkout_created_at = NULL
  WHERE user_id = '00000000-0000-0000-0000-000000000101';

  SELECT trial_eligible INTO retry_trial
  FROM public.begin_checkout('00000000-0000-0000-0000-000000000101', 'pro');
  IF retry_trial THEN
    RAISE EXCEPTION 'consumed trial must never become eligible again';
  END IF;
END;
$$;

DO $$
DECLARE
  state TEXT;
BEGIN
  state := public.begin_stripe_webhook_event('evt_retry', 'test.event', 10);
  IF state <> 'process' THEN RAISE EXCEPTION 'new event must process'; END IF;
  state := public.begin_stripe_webhook_event('evt_retry', 'test.event', 10);
  IF state <> 'busy' THEN RAISE EXCEPTION 'in-flight duplicate must be busy'; END IF;
  PERFORM public.fail_stripe_webhook_event('evt_retry', 'temporary');
  state := public.begin_stripe_webhook_event('evt_retry', 'test.event', 10);
  IF state <> 'process' THEN RAISE EXCEPTION 'failed event must be retryable'; END IF;
  PERFORM public.apply_stripe_entitlement_noop('evt_retry');
  state := public.begin_stripe_webhook_event('evt_retry', 'test.event', 10);
  IF state <> 'duplicate' THEN RAISE EXCEPTION 'processed event must deduplicate'; END IF;
END;
$$;

DO $$
DECLARE
  state TEXT;
BEGIN
  UPDATE public.subscriptions
  SET stripe_customer_id = 'cus_new'
  WHERE user_id = '00000000-0000-0000-0000-000000000101';

  PERFORM public.begin_stripe_webhook_event('evt_new', 'customer.subscription.updated', 200);
  state := public.apply_stripe_entitlement(
    'evt_new', 200, '2026-09-15T12:00:00Z',
    '00000000-0000-0000-0000-000000000101',
    'cus_new', 'sub_new', 200, 'active', 'pro', true
  );
  IF state <> 'applied' THEN RAISE EXCEPTION 'current entitlement must apply'; END IF;

  PERFORM public.begin_stripe_webhook_event('evt_old_customer', 'customer.subscription.updated', 300);
  state := public.apply_stripe_entitlement(
    'evt_old_customer', 300, '2026-09-15T12:01:00Z',
    '00000000-0000-0000-0000-000000000101',
    'cus_old', 'sub_old_customer', 300, 'active', 'pro', true
  );
  IF state <> 'customer_mismatch' THEN
    RAISE EXCEPTION 'old customer event must not replace the current binding';
  END IF;

  PERFORM public.begin_stripe_webhook_event('evt_other', 'customer.subscription.deleted', 310);
  state := public.apply_stripe_entitlement(
    'evt_other', 310, '2026-09-15T12:01:00Z',
    '00000000-0000-0000-0000-000000000101',
    'cus_new', 'sub_other', 310, 'canceled', 'pro', true
  );
  IF state <> 'inactive_other_subscription' THEN
    RAISE EXCEPTION 'inactive duplicate subscription must not replace active binding';
  END IF;

  PERFORM public.begin_stripe_webhook_event('evt_old', 'customer.subscription.deleted', 100);
  state := public.apply_stripe_entitlement(
    'evt_old', 100, '2026-09-15T12:01:00Z',
    '00000000-0000-0000-0000-000000000101',
    'cus_new', 'sub_old', 100, 'canceled', 'pro', true
  );
  IF state <> 'stale_event' THEN RAISE EXCEPTION 'older event must be ignored'; END IF;

  PERFORM public.begin_stripe_webhook_event('evt_old_refund', 'charge.refunded', 400);
  state := public.apply_stripe_refund_hold(
    'evt_old_refund', 400,
    '00000000-0000-0000-0000-000000000101',
    'cus_new', 'sub_old', 'ch_old'
  );
  IF state <> 'subscription_mismatch' THEN
    RAISE EXCEPTION 'refund for an old subscription must not revoke current access';
  END IF;

  PERFORM public.begin_stripe_webhook_event('evt_refund', 'charge.refunded', 500);
  state := public.apply_stripe_refund_hold(
    'evt_refund', 500,
    '00000000-0000-0000-0000-000000000101',
    'cus_new', 'sub_new', 'ch_current'
  );
  IF state <> 'refund_hold_applied' THEN RAISE EXCEPTION 'current refund must apply'; END IF;

  IF (SELECT status FROM public.subscriptions
      WHERE user_id = '00000000-0000-0000-0000-000000000101') <> 'free' THEN
    RAISE EXCEPTION 'refund hold did not revoke entitlement';
  END IF;

  PERFORM public.begin_stripe_webhook_event('evt_same_sub', 'customer.subscription.updated', 600);
  state := public.apply_stripe_entitlement(
    'evt_same_sub', 600, '2026-09-15T12:03:00Z',
    '00000000-0000-0000-0000-000000000101',
    'cus_new', 'sub_new', 200, 'active', 'pro', true
  );
  IF state <> 'applied' THEN RAISE EXCEPTION 'same subscription update must reconcile'; END IF;
  IF (SELECT status FROM public.subscriptions
      WHERE user_id = '00000000-0000-0000-0000-000000000101') <> 'free' THEN
    RAISE EXCEPTION 'same refunded subscription cleared its durable hold';
  END IF;

  PERFORM public.begin_stripe_webhook_event('evt_repurchase', 'customer.subscription.created', 700);
  state := public.apply_stripe_entitlement(
    'evt_repurchase', 700, '2026-09-15T12:04:00Z',
    '00000000-0000-0000-0000-000000000101',
    'cus_new', 'sub_repurchase', 700, 'active', 'pro', true
  );
  IF state <> 'applied' THEN RAISE EXCEPTION 'new subscription must apply'; END IF;

  IF (SELECT status FROM public.subscriptions
      WHERE user_id = '00000000-0000-0000-0000-000000000101') <> 'pro' THEN
    RAISE EXCEPTION 'new subscription did not clear refund hold';
  END IF;
  IF (SELECT refund_hold_subscription_id FROM public.subscriptions
      WHERE user_id = '00000000-0000-0000-0000-000000000101') IS NOT NULL THEN
    RAISE EXCEPTION 'new subscription left refund hold metadata behind';
  END IF;
END;
$$;

ROLLBACK;
