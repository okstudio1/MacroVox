-- Stop `managed_api_keys` from being able to serve a secret to a client, and
-- let the deepgram-grant function's rate limiting actually record.
--
-- Background. `managed_api_keys` held one shared DEEPGRAM_MANAGED_KEY and one
-- shared ANTHROPIC_MANAGED_KEY, copied in per subscriber by the stripe-webhook,
-- with this policy on the table:
--
--     CREATE POLICY "Users read own keys" ON managed_api_keys
--       FOR SELECT USING (auth.uid() = user_id);
--
-- RLS in Postgres is row-level. A policy that lets a user read their own row
-- lets them read every column in it, so any signed-in Pro user could select
-- `deepgram_key` with their own session and walk off with the shared vendor
-- credential. The renderer was changed to stop asking for it, which is worth
-- doing and is not the fix: what the client chooses to select has never been a
-- trust boundary.
--
-- Deploy order matters. Ship the app change that reads entitlement from
-- `subscriptions` (auth.ts::hasManagedTranscription) BEFORE running this, or
-- clients still asking `managed_api_keys` for a row will see none and disable
-- dictation for every paying user.
--
-- Nulling the columns here does NOT rotate anything. Every managed Deepgram key
-- handed out before this is compromised and has to be revoked in the Deepgram
-- console: it sat in a desktop process on every Pro and Team machine, and
-- anyone who kept a copy still has it. See docs/KEY_ROTATION.md.

-- 1. The rate limiter on deepgram-grant has to be able to write ---------------
-- The function logs `service = 'deepgram_grant'`, which the original CHECK
-- rejects, and the insert is fire-and-forget behind a console.error. So every
-- call failed to record, the hourly count sat at zero for ever, and the limit
-- never triggered. A rate limiter that cannot write is not a rate limiter, and
-- this one fails open. Guarded going forward by
-- netlify/functions/__tests__/api-usage-services.test.ts.

ALTER TABLE api_usage DROP CONSTRAINT IF EXISTS api_usage_service_check;
ALTER TABLE api_usage ADD CONSTRAINT api_usage_service_check
  CHECK (service IN ('claude', 'deepgram', 'deepgram_grant'));

-- 2. Take the keys out of the rows -------------------------------------------
-- The columns stay for now rather than being dropped, so this migration is
-- reversible and cannot break a consumer nobody remembered. Dropping them is
-- the tidy follow-up once the deploy has settled: a column that is never read
-- is a column that leaks the next time somebody writes `select *`.

UPDATE managed_api_keys SET deepgram_key = NULL, anthropic_key = NULL;

-- 3. Remove the read path -----------------------------------------------------
-- This is the control. RLS stays enabled with no SELECT policy, which denies
-- the `authenticated` role by default. Entitlement now comes from
-- `subscriptions`, which has a policy of its own and carries no secret. The
-- service role used by the Netlify and Edge functions bypasses RLS and is
-- unaffected.

DROP POLICY IF EXISTS "Users read own keys" ON managed_api_keys;

-- 4. Belt and braces at the column level --------------------------------------
-- Step 3 is what closes the hole. This is what stops a future "users should be
-- able to see their own row" policy from quietly reopening it, because a column
-- grant is checked independently of any policy. Whoever adds that policy gets a
-- permission error naming the column instead of a working key.

REVOKE SELECT (deepgram_key, anthropic_key) ON managed_api_keys FROM authenticated;
REVOKE SELECT (deepgram_key, anthropic_key) ON managed_api_keys FROM anon;

-- Verify ----------------------------------------------------------------------
--   SELECT count(*) FILTER (WHERE deepgram_key IS NOT NULL) AS deepgram_left,
--          count(*) FILTER (WHERE anthropic_key IS NOT NULL) AS anthropic_left
--   FROM managed_api_keys;                         -- both must be 0
--
--   SELECT polname FROM pg_policy
--   WHERE polrelid = 'managed_api_keys'::regclass; -- must return no rows
--
-- Then confirm it from the outside rather than only in the schema. Signed in as
-- a Pro user, in the browser console:
--   await supabase.from('managed_api_keys').select('deepgram_key')
--   -- expected: no rows, not a key
