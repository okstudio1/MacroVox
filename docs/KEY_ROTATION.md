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

## Rotation order

1. Create replacement Anthropic and Deepgram keys in their provider consoles.
   Give the Deepgram key only the scope required to mint temporary grants and
   use the voice APIs.
2. Set `ANTHROPIC_MANAGED_KEY` and `DEEPGRAM_MANAGED_KEY` in Netlify. Do not put
   either value in a `VITE_` variable or a Supabase user-readable row.
3. Deploy `claude-proxy` and `deepgram-token`, then smoke-test both with a test
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

Temporary grant expiry limits when a new Deepgram connection can be opened. It
does not terminate an already authenticated WebSocket and does not enforce
audio minutes. Issuance quotas cap connection creation only. Provider-side
usage limits and monitoring remain necessary.
