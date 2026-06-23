# MacroVox: A Managed, Low-Latency Voice Dictation System

**Technical White Paper — v1.0**
OK Studio · 2026-05-01

---

## Abstract

MacroVox is a desktop voice-dictation application that converts speech to text in real time and inserts the result into the user's active application. It targets Windows as a primary platform and Linux (X11, with degraded Wayland support) as a beta. Two characteristics distinguish MacroVox from existing solutions: (1) it is delivered as a **fully managed service** — the end user supplies no API keys, configures no providers, and runs no local models — and (2) it is built on a **native Rust capture and streaming pipeline** under a Tauri 2 shell, rather than an Electron/Web Audio stack, in pursuit of consistently sub-second perceived latency.

This paper describes the system architecture, the audio and transcription pipeline, the AI post-processing stage, the security and billing infrastructure, the platform-specific trade-offs, and the engineering decisions behind the Tauri-over-Electron migration that defines the v1.0 release.

---

## 1. Introduction

### 1.1 Problem statement

Voice dictation on the desktop is a mature category, but real-world usage exposes three persistent failure modes:

1. **Setup friction.** OS-bundled dictation (Windows Speech Recognition, macOS Dictation) is uneven across languages and applications; third-party offerings frequently require users to obtain and configure their own API keys for cloud STT providers. For users with motor disabilities — for whom dictation is an accessibility tool, not a convenience — that configuration step is itself a barrier.
2. **Perceived latency.** End-to-end latency (button press to text appearing in the target app) is dominated not by the speech-to-text model, but by the surrounding stack: audio capture buffering, language-runtime overhead, IPC hops, and the cost of injecting text into the foreground window. Web-audio-based clients in particular accumulate jitter in each layer.
3. **Transcript quality at edges.** Streaming STT models produce raw output that includes filler, disfluencies, and inconsistent punctuation. For long-form dictation this produces text that is technically correct but practically unusable without manual cleanup.

### 1.2 Design goals

MacroVox is designed around four goals, in priority order:

1. **Zero-configuration usage.** A user installs the app, signs in, subscribes, and dictates. No API keys, no model downloads, no audio device wizards.
2. **Low and predictable end-to-end latency.** Capture, stream, and inject in a path that minimises copies, allocations, and cross-runtime hops.
3. **Quality output by default.** Every Pro transcript is post-processed by an LLM cleanup pass that runs in the background without blocking the paste.
4. **Accessibility as the primary use case.** The product is built and tested as a daily-use input method for users with motor disabilities, not as a productivity novelty.

### 1.3 Non-goals

MacroVox does not target offline / on-device transcription in v1. It does not provide command-and-control automation ("open Outlook"). It does not aim to be a general-purpose voice agent. These are out of scope by design — adding them would compromise the latency budget or the managed-service model.

---

## 2. System Architecture

MacroVox is a four-tier system: a native desktop client, a serverless proxy layer, a managed identity and billing tier, and two third-party AI providers reached only through the proxy layer.

```
┌─────────────────────────────────────────────────────────────────┐
│                       Desktop Client (Tauri 2)                   │
│ ┌──────────────────────────┐    ┌────────────────────────────┐  │
│ │  Rust Backend            │    │  React Renderer (Vite)     │  │
│ │  — cpal WASAPI capture   │◄──►│  — Dictation + Settings UI │  │
│ │  — Deepgram WS streaming │ IPC│  — Theme system            │  │
│ │  — enigo key injection   │    │  — Supabase JS auth client │  │
│ │  — Voice buffer (Opus)   │    │                            │  │
│ └─────────────┬────────────┘    └──────────────┬─────────────┘  │
└───────────────┼──────────────────────────────────┼──────────────┘
                │                                  │
                │ wss (Bearer)                     │ https
                ▼                                  ▼
   ┌────────────────────┐         ┌──────────────────────────────┐
   │ Netlify Functions  │         │ Supabase Edge Functions      │
   │ — claude-proxy     │         │ — create-checkout            │
   │ — deepgram-proxy   │         │ — billing-portal             │
   │   (CORS-pinned to  │         │ — stripe-webhook             │
   │    macrovox.tech)  │         └────────────┬─────────────────┘
   └────────┬───────────┘                      │
            │                                  ▼
            ▼                       ┌──────────────────────┐
   ┌───────────────────┐            │ Supabase (Auth + DB) │
   │ Deepgram Nova-3   │            │ — users              │
   │ Claude Haiku 4.5  │            │ — subscriptions      │
   └───────────────────┘            │ — managed_api_keys   │
                                    └──────────┬───────────┘
                                               │
                                               ▼
                                       ┌──────────────┐
                                       │   Stripe     │
                                       └──────────────┘
```

