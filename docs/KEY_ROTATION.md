# Managed Provider Key Rotation

MacroVox keeps provider master keys only in Netlify environment variables.
Subscribers receive a short-lived Deepgram grant and never receive either
master key. Treat every key previously stored in `managed_api_keys` as
compromised, even if no misuse is visible.

## Preconditions

Do not rotate until the server, database, and desktop cutover described in
`BACKEND_SECURITY_MIGRATION_2026-09-15.md` is ready. Version 1.0.8 reads the
legacy shared Deepgram key and does not mount its updater. Clearing the table or
revoking the old key cuts those clients off until users manually install the
fixed release. There is no secret fallback for old clients.

Apply migration `202609150001_backend_security_baseline.sql` before enabling
`deepgram-grant` in production. That migration is what lets `api_usage.service`
accept `'deepgram_grant'`; enabling the function against an older schema means
every quota-reservation insert violates the CHECK constraint, `reserve_api_quota`
raises, and the function fails closed on every call rather than just rate
limiting late. Confirmed by `netlify/functions/__tests__/api-usage-services.test.ts`,
which fails if a function ever logs a service value the live constraint rejects.

## Rotation order

1. Create replacement Anthropic and Deepgram keys in their provider consoles.
   Give the Deepgram key only the scope required to mint temporary grants and
   use the voice APIs.
2. Set `ANTHROPIC_MANAGED_KEY` and `DEEPGRAM_MANAGED_KEY` in Netlify. Do not put
   either value in a `VITE_` variable or a Supabase user-readable row.
3. Deploy `claude-proxy` and `deepgram-grant`, then smoke-test both with a test
   subscriber. Confirm the token response has `Cache-Control: no-store` and a
   short expiry.
4. Release the desktop client that requests a fresh Deepgram grant immediately
   before each managed batch or WebSocket request. Confirm BYOK requests still
   use the user's own key.
5. Apply migration `202609150002_remove_managed_provider_keys.sql`. It clears
   legacy stored values, removes the old read policy, and revokes client table
   grants.
6. Require users on version 1.0.8 to install the fixed release manually before
   the old Deepgram key is revoked.
7. Revoke both old provider keys. Monitor provider usage and Netlify token
   issuance for unexpected traffic.

## Verification

Check that no tracked source or built renderer contains either old value or a
recognizable prefix. Confirm an authenticated subscriber cannot select from
`managed_api_keys`. Confirm a free account cannot mint a grant, an entitled
account can mint one, and a quota storage failure returns 503 without calling
the provider.

## Local `.env`

```
ANTHROPIC_MANAGED_KEY=<new anthropic key>
DEEPGRAM_MANAGED_KEY=<new deepgram key>
VITE_ANTHROPIC_KEY=<new anthropic key>
VITE_DEEPGRAM_KEY=<new deepgram key>
```

Restart `netlify dev` and any open `python run.py` so they pick up the new
values. `.env` is gitignored, so this stays local.

## Verifying old keys are gone

- Confirm the old key values appear nowhere in the working tree:
  ```powershell
  # Replace <prefix> with the first 12 chars of each old key from .env
  # before rotating them out.
  git grep -F '<old-anthropic-prefix>'
  git grep -F '<old-deepgram-prefix>'
  ```
  Both should return empty.
- Run trufflehog locally:
  ```powershell
  trufflehog filesystem . --only-verified
  ```
  Expected: no findings. If the old keys still verify, something held a
  copy you missed.

## Limits this rotation does not cover

Temporary grant expiry limits when a new Deepgram connection can be opened. It
does not terminate an already authenticated WebSocket and does not enforce
audio minutes. Issuance quotas cap connection creation only. Provider-side
usage limits and monitoring remain necessary.
