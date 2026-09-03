/**
 * VoiceHistory — lists voice buffer recordings with playback, context menu,
 * and AI reprocessing.
 *
 * Renders inside the settings panel when voice buffer is enabled.
 * Audio playback uses HTML5 <audio> with base64-encoded data URIs.
 * Right-click opens a context menu with "Reprocess" and "Delete".
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { Play, Square, Trash2, Loader2, Sparkles, Copy, Check, ArrowDownWideNarrow, ArrowUpNarrowWide } from 'lucide-react'
import { usePostProcessing } from '../hooks/usePostProcessing'
import * as ipc from '../lib/tauri-ipc'
import { resolveDeepgramCredential } from '../lib/deepgramCredential'
import type { VoiceRecording } from '../lib/tauri-ipc'
import { safeAudioMime } from '../lib/audio-mime'

interface VoiceHistoryProps {
  user?: { id: string } | null
}

export function VoiceHistory({ user }: VoiceHistoryProps) {
  const [recordings, setRecordings] = useState<VoiceRecording[]>([])
  const [loading, setLoading] = useState(true)
  const [playingFile, setPlayingFile] = useState<string | null>(null)
  const [loadingAudio, setLoadingAudio] = useState<string | null>(null)
  const [expandedFile, setExpandedFile] = useState<string | null>(null)
  const [reprocessingFile, setReprocessingFile] = useState<string | null>(null)
  const [copiedFile, setCopiedFile] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; file: string } | null>(null)
  const [sortNewestFirst, setSortNewestFirst] = useState(true)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  const { postProcess } = usePostProcessing({
    useProxy: !!user,
    userId: user?.id,
  })

  const loadRecordings = useCallback(async (showSpinner = true) => {
    if (showSpinner) setLoading(true)
    const list = await ipc.voiceBufferList()
    setRecordings(list)
    if (showSpinner) setLoading(false)
  }, [])

  useEffect(() => {
    loadRecordings()
  }, [loadRecordings])

  // Refresh when a new recording is saved elsewhere (e.g., the dictation
  // HUD window). Listens on Tauri's cross-webview event bus because the
  // settings panel and dictation HUD are separate Tauri windows.
  // Silent reload — no spinner flash on the existing list.
  useEffect(() => {
    return ipc.onVoiceBufferUpdated(() => { loadRecordings(false) })
  }, [loadRecordings])

  // Close context menu on click outside
  useEffect(() => {
    if (!contextMenu) return
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [contextMenu])

  const handlePlay = async (file: string) => {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }

    if (playingFile === file) {
      setPlayingFile(null)
      return
    }

    setLoadingAudio(file)
    try {
      const { base64, mime } = await ipc.voiceBufferGetAudio(file)
      const safeMime = safeAudioMime(mime)
      if (!safeMime) {
        console.warn('[VoiceHistory] Refusing unknown audio MIME:', mime)
        return
      }
      const audio = new Audio(`data:${safeMime};base64,${base64}`)
      audio.onended = () => setPlayingFile(null)
      audioRef.current = audio
      await audio.play()
      setPlayingFile(file)
    } catch {
      console.warn('[VoiceHistory] Playback failed for', file)
    } finally {
      setLoadingAudio(null)
    }
  }

  const handleDelete = async (file: string) => {
    if (playingFile === file) {
      audioRef.current?.pause()
      audioRef.current = null
      setPlayingFile(null)
    }
    await ipc.voiceBufferDelete(file)
    setRecordings(prev => prev.filter(r => r.file !== file))
    setContextMenu(null)
    if (expandedFile === file) setExpandedFile(null)
  }

  const handleReprocess = async (file: string) => {
    setContextMenu(null)

    // Resolved per call: the managed credential is a token that expires in
    // about a minute, so there is nothing worth holding onto in component state.
    const credential = await resolveDeepgramCredential()
    if (!credential.success) {
      console.warn('[VoiceHistory] No Deepgram credential:', credential.error)
      return
    }

    setReprocessingFile(file)
    try {
      // Step 1: Re-transcribe through Deepgram
      const result = await ipc.voiceBufferReprocess(file, credential.credential)
      if (!result.success || !result.transcript) {
        console.warn('[VoiceHistory] Re-transcription failed:', result.error)
        return
      }

      let finalTranscript = result.transcript

      // Step 2: Run Claude AI cleanup if enabled
      const aiCleanup = localStorage.getItem('dictation_ai_cleanup') !== 'false'
      if (aiCleanup) {
        const cleaned = await postProcess(finalTranscript)
        if (cleaned) finalTranscript = cleaned
      }

      // Step 3: Update manifest with new transcript
      await ipc.voiceBufferUpdateTranscript(file, finalTranscript)
      setRecordings(prev =>
        prev.map(r => r.file === file ? { ...r, transcript: finalTranscript } : r)
      )
    } catch {
      console.warn('[VoiceHistory] Reprocess failed for', file)
    } finally {
      setReprocessingFile(null)
    }
  }

  const handleCopyTranscript = async (file: string) => {
    const rec = recordings.find(r => r.file === file)
    if (!rec?.transcript) return
    await ipc.copyToClipboard(rec.transcript)
    setCopiedFile(file)
    setTimeout(() => setCopiedFile(null), 2000)
    setContextMenu(null)
  }

  const handleContextMenu = (e: React.MouseEvent, file: string) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, file })
  }

  // Cleanup audio on unmount
  useEffect(() => {
    return () => {
      audioRef.current?.pause()
    }
  }, [])

  const formatDuration = (secs: number) => {
    const m = Math.floor(secs / 60)
    const s = Math.floor(secs % 60)
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const formatDate = (iso: string) => {
    try {
      const d = new Date(iso)
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
        ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    } catch {
      return iso
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-4">
        <Loader2 className="w-4 h-4 animate-spin" style={{ color: 'var(--text-muted)' }} />
      </div>
    )
  }

  if (recordings.length === 0) {
    return (
      <p className="text-xs py-2" style={{ color: 'var(--text-muted)' }}>
        No recordings yet. Recordings will appear here after you dictate.
      </p>
    )
  }

  const sortedRecordings = sortNewestFirst
    ? recordings
    : [...recordings].reverse()

  return (
    <>
      {/* Sort toggle */}
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
          {recordings.length} recording{recordings.length !== 1 ? 's' : ''}
        </span>
        <button
          onClick={() => setSortNewestFirst(prev => !prev)}
          className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded hover:bg-white/10 transition-colors"
          style={{ color: 'var(--text-secondary)' }}
          title={sortNewestFirst ? 'Showing newest first' : 'Showing oldest first'}
        >
          {sortNewestFirst ? <ArrowDownWideNarrow size={12} /> : <ArrowUpNarrowWide size={12} />}
          {sortNewestFirst ? 'Newest first' : 'Oldest first'}
        </button>
      </div>

      <div className="space-y-1 max-h-[300px] overflow-y-auto pr-1">
        {sortedRecordings.map((rec) => (
          <div
            key={rec.file}
            onContextMenu={(e) => handleContextMenu(e, rec.file)}
            className="rounded text-xs cursor-default"
            style={{
              backgroundColor: expandedFile === rec.file
                ? 'var(--accent-primary-10, rgba(103,232,249,0.08))'
                : 'var(--bg-primary)',
              border: '1px solid var(--border-primary)',
            }}
          >
            {/* Main row */}
            <div className="flex items-center gap-2 px-2 py-1.5">
              {/* Play/Stop button */}
              <button
                onClick={() => handlePlay(rec.file)}
                className="shrink-0 p-1 rounded hover:bg-white/10 transition-colors"
                style={{ color: playingFile === rec.file ? 'var(--accent-primary)' : 'var(--text-secondary)' }}
                title={playingFile === rec.file ? 'Stop' : 'Play'}
              >
                {loadingAudio === rec.file ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : playingFile === rec.file ? (
                  <Square size={14} />
                ) : (
                  <Play size={14} />
                )}
              </button>

              {/* Info — click to expand/collapse transcript */}
              <div
                className="flex-1 min-w-0 cursor-pointer"
                onClick={() => setExpandedFile(expandedFile === rec.file ? null : rec.file)}
              >
                <p className="truncate" style={{ color: 'var(--text-primary)' }}>
                  {rec.transcript || '(no transcript)'}
                </p>
                <p style={{ color: 'var(--text-muted)', fontSize: '10px' }}>
                  {formatDate(rec.timestamp)} · {formatDuration(rec.duration_secs)} · {formatSize(rec.size_bytes)}
                  {reprocessingFile === rec.file && (
                    <span style={{ color: 'var(--accent-primary)' }}> · reprocessing...</span>
                  )}
                </p>
              </div>

              {/* Reprocess indicator */}
              {reprocessingFile === rec.file && (
                <Loader2 size={12} className="shrink-0 animate-spin" style={{ color: 'var(--accent-primary)' }} />
              )}
            </div>

            {/* Expanded transcript view */}
            {expandedFile === rec.file && rec.transcript && (
              <div className="px-3 pb-2 pt-0.5" style={{ borderTop: '1px solid var(--border-primary)' }}>
                <p className="text-xs whitespace-pre-wrap leading-relaxed py-1.5" style={{ color: 'var(--text-primary)' }}>
                  {rec.transcript}
                </p>
                <div className="flex items-center gap-1 pt-1">
                  <button
                    onClick={() => handleCopyTranscript(rec.file)}
                    className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded hover:bg-white/10 transition-colors"
                    style={{ color: copiedFile === rec.file ? 'var(--accent-primary)' : 'var(--text-muted)' }}
                  >
                    {copiedFile === rec.file ? <Check size={10} /> : <Copy size={10} />}
                    {copiedFile === rec.file ? 'Copied' : 'Copy'}
                  </button>
                  {user && (
                    <button
                      onClick={() => handleReprocess(rec.file)}
                      disabled={reprocessingFile === rec.file}
                      className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded hover:bg-white/10 transition-colors disabled:opacity-50"
                      style={{ color: 'var(--accent-primary)' }}
                    >
                      <Sparkles size={10} />
                      Reprocess
                    </button>
                  )}
                  <button
                    onClick={() => handleDelete(rec.file)}
                    className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded hover:bg-red-900/40 transition-colors ml-auto"
                    style={{ color: '#f87171' }}
                  >
                    <Trash2 size={10} />
                    Delete
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          ref={menuRef}
          className="fixed z-[100] py-1 rounded-lg shadow-xl min-w-[160px]"
          style={{
            left: contextMenu.x,
            top: contextMenu.y,
            backgroundColor: 'var(--bg-secondary)',
            border: '1px solid var(--border-primary)',
          }}
        >
          <button
            onClick={() => handleCopyTranscript(contextMenu.file)}
            className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 flex items-center gap-2 transition-colors"
            style={{ color: 'var(--text-primary)' }}
          >
            <Copy size={12} /> Copy transcript
          </button>
          {user && (
            <button
              onClick={() => handleReprocess(contextMenu.file)}
              disabled={reprocessingFile === contextMenu.file}
              className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 flex items-center gap-2 transition-colors disabled:opacity-50"
              style={{ color: 'var(--accent-primary)' }}
            >
              <Sparkles size={12} /> Reprocess
            </button>
          )}
          <div className="my-1" style={{ borderTop: '1px solid var(--border-primary)' }} />
          <button
            onClick={() => handleDelete(contextMenu.file)}
            className="w-full text-left px-3 py-1.5 text-xs hover:bg-red-900/30 flex items-center gap-2 transition-colors"
            style={{ color: '#f87171' }}
          >
            <Trash2 size={12} /> Delete
          </button>
        </div>
      )}
    </>
  )
}