### 2.1 Tier responsibilities

- **Desktop client.** Owns the entire real-time audio path: capture, encoding, WebSocket streaming, transcript display, clipboard write, and key injection. Authenticates the user against Supabase and obtains a JWT used to authorise calls to the proxy layer.
- **Proxy layer (Netlify Functions).** Two stateless functions that hold provider credentials and forward authenticated client requests to Deepgram and Claude. The client never sees a Deepgram or Anthropic API key. CORS is pinned to the production origin (`macrovox.tech`).
- **Identity and billing (Supabase Edge Functions + Stripe).** Three edge functions handle subscription creation, the customer portal, and the Stripe webhook that flips a subscription row to active. Subscription state is the gate that the proxy layer checks before forwarding any STT or LLM request.
- **Providers.** Deepgram Nova-3 for STT (streaming WebSocket, batch HTTP fallback). Anthropic Claude Haiku 4.5 for transcript cleanup.

### 2.2 Technology selection

| Layer | Choice | Rationale |
|---|---|---|
| Shell | Tauri 2 | Native binaries, WebView-based UI without bundling Chromium, direct Rust backend, signed installer support. |
| Audio capture | `cpal` (WASAPI on Windows, ALSA/PulseAudio on Linux) | Cross-platform, low-overhead, callback-driven; no Web Audio jitter. |
| STT transport | `tokio-tungstenite` (WebSocket) | Persistent connection to Deepgram, single TLS handshake amortised across many utterances. |
| Key injection | `enigo` (X11/Windows/macOS) + `wtype`/`ydotool` (Wayland) | Synthesises native key events; `enigo` covers Windows, macOS, and X11, with a `wtype`/`ydotool` fallback on Wayland (see §6). |
| Frontend | React + Vite + Tailwind | Fast HMR for theme/UI work; small bundles into the WebView. |
| Auth | Supabase JS SDK in the renderer | Renderer holds the session; the Rust backend reads the bearer token via IPC for its own authenticated calls. |
| Billing | Stripe + Supabase Edge Functions | Subscription state lives next to user identity; webhook is the single source of truth. |

The previous iteration used Electron with a Web Audio capture pipeline. The migration to Tauri (described in §7) was driven primarily by latency — Web Audio's `MediaRecorder` and `AudioWorklet` paths added buffering that was visible to end users — and secondarily by installer size.

---

## 3. The Audio and Transcription Pipeline

### 3.1 Capture

Audio is captured by `cpal` on the host's preferred input device. The cpal callback is invoked per device-driven frame (typically ~10 ms of audio at 16 kHz mono, depending on the device's default configuration). Each callback:

1. Updates a level meter consumed by the renderer for the waveform animation.
2. Appends samples to an in-memory ring buffer used for batch fallback and for the rolling voice memo buffer (§3.4).
3. If a streaming session is active and the user is recording, converts the f32 frame to interleaved 16-bit little-endian PCM (`f32_to_i16_bytes`, `src-tauri/src/audio.rs:73`) and pushes it onto a bounded `tokio::mpsc` channel sized at 1000 messages (~10 s of audio) to absorb network jitter without dropping frames under routine conditions. Drops are counted in an `AtomicUsize` and surfaced via a rate-limited log line (one per 100 drops) to make sustained backpressure visible without flooding logs.

