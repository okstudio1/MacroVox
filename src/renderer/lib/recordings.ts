/**
 * recordings: shared helpers for the voice-buffer "recordings" UIs.
 *
 * VoiceHistory (settings window) and RecordingsPanel (dictation HUD) both
 * need to re-run a stored recording through Deepgram, optionally clean it up
 * with Claude, and persist the result back onto the recording's manifest
 * entry. Keeping that flow in one place means both surfaces treat failures,
 * empty transcripts, and cleanup fallback the same way.
 */

import * as ipc from './tauri-ipc'
import type { DeepgramCredential } from './deepgramCredential'

export type TranscribeOutcome =
  | { success: true; transcript: string }
  | { success: false; error: string }

/**
 * Re-runs a stored recording through Deepgram, optionally cleans it up with
 * Claude, and persists the result on the recording's manifest entry.
 *
 * Failure modes that never touch the manifest: a failed Deepgram reprocess,
 * or one that comes back with an empty transcript. Claude cleanup is
 * best-effort: if `postProcess` throws or returns nothing usable, the raw
 * Deepgram transcript is kept and the operation still succeeds. Persisting
 * the final transcript is also best-effort: if `voiceBufferUpdateTranscript`
 * throws, the transcript is still returned as a success (the caller has the
 * text even if the on-disk manifest write failed), and a warning is logged.
 */
export async function transcribeRecording(
  file: string,
  credential: DeepgramCredential,
  postProcess: (raw: string) => Promise<string | null>,
  opts: { aiCleanup: boolean },
): Promise<TranscribeOutcome> {
  let result
  try {
    result = await ipc.voiceBufferReprocess(file, credential)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { success: false, error: message }
  }

  if (!result.success || !result.transcript) {
    return { success: false, error: result.error || 'Transcription returned no text' }
  }

  let finalTranscript = result.transcript

  if (opts.aiCleanup) {
    try {
      const cleaned = await postProcess(finalTranscript)
      if (cleaned) finalTranscript = cleaned
    } catch {
      // Cleanup is best-effort, so keep the raw Deepgram transcript.
    }
  }

  try {
    await ipc.voiceBufferUpdateTranscript(file, finalTranscript)
  } catch (err) {
    console.warn('[recordings] Failed to persist transcript for', file, err)
  }

  return { success: true, transcript: finalTranscript }
}

/** "0:07", "12:34", "1:02:03" (hours only when >= 1 h). Non-finite/negative -> "0:00". */
export function formatDuration(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return '0:00'

  const totalSeconds = Math.floor(secs)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
  }
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

/**
 * Short human date for a recording row: "Today 14:32", "Yesterday 09:05",
 * "Sep 12, 14:32" (same year), "Sep 12, 2025" (other year). Uses 24h local
 * time. Invalid input -> "".
 */
export function formatRecordingDate(iso: string, now: Date = new Date()): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''

  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

  const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const dayDiff = Math.round(
    (startOfDay(now).getTime() - startOfDay(d).getTime()) / (24 * 60 * 60 * 1000),
  )

  if (dayDiff === 0) return `Today ${time}`
  if (dayDiff === 1) return `Yesterday ${time}`

  const sameYear = d.getFullYear() === now.getFullYear()
  if (sameYear) {
    return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`
  }
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${d.getFullYear()}`
}
