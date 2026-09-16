<div align="center">

<img src="assets/owenpkent_App_icon_for_MACROVOX_minimal_flat_taskbar_icon_sin_39611128-932c-451e-9e58-cc50d23c1b18_1.png" alt="MacroVox logo" width="120" />

# MacroVox

**Speak. It types. Anywhere.**

Real-time voice dictation that drops clean, AI-polished text straight into the app you're already using. Built for anyone who finds typing slow, painful, or impractical. Your voice never has to touch a keyboard.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Release](https://img.shields.io/badge/release-v1.0.8-brightgreen.svg)](https://github.com/okstudio1/macrovox-releases/releases/latest)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-lightgrey.svg)](#install)
[![Built with Tauri 2](https://img.shields.io/badge/built%20with-Tauri%202-24C8DB.svg)](https://tauri.app)
[![Powered by Deepgram + Claude](https://img.shields.io/badge/powered%20by-Deepgram%20%2B%20Claude-7c3aed.svg)](#how-it-works)

</div>

---

## Pick your path

<table>
<tr>
<td width="33%" valign="top">

### 🎙️ I want to use it

You want to talk instead of type, and have it land in any app.

**Go to** [Install](#install), then [First run](#first-run).

</td>
<td width="33%" valign="top">

### 🔑 I want my own keys

You'd rather plug in your own Deepgram and Anthropic keys and skip the subscription.

**Go to** [Bring your own keys](#bring-your-own-keys).

</td>
<td width="33%" valign="top">

### 🔧 I want the code

You're evaluating, forking, or contributing.

**Go to** [Build from source](#build-from-source) and [Architecture](#architecture).

</td>
</tr>
</table>

---

## Install

### Windows

Grab the latest signed installer from the releases repo:

**[Download MacroVox for Windows](https://github.com/okstudio1/macrovox-releases/releases/latest)**

Run `MacroVox_<version>_x64-setup.exe`, signed by OK Studio Inc. The `.msi` is available for managed deployment. Version 1.0.8 needs a manual installer upgrade: its updater was not mounted. The unreleased 1.0.9 source adds an update notice in the dictation window with an explicit install action. Windows reputation prompts can still vary by machine.

### Linux (beta)

Download the `.deb`, `.rpm`, or AppImage from the [same releases page](https://github.com/okstudio1/macrovox-releases/releases/latest) and install the one that matches your distro. See [Linux notes](#linux-notes) for runtime dependencies and Wayland caveats.

> Binaries live in a separate repo, [`okstudio1/macrovox-releases`](https://github.com/okstudio1/macrovox-releases). Source, issues, and development live here.

### First run

1. Launch MacroVox. A small always-on-top window appears.
2. Sign in and start a trial, **or** paste your own keys under [Settings -> Keys](#bring-your-own-keys).
3. Press the mic (or hit `Ctrl+Space` from any app), talk, and stop. Your words land on the clipboard and, if you enable it, paste straight into the app you were in.

---

## Why MacroVox

Typing is a barrier for a lot of people. Repetitive strain, limited mobility, fatigue, or just the friction of a keyboard between a thought and the screen. MacroVox closes that gap: speak naturally, and get back text that reads like you meant it to, in whatever app you're working in. Accessibility isn't a feature here, it's the whole point.

## How it works

Audio is captured natively in Rust (no browser mic prompts, low latency), streamed to [Deepgram](https://deepgram.com) Nova-3 for transcription, then handed to [Claude](https://anthropic.com) Haiku to fix speech-to-text slips, punctuation, and formatting. After Stop, the app waits for Deepgram's final result before copying. AI cleanup runs afterward and may update the clipboard only while the same transcript remains current. It does not replace text already pasted into another application.

---

## Features

- **Real-time dictation.** Deepgram Nova-3 in streaming mode (words as you speak) or batch mode (higher accuracy after you stop).
- **AI cleanup.** Claude Haiku polishes every transcript in the background: punctuation, capitalization, and obvious mis-hearings, without changing your meaning.
- **Drop it anywhere.** Auto-copy and optional auto-paste deliver the finalized transcript to the app you were using. Failed clipboard writes prevent auto-paste. Native key injection uses `enigo`.
- **Global hotkey.** Toggle dictation from any app with a shortcut you choose (default `Ctrl+Space`).
- **20 languages.** English, Spanish, French, German, Portuguese, Japanese, Korean, Chinese, and more. The cleanup prompt is language-aware.
- **Smart number formatting.** Always digits, always words, or a context-aware Smart mode (digits for currency, dates, and measurements; words for small standalone numbers).
- **Keyword boosting.** Teach it your jargon, names, and acronyms so they transcribe correctly.
- **Dictation history.** A rolling buffer saves recordings as OGG Opus (about 10x smaller than WAV) for playback, copying, and one-click reprocessing.
- **Bring your own keys.** Run the whole thing on your own Deepgram and Anthropic accounts, no subscription. [Details below](#bring-your-own-keys).
- **Six themes.** MCRN, Mars, Belter, Earth, Protomolecule, and Laconia.
- **Stays out of the way.** Lives in the system tray, always-on-top dictation window, drag it wherever you like.
- **Signed Windows installer.** The 1.0.9 source adds a signed-update notice and user-initiated installation in the dictation window.

> Screenshots and a short demo clip are on the way. (Want to contribute one? See [Contributing](#contributing).)

---

## Bring your own keys

MacroVox runs as a managed service by default: sign in, start a trial, and the keys are handled for you. Prefer to use your own provider accounts and skip the subscription? Open **Settings -> Keys** and paste them in.

| Key | Powers | Required? | Get one at |
|---|---|---|---|
| **Deepgram** | Speech-to-text | Yes, to record on your own key | [console.deepgram.com](https://console.deepgram.com) |
| **Anthropic** | AI cleanup of transcripts | Optional (raw transcripts still copy without it) | [console.anthropic.com](https://console.anthropic.com) |

- Keys are stored in the app's local storage on your device. They go only to Deepgram and Anthropic, never to OK Studio's servers.
- A saved **Deepgram** key takes priority over managed keys and unlocks recording immediately, with no sign-in.
- A saved **Anthropic** key sends cleanup straight to the Anthropic Messages API instead of the managed proxy.
- Leave a field blank to fall back to the managed plan for that provider.
- Usage on your own keys is billed to you by Deepgram and Anthropic directly.

---

## Build from source

MacroVox is a [Tauri 2](https://tauri.app) app: a Rust backend in `src-tauri/` and a React + Vite renderer in `src/renderer/`.

### Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| **Node.js** | 20+ LTS | [nodejs.org](https://nodejs.org) |
| **Rust** | stable | [rustup.rs](https://rustup.rs) |
| **Git** | any | for cloning |

On Linux you also need the WebKitGTK and ALSA development packages (see [Linux notes](#linux-notes)).

### Run it

```powershell
git clone https://github.com/okstudio1/MacroVox.git
cd MacroVox
python run.py
```

`run.py` checks prerequisites, runs `npm install`, and launches `npx tauri dev`. The first run compiles the Rust backend, which takes a few minutes.

The renderer needs a `.env` **file** in the project root, copied from
`.env.example`:

```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_KEY=your-anon-key
```

Both values are required. Without them the Supabase client throws while the
renderer is still importing, React never mounts, and the window shows nothing
but its background colour. If you get a black window, check `.env` first: it
must be a file with both values set, and a *directory* named `.env` produces
the same symptom, because Vite finds no env file and reports nothing.

To develop against your own provider accounts instead, just paste your keys under Settings -> Keys.

### Scripts

| Command | Description |
|---|---|
| `python run.py` | Start the dev environment (recommended) |
| `npm run dev` | Start the full Tauri application |
| `npm run build:renderer` | Build the renderer only (Vite) |
| `npm run build` | Production native build and installer, requires signing setup |
| `npm test` | Renderer and Netlify tests (Vitest) |
| `npm run typecheck` | Renderer and Netlify TypeScript checks |
| `npm run test:scripts` | Build contract regression tests |
| `npm run check:csp` | Check the single production CSP and required origins |
| `npm run test:rust` | Rust unit tests (cargo) |
| `npm run check:versions` | Verify app manifests and Tauri dependency versions agree |

---

## Security and reliability update (1.0.9, unreleased)

The fix branch addresses final-word truncation, stale cleanup, history races, and hosted billing/security findings. Source changes do not update the installed app or production services. Start with the [fix ledger and validation](docs/SECURITY_ARCHITECTURE_FIXES_2026-09-15.md), the [speech investigation](docs/DICTATION_CUTOFF_AND_LATENCY_REVIEW_2026-09-15.md), and the [backend migration runbook](docs/BACKEND_SECURITY_MIGRATION_2026-09-15.md). Managed speech uses short-lived grants; shared provider keys must be removed from client-readable storage and rotated during rollout.

## Architecture

```
+---------------------------------------------------+
|                  Rust / Tauri 2                   |
|  lib.rs       app lifecycle, tray, global hotkey  |
|  commands.rs  audio, Deepgram, clipboard, paste   |
|  audio.rs     cpal WASAPI capture, WAV encoder    |
|  state.rs     shared AppState (audio, settings)   |
+-----------------------+---------------------------+
                        |  invoke() / emit()
+-----------------------v---------------------------+
|               React Renderer (Vite)               |
|  DictationMode   recording UI                     |
|  SettingsPanel   all user preferences             |
|  tauri-ipc.ts    typed IPC bridge                 |
|  auth.ts         Supabase auth + billing          |
+---------------------------------------------------+
```

The renderer never touches the microphone directly. It asks the Rust side to capture, stream, and inject, which keeps latency low and avoids browser permission prompts. See [`src-tauri/ARCHITECTURE.md`](src-tauri/ARCHITECTURE.md) for the full backend tour.

<details>
<summary><strong>Project structure</strong></summary>

```
MacroVox/
├── run.py                        # Dev launcher (prerequisites + npx tauri dev)
├── src-tauri/                    # Rust / Tauri 2 backend
│   ├── tauri.conf.json           # App config: windows, devUrl, frontendDist
│   ├── capabilities/default.json # IPC permissions for all windows
│   └── src/
│       ├── main.rs               # Entry point, calls lib::run()
│       ├── lib.rs                # App setup, tray, global shortcut, close handler
│       ├── commands.rs           # IPC commands (audio, Deepgram, clipboard, windows)
│       ├── state.rs              # Shared AppState (Mutex-wrapped)
│       ├── audio.rs              # cpal WASAPI native audio capture
│       ├── deepgram_ws.rs        # Deepgram WebSocket streaming
│       ├── voice_buffer.rs       # Dictation history (OGG Opus buffer + manifest)
│       └── platform.rs           # Platform detection (OS, Wayland)
├── src/renderer/                 # React UI (Vite + Tailwind)
│   ├── dictation.html/tsx        # Main dictation window entry
│   ├── settings.html/tsx         # Settings window entry
│   ├── config.ts                 # App configuration constants
│   ├── themes.ts                 # Theme definitions
│   ├── components/               # DictationMode, SettingsPanel, VoiceHistory
│   ├── hooks/                    # usePostProcessing, useDeepgram, useUpdater
│   └── lib/                      # tauri-ipc, auth, supabase, disable-context-menu
├── netlify/functions/            # Serverless proxies (claude-proxy, deepgram-proxy)
├── supabase/functions/           # Edge Functions (checkout, billing, webhook)
├── docs/                         # Documentation
└── package.json
```

</details>

---

## Linux notes

MacroVox builds `.deb`, `.rpm`, and AppImage bundles. Install the one that matches your distro.

**Runtime dependencies** (Debian/Ubuntu names; check your distro for equivalents):

- `libwebkit2gtk-4.1-0` for the Tauri WebView
- `libasound2` and `libpulse0` for audio capture (cpal via ALSA/PulseAudio; PipeWire works through its PulseAudio shim)
- `libayatana-appindicator3-1` for tray icon support

**Display server:**

- **X11** is fully supported. Global hotkey, auto-paste, and clipboard all work as on Windows.
- **Wayland** is partial. Global hotkeys depend on the compositor's XDG portal, and auto-paste via `enigo` is unreliable, so it's disabled automatically (copy and paste manually, or run from an X11 session for full parity). MacroVox detects the session type at startup and reflects the limitation in Settings.

**Microphone picker:** on Linux the dropdown hides ALSA's virtual aliases (`hw:`, `plughw:`, `dmix:`, monitor taps, and friends) so you only see real, named devices. Your choice persists across restarts.

---

## Contributing

Contributions are welcome, especially from people who use adaptive technology day to day. Start with [CONTRIBUTING.md](CONTRIBUTING.md) for setup, conventions, and the PR flow, and please read the [Code of Conduct](CODE_OF_CONDUCT.md). Bug reports and feature requests have [issue templates](.github/ISSUE_TEMPLATE) ready to go.

## Security

Found a vulnerability? Please report it privately, not in a public issue. The preferred channel is a [GitHub Security Advisory](https://github.com/okstudio1/MacroVox/security/advisories/new); the email fallback is `owenpkent@gmail.com` with `[MacroVox security]` in the subject. Details and scope are in [SECURITY.md](SECURITY.md).

## Documentation

- [Setup Guide](docs/SETUP.md): backend infrastructure (Supabase, Netlify, Stripe)
- [Release Process](docs/RELEASE.md) and [Release Checklist](docs/RELEASE_CHECKLIST.md)
- [Changelog](docs/CHANGELOG.md): release history
- [Status and Roadmap](docs/STATUS_AND_ROADMAP.md)
- [LLM Onboarding](docs/LLM_ONBOARDING.md): quick orientation for AI assistants

## License

MIT. Copyright 2026 OK Studio. See [LICENSE](LICENSE).

<div align="center">
<sub>Built with care for people who'd rather talk than type.</sub>
</div>
