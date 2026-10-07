# Security exceptions

Findings from automated security audits that have been reviewed and
knowingly skipped. Each entry records the finding, the reason it
isn't load-bearing for this project's threat model, and the trigger
that would warrant revisiting.

Triage agents should treat entries here as "known skipped, do not
re-flag" rather than as a free pass to ignore the underlying class of
finding.

## Dependabot alert #10: glib GHSA-wrw7-89jp-8q8g (medium)

- **Finding:** `glib` 0.18.5 in `src-tauri/Cargo.lock`. The `Iterator` and
  `DoubleEndedIterator` impls for `glib::VariantStrIter` are unsound.
  Patched in 0.20.0.
- **Decided:** 2026-10-07. Tolerate.
- **Reason:** MacroVox does not depend on `glib` and never calls it
  (`rg "glib" src-tauri/src` finds nothing). It arrives only through the
  Linux GTK 3 stack that Tauri 2.11.1 uses (`gtk` 0.18, reached via
  `muda` and Tauri's Linux runtime), and the gtk-rs 0.18 line cannot take
  `glib` 0.20. No lock-only bump exists; the Windows and macOS builds do
  not link it at all. The unsound code path is `VariantStrIter`, which
  MacroVox has no way to reach except through Tauri's own GTK calls.
- **Revisit when:** Tauri moves its Linux backend off gtk-rs 0.18 (then
  bump Tauri and this resolves), or MacroVox starts calling `glib` or
  GVariant APIs directly.

## Dependabot alert #14: rand GHSA-cq8v-f236-94qc (low)

- **Finding:** `rand` 0.7.3 in `src-tauri/Cargo.lock`. `rand` is unsound
  with a custom logger that calls `rand::rng()`. Patched in 0.8.6.
- **Decided:** 2026-10-07. Tolerate.
- **Reason:** This copy of `rand` is build-time only:
  `tauri-utils` 2.9.1 -> `kuchikiki` -> `selectors` 0.24 ->
  `phf_codegen` 0.8 (a build dependency) -> `phf_generator` 0.8 ->
  `rand` 0.7.3. It runs inside a build script to generate a perfect-hash
  table and is not linked into the shipped binary. MacroVox defines no
  custom logger that calls `rand`. The runtime copies of `rand` in the
  tree (0.8.6, 0.10.2) are already patched. Only a Tauri update that
  moves `kuchikiki`/`selectors` off `phf` 0.8 can remove it.
- **Revisit when:** a Tauri release drops `phf_codegen` 0.8 from
  `tauri-utils`, or `cargo tree -i rand@0.7.3 -e normal` shows it in a
  non-build edge.

## How to add an exception

Document the finding (alert number, advisory ID and severity), the date
the decision was made, the threat-model reasoning, and the concrete
trigger that would warrant revisiting. "Revisit when" should be
observable, not aspirational: "when X happens" not "eventually."
