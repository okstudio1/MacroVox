# Anthropic + Deepgram Key Rotation Runbook

Carryover from the 2026-04-16 security audit (C2). The dev mirrors of the
managed Anthropic and Deepgram keys were treated as compromised because
they were committed to memory, surfaced in audit docs, and pasted into
multiple chat transcripts. Trufflehog still verifies them as live, so
rotation is still required.

This runbook covers every place a copy of the key needs to be replaced.
Do them in order. Steps 1 + 2 each have a window between "old key
revoked" and "new key everywhere" where some users will see auth failures
on the proxy. To keep that window short, generate the new key first, then
revoke the old one only after every consumer has the new value.

The current compromised values are the `ANTHROPIC_MANAGED_KEY` and
`DEEPGRAM_MANAGED_KEY` in your local `.env`. Keep that file open while
you work through this runbook so you can grep for the old values in
step 8.

---

## 1. Rotate the Anthropic key

1. Go to [console.anthropic.com](https://console.anthropic.com/settings/keys).
2. Click **Create Key**. Name it something like
   `macrovox-managed-2026-05-10`. Copy the new value to a password
   manager immediately, you cannot view it again after this screen.
3. Do **not** revoke the old key yet. Leave it active until step 5
   confirms every consumer is updated.

## 2. Rotate the Deepgram key

1. Go to [console.deepgram.com](https://console.deepgram.com/project/_/keys).
2. Click **Create a New API Key**. Scopes: same as the existing
   managed key. Project: same.
3. Copy the new value to a password manager.
4. Do **not** delete the old key yet.

## 3. Update Netlify environment variables

The deployed proxies read these on every request, so this is the
production-impact step.

1. Go to Netlify dashboard for the MacroVox site.
2. **Site settings > Environment variables**.
3. Update:
   - `ANTHROPIC_MANAGED_KEY` to the new Anthropic value.
   - `DEEPGRAM_MANAGED_KEY` to the new Deepgram value.
4. Trigger a redeploy (or wait for the next push). Netlify functions
   re-read env vars on cold start, so an explicit redeploy is the
   safest way to pick up the change immediately.
5. Smoke-test the proxy:
   ```powershell
   # From the local dev build, signed in as a Pro user:
   # post-processing should succeed (claude-proxy).
   # dictation should transcribe (deepgram-grant issues the token;
   # the renderer never sees DEEPGRAM_MANAGED_KEY).
   ```

## 4. Update Supabase Edge Function secrets

The stripe-webhook reads these to provision `managed_api_keys` rows on
subscription create/renew. Existing Pro users already have the old key
in the table, which step 5 below handles.

```powershell
# Requires supabase CLI logged in and linked to the project.
supabase secrets set ANTHROPIC_MANAGED_KEY=<new anthropic key>
supabase secrets set DEEPGRAM_MANAGED_KEY=<new deepgram key>

# Verify:
supabase secrets list | findstr MANAGED_KEY
```

No function redeploy needed: Deno picks the new secret up on the next
cold start. If you want to force it:

```powershell
supabase functions deploy stripe-webhook
```

## 5. Update existing managed_api_keys rows

> **Deepgram changed, 2026-09-03.** The renderer no longer reads
> `deepgram_key` at all. Streaming and batch both resolve a short-lived
> token from the `deepgram-grant` function, which holds
> `DEEPGRAM_MANAGED_KEY` server-side. The row is now an entitlement
> marker and nothing more.
>
> Two consequences for a rotation:
>
> 1. `deepgram_key` in this table no longer needs updating for clients to
>    work. Setting it to `NULL` is the tidier move, because a column that
>    is never read is a column that leaks the next time someone selects
>    `*`.
> 2. **Every managed Deepgram key handed out before that date is
>    compromised** and has to be revoked in the Deepgram console, not just
>    replaced here. It sat in a desktop process on every Pro and Team
>    machine, and anyone who kept a copy still has it. Rotating the env var
>    without revoking the old key leaves it working.
>
> The Anthropic column was never read by the renderer, so nothing about it
> changes.

Nothing to update, and nothing to write here. Neither key column is read
by anything any more, and both are revoked from the `authenticated` role
and nulled by
`supabase/migrations/20260905_managed_keys_stop_serving_secrets.sql`.

**Do not put the new key in this table.** Writing it back is the one step
that would undo the fix: the column has no reader, so a value in it can
only ever be something for an attacker to find. The new keys belong in the
Netlify environment (step 3) and the Supabase secrets (step 4), and nowhere
else.

Confirm the columns are still empty after a rotation:

```sql
SELECT
  count(*) FILTER (WHERE anthropic_key IS NOT NULL) AS anthropic_left,
  count(*) FILTER (WHERE deepgram_key  IS NOT NULL) AS deepgram_left,
  count(*) AS total
FROM managed_api_keys;
```

Both `*_left` counts must be `0`. If either is not, something wrote a key
back: find it before continuing, because step 7 revokes the old key and the
row would then hold the only copy of a credential nothing reads.

## 6. Update local `.env`

```
ANTHROPIC_MANAGED_KEY=<new anthropic key>
DEEPGRAM_MANAGED_KEY=<new deepgram key>
VITE_ANTHROPIC_KEY=<new anthropic key>
VITE_DEEPGRAM_KEY=<new deepgram key>
```

Restart `netlify dev` and any open `npm run tauri dev` so they pick up
the new values. `.env` is gitignored, so this stays local.

## 7. Revoke the old keys

Only after steps 3 through 6 are confirmed:

1. **Anthropic console**: delete the old `sk-ant-api03-...` key (the one
   that matches the value previously in `.env`).
2. **Deepgram console**: delete the old key (the 40-char hex value
   previously in `.env`).

## 8. Verify

- Hit the proxy from production once more, confirm 200s.
- Confirm the old key values appear nowhere in the working tree:
  ```powershell
  # Replace <prefix> with the first 12 chars of each old key from .env
  # before rotating them out.
  git grep -F '<old-anthropic-prefix>'
  git grep -F '<old-deepgram-prefix>'
  ```
  Both should return empty after step 6.
- Run trufflehog locally:
  ```powershell
  trufflehog filesystem . --only-verified
  ```
  Expected: no findings. If the old keys still verify, something held a
  copy you missed.

## 9. Close out

- Mark C2 in `docs/SECURITY_AUDIT_2026-04-16.md` as fully fixed (it is
  currently "Partially mitigated, partially reverted by request").
- Either delete this runbook or leave it for the next rotation. Either
  is fine: it deliberately contains no key material.
