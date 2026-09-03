# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

MacroVox is a Windows-first (Linux beta, macOS planned) voice-dictation desktop app built on Tauri 2: a Rust backend in [src-tauri/](src-tauri/) plus a React 18 + Vite + Tailwind renderer in [src/renderer/](src/renderer/). It is an accessibility tool the owner uses daily. The core pipeline is audio -> Deepgram -> Claude: cpal/WASAPI captures the mic, Deepgram nova-3 does STT (WebSocket streaming by default, batch REST fallback), and Claude Haiku cleans up the transcript in the background before an optimistic auto-paste. Two key-access tiers coexist: managed (Pro/Team subscribers, real keys held server-side behind Netlify/Supabase) and bring-your-own-key (user pastes their own Deepgram/Anthropic key in Settings, no sign-in required).

## Commands

The dev launcher is the Python wrapper [run.py](run.py) at repo root (checks Node 20+/Rust prereqs, runs `npm install`, then `npx tauri dev`). The root `dev.py`/`debug.py`/`ui.py`/`functions.py` are double-click shims for `run.py <mode>`.

| Task | Command |
| --- | --- |
| Run full app (recommended) | `python run.py` (or `python run.py dev`) |
| Run with debug logs + DevTools | `python run.py debug` (RUST_LOG=debug, RUST_BACKTRACE=1) |
| Renderer-only (Vite, CSS/UI work; IPC fails) | `python run.py ui` (localhost:5173) |
| Local Netlify functions + Vite | `python run.py functions` (localhost:8888) |
| Run full app directly | `npx tauri dev` |
| Production build | `npx tauri build` |
| Renderer tests (all) | `npm test` |
| Single test FILE | `npx vitest run src/renderer/lib/__tests__/auth.test.ts` |
| Single test CASE | `npx vitest run <file> -t "name substring"` |
| Rust tests (all) | `npm run test:rust` |
| Single Rust test | `cargo test --manifest-path src-tauri/Cargo.toml <name>` |
| TS typecheck (the TS "lint", CI runs this) | `npx tsc --noEmit` |
| Rust lint (warnings = errors) | `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` |
| Tauri version-drift check | `npm run check:versions` |
| Build with offline Whisper STT | `cargo build --manifest-path src-tauri/Cargo.toml --features local-stt` |

**CI** ([.github/workflows](.github/workflows)): tauri version parity, TypeScript (`tsc --noEmit` + `npm test`), Rust clippy (`-D warnings`), Python (`pyright` over run.py and the shims), plus Semgrep (CI only, ERROR severity gates). Keep `run.py` and the other Python shims pyright-clean.

Pre-push gates: `npm test`, `npm run test:rust`, `npx tsc --noEmit`, `npm run check:versions`, plus `cargo fmt` and `cargo clippy`. There is NO ESLint anywhere; TS static analysis is `tsc --noEmit` plus Semgrep (CI only, ERROR severity gates).

Release is split-host and mostly manual (see [docs/RELEASE.md](docs/RELEASE.md)). Pushing a `v*.*.*` tag triggers [.github/workflows/release.yml](.github/workflows/release.yml), which builds ONLY the Linux bundle and uploads it as a `linux-bundle` artifact (it does NOT publish a GitHub release). Windows installers are built + EV-signed locally (SafeNet eToken), then published by hand to the SEPARATE public repo `okstudio1/macrovox-releases`. Staging scripts: `npm run release:windows` / `release:linux` / `release:manifest` / `release:sbom`.

## Architecture

**Rust backend ([src-tauri/](src-tauri/)).** Owns audio capture (cpal/WASAPI), STT (Deepgram streaming WS + batch REST, optional local whisper-rs), a rolling OGG-Opus dictation-history "voice buffer", native auto-paste (enigo SendInput), the global hotkey, and a two-window model. All mutable state lives in a single `AppState` ([src-tauri/src/state.rs](src-tauri/src/state.rs)) injected via `tauri::State`. Entry point [src-tauri/src/main.rs](src-tauri/src/main.rs) is a stub calling `macrovox_lib::run()`; real setup (plugin + window + hotkey registration) is [src-tauri/src/lib.rs](src-tauri/src/lib.rs). Key modules: `commands.rs` (IPC), `audio.rs` (cpal/WASAPI), `deepgram_ws.rs`, `voice_buffer.rs`, `platform.rs`. Read [src-tauri/ARCHITECTURE.md](src-tauri/ARCHITECTURE.md) first (it is accurate but stale in a few spots, see Gotchas).