The capture path is callback-driven and lock-light: the audio thread holds a mutex for the buffer append and the level write, and is otherwise non-blocking.

### 3.2 Streaming to Deepgram

A persistent WebSocket connection to `wss://api.deepgram.com` is opened by `start_session` in `src-tauri/src/deepgram_ws.rs`. The TLS handshake completes during session start so it is not on the per-utterance hot path. A background `tokio` task owns the socket and pumps the channel:

- `DgMessage::Pcm(bytes)` → binary frame to Deepgram.
- `DgMessage::Stop` → JSON `{"type":"CloseStream"}` and graceful exit.
- Inbound text frames → JSON parse → emit `deepgram:transcript` Tauri event with `{ transcript, isFinal }` to the renderer.

Streaming uses Nova-3 with linear16 encoding, the user's selected language, and a configurable keyword-boost list for domain terminology. Interim and final results are both surfaced — the UI uses interim results for live display and `isFinal` to drive the optimistic-paste path described in §3.5. A batch HTTP path is preserved as a fallback for environments where the WebSocket cannot be established.

### 3.3 Transport authentication

The Deepgram credential is never present on the client. The client connects through a Netlify Function (`deepgram-proxy`) which validates the user's Supabase JWT, checks an active subscription row, and forwards the WebSocket upgrade with a server-side Deepgram key. The Anthropic key follows the same pattern via `claude-proxy`. CORS is restricted to the production origin to prevent the keys from being abused via a hostile page that scrapes the client's bearer.

### 3.4 The rolling voice buffer

Every dictation can be persisted to a per-user rolling buffer for later playback and reprocessing. Buffers are stored under `%LOCALAPPDATA%/com.okstudio.macrovox/voice-buffer/` as OGG Opus files indexed by a `manifest.json`. Opus was chosen over WAV for ~10× storage savings. Eviction is FIFO at a configurable cap (100 MB default) and runs before each new save. A one-shot startup migration (`repair_stretched_recordings`) re-encodes any recordings produced by an earlier encoder pass that stretched durations; the migration is idempotent — files within 50 ms of expected duration are skipped.

The buffer makes two product features practical: (a) the user can replay any past dictation, and (b) any past dictation can be re-run through the full Deepgram + Claude pipeline if the original cleanup was not acceptable. Both are useful for accessibility users who dictate long-form content and benefit from being able to recover when a transcript goes wrong.

### 3.5 Optimistic paste

When the user stops a dictation, two things happen in parallel:

1. The raw final transcript is written to the system clipboard and (if enabled) injected into the previously focused window via `enigo`. The user sees their text in the target app immediately.
2. The same transcript is sent to `claude-proxy` for an LLM cleanup pass. When that returns, the clipboard is updated and the renderer fires a UI event indicating the cleaned version is available.

This is an explicit latency / quality trade. The paste is fast because it does not wait for the LLM; the cleanup arrives ~hundreds of milliseconds later and updates the clipboard transparently. For accessibility users this is the right default — a delayed paste interrupts flow more than a momentarily-uncleaned paste does.

---

## 4. AI Post-Processing

The post-processing stage runs Claude Haiku 4.5 against every transcript with a system prompt that:

- Removes filler words and verbal disfluencies.
- Normalises punctuation and capitalisation.
- Resolves obvious dictation commands ("period", "comma", "new line") that did not collapse during STT.
- Honours per-user "accessibility context" — free-form notes the user provides (e.g., domain vocabulary, names) that the cleanup model is conditioned on.
- Honours the user's number-formatting preference. "Always digits" and "Always words" enforce a uniform style; "Smart" mode applies a contextual rule (digits for currency, measurements, dates, times, percentages, addresses, phone numbers, and any number carrying a unit; words for isolated small numbers used colloquially; digits at 100 and above). Smart mode is implemented entirely in the Claude prompt because Deepgram Nova-3's `smart_format=true` empirically returns spelled-out words for most non-entity numbers, so leaving the decision to Deepgram alone did not match the user-visible promise.

