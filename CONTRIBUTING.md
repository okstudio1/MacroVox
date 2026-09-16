# Contributing to MacroVox

Thanks for your interest. MacroVox is a voice dictation app built with
accessibility in mind, for people who find typing slow, painful, or
impractical. Contributions of every size are welcome, especially from
people who rely on adaptive technology day to day.

## Before you start

- Read the [Code of Conduct](CODE_OF_CONDUCT.md). It applies to every
  interaction in issues, PRs, and discussions.
- For security issues, **do not** open a public issue. Follow the process
  in [SECURITY.md](SECURITY.md) instead.
- Releases live in a separate repo:
  [`okstudio1/macrovox-releases`](https://github.com/okstudio1/macrovox-releases).
  Signed installer downloads go there. Source code, development, and
  issues live here.

## Ways to contribute

- **Report bugs** using the bug report template.
- **Request features** using the feature request template.
- **Improve docs** : typos, clearer wording, missing context.
- **Add tests** : both the Vitest (renderer) and `cargo test` (Rust) suites
  have coverage gaps.
- **Code changes** : see "Development setup" below.

If you are unsure whether a change is wanted, open an issue first to
discuss. For larger features, please discuss before writing code so we can
align on scope and approach.

## Development setup

MacroVox is a [Tauri 2](https://tauri.app) app: a Rust backend
(`src-tauri/`) and a React + Vite renderer (`src/renderer/`).

Prerequisites: Node.js 20+ LTS, the Rust stable toolchain, and Git. On
Linux you also need the WebKitGTK / ALSA dev packages listed in the README.

```bash
git clone https://github.com/okstudio1/MacroVox.git
cd MacroVox
python run.py
```

`run.py` checks prerequisites, runs `npm install`, and launches
`npx tauri dev`. The first run compiles the Rust backend and takes a few
minutes.

You will need a `.env` with `VITE_SUPABASE_URL` and `VITE_SUPABASE_KEY` for
auth to work (see the README). To develop against your own provider
accounts instead, paste your Deepgram and Anthropic keys under
Settings -> Keys.

### Running the checks

Run the same gates CI runs before you push:

```bash
npm test                 # renderer and Netlify tests (Vitest)
npm run test:scripts     # build contracts
npm run check:csp        # production CSP
npm run test:rust        # Rust unit tests (cargo test)
npm run typecheck         # TypeScript type-check
npm run check:versions   # Cargo.lock tauri vs @tauri-apps/api major.minor match
```

For Rust, also run `cargo fmt` and `cargo clippy` in `src-tauri/` before
pushing.

## Architecture orientation

Useful reading before opening a PR:

- [`README.md`](README.md) : project structure and the renderer/backend split.
- [`src-tauri/ARCHITECTURE.md`](src-tauri/ARCHITECTURE.md) : Rust backend:
  audio capture, Deepgram streaming, voice buffer, IPC commands, state.
- [`docs/LLM_ONBOARDING.md`](docs/LLM_ONBOARDING.md) : quick orientation.
- [`docs/RELEASE.md`](docs/RELEASE.md) : how releases are cut and signed.

## Coding conventions

- **TypeScript**: strict mode. Type-check with `npm run typecheck`.
- **Rust**: format with `cargo fmt`, lint with `cargo clippy`.
- **Comments**: TSDoc / rustdoc on exported APIs; inline comments only when
  the *why* is non-obvious. Don't describe what well-named code already does.
- **No em dashes** in code, docs, commit messages, or PR descriptions.
  Use periods, commas, parentheses, or rephrase.
- **Conventional commits**: `feat:`, `fix:`, `docs:`, `refactor:`,
  `chore:`, `test:`. Subject under ~72 chars. No `Co-Authored-By` trailers.
- **Tests required** for behavior changes. Renderer logic goes in Vitest
  (`src/renderer/**/__tests__/`); backend logic goes in `#[cfg(test)]`
  modules under `src-tauri/src/`.
- **Accessibility first**: any UI change must work for users who cannot
  click quickly or precisely. Keep targets large, feedback clear, and don't
  add steps that assume fast or fine motor control.

## Pull request flow

1. Fork and branch from `main`.
2. Make your change, with tests.
3. Run the checks above locally.
4. Push and open a PR using the template.
5. CI runs the test suites plus the Semgrep scan. Merges are gated on a
   clean run.
6. A maintainer will review. Iterate as needed.

If your PR touches the audio pipeline, the Deepgram/Claude request paths,
or the signing / release scripts, please call that out in the PR
description so it gets extra eyes.

## License

By contributing, you agree that your contributions will be licensed under
the same [MIT License](LICENSE) that covers the project.