**The IPC contract.** The renderer talks to Rust ONLY through 28 `#[tauri::command]` functions (all in [src-tauri/src/commands.rs](src-tauri/src/commands.rs)) plus backend->renderer emit events. Two files must stay in lockstep: every command must be listed in the `tauri::generate_handler![...]` macro in [src-tauri/src/lib.rs](src-tauri/src/lib.rs) AND mirrored in the typed bridge [src/renderer/lib/tauri-ipc.ts](src/renderer/lib/tauri-ipc.ts). That bridge is the single import surface for the renderer (`import * as ipc from '../lib/tauri-ipc'`); it wraps `invoke()` for commands and `listen()`/`emit()` for events, and deliberately mirrors the old Electron `window.electronAPI.*` shape. JS camelCase args auto-convert to Rust snake_case. Emit events (the push side): `deepgram:transcript` `{transcript,isFinal}`, `deepgram:error`, `quick-dictation-toggle` (global hotkey, default Ctrl+Space), `theme-changed`, `settings-changed`, `voice-buffer-updated`.

**Multi-window model.** Exactly two windows, both declared in [src-tauri/tauri.conf.json](src-tauri/tauri.conf.json) and both starting `visible:false`: `main` (frameless always-on-top dictation HUD, dictation.html) and `settings` (settings.html). Each HTML file is a SEPARATE Tauri webview with its own React root ([src/renderer/dictation.tsx](src/renderer/dictation.tsx), [src/renderer/settings.tsx](src/renderer/settings.tsx)), built as a Vite multi-entry via `rollupOptions.input` in [vite.config.ts](vite.config.ts). The two webviews do NOT share JS memory, DOM events, or localStorage; anything crossing windows must go through the Tauri event bus (`broadcastSettings`->`settings-changed`, `broadcastThemeChange`->`theme-changed`, `emitVoiceBufferUpdated`->`voice-buffer-updated`). Tauri 2 quirk: programmatically-created windows always resolve to `tauri://localhost`, so all windows MUST be declared in the config; `settings_open_window` just calls `show()+set_focus()`.

**Dictation + post-processing flow.** [src/renderer/components/DictationMode.tsx](src/renderer/components/DictationMode.tsx) is the live UI. It does NOT use the `useDeepgram` hook; it inlines record/transcribe state and calls `ipc.startDeepgram`/`startRecording`/`stopRecording` directly. Supports `batch` (upload on stop) and `streaming` (live WS, final fragments via `ipc.onTranscript`). After an optimistic raw-text clipboard copy, AI cleanup runs in the background via [src/renderer/hooks/usePostProcessing.ts](src/renderer/hooks/usePostProcessing.ts): if `localStorage.user_anthropic_key` is set it POSTs directly to api.anthropic.com; otherwise it uses the managed Netlify claude-proxy with a Supabase bearer token (fails closed otherwise). Cleanup model is `claude-haiku-4-5-20251001` (see [src/renderer/config.ts](src/renderer/config.ts)).

**Two-tier JS/TS build.** [vite.config.ts](vite.config.ts) bundles the live renderer (`src/renderer/**`) to `dist/renderer`. SEPARATELY, [config/tsconfig.main.json](config/tsconfig.main.json) compiles `src/main/**` to `dist/main` as CommonJS. The `src/main` project is dead Electron-era code (see Gotchas). `npm run build` runs both JS pipelines but NOT Rust; `npx tauri build`'s `beforeBuildCommand` runs only `build:renderer`.

**Managed backend.** Real STT/LLM keys never ship in the client. BYOK path: `localStorage.user_deepgram_key`/`user_anthropic_key` win and skip sign-in. Auth/billing are entirely renderer-side via the Supabase JS SDK ([src/renderer/lib/auth.ts](src/renderer/lib/auth.ts), [src/renderer/lib/supabase.ts](src/renderer/lib/supabase.ts)), using `VITE_SUPABASE_URL` + `VITE_SUPABASE_KEY` (anon key, client-safe). The Netlify claude-proxy ([netlify/functions/claude-proxy.ts](netlify/functions/claude-proxy.ts)) holds `ANTHROPIC_MANAGED_KEY` and gates on: origin allowlist -> Supabase JWT verify -> `subscriptions.status` in (pro,team) -> hourly rate limit -> model allowlist. Deepgram streaming goes through [deepgram-grant](netlify/functions/deepgram-grant.ts), which holds `DEEPGRAM_MANAGED_KEY`, runs the same gate, and returns a ~60 s token from Deepgram's `/v1/auth/grant`. The managed key never reaches the client: [src/renderer/lib/deepgramCredential.ts](src/renderer/lib/deepgramCredential.ts) resolves a `DeepgramCredential` per call (BYOK is `api_key` and uses the `Token` scheme, managed is `access_token` and uses `Bearer`), and the Rust side keeps the two apart in the type ([src-tauri/src/deepgram_ws.rs](src-tauri/src/deepgram_ws.rs)). A `deepgram-proxy` also exists and is still UNUSED; it only ever served the batch path. Stripe runs as Supabase EDGE functions (Deno) in [supabase/functions/](supabase/functions/): create-checkout, billing-portal, stripe-webhook (the webhook has `verify_jwt=false` and checks Stripe's HMAC itself).

