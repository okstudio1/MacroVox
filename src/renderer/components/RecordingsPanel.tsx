/**
 * RecordingsPanel: dictation HUD side panel listing voice-buffer recordings,
 * with playback, on-demand transcription, copy, and delete.
 *
 * Sibling to VoiceHistory.tsx (the settings-window equivalent). Transcription
 * goes through the shared `transcribeRecording` helper in `lib/recordings.ts`
 * so both surfaces treat Deepgram failures, empty transcripts, and Claude
 * cleanup fallback the same way.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { Play, Square, Trash2, Loader2, Sparkles, Copy, Check, X } from 'lucide-react'
import * as ipc from '../lib/tauri-ipc'
import type { VoiceRecording } from '../lib/tauri-ipc'
import { safeAudioMime } from '../lib/audio-mime'
import { formatDuration, formatRecordingDate, transcribeRecording } from '../lib/recordings'
import { usePostProcessing } from '../hooks/usePostProcessing'
import { resolveDeepgramCredential } from '../lib/deepgramCredential'

export interface RecordingsPanelProps {
  canTranscribe: boolean
  user: { id: string } | null
  aiCleanupEnabled: boolean
  /** Fired with a transcript the user opened (row click / Open) or just produced via Transcribe. */
  onOpenTranscript: (text: string) => void
  onClose: () => void
  /** Filename of the recording saved most recently in this session; render that row highlighted. */
  highlightFile?: string | null
}

const DELETE_CONFIRM_MS = 4000
const COPY_FEEDBACK_MS = 2000
const TRANSCRIPT_PREVIEW_LEN = 60

