# TODO: follow-ups from the 2026-09-16 PR cleanup

Baseline: `main` at `c34ecb3`. Every PR is merged and the queue is empty.

Merged: #22, `style: apply cargo fmt across the Rust backend`, #23, #25, #17,
`chore(deps): clear 6 cargo advisories via lockfile update`, #27, #29, #30, #28,
#32, #31, #26.

Closed as superseded: #24, #14, #13, #12, #11, #10, #9, #8, #7, #6, #5,
#21, #20, #19, #1.

## Blocking before release

- [ ] **Apply the Supabase migration before enabling `deepgram-grant` in production.**
      Without it, `reserve_api_quota` fails closed with a 503 and managed dictation
      stops working for Pro/Team subscribers. Verify the migration is applied in the
      production project first, then enable the function.
      The one that matters is `supabase/migrations/202609150001_backend_security_baseline.sql`,
      which defines `reserve_api_quota` and grants EXECUTE to `service_role` only. It
      is self-contained, so it does not depend on the two older `api_usage` migrations
      having run. All four migrations are idempotent (`CREATE OR REPLACE`,
      `IF NOT EXISTS`, `DROP ... IF EXISTS` before re-adding), so a second run is a
      no-op. `supabase db push` applies them in filename order.
      Order per `docs/BACKEND_SECURITY_MIGRATION_2026-09-15.md`: back up, run the three
      preflight checks for Stripe customer bindings, apply the baseline, then enable
      `deepgram-grant`. Leave `202609150002_remove_managed_provider_keys.sql` until the
      fixed desktop client has shipped.
      Outside the repo: `supabase link` auth, confirming what is already applied
      (`supabase migration list`), the backup, and the Netlify env vars
      `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `DEEPGRAM_MANAGED_KEY`.

## Verify on main before the release

- [x] **enigo 0.6 auto-paste key injection. Tested 2026-09-16, passes.**
      Ran the exact `dictation_auto_paste` sequence (`Enigo::new(&Settings::default())`,
      then Control press, `Unicode('v')` click, Control release) against three
      different input stacks, each verified by round-trip rather than by trusting
      the return values: the clipboard was replaced with a marker before copying
      the target's content back, so an unpasted target cannot produce a pass.
      1. A raw Win32 EDIT control: pass.
      2. Notepad on Windows 11, a packaged WinUI/RichEdit app: pass.
      3. Chromium, an Edge `--app` window with a focused textarea, which is the
         same input path as VS Code, Slack and Discord: pass.
      Every enigo call returned `Ok(())` in all three.
      The probe refused to inject unless the target window was confirmed to hold
      focus, so a failure could never spray keystrokes into other windows. Worth
      keeping that property in any future version of this test.
- [ ] **Still untested: the end-to-end hide-then-paste flow in the real app.**
      All three probes focused the target themselves. The app instead hides the HUD
      and relies on Windows restoring focus to the previously focused application,
      then injects after 50 ms. That hide-and-restore timing is unchanged by the
      enigo bump, but its interaction with enigo 0.6 has not been exercised. Also
      untested: elevated target windows (UIPI blocks synthetic input from a
      non-elevated process either way), Office, and terminals.
- [ ] **Optional: stop discarding the enigo results.**
      `dictation_auto_paste` writes `let _ = enigo.key(...)` three times, so if
      injection ever does fail the user gets silence and the log gets nothing. The
      transcript is on the clipboard at that point, so a warning would be enough to
      make the failure diagnosable.

## How the #26 items were settled

Branch `chore/deps-major-20260915` at `c98414d`, rebased onto main, all 10 checks
green. It bumps cpal 0.15 to 0.17, enigo 0.2 to 0.6, whisper-rs 0.10 to 0.16,
reqwest 0.12 to 0.13, lucide-react 0.454 to 1.14.

- [x] **cpal 0.17 microphone selection. Resolved in code, no manual test needed.**
      The prediction was right and the failure was worse than expected. cpal 0.17
      returns a `DeviceDescription`, and on WASAPI the endpoint is in `name` while
      the adapter is in `driver`. Reading `name` alone both changed every saved
      string and collapsed distinct devices onto one label: this machine has 21
      input devices, three of which report plain "Microphone" (three different
      USB microphones), so `find` would pick whichever came first. `format!("{} ({})", name, driver)` reproduces all 21 of the 0.15
      strings exactly, same order, no duplicates, so saved settings need no
      migration. Fixed in `e7e567c` on #26 with `format_device_label` pinned by two
      tests. Verified by enumerating both cpal versions side by side in one binary,
      which is worth repeating for any future cpal major.
      Still unverified on Linux: ALSA may populate `driver` differently. The bare
      name fallback keeps the ALSA prefixes the Linux picker filters on intact.
- [ ] **enigo 0.6 auto-paste.** Check SendInput timing and reliability, pasting into
      several different target applications.
- [x] **whisper-rs 0.16 local STT. Removed instead, see #32.**
      The feature did not compile on main either: `whisper_transcribe_impl` built
      `RecordingStopResponse` without the `session_id` and `limit_reached` fields
      added to the struct later, five times over, so the build failed before
      reaching any whisper code. Nothing builds the feature in CI, so it rotted
      unnoticed and nothing could have been using it.
      Two things cost an hour and are worth remembering. A cargo command piped
      into `tail` reports the exit code of `tail`, so a failed build looked like a
      pass; redirect to a file and read `$?` on the cargo command itself. And
      whisper.cpp under MSVC fails with C1041 (cannot open program database) when
      `CARGO_TARGET_DIR` sits at a long path; it needs a short target dir, cl.exe
      on PATH via `VsDevCmd.bat`, and no stale `CMakeCache.txt`.
- [ ] **enigo 0.6 auto-paste.** Not run: it means synthesizing keystrokes into
      whatever window has focus. Tracked above as a pre-release check now that
      #26 has landed.
- [x] #26 merged as `c3a24c7` plus `c34ecb3`, rebased past #32 with the
      whisper-rs bump dropped and the base commit message corrected.

## Done

- [x] Merge #29 (`7b04266`), #30 (`417ea01`) and #28 (`60c844b` plus `85bffb2`).
      All rebase-merged, so `main` is still linear. #26 is the only PR left open.
- [x] Answer the P2 review comment on #28 before merging it. The stale-epoch branch
      in `register_recording_at_epoch` was discarding the `remove_file` error, so a
      failed delete left finalized audio on disk that the UI could not see, `clear_all`
      could not retry (it only walks manifest entries), startup recovery could not
      adopt (it only looks at `.partial` files), and eviction never counted. The error
      now names the file, reaching the user through `RecordStopResponse.error`, and
      `remove_orphan_recordings` runs at startup as the durable retry. It skips
      `.partial` files and anything modified in the last 60 seconds so it cannot take
      a file still on its way into the manifest, and it also closes the older leak
      where the process died between the rename and the registration.
- [x] Verify the #29 and #30 review comments rather than trusting them. Re-resolved
      all four action tags to SHAs (all four matched), confirmed every runner is
      GitHub-hosted so the node24 and runner 2.327.1 floors are met, and read
      upload-artifact v5 to v7 for the one step PR CI never executes (runtime and ESM
      changes only, plus an additive `archive` input, so release.yml is unaffected).
      For #29, plugin-react 5.2.0 peers accept the installed vite 6.4.3 and both
      configs call `react()` with no options.
- [x] Close #24, superseded by #27 once it merged.
- [x] Decide #8. Not mergeable as written (plugin-react 6 needs vite ^8, repo is on
      vite ^6.0.3). Replaced by #29, which takes 5.2.0, the newest release whose peer
      range still accepts vite 6.
- [x] Review the four GitHub Actions bumps. Consolidated into #30. Every SHA was
      verified against its upstream tag rather than trusted from the dependabot diff.
      #19 had already gone `CONFLICTING` against #27's workflow rewrite.
- [x] Resolve the two `#[allow(clippy::too_many_arguments)]`. Done in #28. The crate
      is back to zero allow attributes.
