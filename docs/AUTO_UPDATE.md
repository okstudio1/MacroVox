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
4. **Verify the installer.** Installing goes through the `updater_install`
   command rather than the plugin's own `downloadAndInstall`, because the
   plugin leaves no seam of its own: `download` verifies and `install` does
   not. The command stages the verified bytes, and
   [update_guard.rs](../src-tauri/src/update_guard.rs) requires a valid
   Authenticode signature, our pinned certificate thumbprint, our signer name,
   and a `FileVersion` matching the offered version. Any failure refuses the
   update and installs nothing.
5. **Install.** `Update::install` receives the same verified buffer, writes it
   to a temporary file, hands that to `ShellExecuteW`, and the process exits so
   the installer can replace it. The installer relaunches the app.

## What is verified

| Property | Mechanism |
| --- | --- |
| The payload came from us | minisign signature over the artifact bytes, checked against the pubkey embedded in the binary at build time |
| The payload is intact | same signature check; a truncated or altered download fails it |
| The update is not a downgrade | strict semver comparison against the running version, done before anything is downloaded |
| The manifest cannot substitute a payload | the URL in the manifest is only a location; whatever it serves must still verify against the embedded pubkey |
| The endpoint cannot be redirected by config | the endpoint list is compiled into the app, not read from disk at runtime |
| The installer is ours, not just validly signed by someone | Authenticode status must be `Valid`, the signing certificate thumbprint and signer common name must match the pinned EV certificate |
| A signed but older installer cannot be served as new | the `FileVersion` embedded in the installer must match the version the manifest offered, compared on the first three components |
| Transport | HTTPS to github.com |

The signing key is the operational dependency here. It lives on the signing
host and is never in the repository, and the public half in `tauri.conf.json`
is what makes a leaked private key the one failure that undoes the rest of this
table.

## What is not verified, and why that matters

**We verify the bytes, not the file that is executed.** Authenticode is a
property of a file, so the verified buffer is staged to a temporary file for
the check. The plugin then writes its own temporary copy of the same buffer and
executes that. The content is identical, so the pin is meaningful, but the file
that runs is not the file that was inspected, and closing that gap means
replicating the plugin's installer invocation rather than calling into it.

**The check needs PowerShell, and fails closed without it.** The signature
query runs `Get-AuthenticodeSignature` through an absolute path to
`powershell.exe`, with no profile and no window. On a machine where PowerShell
is missing or locked down, the update is refused rather than installed
unverified. That is the right direction to fail, but it does mean such machines
stop receiving updates silently apart from a log line.

**There is no Authenticode outside Windows.** On Linux the minisign signature
is the only gate, which is all the format offers.

**The manifest itself is unsigned.** Only the artifact is. An attacker who
could rewrite `latest.json` could point clients at a payload of their choosing,
but could not make them install it, because the signature check would reject
it. The practical effect of that attack is denial of updates, not code
execution.

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
date"), an install that routes through the backend rather than the plugin, a
refusal from the signature check reaching the user, and a failed install call,
which must clear the in-progress flag.

[update_guard.rs](../src-tauri/src/update_guard.rs) carries its own tests for
the pins, which run without any signing infrastructure: a correct set of facts
passes, an invalid status is refused, another publisher's valid signature is
refused, a relabelled older installer is refused, and the version comparison
rejects anything it cannot parse rather than guessing.

The minisign verification itself belongs to the plugin and is not re-tested
here.