export function RecordingsPanel({
  canTranscribe,
  user,
  aiCleanupEnabled,
  onOpenTranscript,
  onClose,
  highlightFile,
}: RecordingsPanelProps) {
  const [recordings, setRecordings] = useState<VoiceRecording[]>([])
  const [loading, setLoading] = useState(true)
  const [playingFile, setPlayingFile] = useState<string | null>(null)
  const [loadingAudioFile, setLoadingAudioFile] = useState<string | null>(null)
  const [transcribingFiles, setTranscribingFiles] = useState<Set<string>>(new Set())
  const [copiedFile, setCopiedFile] = useState<string | null>(null)
  const [deleteConfirmFile, setDeleteConfirmFile] = useState<string | null>(null)
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const { postProcess } = usePostProcessing({ useProxy: !!user, userId: user?.id })

  const loadRecordings = useCallback(async (showSpinner = true) => {
    if (showSpinner) setLoading(true)
    try {
      const list = await ipc.voiceBufferList()
      const sorted = [...list].sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
      )
      setRecordings(sorted)
    } finally {
      if (showSpinner) setLoading(false)
    }
  }, [])

  useEffect(() => { loadRecordings() }, [loadRecordings])

  // Silent reload (no spinner flash) when a recording is saved/changed elsewhere.
  useEffect(() => ipc.onVoiceBufferUpdated(() => { loadRecordings(false) }), [loadRecordings])

  // Stop playback and cancel any pending delete-confirm timeout on unmount.
  useEffect(() => () => {
    audioRef.current?.pause()
    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current)
  }, [])

  const clearDeleteConfirm = useCallback(() => {
    if (deleteTimerRef.current) {
      clearTimeout(deleteTimerRef.current)
      deleteTimerRef.current = null
    }
    setDeleteConfirmFile(null)
  }, [])

  const dismissRowError = useCallback((file: string) => {
    setRowErrors(prev => {
      if (!(file in prev)) return prev
      const next = { ...prev }
      delete next[file]
      return next
    })
  }, [])

  const handlePlay = useCallback(async (file: string) => {
    clearDeleteConfirm()
    dismissRowError(file)

    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }

    if (playingFile === file) {
      setPlayingFile(null)
      return
    }

    setLoadingAudioFile(file)
    try {
      const { base64, mime } = await ipc.voiceBufferGetAudio(file)
      const safeMime = safeAudioMime(mime)
      if (!safeMime) {
        console.warn('[RecordingsPanel] Refusing unknown audio MIME:', mime)
        return
      }
      const audio = new Audio(`data:${safeMime};base64,${base64}`)
      audio.onended = () => setPlayingFile(null)
      audioRef.current = audio
      await audio.play()
      setPlayingFile(file)
    } catch {
      console.warn('[RecordingsPanel] Playback failed for', file)
    } finally {
      setLoadingAudioFile(null)
    }
  }, [playingFile, clearDeleteConfirm, dismissRowError])

  const handleTranscribe = useCallback(async (file: string) => {
    clearDeleteConfirm()
    dismissRowError(file)
    if (!canTranscribe) return

    setTranscribingFiles(prev => new Set(prev).add(file))
    try {
      const credential = await resolveDeepgramCredential()
      if (!credential.success) {
        setRowErrors(prev => ({ ...prev, [file]: credential.error }))
        return
      }
      const outcome = await transcribeRecording(file, credential.credential, postProcess, { aiCleanup: aiCleanupEnabled })
      if (outcome.success) {
        setRecordings(prev =>
          prev.map(r => (r.file === file ? { ...r, transcript: outcome.transcript } : r)),
        )
        onOpenTranscript(outcome.transcript)
      } else {
        setRowErrors(prev => ({ ...prev, [file]: outcome.error }))
      }
    } finally {
      setTranscribingFiles(prev => {
        const next = new Set(prev)
        next.delete(file)
        return next
      })
    }
  }, [canTranscribe, postProcess, aiCleanupEnabled, onOpenTranscript, clearDeleteConfirm, dismissRowError])

  const handleCopy = useCallback(async (file: string, transcript: string) => {
    clearDeleteConfirm()
    dismissRowError(file)
    await ipc.copyToClipboard(transcript)
    setCopiedFile(file)
    setTimeout(() => {
      setCopiedFile(prev => (prev === file ? null : prev))
    }, COPY_FEEDBACK_MS)
  }, [clearDeleteConfirm, dismissRowError])

  const handleDeleteClick = useCallback(async (file: string) => {
    dismissRowError(file)

    if (deleteConfirmFile !== file) {
      setDeleteConfirmFile(file)
      if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current)
      deleteTimerRef.current = setTimeout(() => setDeleteConfirmFile(null), DELETE_CONFIRM_MS)
      return
    }

    clearDeleteConfirm()
    if (playingFile === file) {
      audioRef.current?.pause()
      audioRef.current = null
      setPlayingFile(null)
    }
    await ipc.voiceBufferDelete(file)
    setRecordings(prev => prev.filter(r => r.file !== file))
  }, [deleteConfirmFile, playingFile, clearDeleteConfirm, dismissRowError])

  const handleOpenRow = useCallback((rec: VoiceRecording) => {
    clearDeleteConfirm()
    dismissRowError(rec.file)
    if (rec.transcript) {
      onOpenTranscript(rec.transcript)
    } else if (canTranscribe) {
      handleTranscribe(rec.file)
    }
  }, [canTranscribe, handleTranscribe, clearDeleteConfirm, dismissRowError, onOpenTranscript])

  return (
    <aside
      aria-label="Recordings"
      className="w-[300px] shrink-0 h-full flex flex-col"
      style={{ borderLeft: '1px solid var(--border-primary)', backgroundColor: 'var(--bg-primary)' }}
    >
      <div
        className="flex items-center justify-between px-3 py-2 shrink-0"
        style={{ borderBottom: '1px solid var(--border-primary)' }}
      >
        <div className="flex items-baseline gap-2">
          <h2 className="text-xs uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
            Recordings
          </h2>
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {recordings.length}
          </span>
        </div>
        <button
          onClick={onClose}
          aria-label="Close recordings"
          className="flex items-center justify-center min-w-[40px] min-h-[40px] rounded hover:bg-white/10 transition-colors"
          style={{ color: 'var(--text-secondary)' }}
        >
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0" role="list">
        {loading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="w-4 h-4 animate-spin" style={{ color: 'var(--text-muted)' }} />
          </div>
        ) : recordings.length === 0 ? (
          <p className="text-xs px-3 py-4" style={{ color: 'var(--text-muted)' }}>
            No recordings yet. Switch to Record mode and press the big button.
          </p>
        ) : (
          recordings.map(rec => (
            <RecordingRow
              key={rec.file}
              rec={rec}
              canTranscribe={canTranscribe}
              highlighted={highlightFile === rec.file}
              isPlaying={playingFile === rec.file}
              isLoadingAudio={loadingAudioFile === rec.file}
              isTranscribing={transcribingFiles.has(rec.file)}
              isCopied={copiedFile === rec.file}
              isDeleteConfirming={deleteConfirmFile === rec.file}
              error={rowErrors[rec.file]}
              onOpen={() => handleOpenRow(rec)}
              onPlay={() => handlePlay(rec.file)}
              onTranscribe={() => handleTranscribe(rec.file)}
              onCopy={() => handleCopy(rec.file, rec.transcript)}
              onDelete={() => handleDeleteClick(rec.file)}
            />
          ))
        )}
      </div>
    </aside>
  )
}