- [x] Add the `expected_epoch` guard to `register_recording`. Done in #28, with the
      epoch captured at session start rather than at registration, plus two tests.
- [x] Remove the two stale agent worktrees under `.claude/worktrees/`.
- [x] Turn on `delete_branch_on_merge` and prune the backlog: 9 remote and 15 local
      branches gone. Because this repo rebase-merges, a branch tip is never an
      ancestor of `main`, so `git branch --merged` reports nothing and is the wrong
      tool. `git cherry main <branch>` compares patch ids and does answer it.
      Nothing is kept: `main` is the only branch, local and remote, and the only
      worktree.
- [x] Prune the last two branches (2026-09-16).
      `fix/security-dictation-20260915` was the pre-rebase original of #27
      (`fix: dictation finalization and security hardening, on the grant-token
      flow`), so its one patch-id-unique commit `6d6d430` had already landed in
      rebased form. Its `MacroVox-review-20260915` worktree was clean and was
      removed first.
      `yetanotherspeechrecorder` was different: 14 commits from Nov and Dec 2025
      that never touched this lineage (voice memo recorder UI, the v1.0.0 Windows
      build, the voice-to-command pipeline, a mobile web prototype, a GitConnect
      OAuth and Netlify experiment, design and integration docs). Nothing on main
      carries that history, so it is archived as the annotated tag
      `archive/yetanotherspeechrecorder` (pushed to origin) rather than destroyed.
      Delete that tag if the history is genuinely unwanted.

