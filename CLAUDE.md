# Repository guidance

## Runtime and entry points

MacroVox is a Windows-first Tauri 2 application with a Rust backend and a React 18 renderer. Linux is beta. The active code is `src-tauri/src/` and `src/renderer/`. `src/main/` and `config/tsconfig.main.json` are historical Electron code and are excluded from supported builds.

The two configured webviews are `main` (dictation.html) and `settings` (settings.html). Each has independent React state. Synchronize settings through the typed Tauri event bridge and subscribe to Supabase auth changes in each webview. Do not assume React state or event handlers are shared across windows.

Read [src-tauri/ARCHITECTURE.md](src-tauri/ARCHITECTURE.md) for native ownership, session finalization, history persistence, and event contracts. `commands.rs` defines commands, `lib.rs` registers them, and `src/renderer/lib/tauri-ipc.ts` defines their TypeScript bridge. Change these together when an IPC contract changes.

`DictationMode.tsx` owns the live recording flow. The standalone `useDeepgram` hook and the deferred Write tab are not its implementation. `useUpdater` is mounted through `UpdateNotice` in the dictation webview and again by the Updates section of `SettingsPanel`; the two webviews check independently. Installing does not use the plugin's `downloadAndInstall`: it goes through the `updater_install` command so `update_guard` can pin the installer's Authenticode signature, signer and embedded version in the gap the plugin leaves, where `download` verifies and `install` does not. [docs/AUTO_UPDATE.md](docs/AUTO_UPDATE.md) records what the update path verifies and what it does not.

## Commands and checks

| Task | Command |
| --- | --- |
| Full application development | `npm run dev` or `python run.py` |
| Debug application | `python run.py debug` |
| Renderer only, without native IPC | `npm run dev:renderer` |
| Local Netlify functions | `python run.py functions` |
| Renderer production build | `npm run build:renderer` |
| Native bundle, requires signing setup | `npm run build` |
| Renderer and Netlify types | `npm run typecheck` |
| Renderer and Netlify tests | `npm test` |
| Build contract tests | `npm run test:scripts` |
| Native tests | `cargo test --locked --manifest-path src-tauri/Cargo.toml` |
| Native formatting | `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` |
| Native lint | `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` |
| App and Tauri dependency versions | `npm run check:versions` |
| Production content security policy | `npm run check:csp` |

CI also checks Supabase Edge Functions, dependency advisories, and the Python launcher. Follow the commands in `.github/workflows/ci.yml`. There is no ESLint configuration. Use strict TypeScript, meaningful Vitest tests, Rust tests, clippy, and the Semgrep workflow.

## Dictation contracts

Button, global hotkey, and timer must enter the same mode-aware stop operation. Capture stops before network credential acquisition or transcription. For streaming, Deepgram `CloseStream` flushes pending audio and the stop response owns the final transcript. Do not copy, paste, clean up, or persist a provisional fragment before that response. Session IDs reject stale events; asynchronous cleanup must also check the transcript revision before changing the UI or clipboard.

BYOK Deepgram requests use Token authentication. Managed speech resolves a fresh short-lived Bearer credential per call through `deepgram-grant`, which trades a Supabase session for a token and never hands the managed key to the client (see `lib/deepgramCredential.ts`). Do not cache a grant across recordings or assume its expiry limits the lifetime of an already connected WebSocket. Claude BYOK calls go directly to Anthropic; managed cleanup uses the authenticated Netlify proxy. Never log credentials, audio, or transcript contents in timing diagnostics.

`nova-3` uses the `keyterm` query parameter, not the older `keywords` parameter. Keep streaming, batch, and history reprocessing consistent. History operations must serialize full manifest transactions, including repair and file deletion. Preserve failed deletions visibly so users can retry. A discard that cannot delete its file must say so, not fail silently; `remove_orphan_recordings` is the startup retry for audio that reached its final name without a manifest entry.

The persisted microphone string is `device_label`, which formats cpal's `DeviceDescription` as `name (driver)`. That is what `audio_set_device` stores and what `audio_start` matches against, so changing the format silently breaks every saved device selection. `DeviceDescription::name` alone is not unique across devices.

**The IPC contract.** The renderer talks to Rust ONLY through 32 `#[tauri::command]` functions (all in [src-tauri/src/commands.rs](src-tauri/src/commands.rs)) plus backend->renderer emit events. Two files must stay in lockstep: every command must be listed in the `tauri::generate_handler![...]` macro in [src-tauri/src/lib.rs](src-tauri/src/lib.rs) AND mirrored in the typed bridge [src/renderer/lib/tauri-ipc.ts](src/renderer/lib/tauri-ipc.ts). That bridge is the single import surface for the renderer (`import * as ipc from '../lib/tauri-ipc'`); it wraps `invoke()` for commands and `listen()`/`emit()` for events, and deliberately mirrors the old Electron `window.electronAPI.*` shape. JS camelCase args auto-convert to Rust snake_case. Emit events (the push side): `deepgram:transcript` `{transcript,isFinal}`, `deepgram:error`, `quick-dictation-toggle` (global hotkey, default Ctrl+Space), `theme-changed`, `settings-changed`, `voice-buffer-updated`.

