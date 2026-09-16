# MacroVox status and roadmap

Last source review: September 15, 2026. This file records repository state, not a claim that production has been deployed.

## Current delivery status

| Area | Status |
| --- | --- |
| Published Windows application | 1.0.8, manual upgrade required for the next release |
| Fix branch | 1.0.9 source, unreleased; managed Deepgram/Claude credential wiring is implemented (`deepgram-grant`, `claude-proxy`, `lib/deepgramCredential.ts`); see the fix ledger |
| Windows native runtime | Tauri 2, Rust cpal capture, streaming/batch Deepgram, optional AI cleanup |
| Linux | Beta; native build and runtime verification required before shipping |
| macOS | Planned |
| Authentication | Supabase email/password; sessions persist in the webview profile |
| BYOK | Deepgram and Anthropic keys supported independently of managed subscriptions |
| Hosted billing and managed speech | Security migrations and endpoint changes prepared; staging and production rollout remain required |
| Updates | Dictation-window notice and explicit install action added in 1.0.9 source; 1.0.8 updater was not mounted |

## September security and dictation work

The [baseline review](SECURITY_ARCHITECTURE_REVIEW_2026-09-15.md) identifies the defects and their evidence. The [fix ledger](SECURITY_ARCHITECTURE_FIXES_2026-09-15.md) maps each finding to implementation, regression tests, and release gates. The [speech investigation](DICTATION_CUTOFF_AND_LATENCY_REVIEW_2026-09-15.md) distinguishes reproduced truncation from unverified reports of increased latency.

The current work covers final transcript ownership, consistent stop behavior, session isolation, stale cleanup cancellation, clipboard failure handling, microphone release, duration-aware buffering, serialized history, auth changes, shared-key removal, atomic request quotas, trial eligibility, webhook consistency, installer trust, CSP, build checks, and dependency updates.

## Required before release

- Run the database and backend migration against staging, including permissions, concurrent quotas, checkout retries, and webhook replay. Follow [the migration runbook](BACKEND_SECURITY_MIGRATION_2026-09-15.md).
- Deploy the backend and rotate previously distributed provider keys in the documented order. Never restore client-readable master keys as a rollback.
- Build and sign Windows artifacts. Test the on-screen stop button immediately after the final word in streaming and batch modes using a real microphone.
- Measure connection, finalization, provider response, and cleanup timing on the installed release. Synthetic tests cannot establish a real-world latency improvement.
- Verify upgrade from 1.0.8 manually, then verify signed updates from a build with the updater mounted.
- Complete the [release checklist](RELEASE_CHECKLIST.md), including installer and WebView CSP smoke tests.

## Remaining architecture work

- Move BYOK secrets and session persistence into OS-backed credential storage where practical. Current webview localStorage is not a secret vault.
- Consider a metered speech relay if enforceable audio-minute billing is required. Short-lived token issuance limits do not cap an already established provider session.
- Reduce secret-bearing cross-window settings messages while preserving reliable settings synchronization.
- Implement and test OAuth deep-link return handling before advertising OAuth as complete.
- Retire archived Electron sources in a separate cleanup after confirming no external tooling depends on them.
- Add Linux release validation and address upstream Rust advisory warnings when supported dependency replacements are available.

Previously published capabilities and milestones remain in [CHANGELOG.md](CHANGELOG.md). Do not mark these release gates complete based only on source changes.