Haiku was chosen over a Sonnet- or Opus-tier model for two reasons: (1) the task is bounded and well-suited to the smaller model's strengths, and (2) tail latency under load is materially lower, which matters because the user is waiting for the clipboard to update.

The LLM call is non-blocking — see §3.5 — so the worst case for a degraded LLM response is a delayed clipboard refresh, not a delayed paste.

---

## 5. Identity, Billing, and Authorisation

### 5.1 Identity

Identity is handled by Supabase Auth, accessed via the JS SDK in the renderer. Sessions persist via the SDK's `localStorage` driver inside the WebView. The Rust backend does not hold credentials directly; when it needs to make an authenticated outbound call (e.g., to a proxy function), the renderer passes the current bearer token via IPC.

This was a deliberate departure from the previous Electron implementation, which used `safeStorage` in the main process. Moving the session into the renderer simplifies refresh handling and lets the Supabase SDK manage token lifecycle without bespoke IPC plumbing.

### 5.2 Billing

Three Supabase Edge Functions back the subscription experience:

- `create-checkout` — produces a Stripe Checkout URL for a 7-day-trial Pro subscription.
- `billing-portal` — produces a customer-portal URL.
- `stripe-webhook` — the source of truth for subscription state changes.

The webhook writes to a `subscriptions` table with row-level security; the proxy layer joins against this table to gate Deepgram and Claude access. A subscription with status `trialing` or `active` admits requests; anything else is rejected at the proxy without forwarding to a provider.

### 5.3 Authorisation flow

```
Client                   Supabase Auth     Proxy (Netlify)     Provider
  │ login (email+pw) ────►│                    │                   │
  │◄── access_token ──────│                    │                   │
  │                                            │                   │
  │ wss / https + Bearer ─────────────────────►│                   │
  │                                            │── verify JWT      │
  │                                            │── check sub row   │
  │                                            │── forward ───────►│
  │                                            │◄── stream / resp ─│
  │◄────────────────────────── stream / resp ──│                   │
```

The Supabase JWT is the only credential that leaves the client. Provider keys are environment variables on the proxy and never appear in any client artefact.

---

## 6. Platform Considerations

### 6.1 Windows

Windows is the primary release target. The release is delivered as an EV-code-signed NSIS installer plus a portable `.exe`, built from the Tauri pipeline. Auto-update is handled by `tauri-plugin-updater`, which checks GitHub Releases on launch and verifies signatures against a public key embedded in the binary. The signing pipeline is shared with other OK Studio apps; signing quirks specific to Tauri 2 (vendored DLL exclusion, `signtool.exe` resolution, Defender lock retry) are implemented in `scripts/sign-windows.ps1`.

### 6.2 Linux

Linux is supported in beta with `.deb`, `.rpm`, and AppImage bundles produced by `npx tauri build` and aggregated by `npm run release:linux`. Runtime dependencies are documented per distro: `libwebkit2gtk-4.1-0`, `libasound2` + `libpulse0`, and `libayatana-appindicator3-1` where the tray is enabled.

The display server matters:

- **X11.** Full parity with Windows — global hotkey, auto-paste, and clipboard all behave identically.
- **Wayland.** Partial. Global hotkeys depend on the compositor's XDG portal and may not register on some compositors. `enigo` cannot synthesise input under Wayland, so auto-paste falls back to a Wayland-native tool — `wtype` (preferred; daemonless) or `ydotool` — detected on `$PATH` at call time (`src-tauri/src/platform.rs`). When one is present, auto-paste works; when neither is installed, MacroVox reports `auto_paste_available: false` via `platform_info` and Settings disables the toggle with an inline note to install a tool or paste the (already-copied) transcript manually.