**Dictation + post-processing flow.** [src/renderer/components/DictationMode.tsx](src/renderer/components/DictationMode.tsx) is the live UI. It does NOT use the `useDeepgram` hook; it inlines record/transcribe state and calls `ipc.startDeepgram`/`startRecording`/`stopRecording` directly. Supports `batch` (upload on stop) and `streaming` (live WS, final fragments via `ipc.onTranscript`). After an optimistic raw-text clipboard copy, AI cleanup runs in the background via [src/renderer/hooks/usePostProcessing.ts](src/renderer/hooks/usePostProcessing.ts): if `localStorage.user_anthropic_key` is set it POSTs directly to api.anthropic.com; otherwise it uses the managed Netlify claude-proxy with a Supabase bearer token (fails closed otherwise). Cleanup model is `claude-haiku-4-5-20251001` (see [src/renderer/config.ts](src/renderer/config.ts)). The HUD also has a "Record" mode (Dictate/Record toggle under the titlebar, persisted HUD-locally as localStorage `hud_mode`, not broadcast) that streams audio into the voice buffer with NO length limit and no API key via `voice_buffer_record_start`/`_stop` (streaming OGG Opus writer in [src-tauri/src/recorder.rs](src-tauri/src/recorder.rs); the 5-minute `MAX_BUFFER_SAMPLES` cap only applies to dictation). The Recordings side panel ([src/renderer/components/RecordingsPanel.tsx](src/renderer/components/RecordingsPanel.tsx), toggled from the titlebar, widens the window by 300px) lists voice-buffer entries and transcribes them on demand through the shared `transcribeRecording` helper in [src/renderer/lib/recordings.ts](src/renderer/lib/recordings.ts), which VoiceHistory in Settings also uses.

## Security and hosted backend

Provider master keys belong only in server environment variables. Do not restore `managed_api_keys` reads or a compatibility fallback that returns shared keys. The migration and rollout contract is documented in [docs/BACKEND_SECURITY_MIGRATION_2026-09-15.md](docs/BACKEND_SECURITY_MIGRATION_2026-09-15.md). Subscription mutation, trial reservations, webhook application, and quotas use service-role-only database operations. Browser clients may read only their own entitlement.

Deepgram streaming credentials come from `deepgram-grant` (holds `DEEPGRAM_MANAGED_KEY`, returns a ~60 s token from Deepgram's `/v1/auth/grant`); managed Claude cleanup comes from `claude-proxy` (holds `ANTHROPIC_MANAGED_KEY`). Both gate on the same origin allowlist -> Supabase JWT -> `subscriptions.status` in (pro, team) -> rate limit chain. `lib/deepgramCredential.ts` resolves a tagged `DeepgramCredential` per call so BYOK (`api_key`, `Token` scheme) and managed (`access_token`, `Bearer` scheme) can never be presented with the wrong header; the Rust side keeps them apart by type too (`src-tauri/src/deepgram_ws.rs`). `deepgram-proxy` is unused legacy code that only ever served the batch path. Stripe runs as Supabase Edge Functions (Deno) in `supabase/functions/`: `create-checkout`, `billing-portal`, `stripe-webhook` (the webhook has `verify_jwt=false` and checks Stripe's HMAC itself).

CSP has one production source: `src-tauri/tauri.conf.json`. Do not add HTML meta policies. New provider origins must be explicit and covered by `check:csp`. Renderer-only Vite development does not exercise the production Tauri response header.

BYOK secrets and Supabase sessions currently persist in the webview profile. OS credential storage remains a documented hardening task. Do not describe localStorage as encrypted credential storage.

## Release and documentation

Version 1.0.9 was published on 2026-09-16 to `okstudio1/macrovox-releases`: EV-signed installer and MSI, minisign sidecars, `latest.json`, and both SBOMs. It is the first build whose updater is live, so the 1.0.10 update is the first end-to-end exercise of the manifest fetch, minisign verification, installer pinning, install and relaunch. Keep package.json, tauri.conf.json, Cargo.toml, and their lockfiles synchronized. `check:versions` enforces app version parity and Tauri major/minor parity.

Windows bundles are built and EV-signed on the signing host, then minisigned. Publishing is manual to the separate `okstudio1/macrovox-releases` repository. The tag workflow builds Linux artifacts; it does not publish a release. Read [docs/RELEASE.md](docs/RELEASE.md) and [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md).

Existing 1.0.8 clients did not mount the updater and require a manual installer upgrade. Do not promise automatic migration from that release. Schema deployment, environment changes, key rotation, signed installation, and provider smoke tests are separate from a passing source build.

## Working conventions

- Use ripgrep for all content searches.
- Never use em dashes or en dashes in new text, code, or commits.
- Use conventional commit subjects under about 72 characters. Never add AI attribution or session backlinks.
- Test behavior changes at the boundary where the failure occurs. Do not substitute string-matching tests for concurrency or permission tests.
- Keep accessible targets, clear errors, and no fast or fine motor requirements.
- Settings added to cross-window synchronization require both the bridge allowlist and the settings snapshot to change.
- On Wayland, copy remains available even when auto-paste or global shortcuts are unavailable.
- Do not run desktop automation or move the user's focus without authorization.
- Before changing IPC, billing, schema, CSP, audio, provider requests, or signing behavior, establish authorization. An explicit request to fix reviewed defects authorizes the necessary source changes; production deployment and credential rotation require their own authorization.
- Keep docs aligned with the final implementation and distinguish implemented code from deployed behavior.
