# C5 Follow-up: Move Deepgram Auth Off the Renderer

> September 15, 2026: the fix branch uses short-lived Deepgram grants. See the [migration runbook](BACKEND_SECURITY_MIGRATION_2026-09-15.md) and [fix ledger](SECURITY_ARCHITECTURE_FIXES_2026-09-15.md). A metered relay remains future work; issuance quotas do not enforce audio-minute limits. The design below is retained as historical planning.

Implementation plan for the 2026-04-16 audit's § C5 follow-up. Targets
**v1.0.8**, not v1.0.7 (the in-flight launch should not absorb a hot-path
auth-flow change).

## Goal

The renderer / Tauri backend currently holds a long-lived Deepgram API key
fetched from Supabase's `managed_api_keys` table. C5 in the prior audit
identified this as a structural risk: any XSS or process compromise on the
client exposes the key. This plan replaces it with Deepgram's ephemeral
token flow so the master key never leaves the server.

## Architecture

### Today

```
renderer ──fetch managed_api_keys.deepgram_key──▶ Supabase
   │
   └─ passes long-lived key to Tauri
         │
         └─ wss://api.deepgram.com (Authorization: Token <master_key>)
```

The master key sits in the renderer's React state, in the Tauri AppState
mutex, and in the database row, for the lifetime of the subscription.

### After

```
renderer ──Bearer <supabase_jwt>──▶ Netlify /deepgram-token
                                         │
                                         └─ POST /v1/auth/grant
                                              (master key, server-side only)
                                              returns 30s JWT
                                              │
renderer ◀─────────────── { access_token, expires_in } ─────────────────┘
   │
   └─ passes JWT to Tauri
         │
         └─ wss://api.deepgram.com (Authorization: Bearer <jwt>)

Connection persists for normal session length. Token only needs to be
valid at the WebSocket handshake.
```

`managed_api_keys.deepgram_key` becomes a legacy field (kept for one
release for backward compat, removed in v1.0.9).

## Verified Deepgram facts (2026-05-10)

- **Endpoint:** `POST https://api.deepgram.com/v1/auth/grant`
- **Auth on grant call:** `Authorization: Token <master_key>` (Member-or-higher key)
- **Request body:** `{ "ttl_seconds": <optional int> }` (default 30)
- **Response body:** `{ "access_token": "<JWT>", "expires_in": <seconds> }`
- **Token scope:** `usage::write` for core voice APIs (covers `/v1/listen`
  streaming + batch). Does not work for the Manage API.
- **WebSocket persistence:** "You only need the temporary token to be valid
  during the initial websocket connection. The websocket connection will
  then stay open as it would in any other case until you close it."
  Source: `developers.deepgram.com/guides/fundamentals/token-based-authentication`
- **WebSocket auth header:** `Authorization: Bearer <jwt>` (not `Token`).
  Existing Rust code at `src-tauri/src/deepgram_ws.rs:112` uses `Token`
  prefix; this must change for the JWT path.

## Phase 1: Netlify token endpoint

**New file:** `netlify/functions/deepgram-token.ts`

Mirrors the existing `deepgram-proxy.ts` for auth / subscription / rate-limit
plumbing, but body is a Deepgram grant call instead of a forwarded transcription:

```typescript
// Pseudocode skeleton — match deepgram-proxy.ts patterns 1:1 for auth/CORS.
export const handler: Handler = async (event) => {
  // 1. CORS allowlist check (copy from deepgram-proxy.ts)
  // 2. OPTIONS / method gate
  // 3. Auth: extract Bearer JWT, supabase.auth.getUser(token)
  // 4. Subscription gate: ['pro', 'team']
  // 5. Rate limit: per-user, service='deepgram_token', re-use api_usage table
  //    (allow ~10/hour — one token per dictation session)
  // 6. Mint token:
  const dgResp = await fetch('https://api.deepgram.com/v1/auth/grant', {
    method: 'POST',
    headers: {
      Authorization: `Token ${process.env.DEEPGRAM_MANAGED_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ttl_seconds: 30 }),
  })
  // 7. Forward access_token + expires_in to caller
}
```

**Why a separate function and not a mode flag on deepgram-proxy.ts:**
the existing proxy validates audio content type, audio size, and Deepgram
query params. A token endpoint has none of that surface area; splitting
keeps each function's contract small.

**Rate limit choice:** users start one dictation session per hotkey press.
10 tokens/hour is generous for normal use but caps cost-abuse if a credential
leaks. The existing 300 tokens/hour `deepgram` rate limit in
`deepgram-proxy.ts` is for batch transcription size, not session count, and
should not be shared.

## Phase 2: Rust + renderer changes

### 2a. New IPC command `deepgram_token_fetch`

**File:** `src-tauri/src/commands.rs`

```rust
#[tauri::command]
pub async fn deepgram_token_fetch(supabase_jwt: String) -> Result<String, String> {
    // POST to https://${SITE_URL}/.netlify/functions/deepgram-token
    // with Authorization: Bearer <supabase_jwt>.
    // Returns access_token on success; the renderer caller is responsible
    // for using it immediately (within the 30 s TTL window).
}
```

Register in `src-tauri/src/lib.rs` next to the existing commands.

### 2b. Modify `deepgram_start`

**File:** `src-tauri/src/commands.rs` (around line 297)

Currently takes `api_key: String` from the renderer. Change to take the
ephemeral JWT (rename parameter to `auth_token` to make the lifetime
explicit, but keep the type as `String`).

### 2c. Modify `deepgram_ws::start_session`

**File:** `src-tauri/src/deepgram_ws.rs:112`

```rust
// Before:
HeaderValue::from_str(&format!("Token {api_key}"))

