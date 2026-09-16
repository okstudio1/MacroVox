# MacroVox Changelog

## Unreleased (1.0.9)

### September 16 maintenance, dependency majors, and a removal

- **Voice history no longer leaks audio it failed to delete.** When a Clear
  landed mid-session, the stale-epoch branch of `register_recording_at_epoch`
  discarded the `remove_file` error, leaving a finalized recording on disk with
  no manifest entry: invisible in the UI, never retried by Clear, and not
  counted against the size cap. The failure is now named in the error the
  renderer receives, and a startup pass, `remove_orphan_recordings`, reclaims
  unreferenced `.ogg`/`.wav` files as the durable retry. It skips `.partial`
  files and anything modified in the last 60 seconds, so it cannot take a
  recording that is still on its way into the manifest, and it also closes the
  older leak where the process died between the rename and the registration.
- **The `local-stt` feature and `whisper-rs` are removed.** The feature had not
  compiled for some time: `whisper_transcribe_impl` built
  `RecordingStopResponse` without the `session_id` and `limit_reached` fields
  added to the struct later, and no CI job builds the feature, so the breakage
  went unnoticed. Removing it also drops `whisper-rs-sys` and the vendored
  whisper.cpp build, which was the only part of the tree that required cmake and
  a C++ toolchain. The IPC contract goes from 32 commands to 31; the
  `whisperTranscribe` bridge wrapper had no callers.
- **Dependency majors: cpal 0.17, enigo 0.6.1, reqwest 0.13.2, lucide-react
  1.14.0, @vitejs/plugin-react 5.2.0.** cpal 0.17 replaces `Device::name` with a
  `DeviceDescription`; see the microphone label note below, because saved device
  selections depend on that string. enigo 0.6.1 and reqwest 0.13.2 needed no
  source changes. plugin-react stops at 5.2.0, the newest release whose peer
  range still accepts Vite 6.
- **Saved microphone selections survive the cpal 0.17 upgrade.** On WASAPI the
  0.15 `Device::name` string is split across `DeviceDescription::name` (the
  endpoint) and `::driver` (the adapter). Reading `name` alone would have
  changed every persisted device string and collapsed distinct microphones onto
  one label, silently falling back to the default device. `device_label`
  recombines the two, which reproduces the old string exactly, so no migration
  is needed. `format_device_label` carries the format and is covered by tests.
- **Auto-paste verified against the new enigo.** The `dictation_auto_paste` key
  sequence was exercised on a raw Win32 EDIT control, on the Windows 11 packaged
  Notepad, and in a Chromium window, each confirmed by copying the target's
  content back out rather than trusting the return values.
- **Pinned GitHub Actions moved to current majors:** `checkout` v7.0.1,
  `setup-node` v7.0.0, `setup-python` v7.0.0, `upload-artifact` v7.0.1. Every
  SHA was verified against its upstream tag. These majors require Node 24 and
  runner 2.327.1 or newer; all workflow jobs use GitHub-hosted runners.
- **Chore:** the PowerShell module analysis cache (`/Microsoft/`) is ignored, so
  it no longer appears in `git status`.

Note for a future dependency sweep: `release.yml` still pins `ubuntu-22.04`,
which began deprecation on 2026-09-17 and is unsupported from 2027-04-17. Moving
it raises the glibc floor of the Linux `.deb` and AppImage, so it is a
deliberate packaging decision rather than a routine bump.

### September 15 security and dictation fixes

- Streaming Stop waits for the authoritative final transcript. Button, hotkey, and timer share session-aware stop behavior; microphone capture ends on stop or failure.
- Session and transcript revisions prevent stale events or AI cleanup from replacing a newer recording or edited text. Clipboard failure blocks auto-paste.
- Batch buffering accounts for sample rate and channel count. History operations serialize manifest changes and retain failed deletions for retry.
- Managed speech moves from client-readable provider keys to short-lived credentials. Server-side atomic quotas fail closed; billing uses durable customers, trial reservations, verified price mapping, and retryable webhook application.
- Hosted CORS now accepts the exact existing Windows webview origin, with lookalike-origin rejection tests and no change to settings/session storage.
- The elevated installer no longer executes a per-user registry uninstall command. Production CSP has one source and permits supported BYOK and history playback paths.
- The dictation window mounts the updater with an explicit install action. Existing 1.0.8 clients require a manual installer upgrade.
- Default development and build commands target Tauri. CI includes native tests, hosted-function checks, security/build contracts, and dependency audits. App version parity is enforced.
- Rust lockfile updates address the review's h2, rustls, and quick-xml advisories. Upstream maintenance and soundness warnings remain separately documented.

See the [fix ledger](SECURITY_ARCHITECTURE_FIXES_2026-09-15.md) for evidence and validation, and the [backend migration runbook](BACKEND_SECURITY_MIGRATION_2026-09-15.md) for required deployment and key rotation. These changes are not yet a published release.

### Earlier unreleased maintenance, before the September review

The measurements in this subsection describe the earlier maintenance checkpoint. The fix ledger above records the final review results.

- **Dependabot advisories cleared.** Resolved all 7 open npm advisories via `npm audit fix`, all within existing semver ranges so `package.json` is unchanged (only `package-lock.json` moved): `shell-quote` 1.8.4 (fixes the critical newline-escape bypass in `quote()`), `undici` 7.28.0, `ws` 8.21.0, `vite` 6.4.3, `qs` 6.15.3, `@babel/core` 7.29.7. `npm audit` now reports 0 vulnerabilities. On the Rust side, lock-only bumps of `openssl` 0.10.80 (with `openssl-sys` 0.9.117; out-of-bounds write in AES-KW-PAD `cipher_update_inplace`) and `tar` 0.4.46 (PAX header desync). Verified green: `tsc --noEmit`, 110 vitest, `vite build`, and 75 cargo tests. `glib` 0.18.5 and `rand` 0.7.3 stay pinned by the `tauri 2.11.1` dependency tree (gtk 0.18 and phf/kuchikiki) and can only move on an upstream Tauri bump.

