# Repository guidance

## Runtime and entry points

MacroVox is a Windows-first Tauri 2 application with a Rust backend and a React 18 renderer. Linux is beta. The active code is `src-tauri/src/` and `src/renderer/`. `src/main/` and `config/tsconfig.main.json` are historical Electron code and are excluded from supported builds.

The two configured webviews are `main` (dictation.html) and `settings` (settings.html). Each has independent React state. Synchronize settings through the typed Tauri event bridge and subscribe to Supabase auth changes in each webview. Do not assume React state or event handlers are shared across windows.

Read [src-tauri/ARCHITECTURE.md](src-tauri/ARCHITECTURE.md) for native ownership, session finalization, history persistence, and event contracts. `commands.rs` defines commands, `lib.rs` registers them, and `src/renderer/lib/tauri-ipc.ts` defines their TypeScript bridge. Change these together when an IPC contract changes.

`DictationMode.tsx` owns the live recording flow. The standalone `useDeepgram` hook and the deferred Write tab are not its implementation. `useUpdater` is mounted through `UpdateNotice` in the dictation webview.

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

BYOK Deepgram requests use Token authentication. Managed speech must obtain a fresh short-lived Bearer credential for each provider operation. Client wiring awaits explicit destination approval in this intermediate branch; managed speech currently fails closed. See the fix ledger for release status. Do not cache a grant across recordings or assume its expiry limits the lifetime of an already connected WebSocket. Claude BYOK calls go directly to Anthropic; managed cleanup uses the authenticated Netlify proxy. Never log credentials, audio, or transcript contents in timing diagnostics.

`nova-3` uses the `keyterm` query parameter, not the older `keywords` parameter. Keep streaming, batch, and history reprocessing consistent. History operations must serialize full manifest transactions, including repair and file deletion. Preserve failed deletions visibly so users can retry.

## Security and hosted backend

Provider master keys belong only in server environment variables. Do not restore `managed_api_keys` reads or a compatibility fallback that returns shared keys. The migration and rollout contract is documented in [docs/BACKEND_SECURITY_MIGRATION_2026-09-15.md](docs/BACKEND_SECURITY_MIGRATION_2026-09-15.md). Subscription mutation, trial reservations, webhook application, and quotas use service-role-only database operations. Browser clients may read only their own entitlement.

CSP has one production source: `src-tauri/tauri.conf.json`. Do not add HTML meta policies. New provider origins must be explicit and covered by `check:csp`. Renderer-only Vite development does not exercise the production Tauri response header.

BYOK secrets and Supabase sessions currently persist in the webview profile. OS credential storage remains a documented hardening task. Do not describe localStorage as encrypted credential storage.

## Release and documentation

Version 1.0.9 is unreleased until signed artifacts are published. Keep package.json, tauri.conf.json, Cargo.toml, and their lockfiles synchronized. `check:versions` enforces app version parity and Tauri major/minor parity.

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
