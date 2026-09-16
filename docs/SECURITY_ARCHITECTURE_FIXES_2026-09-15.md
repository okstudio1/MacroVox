# Security, architecture, and dictation fixes

Date: September 15, 2026. Base: `2e96786`. Branch: `fix/security-dictation-20260915`. Version: 1.0.9, unreleased.

## Scope and status

**Client wiring complete:** the client request that sends the Supabase sign-in token to the existing `macrovox.tech` backend for a temporary Deepgram grant is implemented (`lib/deepgramCredential.ts` calls `deepgram-grant`; the Rust side takes the resulting tagged `DeepgramCredential` in `deepgram_ws.rs`). Shared-key reads are removed. BYOK and managed speech are both testable paths. The exact Windows-origin CORS correction was separately approved and is complete.

This work follows the [security and architecture review](SECURITY_ARCHITECTURE_REVIEW_2026-09-15.md) and [speech cutoff investigation](DICTATION_CUTOFF_AND_LATENCY_REVIEW_2026-09-15.md). The original checkout and its unrelated changes are separate from this worktree.

The release requires coordinated native-client and hosted-backend changes. A source fix is not a production deployment. Database migration, provider-key rotation, signed installation, real microphone tests, and production latency measurement remain explicit release gates. Follow the [backend migration runbook](BACKEND_SECURITY_MIGRATION_2026-09-15.md) before enabling managed transcription on the new client.

## Finding-to-fix ledger

Numbers refer to the baseline review. Tests are described by behavior so they remain useful when file line numbers change.

| Finding | Implementation | Verification and limits |
| --- | --- | --- |
| 1. Shared provider keys readable by subscribers | Remove client key-table reads and webhook key provisioning. Quarantine legacy key storage. The temporary-grant endpoint and its client routing are both implemented. Managed Claude remains server-side. | Grant endpoint rejects unauthenticated/unentitled callers, reserves quota atomically, returns only temporary grants with `no-store`. Rotation and deployed permission checks remain required. |
| 2. Repeated trials and duplicate checkout | Durable Stripe customer binding, checkout reservation and idempotency, trial eligibility in PostgreSQL, active-subscription rejection, verified price mapping. | Billing helper and SQL state tests; concurrent checkout harness. Test-mode Stripe checkout and legacy customer reconciliation are release gates. |
| 3. Quotas race and fail open | `reserve_api_quota` counts and inserts under one transaction-scoped lock; callers await it and deny requests on storage failure. Validate requests before reservation. | Handler/helper error tests and 25 simultaneous requests for one remaining slot in the database CI harness. Request reservations count attempted upstream calls, including provider failures. |
| 4. Webhook failures acknowledged; stale state | Persist event claims, reconcile current Stripe subscriptions, atomically apply verified entitlement and event completion, reject stale/customer-mismatched state, and propagate storage failures. Preserve refund revocation with a durable hold scoped to the affected current subscription. | Billing/SQL replay, ordering, old-customer rejection, refund-hold, and re-subscription tests. Stripe test-mode retries and recovery still require staging verification. |
| 5. Clipboard failure pastes old content | Require successful clipboard write before native paste or success feedback. | Renderer clipboard-failure regression; no scripted desktop paste was run. |
| 6. Elevated HKCU command execution | Installer no longer reads or executes the per-user UninstallString. It informs users that an older per-user installation can be removed through Windows Settings. | Source review. Existing per-user installation is retained; clean-VM elevated installer testing remains required. |
| 7. Split recording lifecycle and early Stop | Session-aware streaming finalization returns authoritative text; common renderer stop path for button, hotkey, and timer; capture closes on stop or failure. | Delayed-final, timeout, startup event ordering, stale-session, concurrent ownership transition, and unified stop regressions. Real device/network smoke tests remain required. |
| 8. Late cleanup overwrites newer work | Cleanup cancellation plus session/transcript revision checks protect the current UI and clipboard. | Deferred cleanup regressions for edits and newer recordings. Text already pasted into another app is not rewritten by cleanup. |
| 9. Stale account state | Subscribe to auth changes in both webviews, reject stale account loads, and clear managed account state on sign-out. | Auth and renderer tests. BYOK remains available independently of managed sign-in. |
| 10. History mutation races and hidden deletion failures | Serialize full history operations including repair; keep failed deletions visible; move encoding/file work off the asynchronous command path. | Concurrent history mutation, deletion failures, and clear-during-pending-save regressions; a captured history epoch prevents cleared recordings from reappearing. Local filesystem permissions/locks still need native smoke coverage. |
| 11. Conflicting CSP blocks supported flows | Tauri configuration is the sole production policy. Permit explicit Anthropic connections and `data:` audio; remove HTML meta policies. | CSP contract tests and renderer build. A packaged WebView must exercise BYOK cleanup and playback before release. |
| 12. Updater never mounted | Mount update notice once in the dictation window, with explicit install/restart and retry controls. | Renderer mounting tests/build. Version 1.0.8 must upgrade manually; signed artifact verification is a release gate. |
| 13. Dead default build and incomplete CI | Default scripts run Tauri; typecheck Netlify and renderer, check Deno, run Rust tests/lint, build contracts, database concurrency, and dependency audits. | Local check results below. PostgreSQL integration passed locally on an isolated 17.11 server; CI provisions PostgreSQL 16. |
| 14. Fixed sample count truncates higher-rate input | Derive capacity from actual sample rate/channels and report the cap instead of silently discarding a normal 60-second recording. | Native tests include 48 kHz stereo duration/cap behavior. UI cutoff can be disabled; a bounded native memory limit still applies. |