The Linux microphone picker filters out ALSA's virtual aliases (`hw:`, `plughw:`, `dmix:`, `surround*:`, `iec958:`, `hdmi:`, monitor taps) so the user sees only meaningful devices. The selected device is persisted across restarts.

### 6.3 macOS

macOS is planned but not in v1. The blockers are platform-specific: notarised distribution, the accessibility-permission prompt for global key injection, and a different audio backend (CoreAudio via cpal). None are research problems; they are scheduled work.

---

## 7. The Tauri Migration

The v1.0 release is the first to ship on Tauri 2; the prior internal builds were Electron. The migration was scoped tightly: replace the shell, replace the audio path, replace the streaming path, retain the renderer.

### 7.1 What changed

| Subsystem | Before (Electron) | After (Tauri 2) |
|---|---|---|
| Audio capture | Web Audio (`MediaRecorder` / `AudioWorklet`) | Native `cpal` WASAPI (Win) / ALSA (Linux) |
| STT transport | WebSocket from renderer | WebSocket from Rust, frames pumped via `tokio::mpsc` |
| Key injection | RobotJS | `enigo` |
| Auth credential storage | `safeStorage` in main process | Supabase SDK `localStorage` in renderer |
| Installer | electron-builder NSIS | Tauri NSIS, EV-signed via shared OK Studio pipeline |

### 7.2 What stayed

The renderer (React + Vite + Tailwind), the theme system, the settings model, the Netlify proxies, the Supabase schema, and the Stripe integration were all retained. The IPC surface was redesigned but the renderer's mental model — `invoke()` for commands, `listen()` for events — survived.

### 7.3 What it bought us

- **Latency.** End-to-end perceived latency (key press to text in target app) dropped from a multi-hundred-millisecond range with visible jitter to a sub-second range without it. Most of the reduction came from removing the Web Audio buffering layer; some came from running the WebSocket from Rust rather than the renderer, which removed an IPC hop on every PCM frame.
- **Binary size.** Installers shrank by an order of magnitude. The EV-signed NSIS installer is now small enough that auto-updates are unobtrusive.
- **Operational simplicity.** Native audio capture and native key injection collapse two classes of cross-platform bug (device enumeration, focus management) into well-trodden Rust crates.

### 7.4 What it cost

Rust compile times during development are slower than Electron's. We absorb this with a `python run.py` launcher that handles prerequisites and shares a target directory across iterations; first-build cold compile is in the few-minute range and incremental rebuilds are fast.

---

## 8. Reliability and Hardening

A non-trivial fraction of the v1.0 work was hardening the launch path. Specific measures:

- **Mutex-poison recovery.** Every audio-thread mutex is acquired through a helper that recovers from `PoisonError` rather than panicking. A panicked prior thread does not bring down the audio path.
- **Bounded channels.** The PCM channel to the WebSocket task is bounded (1000 messages). Sustained backpressure drops frames rather than ballooning memory; drops are counted and rate-limit-logged.
- **Fetch timeouts.** Every outbound HTTP call from the Rust backend has an explicit timeout. There is no path that can hang the main thread waiting on a provider.
- **Streaming error handling.** WebSocket errors propagate as `deepgram:transcript-error` events to the renderer, which surfaces them in the UI rather than silently dropping the session.
- **Single-instance lock.** Launching MacroVox while it is already running re-focuses the existing instance rather than starting a second one — important because the global hotkey can only be owned by one process.
- **Capabilities lockdown.** Tauri 2's capability model is used to scope the IPC surface. Capabilities are enumerated in `src-tauri/capabilities/default.json` and are explicit per-window.
- **Security audits.** Two dated audits in `docs/SECURITY_AUDIT_2026-04-16.md` and `docs/SECURITY_AUDIT_2026-04-19.md` document the CORS, CSP, payload-limit, input-validation, and capabilities review.

---

## 9. Accessibility

MacroVox is built and tested as an accessibility tool. The author is a daily user with a motor disability. Two consequences:

