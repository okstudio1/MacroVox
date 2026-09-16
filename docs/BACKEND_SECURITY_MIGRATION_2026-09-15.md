# Backend Security Migration, 2026-09-15

This change removes subscriber access to shared provider credentials, makes
quota reservation atomic, prevents repeat trials under concurrent checkout,
and makes Stripe entitlement updates retryable and order-aware. It does not
deploy functions, apply migrations, rotate keys, or modify production data.

**Client release gate:** this intermediate branch does not yet request managed Deepgram grants. Explicit authorization for sending the sign-in token to the existing backend is pending. BYOK is the working client speech path. Complete that wiring and its tests before rollout step 6 or either provider-key rotation. See the [fix ledger](SECURITY_ARCHITECTURE_FIXES_2026-09-15.md) for current status.

## Runtime contracts

`POST /.netlify/functions/deepgram-token` requires an allowed Origin, a valid
Supabase bearer token, and a `pro` or `team` subscription. It atomically
reserves one `deepgram_token` quota unit, then calls Deepgram's grant endpoint
with the server key. A successful response is:

```json
{"access_token":"short-lived value","expires_in":30}
```

Responses use `Cache-Control: no-store`. Managed clients must mint a fresh
grant immediately before each Deepgram request and authenticate with `Bearer`.
BYOK clients continue authenticating their own key with `Token`.

The 30 second grant lifetime controls the connection handshake. Deepgram does
not terminate an active WebSocket when that grant expires. The hourly issuance
quota therefore limits connection creation, not transcription minutes.

Claude and the legacy audio proxy call `reserve_api_quota`. The database takes
a transaction-scoped advisory lock, counts the current window, and inserts the
reservation in one transaction. Storage errors return 503 and do not call the
provider.

## Billing model

Checkout maps `pro` and `team` to server-configured Stripe Price IDs. The
webhook independently derives the plan from the current Stripe subscription's
price. Client metadata never decides entitlement.

`begin_checkout` serializes checkout for a user, reserves trial eligibility
before the external Stripe call, and returns the same durable reservation to
concurrent retries. Stripe idempotency keys use that reservation. A reserved
trial is treated as consumed even if the user abandons checkout. This is the
intentional fail-safe tradeoff that prevents repeated trial sessions.

The stored Stripe Customer is reused. Existing users with any Stripe customer,
subscription, or paid entitlement are backfilled with `trial_used = true`.
Before migration, reconcile users that exist in Stripe but lack both database
identifiers, otherwise the database cannot recognize their prior trial.

Webhook event IDs are reserved before processing. Duplicate and concurrent
deliveries cannot both claim the event. Each relevant event lists current
subscriptions for the customer, verifies configured prices, chooses the newest
active or trialing subscription, and applies the snapshot in one database
transaction. Event creation time, observation time, and subscription creation
time prevent a delayed older snapshot or an old duplicate subscription from
overwriting newer state. The transaction also requires the event Customer to
match the durable Customer binding. An empty current Stripe subscription list
fails closed instead of trusting an older event payload. Database failures
return non-2xx so Stripe retries.

Full and partial `charge.refunded` events preserve the established entitlement
revocation policy without canceling a Stripe subscription. The handler resolves
the charge invoice to a subscription, then records a durable refund hold only
when the Customer and subscription match the current database binding. A refund
for an old Customer or old subscription cannot revoke a newer purchase. Later
updates for the refunded subscription cannot restore access. A verified new
subscription clears the hold. The webhook event ledger and stored charge,
subscription, and event identifiers provide the audit record.

## Preflight

Run these read-only checks before applying migrations:

```sql
SELECT stripe_customer_id, count(*)
FROM public.subscriptions
WHERE stripe_customer_id IS NOT NULL
GROUP BY stripe_customer_id
HAVING count(*) > 1;

SELECT stripe_subscription_id, count(*)
FROM public.subscriptions
WHERE stripe_subscription_id IS NOT NULL
GROUP BY stripe_subscription_id
HAVING count(*) > 1;

SELECT user_id, status, stripe_customer_id, stripe_subscription_id
FROM public.subscriptions
WHERE status IN ('pro', 'team')
  AND (stripe_customer_id IS NULL OR stripe_subscription_id IS NULL);
```

Resolve every result deliberately against Stripe before creating the unique
indexes. For a user with multiple historical Customers, choose the Customer
that owns the current active subscription. Do not let an event from an older
Customer replace that binding.

## Rollout order

### Windows app origin

Windows uses `http://tauri.localhost` by default because this application does
not override Tauri's `useHttpsScheme` setting. The hosted Claude proxy,
Deepgram proxy, Deepgram token broker, checkout, and billing portal allowlists
include that exact origin. Lookalike origins remain rejected, and all remote
service destinations continue to use HTTPS.

Do not change `useHttpsScheme`. Changing it moves the webview origin and can
relocate local storage and cookies, which can reset saved settings.

1. Back up the database and run the preflight queries.
2. Configure `STRIPE_PRO_PRICE_ID`, optional `STRIPE_TEAM_PRICE_ID`, and
   `SITE_URL` in Supabase. The legacy `STRIPE_PRICE_ID` is accepted only as a
   Pro fallback during transition.
3. Configure the Supabase URL, service role key, Anthropic key, Deepgram key,
   and optional `DEEPGRAM_TOKEN_RATE_LIMIT` in Netlify.
4. Apply `202609150001_backend_security_baseline.sql`.
5. Deploy checkout, portal, webhook, Claude proxy, and Deepgram token changes.
6. Deploy the desktop client and verify managed and BYOK paths.
7. Apply `202609150002_remove_managed_provider_keys.sql`.
8. Tell version 1.0.8 users to install the fixed client manually. Its updater is
   not mounted, and removing the shared key intentionally breaks its managed
   Deepgram path.
9. Rotate both provider master keys by following `KEY_ROTATION.md`.

Do not apply the secret-removal migration before the fixed desktop release is
available. Do not preserve a shared-key fallback for old clients.

## Checks

From the repository root:

```powershell
deno task --config supabase/deno.json check
deno task --config supabase/deno.json test
npx vitest run --config vitest.config.ts netlify/functions/__tests__
npx tsc -p config/tsconfig.functions.json --noEmit
```

Database assertions live in `supabase/tests/assertions.sql`. The CI database
harness applies all migrations to PostgreSQL 16, checks grants and state
transitions, and drives concurrent quota, checkout, and webhook reservations.
The same harness passed against an isolated local PostgreSQL 17.11 cluster. It
verified legacy key quarantine and RLS, allowed exactly one reservation for 25
concurrent quota calls with one slot left, returned one reservation ID for 10
concurrent checkout calls, and allowed one processor for 10 concurrent claims
of the same webhook event.