// After:
HeaderValue::from_str(&format!("Bearer {auth_token}"))
```

Update the parameter name in the function signature and the doc comment.

### 2d. Renderer changes

**File:** `src/renderer/hooks/useDeepgram.ts` (or wherever the current key
fetch lives)

Replace the `managed_api_keys.deepgram_key` read with:
1. Get current Supabase session.
2. Call `invoke('deepgram_token_fetch', { supabase_jwt: session.access_token })`.
3. Pass the returned ephemeral JWT into `invoke('deepgram_start', { auth_token: ... })`.

Do this on every `deepgram_start` call, not once at app launch. The token
expires after 30 s.

### 2e. Batch path

**File:** `src-tauri/src/commands.rs:recording_stop` (around line 451)

Same swap: fetch ephemeral token, use `Bearer <jwt>` instead of `Token <key>`.
The batch endpoint accepts the same JWT.

## Phase 3: Cleanup

After Phase 2 ships:

- Leave `managed_api_keys.deepgram_key` populated for one release so the
  Electron-build fallback continues working. Mark the column as deprecated
  with a comment.
- Stop reading `managed_api_keys.deepgram_key` from the renderer
  (`getManagedKeys` should return `{ hasManagedKeys, anthropicKey: null,
  deepgramKey: null }`).
- In v1.0.9: drop the column, remove the provisioning code in
  `supabase/functions/stripe-webhook`, remove the read paths.

## Test plan

### Unit / integration

- `netlify/functions/deepgram-token.test.ts` (new): JWT-rejection, sub-gate,
  rate-limit, successful mint. Mirrors the structure of the existing
  `deepgram-proxy.test.ts`.
- `src-tauri/src/deepgram_ws.rs` tests: add a header-format test asserting
  the `Bearer` prefix on the Authorization header.

### Manual smoke

1. Local dev (`netlify dev` + `npm run tauri dev`) with `VITE_DEV_MODE=true`:
   verify the token endpoint returns a JWT and dictation works.
2. Pro account on staging: verify the renderer never touches
   `managed_api_keys.deepgram_key`; verify mid-session token expiry doesn't
   close the WebSocket; verify a re-record (new session) mints a new token.
3. Network throttle test: artificially delay the token fetch by 5 s, verify
   the dictation UX surfaces a "starting" state rather than hanging silently.

### Regression

- Test all 20 languages still transcribe correctly.
- Test keyword boost (`keyterm` param) still works.
- Test streaming + batch modes both work.

## Open questions

1. **Rate limiting on `/v1/auth/grant`** — does Deepgram throttle grant calls?
   Probably yes, but the docs don't specify. Mitigation: our per-user rate
   limit caps grant volume at the client side.
2. **Multi-window timing** — the settings window also opens a Deepgram
   connection for the test-mic feature (if I remember right). Each window
   would mint its own token. Should be fine but worth confirming during
   manual smoke testing.
3. **Anthropic parity** — the Claude proxy doesn't have this problem because
   the master key never leaves the Netlify function. Should we delete the
   `managed_api_keys.anthropic_key` column at the same time? It's already
   unused in the renderer (per H16). Probably yes; folds into the same
   migration.

## Estimated effort

- Phase 1 (Netlify function + tests): ~1.5 hours
- Phase 2 (Rust + renderer + tests): ~2 hours
- Phase 3 (cleanup, deferred to v1.0.9): ~0.5 hours
- Manual smoke + clean-VM verification: ~1 hour

Total active work: ~4.5 hours plus normal release-checklist time.

## Rollout

- Land behind a feature flag (`VITE_DEEPGRAM_EPHEMERAL=true`) for one beta
  cycle. Renderer reads the flag and picks the old (managed-keys) or new
  (ephemeral) path.
- After a clean week of beta data, flip the flag default to `true` and
  delete the old path in the next release.

## References

- Deepgram auth docs: `https://developers.deepgram.com/guides/fundamentals/token-based-authentication`
- Grant endpoint: `https://developers.deepgram.com/reference/auth/tokens/grant`
- Prior audit C5: `docs/SECURITY_AUDIT_2026-04-16.md` § C5
- Existing proxy patterns: `netlify/functions/deepgram-proxy.ts`, `netlify/functions/claude-proxy.ts`
- Existing streaming code: `src-tauri/src/deepgram_ws.rs`
