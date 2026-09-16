# Auto-update: how it works and what it verifies

MacroVox updates itself through the Tauri updater plugin
(`tauri-plugin-updater` 2.10.1, `@tauri-apps/plugin-updater`). This document
records what that path actually does, what it verifies, and what it does not,
so the guarantees are reviewable rather than assumed.

Everything below was read out of the plugin source at the locked version, not
its README.

## The flow

1. **Check.** [useUpdater.ts](../src/renderer/hooks/useUpdater.ts) calls
   `check()` about five seconds after the dictation window mounts, and again
   whenever a user presses "Check for updates" in Settings -> Updates. The
   plugin fetches the endpoint configured in
   [tauri.conf.json](../src-tauri/tauri.conf.json):
   `https://github.com/okstudio1/macrovox-releases/releases/latest/download/latest.json`.
2. **Compare.** The plugin only reports an update when the manifest version is
   strictly newer than the running version, by semver. A manifest advertising
   an older or equal version is ignored, so a rolled-back or replayed manifest
   cannot move a client backwards.
3. **Download.** `Update::download` streams the artifact into memory and, once
   the stream completes, verifies the minisign signature from the manifest
   against the public key compiled into the binary. A payload that fails
   verification is never returned to the caller.
4. **Install.** `Update::install` writes those bytes to a temporary file and
   hands it to `ShellExecuteW`, then the current process exits so the installer
   can replace it. The renderer calls `relaunch()` afterwards.

## What is verified

| Property | Mechanism |
| --- | --- |
| The payload came from us | minisign signature over the artifact bytes, checked against the pubkey embedded in the binary at build time |
| The payload is intact | same signature check; a truncated or altered download fails it |
| The update is not a downgrade | strict semver comparison against the running version, done before anything is downloaded |
| The manifest cannot substitute a payload | the URL in the manifest is only a location; whatever it serves must still verify against the embedded pubkey |
| The endpoint cannot be redirected by config | the endpoint list is compiled into the app, not read from disk at runtime |
| Transport | HTTPS to github.com |

The signing key is the operational dependency here. It lives on the signing
host and is never in the repository, and the public half in `tauri.conf.json`
is what makes a leaked private key the one failure that undoes the rest of this
table.

## What is not verified, and why that matters

**The installer's Authenticode signature is not checked by us.** The EV
signature exists on shipped artifacts and Windows will evaluate it at
execution, but MacroVox does not pin the certificate thumbprint or the signer
name before running the installer. A leaked minisign key would therefore be
sufficient on its own. Pinning it would mean taking over the download and
install steps in Rust so a check can run between them, which is the one seam
the plugin leaves open: `download` verifies, `install` verifies nothing and
trusts whatever bytes it is handed.

**The manifest itself is unsigned.** Only the artifact is. An attacker who
could rewrite `latest.json` could point clients at a payload of their choosing,
but could not make them install it, because the signature check would reject
it. The practical effect of that attack is denial of updates, not code
execution.

**There is a window inside the plugin between write and execute.** `install`
writes the verified bytes to a temporary path and then executes that path. We
verify the bytes, not the file that ultimately runs. The window is short and
the path is unpredictable, but anything with write access to that temp
directory at that instant is outside what the signature check covers.

**Nothing bounds the download size.** A hostile or broken endpoint can stream
until memory is exhausted, because the plugin buffers the artifact in memory
before verifying it.

## Operational notes

- Artifacts and manifest are published to a separate repository,
  `okstudio1/macrovox-releases`, so source access and release-signing access
  are not the same thing.
- Publishing is manual: build and EV-sign on the signing host, minisign, then
  upload with the manifest. See [RELEASE.md](RELEASE.md) and
  [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md).
- `createUpdaterArtifacts` is enabled in the bundle config, which is what
  produces the `.sig` files the manifest refers to.
- 1.0.8 clients never mounted the updater, so they cannot be reached by this
  path at all and need a manual installer download. Do not count them as
  updatable.

## Tests

[useUpdater.test.tsx](../src/renderer/hooks/__tests__/useUpdater.test.tsx)
covers the states the UI depends on: an available update, a completed check
with nothing newer, a failed check (which must not be reported as "up to
date"), a successful install and relaunch, and a failed install, which must
clear the in-progress flag and must not relaunch into a half-applied update.

The verification itself belongs to the plugin and is not re-tested here.