interface RecordingRowProps {
  rec: VoiceRecording
  canTranscribe: boolean
  highlighted: boolean
  isPlaying: boolean
  isLoadingAudio: boolean
  isTranscribing: boolean
  isCopied: boolean
  isDeleteConfirming: boolean
  error?: string
  onOpen: () => void
  onPlay: () => void
  onTranscribe: () => void
  onCopy: () => void
  onDelete: () => void
}

function RecordingRow({
  rec,
  canTranscribe,
  highlighted,
  isPlaying,
  isLoadingAudio,
  isTranscribing,
  isCopied,
  isDeleteConfirming,
  error,
  onOpen,
  onPlay,
  onTranscribe,
  onCopy,
  onDelete,
}: RecordingRowProps) {
  const hasTranscript = !!rec.transcript
  const preview = hasTranscript
    ? rec.transcript.length > TRANSCRIPT_PREVIEW_LEN
      ? `${rec.transcript.slice(0, TRANSCRIPT_PREVIEW_LEN)}...`
      : rec.transcript
    : 'Not transcribed yet'
  const canOpen = hasTranscript || canTranscribe
  const dateLabel = formatRecordingDate(rec.timestamp)
  const actionBtn = 'flex flex-col items-center justify-center gap-0.5 min-h-[40px] flex-1 rounded hover:bg-white/10 transition-colors'
  const actionBtnDisablable = `${actionBtn} disabled:opacity-50 disabled:hover:bg-transparent`

  return (
    <div
      role="listitem"
      className="px-2 py-2"
      style={{
        borderBottom: '1px solid var(--border-primary)',
        borderLeft: highlighted ? '3px solid var(--accent-primary)' : '3px solid transparent',
        backgroundColor: highlighted ? 'var(--accent-primary-10, rgba(103,232,249,0.08))' : 'transparent',
      }}
    >
      <button
        onClick={onOpen}
        disabled={!canOpen}
        className="w-full text-left min-h-[44px] rounded px-1 py-1 hover:bg-white/5 transition-colors disabled:hover:bg-transparent disabled:cursor-default"
      >
        <p className="text-xs flex items-center justify-between gap-2" style={{ color: 'var(--text-primary)' }}>
          <span>{dateLabel}</span>
          <span style={{ color: 'var(--text-muted)' }}>{formatDuration(rec.duration_secs)}</span>
        </p>
        <p
          className="text-xs truncate mt-0.5"
          style={{
            color: hasTranscript ? 'var(--text-secondary)' : 'var(--text-muted)',
            fontStyle: hasTranscript ? 'normal' : 'italic',
          }}
        >
          {preview}
        </p>
      </button>

      <div className="flex items-center gap-1 mt-1">
        <button
          onClick={onPlay} className={actionBtn}
          aria-label={isPlaying ? `Stop playback of recording from ${dateLabel}` : `Play recording from ${dateLabel}`}
          style={{ color: isPlaying ? 'var(--accent-primary)' : 'var(--text-secondary)' }}
        >
          {isLoadingAudio
            ? <Loader2 size={14} className="animate-spin" />
            : isPlaying ? <Square size={14} /> : <Play size={14} />}
          <span className="text-[11px]">{isPlaying ? 'Stop' : 'Play'}</span>
        </button>

        <button
          onClick={onTranscribe} className={actionBtnDisablable}
          disabled={!canTranscribe || isTranscribing}
          title={!canTranscribe ? 'Add a Deepgram key in Settings, or sign in, to transcribe' : undefined}
          aria-label={hasTranscript ? 'Redo transcription' : 'Transcribe recording'}
          style={{ color: 'var(--accent-primary)' }}
        >
          {isTranscribing ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
          <span className="text-[11px]">{isTranscribing ? 'Working...' : hasTranscript ? 'Redo' : 'Transcribe'}</span>
        </button>

        <button
          onClick={onCopy} className={actionBtnDisablable}
          disabled={!hasTranscript} aria-label="Copy transcript"
          style={{ color: isCopied ? 'var(--accent-primary)' : 'var(--text-secondary)' }}
        >
          {isCopied ? <Check size={14} /> : <Copy size={14} />}
          <span className="text-[11px]">{isCopied ? 'Copied' : 'Copy'}</span>
        </button>

        <button
          onClick={onDelete} className={actionBtn}
          aria-label={isDeleteConfirming ? 'Confirm delete recording' : 'Delete recording'}
          style={{ color: isDeleteConfirming ? 'var(--danger)' : 'var(--text-secondary)' }}
        >
          <Trash2 size={14} />
          <span className="text-[11px]">{isDeleteConfirming ? 'Confirm?' : 'Delete'}</span>
        </button>
      </div>

      {error && <p className="text-[11px] mt-1" style={{ color: 'var(--danger)' }}>{error}</p>}
    </div>
  )
}