## Additional integration correction

Final review also found that hosted CORS allowlists omitted the installed Windows webview's default origin, `http://tauri.localhost`. With explicit approval, all five hosted handlers now allow that exact local origin while retaining the existing origins and rejecting lookalikes. Provider requests still use HTTPS. The application's origin setting stays unchanged because switching it would relocate stored sessions and settings. This was verified against the installed Tauri source and the [Tauri configuration reference](https://v2.tauri.app/reference/config/#usehttpsscheme).

## Speech behavior and latency

The reproduced streaming failure copied `Please send the` before a delayed final event delivered `Please send the final report`. Finalization now owns the result returned to downstream copy, cleanup, and history consumers. Deepgram's `CloseStream` flushes pending audio and is followed by final results/metadata; closing the socket immediately after sending it is incorrect. See [Deepgram CloseStream](https://developers.deepgram.com/docs/close-stream).

Waiting for the real final result can make Stop visibly take longer than the defective early-return path. It is necessary to retain final words. AI cleanup remains asynchronous and separate from speech finalization. HTTP connection reuse, bounded waits, background history work, and content-free timing diagnostics address avoidable delay and make remaining delay measurable.

The baseline debug benchmark measured history encoding/storage at about 103 ms for 30 seconds of synthetic 48 kHz stereo audio and 203 ms for 60 seconds. These are local baseline measurements, not an end-to-end before/after speedup. No live provider or microphone benchmark was performed, and the report of a recent slowdown is not attributed conclusively to one provider or commit.

## Security boundaries and residual work

A short-lived grant reduces exposure compared with a shared master key. It is still a bearer credential. Mint it immediately before the provider operation; do not persist it or log it. Deepgram validates expiration when authentication starts, so a WebSocket can remain open beyond the grant TTL. Issuance quotas do not enforce monthly audio-minute limits. A metered relay is a separate architecture project. See [Deepgram token authentication](https://developers.deepgram.com/guides/fundamentals/token-based-authentication).

Existing managed Claude requests use the Supabase sign-in token to authenticate to the MacroVox backend. The Deepgram grant endpoint also verifies that token, identity, and entitlement, and the client call to it is wired in. Only service-role server operations may mutate quotas, billing reservations, or entitlements. Client-side plan labels are not authorization.

BYOK credentials and Supabase session persistence still use webview localStorage. OS credential storage and reducing secret-bearing cross-window messages remain hardening tasks. OAuth deep-link completion, Linux runtime coverage, and a scheduled Stripe reconciliation service are also outside this fix's completed scope. A webhook retry/reconciliation runbook is not a deployed scheduler.

## Dependency audit

Compatible lockfile updates remove the review's vulnerability matches: `h2` 0.4.19, `rustls` 0.23.45, `rustls-webpki` 0.103.15, and `quick-xml` 0.41.0 via compatible parent updates. No advisory was suppressed to obtain a passing result.

A fresh npm audit during implementation reported 11 vulnerable packages. Compatible lockfile updates (including Vitest 4.1.11, undici 7.29.1, Browserslist 4.29.0, and PostCSS 8.5.28) reduced the final npm audit to zero. This supersedes the earlier baseline npm snapshot.

The local RustSec check found zero vulnerability matches. Informational categories still include eight unmaintained packages (`audiopus_sys`, `fxhash`, `proc-macro-error`, and five `unic-*` packages) and three soundness advisories (`glib` 0.18.5, `memmap2` 0.8.0, `rand` 0.7.3). These enter through the existing Opus, Tauri/GTK/parser, xkbcommon, and phf dependency graphs. A zero vulnerability count does not mean these warnings are resolved. Review supported upstream upgrades before a Linux release; replacing codec/windowing dependencies requires separate compatibility work.

## Validation record

The checks use mocks or disposable local state and do not call live transcription/billing providers, record the user's microphone, or automate the desktop.

| Check | Result |
| --- | --- |
| Integrated Vitest | 146 tests passed across 13 files |
| Renderer and Netlify TypeScript | Passed |
| Production renderer build | Passed |
| Native tests | 88 passed |
| Native formatting | Passed |
| Native clippy | Passed with warnings treated as errors |
| Build contract tests | 5 passed |
| App/Tauri version parity and CSP checks | Passed |
| Deno Edge Function checks | All three entry points passed |
| Deno billing, webhook selection, and origin tests | 8 passed |
| Database migration/permissions/state assertions | Passed on isolated PostgreSQL 17.11 |
| Concurrent quota requests | Exactly 1 of 25 accepted with 199 of 200 slots already used; final count 200 |
| Concurrent checkout requests | All 10 reused the same reservation |
| Concurrent webhook deliveries | Exactly 1 processor and 9 busy responses |
| npm vulnerability audit | Zero vulnerabilities after compatible updates |
| RustSec vulnerability audit | Zero vulnerability matches; informational warnings listed above remain |

The database harness creates and drops a uniquely named database on an explicitly configured local test server. The temporary server used here was shut down after the checks. It did not connect to the application's deployed Supabase database. CI repeats these tests on PostgreSQL 16.

Known toolchain noise: MSVC reports missing debug PDBs for vendored Opus objects, and Node reports the existing PostCSS module-type warning. Neither prevented the test or renderer build results above. No signed installer build, live provider call, packaged WebView smoke test, or Linux run was performed.

## Rollout and rollback

1. Review the final diff and validation record. Use a disposable database and Stripe test mode to rehearse migrations, concurrency, customer backfill, and event retry.
2. Follow the backend migration runbook's staged order. Existing clients cannot safely retain access to the old shared-key path.
3. Rotate provider keys after closing the read path. Treat previous copies as unrecoverable; deleting database rows alone does not revoke them.
4. Build and sign 1.0.9, manually upgrade a 1.0.8 test machine, and verify settings/history preservation and on-screen Stop behavior.
5. Verify a subsequent signed update from a build that mounts the updater. Publish only after the release checklist passes.

Rollback must never restore master-key distribution or a fail-open quota path. Prefer a managed-service maintenance response or BYOK while repairing a hosted migration. Preserve subscription and webhook history so recovery can reconcile real Stripe state rather than granting access from stale event payloads.