## Gotchas

**`src/main/*` is DEAD Electron code, do not edit it expecting runtime effect.** package.json has no `electron` dependency, so it cannot even compile against installed deps; no release path builds or imports it. `main: dist/main/main.js` and the `build:main`/`dev:main`/`clean:main` scripts are vestigial. Live equivalents: backend -> [src-tauri/src/](src-tauri/src/); renderer IPC -> [src/renderer/lib/tauri-ipc.ts](src/renderer/lib/tauri-ipc.ts); auth/billing -> [src/renderer/lib/auth.ts](src/renderer/lib/auth.ts).

**`npm run dev` is NOT how you run the app.** It only starts Vite + the legacy `src/main` tsc watch (no Rust window). Use `python run.py` or `npx tauri dev`.

**Deferred-but-in-tree.** `AgentiveWriting.tsx` + `useAgentiveWriting.ts` (the Write tab, removed from UI for v1) have no live parent that mounts them. `useDeepgram.ts` and `useUpdater.ts` are ALSO unused. Do not assume these hooks reflect live behavior; edit DictationMode/usePostProcessing for real changes.

**Adding a broadcastable setting requires two coupled edits or it silently breaks:** the `ALLOWED_SETTINGS_KEYS` allow-list in [src/renderer/lib/tauri-ipc.ts](src/renderer/lib/tauri-ipc.ts) (else `onSettingsChanged` drops it; this is a prompt-injection guard since some values feed Claude prompts), plus the bulk-sync `keys` array in SettingsPanel's open effect. Themes do NOT go through the settings broadcast: they use the dedicated `broadcastThemeChange`/`theme-changed` event and persist under localStorage key `app_theme` (not `theme`).

**Deepgram nova-3 keyword footgun:** use `&keyterm=` NOT the legacy `&keywords=` (which 400s on nova-3). Duplicated in three Rust call sites (recording_stop, voice_buffer_reprocess, deepgram_ws::start_session); change all three together.

**Wayland:** auto-paste and global hotkeys have no reliable path. [src-tauri/src/platform.rs](src-tauri/src/platform.rs)::`is_wayland()` gates this; `dictation_auto_paste` short-circuits with an error (clipboard copy still works for manual paste). X11 has full parity.

**Version is set in three manifests that must be bumped together** (their lockfiles follow): package.json, [src-tauri/tauri.conf.json](src-tauri/tauri.conf.json) (the authoritative user/updater version), and [src-tauri/Cargo.toml](src-tauri/Cargo.toml). All aligned at 1.0.8 now, but nothing enforces it: `npm run check:versions` only compares the tauri crate vs `@tauri-apps/api` major.minor, NOT the app version. On release, bump all three (and let `npm install` / `cargo build` update package-lock.json / Cargo.lock).

**CSP is an explicit allowlist** in [src-tauri/tauri.conf.json](src-tauri/tauri.conf.json) `connect-src` (self, Supabase host, macrovox.tech, Deepgram, api.anthropic.com), duplicated in the `<meta>` tags of dictation.html/settings.html. Adding a backend host means editing all of them or requests are blocked.

**Shared cargo target dir (this machine):** if `~/.cargo/config.toml` redirects Rust output (here to `C:/Users/Owen/cargo-target`), bundles land there, NOT under `src-tauri/target/`. `npm run release:windows` reads the `src-tauri/target` path and will silently copy nothing; copy Windows artifacts by hand in that case.

## Conventions

- **Conventional commits** (feat/fix/docs/refactor/chore/test), subject under ~72 chars. NEVER add `Co-Authored-By` trailers or any AI attribution.
- **NEVER use em dashes or en dashes** anywhere (code, docs, commits, PRs); use periods, colons, commas, or parentheses.
- **No ESLint anywhere.** TS static analysis is `tsc --noEmit` (TypeScript strict mode) plus Semgrep (CI). Rust: `cargo fmt` + clippy.
- Tests required for behavior changes: renderer -> Vitest in `src/renderer/**/__tests__/`; backend -> `#[cfg(test)]` under `src-tauri/src/`.
- TSDoc/rustdoc on exported APIs; inline comments only for non-obvious "why".
- **Accessibility is a hard requirement** for any UI change: large targets, clear feedback, no fast or fine motor control needed.

## When to ask

- Changing the IPC surface, the Netlify/Supabase proxies, CSP/`connect-src`, or Stripe/billing flows (security and revenue impact).
- Editing signing / release scripts or the updater manifest.
- Any change to the audio pipeline or the Deepgram/Claude request paths (call it out in the PR per CONTRIBUTING.md).
- Schema or `subscriptions` gating changes, or anything that would place a real key in the client.
- Ambiguous spec, or a change that would touch the dead `src/main` / deferred hooks (confirm it is actually wired to live code first).