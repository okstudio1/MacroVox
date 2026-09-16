**MacroVox security and architecture review, 2026-09-15**

> Baseline investigation at commit 2e96786. See the [fix ledger](SECURITY_ARCHITECTURE_FIXES_2026-09-15.md) for subsequent remediation and validation. Findings below describe the reviewed code, not the final fix branch.

Reviewed commit: 2e96786, version 1.0.8. Review branch: review/security-architecture-20260915. Worktree: C:/Users/owenp/dev/MacroVox-review-20260915.

The highest priorities are removing shared provider credentials from subscriber-readable storage and preventing repeated free trials. Several independent defects also affect quota enforcement, cancellation processing, microphone state, clipboard safety, and delivery of updates. Passing unit tests do not cover these failure paths.

This is a source review with local builds, dependency checks, and isolated reproductions. No production accounts, credentials, provider APIs, billing operations, registry entries, or deployed database policies were accessed or changed. No desktop automation or installer execution was performed. Only review documentation was added.

**Prioritized findings**

1. **High, security: subscriber-readable rows contain shared provider credentials.**

   Evidence: supabase/functions/stripe-webhook/index.ts:137-146 copies DEEPGRAM_MANAGED_KEY and ANTHROPIC_MANAGED_KEY into every subscriber's managed_api_keys row. src/renderer/lib/auth.ts:213-227 retrieves the Deepgram value; DictationMode.tsx:152-160 uses it in the live app. This is a shared credential, not a per-user credential. Deleting a subscriber's database row cannot revoke a copy they already extracted.

   A trial subscriber can obtain the Deepgram credential and call the provider outside application billing and quota controls. The documented SELECT policy in docs/SETUP.md:84-113 also exposes the Anthropic column through a direct database API query. Selecting only deepgram_key in the official client does not prevent another client from selecting anthropic_key. Anthropic exposure is conditional on deployed grants matching the documented setup; production grants were not inspected. [Supabase distinguishes row permissions from column permissions](https://supabase.com/docs/guides/database/postgres/column-level-security).

   Fix: remove provider secrets from user-readable tables, use the existing server-side Anthropic proxy, and authorize short-lived Deepgram token issuance or streaming through a backend. Remove stored copies and rotate affected credentials after closing the read path. [Deepgram supports temporary grants](https://developers.deepgram.com/reference/auth/tokens/grant); token issuance must still enforce entitlement and usage.

2. **High, billing abuse: the same account can repeatedly obtain a fresh seven-day trial.**

   Evidence: supabase/functions/create-checkout/index.ts:95-103 always sets trial_period_days to 7, supplies customer_email instead of an existing customer, and never checks previous trial use or active subscriptions. A user can cancel and start checkout again. Subscription Checkout creates a new Customer when customer is omitted. [Stripe Checkout API](https://docs.stripe.com/api/checkout/sessions/create)

   Fix: persist and reuse the Stripe Customer, maintain durable trial eligibility, and reject or reconcile existing active subscriptions before creating another session. Verify eligibility server-side, including concurrent checkout attempts.

3. **Medium, security: Claude quota checks are non-atomic and fail open.**

   Evidence: netlify/functions/claude-proxy.ts:142-162 reads a count, treats a failed count as zero, then starts a separate unawaited insert. Supabase result errors are not checked. Requests can pass together before reservations commit.

   Local reproduction against the actual transpiled handler with mocked dependencies: a failed usage query and insert still produced one provider call and HTTP 200. Starting at 199 requests, 25 simultaneous calls with delayed inserts all returned 200, producing 224 usage records against a limit of 200. No external requests were made.

   Fix: validate the request, then atomically reserve quota in a transaction or database function. Await the reservation and deny service when usage storage fails. The unused Deepgram proxy has the same pattern.

4. **Medium, billing integrity: webhook failures and event ordering can leave incorrect entitlement.**

   Evidence: supabase/functions/stripe-webhook/index.ts:120-150 logs provisioning errors without failing delivery; :168-179 and :200-226 ignore database result errors; :80-83 still returns HTTP 200. Checkout completion always grants access, while event IDs, event ordering, and current Stripe subscription status are not reconciled. A delayed checkout completion after cancellation can restore access. Recovery to active status updates the subscription but does not restore deleted managed key rows.

   Local reproduction: a cancellation event with both downgrade and key-deletion writes returning errors still returned HTTP 200 with received:true. Stripe does not guarantee event order and uses delivery failures to trigger retries. [Stripe webhook behavior](https://docs.stripe.com/webhooks?lang=node)

   Fix: check every database result; commit entitlement changes atomically; return non-2xx for retryable failures; deduplicate event IDs; and reconcile current Stripe state before granting access. Add a periodic reconciliation path.

5. **Medium, privacy: failed clipboard writes can paste unrelated existing contents.**

   Evidence: src-tauri/src/commands.rs:751-755 returns a resolved response with success:false on clipboard failure. src/renderer/components/DictationMode.tsx:288-305, :321-340, and :424-428 ignore that result and call autoPaste. If the clipboard is locked or unavailable, Ctrl+V can insert the user's previous clipboard contents into the target application.

   Fix: require success:true before marking the copy successful or pasting. Prefer a backend operation that writes the transcript and conditionally pastes, returning actual completion status. This is a source-confirmed failure path; clipboard contention was not induced on the user's desktop.

6. **Medium, installer security: elevated installation executes an untrusted HKCU command.**

   Evidence: src-tauri/installer/windows/installer-hooks.nsh:34-43 reads UninstallString from the current user's registry and executes it after a removal prompt. src-tauri/tauri.conf.json configures perMachine installation, which requires administrator privileges. [Tauri installation modes](https://v2.tauri.app/distribute/windows-installer/)

   A process with access to the same user's HKCU can replace the command with an executable it controls. If that user later authorizes the legitimate elevated installer and accepts the recommended previous-version removal, the installer executes the substituted program with its privileges. This requires local access and user interaction; it is not a remote or unattended elevation path.

   Fix: perform removal of a per-user installation without elevation. Do not treat a user-writable registry value as trusted elevated executable input. A path allowlist alone is insufficient when the executable itself is user-writable.

7. **Medium, architecture and privacy: recording has no single authoritative session lifecycle.**

   Evidence: src-tauri/src/deepgram_ws.rs:137-175 reports socket failure without resetting Rust is_recording or dg_sender. DictationMode.tsx:123-130 only resets React state. src-tauri/src/audio.rs:114-143 continues buffering microphone samples while the UI shows stopped, up to its existing buffer limit.

   Two stop paths also disagree. DictationMode.tsx:275-305 snapshots streaming text immediately after deepgram_stop, but commands.rs:393-402 only queues shutdown and final events may arrive later. The hotkey path at DictationMode.tsx:383-414 always calls batch stopRecording even for streaming, leaving the streaming sender open and issuing another transcription request. Normal stop paths also retain the CPAL stream; the live renderer never calls stopAudio.

   Fix: let one backend session owner control capture, transport, mode, cancellation, and finalization. Stop should await the complete final transcript. Emit session IDs with every event, clear backend state on every exit, and define an explicit idle microphone lifetime.

8. **Medium, architecture: late AI cleanup can overwrite newer text and clipboard contents.**

   Evidence: DictationMode.tsx:299-305 replaces the whole current transcript when an earlier streaming cleanup resolves. The operation lock is released before cleanup finishes, allowing a new recording. Batch cleanup at :329-338 replaces text by substring rather than segment identity.

   Scenario: stop recording A, start recording B or edit/clear the text, then let A's delayed response resolve. A can replace B, restore cleared text, or overwrite a newer clipboard value.

   Fix: assign recording and segment IDs, reject results from superseded generations, cancel obsolete requests, and merge by segment identity. Clipboard writes should also be conditional on the user still owning that pending operation.

9. **Medium, architecture: authentication changes do not consistently update either window.**

   Evidence: src/renderer/settings.tsx:42-55 reads the account once. SettingsPanel.tsx:167-181 hides the window after sign-in; :499 signs out without clearing parent state. DictationMode.tsx:185-191 polls only while user is null, and :135-170 never clears a previous user on an unsuccessful lookup.

   Account UI can stay stale, and an already fetched managed key can remain in React state after sign-out until another reload trigger. Server checks still protect proxied Claude requests; cached Deepgram credentials bypass those checks as described in finding 1.

   Fix: subscribe to auth transitions in both windows, clear account and managed credentials immediately, and reject older key-loading responses with an auth generation number. Keep BYOK policy explicit and separate from managed account state.

10. **Medium, privacy and architecture: history mutations can lose records and conceal deletion failures.**

    Evidence: src-tauri/src/commands.rs:545-566 starts detached saves. src-tauri/src/voice_buffer.rs performs independent manifest read-modify-write operations and uses the same manifest.json.tmp file at :102-110. Save, clear, edit, eviction, and startup repair can overlap. Atomic rename protects one write, not the complete transaction.

    Additionally, clear_all at voice_buffer.rs:459-469 ignores file deletion errors and resets the manifest. Locked or otherwise undeletable recordings then disappear from the UI while remaining on disk.

    Fix: serialize complete history operations behind one owner; coordinate saves with clear and repair; retain failed deletion entries and report partial failure; reconcile orphan files. Add concurrency and failed-deletion tests. Existing tests exercise sequential success cases.

11. **Medium, architecture: conflicting CSPs block BYOK cleanup and history playback.**

    Evidence: src/renderer/dictation.html:11 and settings.html:7 omit api.anthropic.com from connect-src, although usePostProcessing.ts:88-105 calls it for BYOK cleanup. src-tauri/tauri.conf.json:40 omits media-src, so its default-src self disallows the data: audio created by VoiceHistory.tsx:84-93.

    Installed Tauri 2.11.1 source confirms that manager/mod.rs:438-455 retains the HTML meta policy while protocol/tauri.rs:212-220 adds the configured response-header policy. These packaged-asset paths apply on Windows and Linux. Both policies therefore restrict the page.

    Fix: generate the policy from one source or synchronize both sources. Allow Anthropic connections where used, and data: media for the existing playback implementation. Verify these two flows in a packaged WebView; that runtime verification was not performed here.

12. **Medium, architecture: update discovery and installation are never started.**

    Evidence: src/renderer/hooks/useUpdater.ts:27-80 contains the only update check and installation calls, but no live component imports the hook. The production renderer bundle contains no updater invocation. Rust plugin registration and capabilities do not initiate a check. README.md:104 and docs/CHANGELOG.md:57 describe launch-time updating that is not connected.

    Fix: mount update orchestration once in a live root, expose discovery and installation status, and test upgrading an installed previous version. A configured public signing key exists, but clients currently lack the advertised automatic update discovery path.

13. **Medium, architecture: build and CI gates do not match the maintained application.**

    Evidence: package.json:9-15 still routes default development and build scripts through dead Electron code. Compiling config/tsconfig.main.json reports missing electron and related type errors; the supported Tauri renderer build succeeds. docs/RELEASE_CHECKLIST.md:18-19 directs maintainers to these stale build/typecheck paths.

    .github/workflows/ci.yml:42-58 checks renderer types, JavaScript tests, and Rust clippy, but does not execute Rust tests. The TypeScript project excludes Netlify and Supabase functions, and the billing functions have no checked-in tests. Dependency audits are not CI gates.

    Fix: remove or archive the Electron path, make default commands target Tauri, update the release checklist, and add actual Rust tests plus billing, quota, and dependency checks to CI.

14. **Medium, reliability: the recording limit silently truncates audio at higher device rates.**

    Evidence: src-tauri/src/audio.rs:84-87 fixes the buffer at 4,800,000 interleaved samples and :118-124 silently stops appending when full. This is 300 seconds at 16 kHz mono, but only 50 seconds at 48 kHz stereo. SettingsPanel.tsx:667 offers a 60-second recording cutoff, so an ordinary supported duration can exceed the buffer. Live WebSocket transmission continues, but batch transcription and saved history use the truncated buffer.

    Fix: express the limit in duration using actual sample rate and channel count, or normalize capture before buffering. Report reaching the limit instead of silently dropping the tail. The user's actual microphone format was not established.

**Further architecture concerns**

- Entitlement has multiple sources: Stripe metadata, database rows, client feature declarations, and copied provider credentials. create-checkout/index.ts:76-102 accepts pro or team but uses one STRIPE_PRICE_ID; stripe-webhook/index.ts:88-129 grants the caller-selected plan. Team limits are currently client declarations, so a larger enforced service quota was not demonstrated. Derive plans from verified Stripe prices and enforce resource budgets centrally.
- Only api_usage has a migration. The subscriptions and managed_api_keys schemas and policies live in docs/SETUP.md. Add versioned migrations and policy tests so a new environment can reproduce the reviewed security boundary.
- Supabase sessions and BYOK secrets reside in WebView localStorage, and key values cross the generic settings event bus. Move secret storage behind OS credential facilities and expose purpose-specific operations. This is hardening against local profile access or a future renderer compromise, not a demonstrated standalone remote exploit.
- Keep the two-window UI and Rust native layer, but give recording, history, authentication, entitlement, and update orchestration explicit owners. The observed bugs arise at transitions between independently maintained state.

**Dependency results, checked 2026-09-15**

npm audit using package-lock.json reported zero known vulnerabilities. This does not audit the independently resolved npm imports in Deno Edge Functions.

A refreshed RustSec database at commit e2e640471715167f73e22eaf761f2e547adafeec, updated 2026-09-14, reported six vulnerability matches representing four unique advisories:

| Locked dependency | Advisory and fix | Application exposure |
| --- | --- | --- |
| h2 0.4.13, Cargo.lock:1743 | RUSTSEC-2026-0258; fixed in 0.4.16 | Reaches direct transcription HTTP and updater dependencies. Exploitation requires a malicious HTTP/2 peer and undrained bodies; no attack was demonstrated. [Maintainer advisory](https://github.com/hyperium/hyper/security/advisories/GHSA-q83h-524g-xf6h) |
| rustls 0.23.37, Cargo.lock:3985 | RUSTSEC-2026-0285; fixed in 0.23.45 | Present through the updater. Its normal UI call path is currently dormant. The advisory does not establish handshake forgery or updater signature bypass. [Maintainer advisory](https://github.com/rustls/rustls/security/advisories/GHSA-2mjx-qc3c-rqvc) |
| quick-xml 0.38.4 and 0.39.2, Cargo.lock:3641 and :3650 | RUSTSEC-2026-0194 and RUSTSEC-2026-0195; fixed in 0.41.0 | Dependency paths include plist and wayland-scanner. No runtime path feeding attacker-controlled XML was established in MacroVox. These are four lockfile matches, not four demonstrated app exploits. [CPU exhaustion advisory](https://rustsec.org/advisories/RUSTSEC-2026-0194.html), [allocation advisory](https://rustsec.org/advisories/RUSTSEC-2026-0195.html) |

The fresh scan also reported eight unmaintained-package warnings, four unsoundness warnings, and one yanked-package warning. These require dependency-specific triage; their presence alone does not prove reachability. Update the compatible patches and trace upstream constraints before enabling the updater.

**Validation and limits**

| Check | Result |
| --- | --- |
| Locked npm install in review worktree, lifecycle scripts disabled | Passed |
| Existing JavaScript suite | 110 tests passed across 7 files |
| Existing Rust suite, locked and offline | 75 tests passed |
| Active renderer TypeScript check | Passed |
| Tauri Rust/JS version parity | Passed |
| Production renderer build | Passed; routine Browserslist/module-format warnings |
| Legacy Electron typecheck | Failed with missing electron and related types |
| Local quota failure and concurrency reproductions | Confirmed finding 3 |
| Local webhook database-failure reproduction | Confirmed finding 4 |
| On-screen streaming-stop handler with delayed final event | Copied and saved incomplete text, confirming finding 7 |
| npm dependency audit | Zero known vulnerabilities |
| Refreshed cargo audit | Failed with the advisory matches listed above |

Existing positive controls include JWT verification, caller/user binding, Stripe webhook signature verification, payload and model limits, restricted CORS, history filename validation, bounded recording/channel buffers, and a configured updater signing key.

Not performed: production RLS/grant verification, live Stripe or provider tests, package installation or update execution, microphone/focus tests, Linux execution, optional local-stt builds, full git-history secret scanning, or a new Semgrep run. The isolated reproductions mock authentication and external services; they test handler behavior after an authenticated request or verified event.

Recommended order: close credential exposure and rotate affected keys; enforce trial eligibility and atomic quotas; make billing reconciliation durable; repair clipboard and installer trust boundaries; then consolidate recording/history/auth state, align CSPs, connect the updater, and correct build and CI gates.
