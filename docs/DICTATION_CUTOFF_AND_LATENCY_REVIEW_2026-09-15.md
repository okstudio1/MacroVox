**Dictation cutoff and latency investigation, 2026-09-15**

> Baseline investigation at commit 2e96786. See the [fix ledger](SECURITY_ARCHITECTURE_FIXES_2026-09-15.md) for subsequent remediation and validation. Findings below describe the reviewed code, not the final fix branch.

The user reports missing speech endings and slower dictation, and confirmed stopping with the on-screen button. Whether text appears during recording or only after Stop remains unconfirmed, so the streaming and batch findings below are kept separate.

Installed app: the Windows uninstall registry reports MacroVox 1.0.8. The running executable is C:/Program Files/MacroVox/macrovox.exe, with a May 30, 2026 modification timestamp. The repository v1.0.8 tag is also dated May 30. A version number and timestamp do not identify its exact build commit. The reviewed capture, stop, and dictation component files have no changes between that tag and reviewed commit 2e96786; only the cleanup prompt changed among the inspected pipeline files.

**Confirmed cutoff defects**

1. **Streaming Stop consumes the transcript before finalization completes.** DictationMode.tsx:275-277 awaits stopDeepgram and immediately captures streamingTranscriptRef. commands.rs:393-402 only queues shutdown and returns. A final speech fragment may arrive afterward, missing the text already sent to clipboard, history, and cleanup.

   A local reproduction extracted and executed the actual on-screen stop handler with mocked IPC. At Stop, the accumulated text was "Please send the". A later final event completed it to "Please send the final report". Clipboard and saved history both remained "Please send the". No speech or provider request was sent.

   deepgram_ws.rs:142-151 also sends a WebSocket close frame immediately after the application-level CloseStream request. Deepgram documents that CloseStream itself flushes cached audio, returns final results and metadata, and then closes the connection. The client should receive that output before ending the socket. A separate Finalize message is optional, not inherently required. [Deepgram CloseStream contract](https://developers.deepgram.com/docs/close-stream)

   Correction: stop capture, drain queued audio, send CloseStream, keep reading with a bounded completion timeout, and return the authoritative final transcript to the renderer. Only then copy, paste, save, or clean up the text. Returning that transcript is safer than relying on event-delivery ordering after an IPC acknowledgement.

2. **The fixed audio cap can discard the last ten seconds of a supported 60-second batch recording.** audio.rs:84-87 caps the buffer at 4,800,000 interleaved samples. At 48 kHz stereo this holds 50 seconds; at 48 kHz mono it holds 100 seconds. audio.rs:118-124 silently ignores further buffered samples. Settings offers a 60-second cutoff.

   This affects batch transcription, batch fallback, and saved history audio. The normal streaming WebSocket still receives frames after this buffer fills. The user's microphone rate and channel count were not established.

   Correction: calculate the maximum sample count from actual sample rate, channels, and the intended duration. Show a limit-reached state rather than continuing to indicate usable recording.

3. **Delayed cleanup can remove a final phrase that arrived after Stop.** DictationMode.tsx:299-305 replaces both the displayed transcript and streaming reference with cleanup of the earlier snapshot. Thus a late final result may briefly appear, then disappear when cleanup of the incomplete text finishes. The same missing recording-generation guard lets an older cleanup overwrite a newer recording or edit.

   Correction: associate cleanup with a finalized recording revision and reject stale responses. Merge identified segments instead of replacing matching text strings.

**Other cutoff behavior**

The default auto-cutoff is a fixed 30 seconds, not silence detection (DictationMode.tsx:60-61 and :242-251). Settings offers 15, 30, 45, and 60 seconds with no Off choice, despite an Off branch in the code. If recordings stop at a repeatable duration, this timer can explain that behavior independently of the Stop-button race. The user's selected duration was not read or assumed.

Under network backpressure, audio.rs:127-141 drops incoming streaming frames once the bounded queue fills. The queue holds 1,000 callback messages, approximately ten seconds if callbacks contain ten milliseconds each. Stop normally follows already queued audio in FIFO order; it does not automatically discard the entire queue. Backlog can still delay the final response, and dropped frames are logged rather than clearly surfaced to the user.

**Latency measurements and causes**

Local history-save benchmark using the actual voice_buffer::save_recording implementation:

| Synthetic recording | Three runs | Mean |
| --- | --- | --- |
| 30 seconds, 48 kHz stereo | 103.207, 104.536, 102.544 ms | 103.429 ms |
| 60 seconds, 48 kHz stereo | 203.546, 202.294, 201.733 ms | 202.524 ms |

These debug-build measurements include Opus encoding, audio file writes, and manifest writes. They exclude synthetic sample generation and compilation, use a fresh history directory per run, and are not production or network timings. This measured path adds about a tenth to two-tenths of a second under these conditions; it does not explain a multi-second slowdown by itself.

In streaming mode, DictationMode.tsx:284-289 invokes the synchronous Rust history-save command before copying. Moving encoding and disk work off the command path remains useful.

In batch mode, commands.rs:466-487 creates an uncompressed WAV and only starts uploading after Stop. It creates a fresh reqwest client each time and sets no explicit request timeout. For illustration, 30 seconds at 48 kHz stereo produces approximately 5.76 MB of 16-bit PCM plus the WAV header. A slower uplink or provider response therefore directly delays the initial transcript. Reuse an HTTP client, measure request phases, and consider a suitable normalized audio format.

Streaming also requests interim results but the renderer displays only final results (DictationMode.tsx:115-121). Showing provisional text separately would improve visible responsiveness without treating it as finalized text.

AI cleanup runs after raw text is copied and has a 15-second abort timeout (usePostProcessing.ts:62-65). Its duration affects the later cleaned result, not the intended first raw paste. Recent number-format prompt changes could alter cleanup work, but no measured regression was established.

At inspection, the public [Deepgram status page](https://status.deepgram.com/) showed its APIs operational. The [Claude status page](https://status.claude.com/) also showed its API operational and listed a resolved September 10 API latency incident. This does not establish that the user's requests were affected or rule out regional, account-specific, or local network delays.

**Proposed correction and verification**

Use one mode-aware recording session owner. Streaming stop should return finalized text with a recording ID, using a bounded wait for completion. Use that result consistently for display, clipboard, history, and cleanup. Correct the sample cap, expose an Off timer option, run history saves in a background worker, and discard stale cleanup results.

Add tests that delay the final speech event until after Stop, verify clipboard/history retain the tail, check limits at 16 kHz mono and 48 kHz stereo, and resolve older cleanup after a newer recording. Add content-free timings for Stop, final result, clipboard completion, history-save completion, and cleanup completion. Those measurements are needed to distinguish upload/provider latency from local processing in the actual installed app.

The cutoff race is reproduced and the buffer-cap defect is confirmed from source. The cause of the recent slowdown remains unproven. No application code, installed binary, settings, or credentials were changed; the temporary benchmark example was removed.