### Chore

- **Version synced to 1.0.8 across manifests.** `Cargo.toml`, `Cargo.lock`, and `package-lock.json` lagged at 1.0.7 while `package.json` and `tauri.conf.json` (the authoritative updater version) were already 1.0.8 for the published release. All four now agree.

### Linux

- **Auto-paste now works on Wayland.** Previously auto-paste was disabled entirely under Wayland (`enigo` can't synthesise input there), leaving Wayland users to paste manually, a regression versus X11. MacroVox now falls back to a Wayland-native injector, preferring `wtype` (daemonless) and falling back to `ydotool`, detected on `$PATH` at paste time. When one is installed the "Auto-paste on stop" toggle is enabled and Ctrl+V is injected as on X11; when neither is present, the toggle is disabled with an inline note to install one (the transcript still copies to the clipboard). Exposed to the renderer via a new `auto_paste_available` field on `platform_info`. See `src-tauri/src/platform.rs` and `dictation_auto_paste` in `commands.rs`.

### Internal

- **Perf instrumentation for the latencies that matter.** Added `info`-level `[perf] …` probes so perceived-latency claims rest on measured numbers, not folklore: `audio_start` logs time-to-first-capture broken into config/build/play stages; `dictation_auto_paste` logs end-to-end keystroke-inject latency; and a new `perf_mark` command (called from `dictation.tsx` after first paint) logs time-to-first-paint relative to process start. Run with `RUST_LOG=info` to see them. See the "Perf instrumentation" section in `src-tauri/ARCHITECTURE.md`.

### Fixes

- **Smart number formatting now recognizes item labels.** In `Smart` number mode, numbers that label or identify a specific item (e.g. "survey 3", "step 2", "question 9") now render as digits instead of words. Previously the AI-cleanup prompt treated these as small standalone counts and spelled them out ("surveys three and four"). The prompt also propagates digit formatting across a list when the noun is implied, so "I updated surveys 3 and 4; still waiting on 7, 5, and 6" formats consistently. Genuine colloquial counts ("twenty-one people", "three of them") still spell out. Applies to the `Smart` mode only and requires AI cleanup. See `src/renderer/hooks/usePostProcessing.ts`.

## v1.0.8 : 2026-05-30

### New Features

- **Bring your own API keys** : new **Keys** tab in Settings lets you paste your own Deepgram and Anthropic API keys and run MacroVox without a subscription. Keys are stored in `localStorage` on the device and sent only to Deepgram / Anthropic, never to OK Studio's servers. A saved Deepgram key takes priority over managed keys and unlocks recording with no sign-in; a saved Anthropic key routes AI cleanup directly to the Anthropic Messages API instead of the managed `claude-proxy`. Leave the fields blank to keep using the managed plan. Each field has a show/hide toggle. The dictation window picks up a newly-saved key live via the settings broadcast (both keys added to `ALLOWED_SETTINGS_KEYS`; `connect-src` in `tauri.conf.json` now allows `api.anthropic.com` for the direct-call path).

### UI / UX

- **Native right-click behavior** : the WebView2 default page context menu (Back, Reload, Save as, Print, Inspect) is now suppressed app-wide so MacroVox stops feeling like a web page. Implemented as a shared `disableContextMenu()` helper wired into both window entry points. DevTools stays reachable via F12 / the `RUST_LOG` auto-open.

### Installer

- **Uninstall offers to remove user data** : an interactive uninstall now prompts to delete `%LOCALAPPDATA%\com.okstudio.macrovox`, which holds saved dictation recordings (`voice-buffer\`) and the WebView2 `localStorage` profile that stores bring-your-own API keys. Previously these were left on disk after uninstall. Silent uninstall (`/S`, the auto-updater's upgrade path) never wipes data, so updates keep your settings. Mirrors alpha-osk's `installer.nsh`. NSIS installer (`-setup.exe`) only : the Wix `.msi` is unaffected.

### Release notes

- First release published to the separate `okstudio1/macrovox-releases` repo (Windows-only: EV-signed `-setup.exe` + `.msi`). Auto-updater minisign signatures (`latest.json`) were deferred for this first release since no prior clients exist to verify them; the next release will include them.
- **CycloneDX SBOMs attached.** Each release now ships a Software Bill of Materials for both dependency graphs (npm renderer and Rust backend), generated by `npm run release:sbom` and uploaded alongside the installer. See `scripts/generate-sbom.mjs` and the SBOM section in `docs/RELEASE.md`.

## v1.0.7 : 2026-04-26

Major release: Linux beta, voice history with OGG Opus, Wayland support,
streaming-by-default with optimistic auto-paste, multi-language Deepgram
Nova-3, configurable hotkey, hardened security posture, signed
auto-update pipeline, and a working Tauri 2 release workflow.

### New Features

- **Streaming transcription by default** : words appear as you speak instead of after you stop recording. Perceived latency drops to near-zero for transcript display. Batch mode still selectable in Settings → Voice Recognition.
- **Optimistic auto-copy + auto-paste** : raw transcript is copied to clipboard and auto-pasted immediately when recording stops. AI cleanup runs in the background and silently updates the clipboard if the cleaned text differs. Users no longer wait for cleanup before the text lands in their target app.
- **Custom global hotkey** : configurable keyboard shortcut to toggle dictation (default `Ctrl+Space`). Change it in Settings → Dictation Window. The app dynamically registers/unregisters shortcuts at runtime.
- **Multi-language transcription** : 20 languages supported via Deepgram Nova-3 (English, Spanish, French, German, Portuguese, Japanese, Korean, Chinese, and more). Change in Settings → Voice Recognition. Claude cleanup prompt is language-aware.
- **Number formatting** : choose how numbers appear in transcripts: Smart (Deepgram decides), Always digits, or Always words. Applies to both Deepgram output and Claude cleanup.
- **Voice History buffer** : rolling buffer that saves dictation recordings as OGG Opus files (~10× smaller than WAV) for playback and future model training. Enabled by default. Configurable storage limit (50-500 MB, default 100 MB ≈ 14 hours of audio). FIFO eviction deletes oldest recordings when the limit is reached. Recordings are paired with their transcripts in a JSON manifest.
- **Voice History playback + reprocess** : click any recording to expand and view its full transcript; copy transcript to clipboard from the expanded view. Right-click → "Reprocess" re-runs the full pipeline (decode OGG Opus → re-transcribe through Deepgram → Claude AI cleanup → update manifest). Useful after changing keyword boosts or accessibility context.
- **History sort toggle** : sort voice buffer recordings by newest-first or oldest-first. Backend sorts by timestamp explicitly instead of relying on insertion order.
- **Linux support (beta)** : `.deb`, `.rpm`, and AppImage bundles. ALSA/PulseAudio capture via `cpal`. ALSA device-list filter so the mic dropdown shows real devices only (no `hw:` / `plughw:` / `dmix:` / `surround*:` entries). Mic pick persists across restarts. Bundle metadata (deb section/priority/depends, rpm depends, desktop file) configured under `bundle.linux` in `tauri.conf.json` with a Handlebars desktop template at `installer/linux/macrovox.desktop`.
- **Wayland detection + auto-paste fallback** : new `platform_info` IPC command and `platform::is_wayland` helper. On Wayland, `dictation_auto_paste` short-circuits (clipboard still succeeds so users can paste manually) and the Settings → Quick Dictation panel renders the "Auto-paste on stop" toggle disabled with an inline explanation. Both X11 sessions and Windows keep the previous behavior untouched.
- **7-day free trial** : website updated with free trial messaging, pricing, and CTAs. Implementation guide in `docs/FREE_TRIAL_IMPLEMENTATION.md`.
- **Branded NSIS installer** : custom header and sidebar images with MacroVox waveform branding. NSIS hooks handle process kill on upgrade, old version migration from different install directories, and shortcut creation. Per-machine install to Program Files with Start Menu folder.
- **Auto-updater** : checks for updates on launch via `tauri-plugin-updater`. When a new version is available, downloads the installer, applies it, and relaunches automatically. Endpoint: GitHub Releases `latest.json`.

### Release pipeline & signing

- **Updater signing keypair wired in** : minisign keypair generated at `~/.tauri/macrovox.key{,.pub}` (key ID `9B91F23A49E0246D`) and the public key baked into `tauri.conf.json → plugins.updater.pubkey`. Builds with `TAURI_SIGNING_PRIVATE_KEY[_PASSWORD]` env vars set now emit `.exe.sig` / `.msi.sig` / `.AppImage.sig` minisign sidecars that auto-update verifies.
- **`bundle.createUpdaterArtifacts: true`** : explicit in `tauri.conf.json` so missing signing env vars fail the build loudly rather than silently skipping the updater artifacts.
- **EV Authenticode signing wrapper** : `scripts/sign-windows.ps1` invoked via `bundle.windows.signCommand`. Uses the OK Studio Inc. EV cert (SHA1 `fc22b522…`) on the SafeNet eToken, retries up to 5× with linear backoff to handle Windows Defender file locks (mirrors `alpha-osk/build/windows/sign.py`), and skips vendor DLLs (Wix UI/Util extensions, NSIS plugins) so only `.exe` / `.msi` get OK Studio's signature. Order is correct end-to-end: bundler EV-signs → minisign computes its sig over the EV-signed bytes.
- **Tag-triggered release workflow** : new `.github/workflows/release.yml` builds the Linux bundle on `ubuntu-22.04` with the minisign signing key injected from GitHub repo secrets, then opens a draft GitHub release. Windows is built locally because the EV cert is on a hardware token and split-host signing would invalidate either Authenticode or minisign.
- **Updater manifest generator** : `scripts/generate-latest.mjs` (wired as `npm run release:manifest`) scans `release/windows/` and `release/linux/` for `*-setup.exe` / `*.msi` / `*.AppImage` updater artifacts, reads their `.sig` sidecars, and emits `latest.json` with both `windows-x86_64` and `linux-x86_64` platform keys.

### UI / UX

- **Dictation History settings panel** : new section in settings with: enable toggle (on by default), storage limit selector with visual usage bar (turns red at 90%), recording count and total duration display, "Open folder" button to reveal storage in Explorer, "Clear all" button, and scrollable recording list with play/stop/expand/delete per item and right-click context menu.
- **Settings reordered** : Audio Input moved up (first-run priority), Subscription moved down, About and Shortcuts merged into one section.
- **Settings panel reorganized into tabs** : the eleven flat sections that previously stacked into one long scroll are now grouped under a left sidebar with five tabs: **Account** (sign-in/account pill, Subscription), **Dictation** (Audio Input, Voice Recognition, Quick Dictation, AI Post-Processing), **Window** (always-on-top, minimize-to-tray, global hotkey), **History** (voice buffer + recordings list), and **Appearance** (theme picker, About). Sidebar rows are full-width click targets with icon + label, an accent-color left border on the active row, and they reuse the existing CSS theme variables so they pick up the active palette. `NAV_ITEMS` drives the nav so adding a future tab is one line. Side benefit: leaving the History tab unmounts `<VoiceHistory>`, and returning to it remounts and re-fetches, so the recordings list is always fresh on arrival.
- **Settings window now fills its window** : `isPopup` was declared on `SettingsPanelProps` but never destructured, so the panel always rendered as a `max-w-md` (448 px) floating card centered with `fixed inset-0` inside the dedicated Tauri settings window. The capped width and `max-h-[90vh]` meant the rest of the 480×700 window was wasted background, and dragging the window larger left the panel a tiny card in the middle. Fixed by reading the prop and switching the outer/inner divs to `h-screen w-screen` + `flex-1 min-h-0 w-full` in popup mode (no rounded card, no border, no `mx-4` margins); the legacy modal layout is kept behind `isPopup={false}` for any future in-app modal use. The panel now scales live with the window and pairs naturally with the new sidebar nav.
- **Auto-copy defaults to ON for new users** : changed from opt-in to opt-out. New installs get clipboard copy behavior immediately without visiting settings.
- **Auto-copy and auto-paste settings surfaced more prominently** : reordered Quick Dictation toggles to put auto-copy and auto-paste first (above "Clear on new recording"). Descriptions rewritten to be clearer about what each toggle does.
- **Writing tab removed** : Agentic Writing tab and settings section removed from the UI for initial release. Source files kept in repo for potential re-addition later.
- **Processing ring removed** : removed the spinning cyan ring around the record button during transcript processing.

### Performance

- **AI cleanup model switched from Claude Sonnet to Claude Haiku** : 3-5× faster cleanup (~200-500 ms vs ~1-2 s). Haiku is more than capable for grammar and punctuation correction.
- **`encode_opus` resampling fix** : voice buffer recordings now play back at real-time speed; previously played back at ~⅓ speed due to a sample-rate mismatch (cpal captures at 48 kHz on Windows but `ogg_opus::encode::<16000, 1>` claimed 16 kHz in the file header).

### Bug Fixes

- **Saved recordings no longer play back slowed down** : `encode_opus` in `voice_buffer.rs` was hardcoded to claim its input was 16 kHz mono, but cpal's `default_input_config()` is typically 48 kHz on Windows. Fixed by downmixing to mono and linearly resampling to 16 kHz before handing samples to the Opus encoder.
- **Auto-repair on launch for already-stretched recordings** : new `voice_buffer::repair_stretched_recordings`, spawned on a background thread from `lib.rs` setup, walks the manifest once per startup. For each `.ogg` whose decoded length at 16 kHz drifts more than 50 ms from `manifest.duration_secs`, it decodes, resamples to the correct length, and re-encodes. Idempotent : files already at the right speed are skipped.
- **Settings window no longer pinned on top (Linux)** : removed `alwaysOnTop: true` from the settings window in `tauri.conf.json`. The main dictation HUD still defaults to always-on-top, and reapplies the user's saved toggle on startup via `DictationMode` mount.
- **Microphone selection now persists across restarts** : previously the selected mic lived only in the Rust `AppState` mutex (in-memory). `SettingsPanel` now writes `selected_mic_device` to `localStorage`, restores it on `loadDevices`, and `DictationMode` re-pushes it to the backend on window mount.
- **Linux microphone dropdown no longer lists ALSA noise** : new `filter_device_list` in `commands.rs` drops `hw:`, `plughw:`, `dmix:`, `dsnoop:`, `surround*:`, `iec958:`, `hdmi:`, `sysdefault:`, monitor taps on Linux only. Windows/macOS device lists are unchanged.
- **Dropdown contrast on Linux** : WebKitGTK was rendering `<select>` elements with the native GTK widget, ignoring our inline colors. Added global `select { appearance: none }` in `index.css` with a themed chevron and explicit `option` colors so closed-state text and the open menu both honor theme variables.
- **Auto-cutoff transcript disappearing** : the auto-cutoff timer was calling `setTranscript('')` immediately after `handleStopRecording()`, wiping the transcript from the UI before the user could see it. Removed the errant clear.
- **Keyword boosting was silently ignored** : keywords were parsed and stored in `AppState` but never appended to the Deepgram URLs. Both streaming WebSocket and batch REST paths now include `&keyterm=` parameters with proper URL encoding. (Nova-3 retired the legacy `&keywords=` param; sending it returned 400 Bad Request as soon as a user added a custom term.)
- **Auto-paste missing from batch and streaming stop paths** : `Ctrl+V` injection only fired from the `Ctrl+Space` toggle path. Now fires from button-click stop and streaming-mode stop too.
- **Settings window black screen** : root cause was two-fold: `devUrl` pointed to the full `dictation.html` URL instead of Vite root, and `WebviewUrl::App` for programmatically-created windows always uses `tauri://localhost`, never the dev server. Fix: declare the settings window in `tauri.conf.json` like the main window (hidden at startup); `settings_open_window` now just calls `show()` + `set_focus()` instead of constructing the window at runtime.
- **Minimize and close buttons unresponsive** : the entire titlebar `div` had `data-tauri-drag-region`, swallowing click events. Only the `MacroVox` label span carries the drag attribute now; the buttons sit in a sibling flex container outside the drag region.
- **Settings panel error boundary** : if the settings panel fails to render, an error message is shown instead of a blank page.
- **Dictation history list now refreshes live** : the recordings list and storage-usage bar in the settings panel only loaded on mount, so newly-saved dictations didn't appear until the next app launch. `DictationMode` now broadcasts a `voice-buffer-updated` event over Tauri's cross-webview event bus after `voiceBufferSave` resolves, and `VoiceHistory` + `SettingsPanel` listen for it to silently re-fetch. The first attempt used `window.dispatchEvent`, which doesn't cross webview boundaries : the dictation HUD and settings panel are separate Tauri windows.
- **Batch-mode recordings now appear in settings without a restart** : the previous live-refresh fix only emitted `voice-buffer-updated` from the renderer's streaming path. Batch mode (the default `transcription_mode`) saves the recording inside `recording_stop`'s background thread on the Rust side and never round-trips through `voiceBufferSave`, so no emit ever fired and the settings window's `VoiceHistory` stayed frozen at whatever was on disk when the WebView first loaded. `recording_stop` now takes an `AppHandle`, clones it into the save thread, and `app_handle.emit("voice-buffer-updated", ())` after `save_recording` returns Ok : keeping the contract symmetric across both transcription modes.
- **"Open folder" button readability** : the dictation history "Open folder" action used `var(--text-muted)`, which rendered nearly invisible against the panel background. Bumped to `var(--text-secondary)` to match the rest of the panel's actionable text.
- **Number formatting "Smart" mode now actually smart-formats.** Selecting Smart previously relied on Deepgram's `smart_format=true` to produce context-aware output (digits for currency/dates/measurements, words for isolated counts), but Nova-3's smart_format in practice almost always returns spelled-out words. The Claude cleanup pass also got no instruction at all in Smart mode, leaving it free to rewrite numbers however it pleased. Smart mode now sends an explicit contextual-formatting rule to Claude: digits for currency, measurements, dates, times, percentages, addresses, phone numbers, and units; words for isolated small numbers under 100; digits for 100 and above. Always-digits and Always-words modes are unchanged. The in-app description was also updated to reflect that Smart mode requires AI cleanup to take effect.

### Stability

- **Race condition on rapid start/stop** : added `operationInProgressRef` guard to prevent concurrent `handleStartRecording`, `handleStopRecording`, and `handleStopAndCopy` calls from overlapping when the record button is clicked rapidly.
- **Mutex poison recovery** : all `.lock().unwrap()` calls in `audio.rs` and `commands.rs` replaced with `lock_or_recover()` helper that recovers from poisoned mutexes instead of panicking the app.
- **Audio level interval cleaned up on unmount** : `audioLevelIntervalRef` is now cleared when the dictation component unmounts, preventing leaked polling intervals.
- **AI cleanup fetch timeout** : `usePostProcessing` now uses an `AbortController` with a 15-second timeout. Previously could hang indefinitely if the proxy was slow or offline.
- **Global unhandled promise rejection handler** : both `dictation.tsx` and `settings.tsx` entry points now catch unhandled rejections to prevent silent failures.
- **Streaming network failure surfaced to user** : WebSocket task now emits a `deepgram:error` event on unexpected disconnection. Frontend listens, shows error, stops recording state, cleans up intervals.
- **Recording buffer capped at 5 minutes** : prevents unbounded memory growth if recording is never stopped (~18 MB at 16 kHz mono). New frames silently dropped after the cap.
- **Deepgram WebSocket channel bounded to 500 messages** : prevents unbounded memory growth if the WebSocket is slower than audio capture. Frames silently dropped when the channel is full.

### Tests / CI

- **Tauri version-parity CI check** : new `scripts/check-tauri-versions.mjs` (run via `npm run check:versions`) compares the resolved `tauri` crate version in `Cargo.lock` against `@tauri-apps/api` in `package-lock.json` and fails on major.minor drift. Wired into CI as a separate fast job. Catches the silent JS↔Rust protocol mismatch class in seconds : the kind of bug that previously made cross-webview events fail without surfacing any error.
- **Renderer test coverage** : vitest grew from 20 to 109 tests across 7 files: `usePostProcessing` (fail-closed paths, dev bypass, prompt-injection escaping, context cap, settings overrides, abort/timeout), `themes` (palette completeness, invalid-id fallback, persistence round-trip), `tauri-ipc` cross-webview event helpers (DOM-events-don't-cross regression guard), `audio-mime` (security whitelist for the data-URI playback path), and `auth` (29 tests covering provider mapping, fail-closed paths, anthropic-key never-leaks invariant, billing flows).
- **Rust voice_buffer + commands tests** : cargo grew from 55 to 75 tests. Added edge-case coverage for `voice_buffer`: corrupt manifest backup-and-recover, missing-file error paths, `validate_filename` traversal/null-byte/drive-letter rejections, multi-file FIFO eviction, `set_max_size` shrink-and-evict, `f32_to_i16` clamp behavior, empty-input resampling. `commands` gained branch-logic tests for `settings_broadcast` parsing of `voice_buffer_enabled` (typo-tolerant fail-safe), `voice_buffer_max_size` (rejects unparseable values), `transcription_language` (length cap), and the `deepgram_keywords` newline-strip-empties parser that prevents 400s from Nova-3.
- **Small refactor : `safeAudioMime` extracted to `lib/audio-mime.ts`** : the inline `mime === 'audio/wav' || mime === 'audio/ogg'` check in `VoiceHistory.handlePlay` moved to a named function so the security-critical whitelist has a unit-testable surface.

### Security

- **`tauri` bumped 2.10.3 → 2.11.1** : patches `GHSA-7gmj-67g7-phm9` (Origin Confusion in `is_local_url()` on Windows/Android : `split_once('.')` extracted only the first label of the host, so any `http://<scheme>.evil.com/` was classified as a local origin and could invoke local-only IPC commands). MacroVox's webviews load only local bundled pages and we don't register a custom URI scheme protocol that creates the `app.localhost` mapping, so the attack surface isn't reachable from our flows : but it's a direct dep on the platform we ship to most users. Bump also moved `tauri-runtime-wry`, `wry`, `tao`, and `tray-icon` along with it.
- **`openssl` bumped 0.10.78 → 0.10.79** : patches `GHSA-xp3w-r5p5-63rr` (UB in `X509Ref::ocsp_responders` for certs with non-UTF-8 OCSP URLs). Pulled in transitively via `reqwest` + `tokio-tungstenite` → `native-tls`. Not exploitable in MacroVox (we never call `ocsp_responders`, and on Windows `native-tls` uses SChannel rather than openssl), but updating closes the alert. `glib` 0.18.5 (medium) and `rand` 0.7.3 build-dep (low) remain pinned by upstream gtk-rs / Tauri's `kuchikiki` chain and will move when those parents do.
- **Delta audit, 2026-04-19** : focused review of all code changes via the `/security-review` workflow. No vulnerabilities introduced (0 Critical / 0 High / 0 Medium / 0 Low). Details: [SECURITY_AUDIT_2026-04-19.md](SECURITY_AUDIT_2026-04-19.md).
- **CORS: reject unknown origins** : Netlify proxy functions (`claude-proxy`, `deepgram-proxy`) previously fell back to the first allowed origin when the request origin didn't match the allowlist, effectively allowing any origin. Now returns 403 for unknown origins. Comparison is also case-insensitive now.
- **Per-user rate limiting on proxy functions** : `claude-proxy` (200/hour) and `deepgram-proxy` (300/hour) now track API calls per user via Supabase `api_usage` table. Returns 429 with `Retry-After` header when exceeded.
- **`user_id` body parameter validated against JWT** : `claude-proxy` rejects requests where the `user_id` in the body doesn't match the authenticated JWT user, preventing impersonation.
- **Payload size limits** : `claude-proxy` rejects request bodies over 512 KB. `deepgram-proxy` rejects audio over 25 MB. Prevents resource exhaustion and cost abuse.
- **Input validation on `claude-proxy`** : messages array structure validated (role must be `user`/`assistant`, content must be string). System prompt capped at 10,000 chars; individual messages capped at 100,000 chars.
- **Deepgram proxy parameter whitelisting** : model and language parameters are whitelisted against known-good values. Content-Type validated against allowed audio formats.
- **Removed `shell:allow-execute` capability** : unused but dangerous IPC permission removed from Tauri capabilities. `shell:allow-open` retained for OAuth URL opening.
- **CSP pinned to specific subdomains** : replaced wildcard `https://*.supabase.co` and `https://*.netlify.app` with exact project URLs. Removed unnecessary `wasm-unsafe-eval`. Added `wss://api.deepgram.com` for WebSocket streaming.
- **Keywords capped at 50 entries, 100 chars each** : prevents URL length abuse and Deepgram API rejection.
- **API key error messages sanitized** : Deepgram WebSocket connection errors no longer include the API key value in error strings. Console logs no longer print API key prefixes.
- **Prompt injection mitigation** : user-controlled context fields (`post_processing_context`, `writing_style_profile`) are wrapped in XML boundary tags with explicit instructions not to follow any embedded instructions. Both fields capped at 1,000 chars.
- **Deepgram response validation** : `recording_stop` now checks HTTP status before parsing, validates JSON structure with `.get()` chains, and returns proper error messages on non-2xx or malformed responses. Previously treated error responses as empty successful transcriptions.
- **Console log cleanup** : removed API key confirmation logs, replaced `console.error` with `console.warn` for non-critical failures, stripped error objects from log output. Server-side logs include error messages only, not full stack traces.
- **Supabase Edge Functions hardened** : `create-checkout` and `billing-portal` reject unknown CORS origins. Plan parameter validated against allowlist. Error logs sanitized to not leak stack traces or PII (user IDs removed from webhook logs). `stripe-webhook` signature verification error no longer logs the raw error.
- **Dev bypass flags hardened for production** : Netlify proxy functions now check `process.env.CONTEXT !== 'production'` in addition to `DEV_BYPASS_AUTH`, preventing accidental bypass on production deploys.
- **API usage logging errors caught** : fire-and-forget `.insert()` calls in both proxy functions now have `.catch()` handlers to log failures instead of silently swallowing them.
- **`.gitignore`** : added `*.key`, `*.key.pub`, `.tauri/` patterns as defense-in-depth so a stray copy of the signing key inside the repo tree can't accidentally be committed.
- **Supply-chain hardening, 2026-05-10** : third-party audit pass (semgrep, codeql, gitleaks, trufflehog, osv-scanner, scorecard, zizmor, cargo-deny). Cleaned up the actionable findings:
  - All 13 GitHub Action references in `.github/workflows/ci.yml` and `release.yml` are now pinned to commit SHAs with trailing version comments (closes zizmor `unpinned-uses`). Dependabot's `github-actions` ecosystem keeps the pins fresh.
  - **Workflow least-privilege** : `ci.yml` and `release.yml` now declare workflow-level `permissions: contents: read`, every `actions/checkout` step sets `persist-credentials: false`, and the `release.yml` rust-cache step is `save-if: false` so tag builds with signing secrets can restore from cache but never write back (closes zizmor `excessive-permissions`, `artipacked`, `cache-poisoning`).
  - New `.github/workflows/semgrep.yml` : SAST gate pinned to semgrep 1.162.0, same pack set the local audit uses (`p/security-audit`, `p/secrets`, `p/javascript`, `p/typescript`, `p/rust`, `p/nodejs`). Gates on ERROR-severity only to avoid false-positive churn. Satisfies scorecard's SAST check. First-run findings cleared: the 4 Python launcher stubs (`debug.py`, `dev.py`, `functions.py`, `ui.py`) converted from `subprocess.run(f"... shell=True)` to argv lists; `run.py` and `src/main/audio.ts` retain `shell=True` / `spawnSync(ffmpegPath, ...)` with inline `nosemgrep:<rule-id>` markers + rationale comments (dev-launcher PATH resolution for `.cmd` shims, and the audit's M5 already-applied argv-list fix respectively).
  - New `SECURITY.md` documents the private-disclosure flow (advisory link + email fallback, 3-day ack / 7-day assessment / 30-day fix timeline).
  - New `.github/dependabot.yml` schedules weekly npm + cargo + github-actions updates. Ignores the upstream-pinned gtk-rs family, `glib 0.18.x`, and `rand 0.7.x` so Dependabot doesn't open unmergeable PRs.
  - New `src-tauri/deny.toml` (project-specific, replaces the audit tool's default): advisory-ignores the same deferred RUSTSEC IDs codified in dependabot.yml, skip-trees Tauri/wry/windows/objc2/ndk for the unavoidable multi-version churn, adds BSL-1.0 exceptions for `clipboard-win` and `error-code`.
  - New `docs/KEY_ROTATION.md` runbook for the still-pending Anthropic + Deepgram managed-key rotation (referenced from `SECURITY_AUDIT_2026-04-16.md § C2`).
  - **`whisper_transcribe_impl` now validates sample_rate** : feature-gated local-STT path previously accepted `sample_rate` and ignored it, silently producing garbled transcription on any non-16kHz mic. Now returns an explicit error if the rate isn't 16 kHz. Closes codeql `unused-variable` at `commands.rs:655` by actually using the parameter.
  - **Capability rationale inlined** : `src-tauri/capabilities/default.json` `description` field now lists per-permission justification (`shell:allow-open`, `process:allow-restart`, `updater:default`, `clipboard-manager:allow-write-text`) so the next audit doesn't re-flag permissions required for documented features.
  - **Audit addendum** : `docs/SECURITY_AUDIT_2026-04-16.md` gained a 2026-05-10 section dispositioning the items the new audit re-flagged: CSP `style-src 'unsafe-inline'` (required by React inline styles, accepted because `script-src` stays `'self'`), the shell + process capabilities (accepted, see above), and the Deepgram origins in CSP (required for free-tier path, tracked alongside the C5 follow-up).
  - **C5 migration plan, targets v1.0.8** : `docs/PLAN_DEEPGRAM_PROXY_MIGRATION.md` walks the implementation of Deepgram's ephemeral-token flow (verified `POST /v1/auth/grant`, 30s JWT, WebSocket-handshake-only auth) so the master key stops shipping to the renderer. Phase 1 = Netlify token endpoint, Phase 2 = Tauri/renderer wiring (`Authorization: Token` → `Bearer`), Phase 3 = drop `managed_api_keys.deepgram_key` in v1.0.9. Estimated ~4.5 h. Deferred out of v1.0.7 to keep the launch stable.

### Dependencies

- **`openssl` 0.10.76 → 0.10.78** : patches 4 advisories: PSK/cookie trampolines leaking adjacent memory (high), `MdCtxRef::digest_final` writing past caller buffer (high), incorrect bounds assertion in AES key wrap (high), and oversized PEM password-callback length (low). Transitive via `native-tls`.
- **`rustls-webpki` 0.103.12 → 0.103.13** : patches a high-severity DoS via panic on a malformed CRL `BIT STRING`. Transitive via `rustls`.
- **`rand` 0.8.5 → 0.8.6** : patches a low-severity unsoundness with custom loggers using `rand::rng()`.
- **`postcss` 8.5.8 → 8.5.12** : patches a medium-severity XSS via unescaped `</style>` in PostCSS's CSS stringify output (GHSA-qx2v-qp2m-jg93). devDependency only (Tailwind/autoprefixer build chain).
- **`urlencoding`** crate added : for encoding keyword boost parameters in Deepgram API URLs.

Two upstream-pinned advisories remain open and are not patchable from our `Cargo.toml`:
- **`glib` 0.18.5** (medium, unsoundness in `VariantStrIter`) : pulled in by `gtk` 0.18 via Tauri 2.10's GTK stack. Linux-only build path; we don't construct `VariantStrIter` ourselves. Will clear when Tauri upgrades to gtk-rs 0.20+.
- **`rand` 0.7.3** (low) : build-only dep of `phf_codegen` via `tauri-utils`; never compiled into the runtime binary.

### Cleanup

- **Removed legacy Electron artifacts** : deleted `build/` directory (old Electron builder configs and PyInstaller outputs). Removed `electron` and `electron-builder` from devDependencies. Removed stale npm scripts (`start`, `package`, `package:win`, `package:dev`).
- **Removed stale design docs** : deleted 5 pre-implementation design documents for features already shipped.
- **Moved `LLM_ONBOARDING.md`** to `docs/` directory.
- **Updated `README.md`** : refreshed feature list, fixed model name (`nova-2` → Nova-3), updated project structure, added new features.
- **App icon made square** : source PNG was 1326×1294 (not square), causing rendering issues. Padded to 1326×1326 and regenerated all sizes (32, 64, 128, 256, 512, ICO, ICNS) via `npx tauri icon`.
- **Tray icon converted to RGBA** : was RGB (no transparency).

### Docs

- **`docs/RELEASE.md`** : covers version bump, per-platform bundle build, `latest.json` generation, updater-artifact requirements, signing-wrapper notes, and known Wayland limits.
- **`docs/RELEASE_CHECKLIST.md`** : preflight gate for releases (tests, smoke tests, signing, Dependabot status, doc updates).
- **`docs/LAUNCH_PLAN.md`** : go-to-market plan; Phase 1 keypair + workflow tasks ticked.
- **README** title updated to "Voice Dictation for Windows & Linux"; added a **Linux notes** section covering runtime dependencies, display-server caveats (X11 full parity / Wayland limits), and the mic-picker filter.
- **`docs/STATUS_AND_ROADMAP.md`** : Linux App row moved from 🔜 Planned to 🧪 Beta; macOS split into its own row.

---

## v1.0.6 (2026-03-17) : Transcript Disappears After Second Recording Fix

### Bug Fixes
- **Fixed transcript not appearing on subsequent recordings** : `handleStopRecording` and `handleStopAndCopy` closed over a stale `transcript` state variable. When AI post-processing (Claude) resolved after a second recording had already updated the transcript, the `.then()` callback overwrote the current transcript with a value computed from the stale closure. The second recording's text was silently replaced.
- **Fix**: All `setTranscript` calls in async callbacks now use React functional updaters (`prev => ...`) so they always operate on the latest state. The `postProcess().then()` callback uses `prev.replace(rawSegment, cleaned)` to surgically swap only the raw segment with the cleaned version, regardless of what other recordings have appended in the meantime.

---

## v1.0.5 (2026-03-17) : Program Files Install + Upgrade Reliability

### Changes
- **MacroVox now installs to `C:\Program Files\MacroVox`** : switched from per-user (`AppData\Local\Programs`) to per-machine install. Registers in HKLM. Requires admin elevation (UAC prompt shown once during install).
- **Desktop shortcut now appears on all user desktops** : `C:\Users\Public\Desktop`, matching Windows conventions for machine-wide installs.
- **Start Menu shortcut in `C:\ProgramData\Microsoft\Windows\Start Menu\Programs\MacroVox`** : visible to all users on the machine.

### Bug Fixes
- **Fixed "Failed to uninstall old application files" error during upgrades** : `taskkill` ran but only waited 1.5 s before the upgrade uninstaller fired. If Electron hadn't released all file handles yet, the uninstaller exited with code 2. Fix: poll for process exit in a loop (up to 8 s) before handing control back to the installer.
- **Migration from v1.0.4 and earlier** : old per-user installs (`AppData\Local\Programs\macrovox`) are detected during `customInstall` and the user is offered a silent uninstall before the new Program Files install proceeds.

---

## v1.0.4 (2026-03-17) : Desktop Shortcut Fix

### Bug Fixes
- **Fixed Desktop shortcut not created during install** : The NSIS `$DESKTOP` variable resolves to the All Users desktop (`C:\Users\Public\Desktop`) when the installer runs elevated via UAC, even for per-user installs. The shortcut was created in the wrong location and never appeared on the user's Desktop.
- **Fix**: `customInstall` and `customUnInstall` now read the correct desktop path directly from `HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders\Desktop`, with `$PROFILE\Desktop` as fallback. Start Menu shortcut was unaffected.

---

## v1.0.3 (2026-03-17) : Transcription Works More Than Once Fix

### Bug Fixes
- **Fixed transcription only working once per launch (batch mode)** : `DictationMode.tsx` called `setIsProcessing(false)` *inside* the `if (result.transcript)` branch. When Deepgram returned an empty transcript (e.g. silence or very short audio), `isProcessing` was never cleared, permanently disabling the record button for the rest of the session.
- **Fix**: Moved `setIsProcessing(false)` to execute unconditionally immediately after `stopRecording()` returns, in both `handleStopRecording` and `handleStopAndCopy`.
- **Fixed dead-process recovery in batch recording** : If the pre-warmed ffmpeg process had exited (e.g. device error, system sleep), `recording:start` would call `startBuffering()` on the dead `AudioCapture` instance and silently capture nothing. No audio would be buffered and every subsequent recording would return an empty transcript.
- **Fix**: `recording:start` now checks `isRunning()` and, if false, explicitly stops and replaces the stale `AudioCapture` instance before starting a fresh ffmpeg process.

---

## v1.0.2 (2026-03-09) : Auth Token Path Fix

### Bug Fixes
- **Fixed "No API key" shown after v1.0.1's IPC bridge fix** : `main-dictation.ts` was reading token files from `app.getPath('userData')` which resolves to `%APPDATA%\macrovox` (MacroVox's own userData directory). GitConnect Pro writes its tokens to `%APPDATA%\gitconnect-desktop`. These are separate directories so MacroVox found no token files and returned `{ success: false }` on every `auth:getToken` call.
- **Fix**: Now uses Supabase Auth with its own session storage : no longer depends on any external app's credential store.

---

## v1.0.1 (2026-03-09) : Auth IPC Bridge Fix

### Bug Fixes
- **Fixed "No API key" warning on first launch when already logged in** : `preload.ts` was missing `getToken`, `fetchGitHubUser`, `getManagedKeys`, and `onTokenReady`. The IPC bridge was incomplete, so `DictationMode` could never read the stored token or fetch managed API keys.
- **Fix**: Added the missing IPC methods to `preload.ts` with corresponding handlers in `main.ts`.

---

## v1.0.0 (2026-03-09) : Initial Release

### New Features
- Standalone MacroVox dictation app
- NSIS installer + portable executable, both code-signed with EV certificate
- **Batch mode**: Record audio, then transcribe all at once (higher accuracy)
- **Streaming mode**: Real-time word-by-word transcription via WebSocket
- **Smart Clipboard**: Auto-copy on stop, optional auto-paste into previous app
- **AI Post-Processing**: Optional Claude-powered cleanup of speech-to-text errors
- **6 themes**: MCRN, Mars, Belter, Earth, Protomolecule, Laconia
- **System tray**: Minimize to tray, context menu, `Ctrl+Space` global shortcut
- **Single-instance lock**: Prevents duplicate processes

### Architecture
- `main.ts` : Standalone main process
- `preload.ts` : Restricted IPC surface (audio, clipboard, settings, auth)
- Shared renderer: `DictationMode.tsx`, `SettingsPanel.tsx`, themes
- Separate build config: `build/electron-builder.json`
- NSIS installer: `build/installer.nsh` with previous-version detection