1. **The product is dogfooded continuously.** Every release has been used to write the release itself. Bugs that would be cosmetic in a productivity tool (e.g., a jittery hotkey, a transcript that fails to paste) are showstoppers here, and are treated as such.
2. **Defaults are tuned for accessibility, not novelty.** Auto-copy is on. Auto-paste is on. The hotkey is bound by default. Cleanup is on by default. A first-launch user can install, sign in, subscribe, and dictate without changing any setting.

Future accessibility work tracked in the roadmap includes a streaming low-latency cleanup pass (so the cleaned text arrives even faster), expanded dictation-command vocabulary, and macOS support.

---

## 10. Roadmap

In approximate priority order:

1. **macOS port.** CoreAudio backend in cpal, notarised distribution, accessibility-permission flow.
2. **Streaming cleanup.** Replace the post-utterance batch Claude call with a streamed pass, so the cleaned text arrives concurrently with the raw paste rather than after it.
3. **OAuth providers.** Google and Facebook in Supabase Auth.
4. **Wayland parity.** Auto-paste now has a `wtype`/`ydotool` fallback; the remaining gap is global hotkeys, which depend on XDG portal support — track that upstream and revisit when the portal is stable.
5. **Expanded language coverage.** Currently 20 languages via Deepgram Nova-3; the limit is upstream model availability, not client work.

---

## 11. Conclusion

MacroVox demonstrates that a managed, low-latency desktop dictation experience does not require either a heavyweight runtime (Electron) or a bespoke local model. A native Rust capture path under a Tauri shell, a stateless proxy layer holding provider credentials, and an LLM cleanup pass that runs off the critical path together produce an application that is fast enough to be useful as an accessibility tool, simple enough that the end user never sees an API key, and small enough to ship as a signed installer with auto-update.

The v1.0 release is the foundation. The roadmap above is incremental: every item extends the current architecture rather than replacing it. The harder design problems — audio capture, streaming transport, paste injection, billing, key custody — are settled.

---

## Appendix A: Component Map

| Module | Path | Role |
|---|---|---|
| App entry | `src-tauri/src/main.rs` | Calls `lib::run()`. |
| App setup | `src-tauri/src/lib.rs` | Plugins, tray, global hotkey, close-to-tray, voice-buffer init. |
| IPC commands | `src-tauri/src/commands.rs` | All `invoke()` targets — audio, Deepgram, clipboard, windows. |
| Shared state | `src-tauri/src/state.rs` | Mutex-wrapped `AppState`. |
| Audio capture | `src-tauri/src/audio.rs` | cpal callbacks, WAV encode, PCM conversion. |
| STT streaming | `src-tauri/src/deepgram_ws.rs` | `tokio-tungstenite` session manager. |
| Voice buffer | `src-tauri/src/voice_buffer.rs` | OGG Opus rolling buffer + manifest. |
| Platform detection | `src-tauri/src/platform.rs` | OS / Wayland detection. |
| Renderer entries | `src/renderer/dictation.tsx`, `settings.tsx` | Two windows, two entries. |
| IPC bridge | `src/renderer/lib/tauri-ipc.ts` | Typed wrappers around `invoke` / `listen`. |
| Auth | `src/renderer/lib/auth.ts`, `supabase.ts` | Supabase JS SDK. |
| Proxy layer | `netlify/functions/` | `claude-proxy`, `deepgram-proxy`. |
| Edge functions | `supabase/functions/` | `create-checkout`, `billing-portal`, `stripe-webhook`. |

## Appendix B: Glossary

- **Pro subscriber.** A user with an active or trialing Stripe subscription. The proxy layer admits requests only from Pro subscribers.
- **Optimistic paste.** Writing the raw transcript to the clipboard and target window before the LLM cleanup completes; the cleanup updates the clipboard when it returns.
- **Voice buffer.** Per-user rolling local store of dictation audio in OGG Opus, capped (default 100 MB) with FIFO eviction.
- **Capabilities.** Tauri 2's per-window IPC permission model.
