-- Reproducible backend schema and atomic security boundaries.
-- Safe on an existing project: tables are preserved and columns are added.

CREATE TABLE IF NOT EXISTS public.subscriptions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'free',
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS stripe_status TEXT,
  ADD COLUMN IF NOT EXISTS stripe_subscription_created BIGINT,
  ADD COLUMN IF NOT EXISTS trial_used BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS checkout_reservation_id UUID,
  ADD COLUMN IF NOT EXISTS checkout_reservation_plan TEXT,
  ADD COLUMN IF NOT EXISTS checkout_trial_reserved BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS checkout_reserved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pending_checkout_session_id TEXT,
  ADD COLUMN IF NOT EXISTS pending_checkout_created_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS latest_stripe_event_created BIGINT,
  ADD COLUMN IF NOT EXISTS latest_stripe_observed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS refund_hold_subscription_id TEXT,
  ADD COLUMN IF NOT EXISTS refund_hold_subscription_created BIGINT,
  ADD COLUMN IF NOT EXISTS refund_hold_event_created BIGINT,
  ADD COLUMN IF NOT EXISTS refund_hold_charge_id TEXT,
  ADD COLUMN IF NOT EXISTS refund_hold_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.subscriptions'::regclass
      AND conname = 'subscriptions_status_check'
  ) THEN
    ALTER TABLE public.subscriptions ADD CONSTRAINT subscriptions_status_check
      CHECK (status IN ('free', 'pro', 'team'));
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_stripe_customer_unique
  ON public.subscriptions (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_stripe_subscription_unique
  ON public.subscriptions (stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users read own subscription" ON public.subscriptions;
CREATE POLICY "Users read own subscription" ON public.subscriptions
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

REVOKE ALL ON public.subscriptions FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.subscriptions FROM authenticated;
GRANT SELECT ON public.subscriptions TO authenticated;
GRANT ALL ON public.subscriptions TO service_role;

CREATE TABLE IF NOT EXISTS public.api_usage (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  service TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

ALTER TABLE public.api_usage DROP CONSTRAINT IF EXISTS api_usage_service_check;
ALTER TABLE public.api_usage ADD CONSTRAINT api_usage_service_check
  CHECK (service IN ('claude', 'deepgram', 'deepgram_token'));

CREATE INDEX IF NOT EXISTS idx_api_usage_rate_limit
  ON public.api_usage (user_id, service, created_at DESC);

ALTER TABLE public.api_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.api_usage FROM anon, authenticated;
GRANT ALL ON public.api_usage TO service_role;

CREATE TABLE IF NOT EXISTS public.stripe_webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  event_created BIGINT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('processing', 'processed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 1,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);

ALTER TABLE public.stripe_webhook_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.stripe_webhook_events FROM anon, authenticated;
GRANT ALL ON public.stripe_webhook_events TO service_role;

CREATE OR REPLACE FUNCTION public.reserve_api_quota(
  p_user_id UUID,
  p_service TEXT,
  p_limit INTEGER,
  p_window_seconds INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  current_usage BIGINT;
BEGIN
  IF p_limit < 1 OR p_window_seconds < 1
     OR p_service NOT IN ('claude', 'deepgram', 'deepgram_token') THEN
    RAISE EXCEPTION 'invalid quota request';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_user_id::TEXT || ':' || p_service, 0)
  );

  SELECT count(*) INTO current_usage
  FROM public.api_usage
  WHERE user_id = p_user_id
    AND service = p_service
    AND created_at >= now() - make_interval(secs => p_window_seconds);

  IF current_usage >= p_limit THEN
    RETURN false;
  END IF;

  INSERT INTO public.api_usage (user_id, service)
  VALUES (p_user_id, p_service);
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_api_quota(UUID, TEXT, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_api_quota(UUID, TEXT, INTEGER, INTEGER)
  TO service_role;

CREATE OR REPLACE FUNCTION public.begin_checkout(
  p_user_id UUID,
  p_plan TEXT
)
RETURNS TABLE (
  reservation_id UUID,
  stripe_customer_id TEXT,
  trial_eligible BOOLEAN,
  pending_checkout_session_id TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  sub public.subscriptions%ROWTYPE;
BEGIN
  IF p_plan NOT IN ('pro', 'team') THEN
    RAISE EXCEPTION 'invalid plan';
  END IF;

  INSERT INTO public.subscriptions (user_id, status)
  VALUES (p_user_id, 'free')
  ON CONFLICT (user_id) DO NOTHING;

  SELECT * INTO sub
  FROM public.subscriptions
  WHERE user_id = p_user_id
  FOR UPDATE;

  PERFORM pg_advisory_xact_lock(hashtextextended('checkout:' || p_user_id::TEXT, 0));

  IF sub.status IN ('pro', 'team') THEN
    RAISE EXCEPTION 'active subscription already exists';
  END IF;

  IF sub.pending_checkout_session_id IS NOT NULL
     AND sub.pending_checkout_created_at > now() - interval '24 hours' THEN
    RETURN QUERY SELECT
      NULL::UUID,
      sub.stripe_customer_id,
      false,
      sub.pending_checkout_session_id;
    RETURN;
  END IF;

  IF sub.checkout_reservation_id IS NOT NULL THEN
    IF sub.checkout_reservation_plan IS DISTINCT FROM p_plan THEN
      RAISE EXCEPTION 'another checkout plan is already reserved';
    END IF;
    RETURN QUERY SELECT
      sub.checkout_reservation_id,
      sub.stripe_customer_id,
      sub.checkout_trial_reserved,
      NULL::TEXT;
    RETURN;
  END IF;

  sub.checkout_reservation_id := gen_random_uuid();
  sub.checkout_trial_reserved := NOT sub.trial_used;

  UPDATE public.subscriptions
  SET checkout_reservation_id = sub.checkout_reservation_id,
      checkout_reservation_plan = p_plan,
      checkout_trial_reserved = sub.checkout_trial_reserved,
      checkout_reserved_at = now(),
      trial_used = trial_used OR sub.checkout_trial_reserved,
      pending_checkout_session_id = NULL,
      pending_checkout_created_at = NULL,
      updated_at = now()
  WHERE user_id = p_user_id;

  RETURN QUERY SELECT
    sub.checkout_reservation_id,
    sub.stripe_customer_id,
    sub.checkout_trial_reserved,
    NULL::TEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.attach_checkout_customer(
  p_user_id UUID,
  p_reservation_id UUID,
  p_stripe_customer_id TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.subscriptions
  SET stripe_customer_id = COALESCE(stripe_customer_id, p_stripe_customer_id),
      updated_at = now()
  WHERE user_id = p_user_id
    AND checkout_reservation_id = p_reservation_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'checkout reservation not found';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_checkout_reservation(
  p_user_id UUID,
  p_reservation_id UUID,
  p_checkout_session_id TEXT,
  p_trial_reserved BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.subscriptions
  SET trial_used = trial_used OR p_trial_reserved,
      pending_checkout_session_id = p_checkout_session_id,
      pending_checkout_created_at = now(),
      checkout_reservation_id = NULL,
      checkout_reservation_plan = NULL,
      checkout_trial_reserved = false,
      checkout_reserved_at = NULL,
      updated_at = now()
  WHERE user_id = p_user_id
    AND checkout_reservation_id = p_reservation_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'checkout reservation not found';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.begin_stripe_webhook_event(
  p_event_id TEXT,
  p_event_type TEXT,
  p_event_created BIGINT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  existing public.stripe_webhook_events%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('stripe-event:' || p_event_id, 0));

  SELECT * INTO existing
  FROM public.stripe_webhook_events
  WHERE event_id = p_event_id
  FOR UPDATE;

  IF FOUND AND existing.state = 'processed' THEN
    RETURN 'duplicate';
  END IF;
  IF FOUND AND existing.state = 'processing'
     AND existing.updated_at > now() - interval '5 minutes' THEN
    RETURN 'busy';
  END IF;

  INSERT INTO public.stripe_webhook_events (
    event_id, event_type, event_created, state, attempts, updated_at
  ) VALUES (
    p_event_id, p_event_type, p_event_created, 'processing', 1, now()
  )
  ON CONFLICT (event_id) DO UPDATE
    SET state = 'processing',
        attempts = public.stripe_webhook_events.attempts + 1,
        last_error = NULL,
        updated_at = now();
  RETURN 'process';
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_stripe_webhook_event(
  p_event_id TEXT,
  p_error TEXT
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.stripe_webhook_events
  SET state = 'failed',
      last_error = left(p_error, 500),
      updated_at = now()
  WHERE event_id = p_event_id
    AND state = 'processing';
$$;

CREATE OR REPLACE FUNCTION public.apply_stripe_entitlement(
  p_event_id TEXT,
  p_event_created BIGINT,
  p_observed_at TIMESTAMPTZ,
  p_user_id UUID,
  p_stripe_customer_id TEXT,
  p_stripe_subscription_id TEXT,
  p_stripe_subscription_created BIGINT,
  p_stripe_status TEXT,
  p_plan TEXT,
  p_trial_used BOOLEAN
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  current_sub public.subscriptions%ROWTYPE;
  next_status TEXT;
BEGIN
  IF p_plan NOT IN ('pro', 'team') THEN
    RAISE EXCEPTION 'invalid verified plan';
  END IF;
  IF p_stripe_status IS NULL THEN
    RAISE EXCEPTION 'missing Stripe status';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::TEXT, 0));

  SELECT * INTO current_sub
  FROM public.subscriptions
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription row not found';
  END IF;

  IF current_sub.stripe_customer_id IS DISTINCT FROM p_stripe_customer_id THEN
    UPDATE public.stripe_webhook_events
    SET state = 'processed', processed_at = now(), updated_at = now()
    WHERE event_id = p_event_id AND state = 'processing';
    RETURN 'customer_mismatch';
  END IF;

  IF current_sub.latest_stripe_event_created IS NOT NULL
     AND p_event_created < current_sub.latest_stripe_event_created THEN
    UPDATE public.stripe_webhook_events
    SET state = 'processed', processed_at = now(), updated_at = now()
    WHERE event_id = p_event_id AND state = 'processing';
    RETURN 'stale_event';
  END IF;

  IF current_sub.latest_stripe_observed_at IS NOT NULL
     AND p_observed_at < current_sub.latest_stripe_observed_at THEN
    UPDATE public.stripe_webhook_events
    SET state = 'processed', processed_at = now(), updated_at = now()
    WHERE event_id = p_event_id AND state = 'processing';
    RETURN 'stale_observation';
  END IF;

  IF current_sub.stripe_subscription_id IS DISTINCT FROM p_stripe_subscription_id
     AND current_sub.status IN ('pro', 'team')
     AND p_stripe_status NOT IN ('active', 'trialing') THEN
    UPDATE public.stripe_webhook_events
    SET state = 'processed', processed_at = now(), updated_at = now()
    WHERE event_id = p_event_id AND state = 'processing';
    RETURN 'inactive_other_subscription';
  END IF;

  IF current_sub.stripe_subscription_id IS DISTINCT FROM p_stripe_subscription_id
     AND current_sub.stripe_subscription_created IS NOT NULL
     AND p_stripe_subscription_created < current_sub.stripe_subscription_created THEN
    UPDATE public.stripe_webhook_events
    SET state = 'processed', processed_at = now(), updated_at = now()
    WHERE event_id = p_event_id AND state = 'processing';
    RETURN 'older_subscription';
  END IF;

  next_status := CASE
    WHEN p_stripe_status IN ('active', 'trialing')
      AND current_sub.refund_hold_subscription_id IS DISTINCT FROM p_stripe_subscription_id
      THEN p_plan
    ELSE 'free'
  END;

  UPDATE public.subscriptions
  SET status = next_status,
      stripe_customer_id = p_stripe_customer_id,
      stripe_subscription_id = p_stripe_subscription_id,
      stripe_subscription_created = p_stripe_subscription_created,
      stripe_status = p_stripe_status,
      trial_used = trial_used OR p_trial_used,
      expires_at = CASE WHEN next_status = 'free' THEN now() ELSE NULL END,
      pending_checkout_session_id = NULL,
      pending_checkout_created_at = NULL,
      checkout_reservation_id = NULL,
      checkout_reservation_plan = NULL,
      checkout_trial_reserved = false,
      checkout_reserved_at = NULL,
      latest_stripe_event_created = GREATEST(
        COALESCE(latest_stripe_event_created, p_event_created),
        p_event_created
      ),
      latest_stripe_observed_at = p_observed_at,
      refund_hold_subscription_id = CASE
        WHEN next_status IN ('pro', 'team') THEN NULL
        ELSE refund_hold_subscription_id
      END,
      refund_hold_subscription_created = CASE
        WHEN next_status IN ('pro', 'team') THEN NULL
        ELSE refund_hold_subscription_created
      END,
      refund_hold_event_created = CASE
        WHEN next_status IN ('pro', 'team') THEN NULL
        ELSE refund_hold_event_created
      END,
      refund_hold_charge_id = CASE
        WHEN next_status IN ('pro', 'team') THEN NULL
        ELSE refund_hold_charge_id
      END,
      refund_hold_at = CASE
        WHEN next_status IN ('pro', 'team') THEN NULL
        ELSE refund_hold_at
      END,
      updated_at = now()
  WHERE user_id = p_user_id;

  UPDATE public.stripe_webhook_events
  SET state = 'processed', processed_at = now(), updated_at = now()
  WHERE event_id = p_event_id AND state = 'processing';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'webhook event is not processing';
  END IF;

  RETURN 'applied';
END;
$$;

CREATE OR REPLACE FUNCTION public.apply_stripe_refund_hold(
  p_event_id TEXT,
  p_event_created BIGINT,
  p_user_id UUID,
  p_stripe_customer_id TEXT,
  p_stripe_subscription_id TEXT,
  p_stripe_charge_id TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  current_sub public.subscriptions%ROWTYPE;
BEGIN
  IF p_stripe_charge_id IS NULL OR p_stripe_charge_id = '' THEN
    RAISE EXCEPTION 'missing Stripe charge';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::TEXT, 0));

  SELECT * INTO current_sub
  FROM public.subscriptions
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription row not found';
  END IF;

  IF current_sub.stripe_customer_id IS DISTINCT FROM p_stripe_customer_id THEN
    UPDATE public.stripe_webhook_events
    SET state = 'processed', processed_at = now(), updated_at = now()
    WHERE event_id = p_event_id AND state = 'processing';
    RETURN 'customer_mismatch';
  END IF;

  IF current_sub.stripe_subscription_id IS DISTINCT FROM p_stripe_subscription_id THEN
    UPDATE public.stripe_webhook_events
    SET state = 'processed', processed_at = now(), updated_at = now()
    WHERE event_id = p_event_id AND state = 'processing';
    RETURN 'subscription_mismatch';
  END IF;

  IF current_sub.refund_hold_event_created IS NOT NULL
     AND p_event_created < current_sub.refund_hold_event_created THEN
    UPDATE public.stripe_webhook_events
    SET state = 'processed', processed_at = now(), updated_at = now()
    WHERE event_id = p_event_id AND state = 'processing';
    RETURN 'stale_refund';
  END IF;

  UPDATE public.subscriptions
  SET status = 'free',
      expires_at = now(),
      refund_hold_subscription_id = p_stripe_subscription_id,
      refund_hold_subscription_created = stripe_subscription_created,
      refund_hold_event_created = p_event_created,
      refund_hold_charge_id = p_stripe_charge_id,
      refund_hold_at = now(),
      latest_stripe_event_created = GREATEST(
        COALESCE(latest_stripe_event_created, p_event_created),
        p_event_created
      ),
      updated_at = now()
  WHERE user_id = p_user_id;

  UPDATE public.stripe_webhook_events
  SET state = 'processed', processed_at = now(), updated_at = now()
  WHERE event_id = p_event_id AND state = 'processing';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'webhook event is not processing';
  END IF;

  RETURN 'refund_hold_applied';
END;
$$;

CREATE OR REPLACE FUNCTION public.apply_stripe_entitlement_noop(p_event_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.stripe_webhook_events
  SET state = 'processed', processed_at = now(), updated_at = now()
  WHERE event_id = p_event_id AND state = 'processing';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'webhook event is not processing';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.begin_checkout(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.attach_checkout_customer(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_checkout_reservation(UUID, UUID, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.begin_stripe_webhook_event(TEXT, TEXT, BIGINT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_stripe_webhook_event(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_stripe_entitlement(TEXT, BIGINT, TIMESTAMPTZ, UUID, TEXT, TEXT, BIGINT, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_stripe_refund_hold(TEXT, BIGINT, UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_stripe_entitlement_noop(TEXT) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.begin_checkout(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.attach_checkout_customer(UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_checkout_reservation(UUID, UUID, TEXT, BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION public.begin_stripe_webhook_event(TEXT, TEXT, BIGINT) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_stripe_webhook_event(TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_stripe_entitlement(TEXT, BIGINT, TIMESTAMPTZ, UUID, TEXT, TEXT, BIGINT, TEXT, TEXT, BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_stripe_refund_hold(TEXT, BIGINT, UUID, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_stripe_entitlement_noop(TEXT) TO service_role;

-- Existing subscribers have already consumed trial eligibility. This also
-- covers canceled legacy customers whose prior status is retained in Stripe.
UPDATE public.subscriptions
SET trial_used = true
WHERE stripe_customer_id IS NOT NULL
   OR stripe_subscription_id IS NOT NULL
   OR status IN ('pro', 'team');