## A black window is almost always `.env`

Hit on 2026-09-16: the app built and launched but rendered nothing except its
background colour. The cause was an empty **directory** named `.env` in the repo
root, created by something running there earlier that day, sitting where Vite
expects the env file. No `VITE_*` var loaded, the Supabase client threw
`supabaseUrl is required` while the renderer was still importing, React never
mounted, and `body { background: #0a0f14 }` is what you see. Vite reports
nothing when an env file is absent, so there is no error to follow.

How to tell this apart from a real renderer regression, in about a minute:
start `npm run dev:renderer`, load `http://localhost:5173/dictation.html` in
headless Edge with `--dump-dom`, and look at the size. A failed mount is about
1 KB with an empty `<div id="root">`; a healthy one is about 35 KB of HUD
markup. Add `--enable-logging=stderr` and the first `Uncaught` line names the
real cause. Unhandled rejections about undefined properties are expected in a
plain browser, because there is no Tauri IPC host.

README now documents the symptom next to the `.env` instructions.

## Worth knowing for next time

- CI (`ci.yml` and `semgrep.yml`) only triggers on `pull_request: branches: [main]`.
  A stacked PR that targets another branch runs NO checks at all, and GitHub shows
  the absence of checks in a way that is easy to misread as passing.
- `cargo fmt --check` is now enforced, added by #27. Run `cargo fmt` before pushing.
- Landing a whole-file reformat as its own commit, separate from behaviour changes,
  is what made the #23, #17 and #26 rebases tractable. Keep reformats standalone.
- `git worktree remove` can fail with "Filename too long" on Windows when the
  worktree contains `node_modules`. Purge the directory with robocopy against an
  empty folder first, then run `git worktree prune`.
- Clippy's argument-count threshold is 7. Two independent PRs each adding one
  parameter to the same function is enough to cross it.
- `release.yml` pins `ubuntu-22.04`. Deprecation began 2026-09-17, brownouts fall
  on four Mondays in March and April 2027, and it is unsupported from 2027-04-17
  (actions/runner-images#14254). No rush, and moving to `ubuntu-24.04` raises the
  glibc floor of the `.deb` and AppImage, which is the usual reason to pin an old
  image on purpose. Decide that deliberately rather than as a routine bump.
- A feature nothing compiles will rot. `local-stt` was the only one; if a
  feature-gated path is worth keeping, it needs a CI job that builds it.
- A `let _ = fs::remove_file(...)` in the voice buffer is worth a second look every
  time. Anything that reaches its final name without a manifest entry is invisible
  to the UI, to `clear_all` and to eviction, so a swallowed error leaks audio the
  user believes they erased.
