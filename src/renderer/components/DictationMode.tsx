/**
 * MacroVox — Dictation window component.
 *
 * Owns the entire record/transcribe/post-process flow:
 *   1. Loads the Deepgram API key from the current Supabase session (managed
 *      keys for Pro subscribers); polls every 5 s to pick up sign-in from the
 *      settings window.
 *   2. Starts capture in either `'streaming'` mode (live WebSocket; transcripts
 *      arrive via `onTranscript` events) or `'batch'` mode (record then upload
 *      to Deepgram pre-recorded API on stop).
 *   3. Optionally runs Claude cleanup in the background via `usePostProcessing`
 *      and updates the clipboard if the cleaned text differs from the raw
 *      transcript — the raw text is copied first (optimistic) so the user
 *      doesn't wait for cleanup.
 *   4. Optionally fires `dictation:autoPaste` to send Ctrl+V to the previously
 *      focused window after the dictation window hides itself.
 *
 * Concurrency guards:
 *   - `operationInProgressRef` prevents double-clicking the record button from
 *     starting a second start/stop while the first is still in flight.
 *   - `autoCutoffFiredRef` distinguishes a user-initiated stop from a timer
 *     auto-stop so the prior transcript isn't double-prepended in the latter case.
 *
 * Hotkey integration: listens for `quick-dictation-start` (begin recording on
 * first show) and `quick-dictation-toggle` (start ↔ stop+copy) events emitted
 * by the backend in response to the global Ctrl+Space hotkey.
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { Mic, MicOff, Copy, Check, Trash2, Loader2, Settings, Minus, X } from 'lucide-react'
import { usePostProcessing } from '../hooks/usePostProcessing'
import { getCurrentWindow } from '@tauri-apps/api/window'
import * as ipc from '../lib/tauri-ipc'
import type { AppUser } from '../lib/tauri-ipc'
import * as auth from '../lib/auth'
import { ownKey, resolveDeepgramCredential } from '../lib/deepgramCredential'

export function DictationMode() {
  const [isRecording, setIsRecording] = useState(false)
  const [isPreparing, setIsPreparing] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Whether transcription is available at all, not the credential itself.
  // The credential is resolved per call in lib/deepgramCredential.ts, because
  // the managed one is a token that expires in about a minute.
  const [canTranscribe, setCanTranscribe] = useState(false)
  const [isLoadingKey, setIsLoadingKey] = useState(true)
  const [user, setUser] = useState<AppUser | null>(null)
  const [audioLevel, setAudioLevel] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const autoStopTimerRef = useRef<NodeJS.Timeout | null>(null)
  const audioLevelIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const operationInProgressRef = useRef(false)
  const autoCutoffFiredRef = useRef(false)

  // Quick Dictation settings from localStorage
  const [autoCopyOnStop, setAutoCopyOnStop] = useState(() =>
    localStorage.getItem('dictation_auto_copy') !== 'false'
  )
  const [clearOnNewRecording, setClearOnNewRecording] = useState(() =>
    localStorage.getItem('dictation_clear_on_new') === 'true'
  )
  const [autoCutoffSeconds, setAutoCutoffSeconds] = useState(() =>
    localStorage.getItem('dictation_auto_cutoff') || '30'
  )
  const [transcriptionMode, setTranscriptionMode] = useState(() =>
    localStorage.getItem('transcription_mode') || 'batch'
  )
  const [autoPasteEnabled, setAutoPasteEnabled] = useState(() =>
    localStorage.getItem('dictation_auto_paste') === 'true'
  )
  const [aiCleanupEnabled, setAiCleanupEnabled] = useState(() =>
    localStorage.getItem('dictation_ai_cleanup') !== 'false'
  )
  const streamingTranscriptRef = useRef('')

  const { postProcess, isPostProcessing } = usePostProcessing({
    useProxy: !!user,
    userId: user?.id,
  })

  // Listen for settings changes from backend
  useEffect(() => {
    const cleanup = ipc.onSettingsChanged((settings) => {
      for (const [key, value] of Object.entries(settings)) {
        localStorage.setItem(key, value)
        switch (key) {
          case 'dictation_auto_copy': setAutoCopyOnStop(value === 'true'); break
          case 'dictation_clear_on_new': setClearOnNewRecording(value === 'true'); break
          case 'dictation_auto_cutoff': setAutoCutoffSeconds(value || '30'); break
          case 'transcription_mode': setTranscriptionMode(value || 'batch'); break
          case 'dictation_auto_paste': setAutoPasteEnabled(value === 'true'); break
          case 'dictation_ai_cleanup': setAiCleanupEnabled(value !== 'false'); break
        }
      }
    })
    return cleanup
  }, [])

  // Apply persisted window/audio preferences on startup
  useEffect(() => {
    const alwaysOnTop = localStorage.getItem('dictation_always_on_top') !== 'false'
    ipc.setDictationAlwaysOnTop(alwaysOnTop).catch(() => {})
    const savedMic = localStorage.getItem('selected_mic_device')
    if (savedMic) ipc.setAudioDevice(savedMic).catch(() => {})
  }, [])

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (autoStopTimerRef.current) clearTimeout(autoStopTimerRef.current)
      if (audioLevelIntervalRef.current) clearInterval(audioLevelIntervalRef.current)
    }
  }, [])

  // Listen for streaming transcripts from Deepgram
  useEffect(() => {
    const cleanupTranscript = ipc.onTranscript(({ transcript: text, isFinal }) => {
      if (isFinal && text) {
        streamingTranscriptRef.current = streamingTranscriptRef.current
          ? streamingTranscriptRef.current + ' ' + text
          : text
        setTranscript(streamingTranscriptRef.current)
      }
    })
    const cleanupError = ipc.onStreamingError(({ error }) => {
      setError(error)
      setIsRecording(false)
      setAudioLevel(0)
      if (audioLevelIntervalRef.current) {
        clearInterval(audioLevelIntervalRef.current)
        audioLevelIntervalRef.current = null
      }
    })
    return () => { cleanupTranscript(); cleanupError() }
  }, [])

  const loadApiKey = useCallback(async () => {
    // Bring-your-own-key wins: if the user saved a Deepgram key in Settings then
    // API Keys, use it and skip the entitlement lookup entirely. This lets the
    // app run with no sign-in and no subscription.
    if (ownKey()) {
      setCanTranscribe(true)
      setIsLoadingKey(false)
      // Still resolve the user (if signed in) so account UI/post-processing
      // proxy stays available, but don't let a failure block recording.
      try {
        const userResult = await auth.getUser()
        if (userResult.success && userResult.user) setUser(userResult.user)
      } catch {}
      return
    }

    try {
      const userResult = await auth.getUser()
      if (userResult.success && userResult.user) {
        setUser(userResult.user)
        try {
          // Entitlement only, read from the subscription. No key exists to come
          // back: see lib/deepgramCredential.ts for how a call authenticates.
          const entitlement = await auth.hasManagedTranscription()
          if (entitlement.success && entitlement.entitled) {
            setCanTranscribe(true)
            setIsLoadingKey(false)
            return
          }
        } catch {
          // Not entitled, or the lookup failed. Fall through to free tier.
        }
      }
    } catch {}

    setCanTranscribe(false)
    setIsLoadingKey(false)
  }, [])

  useEffect(() => {
    loadApiKey()
  }, [loadApiKey])

  // Re-load key each time the window is shown via Ctrl+Space
  useEffect(() => {
    const cleanup = ipc.onQuickDictationToggle(() => {
      loadApiKey()
    })
    return cleanup
  }, [loadApiKey])

  // Periodically re-check auth in case user logs in from settings window
  useEffect(() => {
    const interval = setInterval(() => {
      if (!user) loadApiKey()
    }, 5000)
    return () => clearInterval(interval)
  }, [loadApiKey, user])

  // Re-resolve the active key the moment a bring-your-own Deepgram key is saved
  // in the settings window. The periodic re-check above is gated on `!user`, so
  // a signed-in user wouldn't otherwise pick up a newly-entered key until restart.
  useEffect(() => {
    const cleanup = ipc.onSettingsChanged((settings) => {
      if ('user_deepgram_key' in settings) loadApiKey()
    })
    return cleanup
  }, [loadApiKey])

  const handleStartRecording = async () => {
    if (!canTranscribe || operationInProgressRef.current) return
    operationInProgressRef.current = true
    setError(null)

    if (clearOnNewRecording) {
      setTranscript('')
      streamingTranscriptRef.current = ''
    }

    setIsPreparing(true)
    setAudioLevel(0)

    try {
      if (transcriptionMode === 'streaming') {
        if (!clearOnNewRecording) streamingTranscriptRef.current = transcript || ''
        const credential = await resolveDeepgramCredential()
        if (!credential.success) {
          setError(credential.error)
          setIsPreparing(false)
          return
        }
        const result = await ipc.startDeepgram(credential.credential)
        if (!result.success) {
          setError(result.error || 'Failed to start streaming')
          setIsPreparing(false)
          return
        }
      } else {
        const result = await ipc.startRecording()
        if (!result.success) {
          setError(result.error || 'Failed to start')
          setIsPreparing(false)
          return
        }
      }

      setIsPreparing(false)
      setIsRecording(true)

    audioLevelIntervalRef.current = setInterval(async () => {
      const level = await ipc.getAudioLevel()
      setAudioLevel(level)
    }, 50)

    if (autoCutoffSeconds && autoCutoffSeconds !== 'off') {
      const parsed = parseInt(autoCutoffSeconds, 10)
      // Clamp to [5, 300] seconds — anything outside this is either typo'd
      // settings or intentionally bogus input that would overflow setTimeout.
      const seconds = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 5), 300) : 30
      autoStopTimerRef.current = setTimeout(async () => {
        autoCutoffFiredRef.current = true
        await handleStopRecording()
        autoCutoffFiredRef.current = false
      }, seconds * 1000)
    }
    } finally {
      operationInProgressRef.current = false
    }
  }

  const handleStopRecording = async () => {
    if (!canTranscribe || operationInProgressRef.current) return
    operationInProgressRef.current = true

    try {
    if (autoStopTimerRef.current) {
      clearTimeout(autoStopTimerRef.current)
      autoStopTimerRef.current = null
    }
    if (audioLevelIntervalRef.current) {
      clearInterval(audioLevelIntervalRef.current)
      audioLevelIntervalRef.current = null
    }

    setIsRecording(false)
    setAudioLevel(0)

    if (transcriptionMode === 'streaming') {
      await ipc.stopDeepgram()
      const currentText = streamingTranscriptRef.current
      if (currentText) {
        // Save to voice buffer (fire-and-forget — backend checks if enabled).
        // Broadcast across webviews so the settings window's recordings list
        // and usage bar refresh without requiring an app restart. Uses Tauri's
        // event bus because the dictation HUD and settings panel are separate
        // webviews — DOM CustomEvents don't cross that boundary.
        ipc.voiceBufferSave(currentText)
          .then(() => ipc.emitVoiceBufferUpdated())
          .catch(() => {})
        // Optimistic: copy raw transcript immediately, don't wait for cleanup
        if (autoCopyOnStop) {
          await ipc.copyToClipboard(currentText)
          setCopied(true)
          setTimeout(() => setCopied(false), 2000)
        }

        if (autoPasteEnabled && autoCopyOnStop) ipc.autoPaste()

        // AI cleanup in background — update clipboard if result differs.
        // Catch rejection so a failed proxy call doesn't leave isPostProcessing
        // stuck and doesn't surface as an unhandled rejection.
        if (aiCleanupEnabled) {
          postProcess(currentText)
            .then((cleaned) => {
              if (cleaned && cleaned !== currentText) {
                setTranscript(cleaned)
                streamingTranscriptRef.current = cleaned
                if (autoCopyOnStop) ipc.copyToClipboard(cleaned)
              }
            })
            .catch(() => { setError('AI cleanup failed') })
        }
      }
    } else {
      setIsProcessing(true)
      const credential = await resolveDeepgramCredential()
      if (!credential.success) {
        setIsProcessing(false)
        setError(credential.error)
        return
      }
      const result = await ipc.stopRecording(credential.credential)
      setIsProcessing(false)
      if (result.success && result.transcript) {
        const rawSegment = result.transcript
        const prevText = autoCutoffFiredRef.current ? '' : transcript
        const rawText = prevText ? prevText + ' ' + rawSegment : rawSegment
        setTranscript(rawText)

        if (autoCopyOnStop) {
          await ipc.copyToClipboard(rawText)
          setCopied(true)
          setTimeout(() => setCopied(false), 2000)
        }

        if (autoPasteEnabled && autoCopyOnStop) ipc.autoPaste()

        if (aiCleanupEnabled) {
          postProcess(rawSegment)
            .then((cleaned) => {
              if (cleaned && cleaned !== rawSegment) {
                setTranscript(prev => {
                  const cleanedFull = prev.replace(rawSegment, cleaned)
                  if (autoCopyOnStop) ipc.copyToClipboard(cleanedFull)
                  return cleanedFull
                })
              }
            })
            .catch(() => { setError('AI cleanup failed') })
        }
      } else if (!result.success && result.error) {
        setError(result.error)
      }
    }
    } finally {
      operationInProgressRef.current = false
    }
  }

  const handleCopy = async () => {
    if (!transcript) return
    try {
      await ipc.copyToClipboard(transcript)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError('Copy failed')
    }
  }

  const handleClear = () => {
    setTranscript('')
    setError(null)
  }

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + 'px'
    }
  }, [transcript])

  // Handle Ctrl+Space quick dictation shortcut (events from backend)
  useEffect(() => {
    const cleanupStart = ipc.onQuickDictationStart(() => {
      if (canTranscribe && !isRecording && !isPreparing && !isProcessing) {
        handleStartRecording()
      }
    })

    const cleanupToggle = ipc.onQuickDictationToggle(() => {
      if (isRecording) {
        handleStopAndCopy()
      } else if (canTranscribe && !isPreparing && !isProcessing) {
        handleStartRecording()
      }
    })

    return () => {
      cleanupStart()
      cleanupToggle()
    }
  }, [canTranscribe, isRecording, isPreparing, isProcessing])

  const handleStopAndCopy = async () => {
    if (!canTranscribe || operationInProgressRef.current) return
    operationInProgressRef.current = true

    try {
    if (autoStopTimerRef.current) {
      clearTimeout(autoStopTimerRef.current)
      autoStopTimerRef.current = null
    }
    if (audioLevelIntervalRef.current) {
      clearInterval(audioLevelIntervalRef.current)
      audioLevelIntervalRef.current = null
    }

    setIsRecording(false)
    setIsProcessing(true)
    setAudioLevel(0)
    const stopCredential = await resolveDeepgramCredential()
    if (!stopCredential.success) {
      setIsProcessing(false)
      setError(stopCredential.error)
      return
    }
    const result = await ipc.stopRecording(stopCredential.credential)
    setIsProcessing(false)
    if (result.success && result.transcript) {
      const rawSegment = result.transcript
      let rawText = ''
      setTranscript(prev => {
        rawText = prev ? prev + ' ' + rawSegment : rawSegment
        return rawText
      })

      await ipc.copyToClipboard(rawText)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)

      if (autoPasteEnabled) ipc.autoPaste()

      if (aiCleanupEnabled) {
        postProcess(rawSegment)
          .then((cleaned) => {
            if (cleaned && cleaned !== rawSegment) {
              setTranscript(prev => {
                const cleanedFull = prev.replace(rawSegment, cleaned)
                ipc.copyToClipboard(cleanedFull)
                return cleanedFull
              })
            }
          })
          .catch(() => { setError('AI cleanup failed') })
      }
    } else if (!result.success && result.error) {
      setError(result.error)
    }
    } finally {
      operationInProgressRef.current = false
    }
  }

  if (isLoadingKey) {
    return (
      <div className="h-screen w-screen flex items-center justify-center" style={{ backgroundColor: 'var(--bg-primary)' }}>
        <Loader2 className="w-6 h-6 animate-spin" style={{ color: 'var(--accent-primary)' }} />
      </div>
    )
  }

  return (
    <div className="h-screen w-screen flex flex-col p-4 select-none font-mono" style={{ backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)' }}>
      {/* Titlebar: drag the window by pressing anywhere on this bar */}
      <div
        className="h-8 -mx-4 -mt-4 mb-2 flex items-center justify-between cursor-grab active:cursor-grabbing"
        onMouseDown={(e) => {
          if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return
          getCurrentWindow().startDragging()
        }}
      >
        <div className="ml-4 flex-1 h-full" />
        <div className="flex items-center gap-1 pr-1">
          <button
            onClick={() => ipc.openSettingsWindow()}
            className="p-1 rounded hover:bg-white/10"
            style={{ color: 'var(--text-muted)' }}
            title="Settings"
          >
            <Settings size={14} />
          </button>
          <button
            onClick={() => getCurrentWindow().minimize()}
            className="p-1 rounded hover:bg-white/10"
            style={{ color: 'var(--text-muted)' }}
            title="Minimize"
          >
            <Minus size={14} />
          </button>
          <button
            onClick={() => getCurrentWindow().close()}
            className="p-1 rounded hover:bg-red-500/20"
            style={{ color: 'var(--text-muted)' }}
            title="Close"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Main content */}
      <>
      <div className="shrink-0 flex flex-col items-center justify-center gap-3 pt-2">
        {/* Error */}
        {error && (
          <div className="text-xs px-3 py-1 rounded" style={{ color: 'var(--danger)', backgroundColor: 'var(--danger-bg)', border: '1px solid var(--danger)' }}>
            {error}
          </div>
        )}

        {/* Record button */}
        <div className="relative flex items-center justify-center" style={{ width: 80, height: 80 }}>

          {isPreparing && (
            <div className="absolute inset-1 rounded-full border-2 border-amber-500/50 animate-spin" style={{ borderStyle: 'dashed', animationDuration: '1.5s' }} />
          )}

          <button
            onClick={isRecording ? handleStopRecording : handleStartRecording}
            disabled={isProcessing || isPreparing || !canTranscribe}
            className={`relative z-10 w-14 h-14 rounded-full flex items-center justify-center transition-all shadow-lg ${(!canTranscribe || isProcessing || isPreparing) ? 'opacity-50 cursor-not-allowed' : ''}`}
            style={{
              backgroundColor: isPreparing ? 'var(--warning, #d97706)' : isRecording ? 'var(--danger)' : 'var(--accent-primary)',
              border: `2px solid ${isPreparing ? 'var(--warning, #d97706)' : isRecording ? 'var(--danger)' : 'var(--accent-hover)'}`
            }}
          >
            {isProcessing || isPreparing ? (
              <Loader2 className="w-5 h-5 text-white animate-spin" />
            ) : isRecording ? (
              <MicOff className="w-5 h-5 text-white" />
            ) : (
              <Mic className="w-5 h-5 text-white" />
            )}
          </button>
        </div>

        {/* Audio level bars */}
        {isRecording && (
          <div className="flex items-center gap-[2px] h-14">
            {[...Array(21)].map((_, i) => {
              const center = 10
              const dist = Math.abs(i - center)
              const amplified = Math.min(audioLevel * 6, 1)
              const barLevel = Math.max(0.05, amplified - (dist * 0.03))
              const hue = amplified * 25  // red → orange-ish at peak
              return (
                <div
                  key={i}
                  className="w-[3px] rounded-full transition-all duration-[40ms]"
                  style={{
                    backgroundColor: amplified > 0.4
                      ? `hsl(${hue}, 92%, ${48 + barLevel * 18}%)`
                      : 'var(--danger)',
                    height: `${2 + barLevel * 52}px`,
                    opacity: 0.2 + barLevel * 0.8,
                    boxShadow: amplified > 0.3
                      ? `0 0 ${barLevel * 10}px rgba(239, 68, 68, ${barLevel * 0.7})`
                      : 'none',
                  }}
                />
              )
            })}
          </div>
        )}

        {/* Status */}
        <p className="text-xs uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
          {!canTranscribe
            ? 'Sign in & subscribe to start'
            : isPostProcessing
              ? '◎ AI cleanup...'
              : isProcessing
              ? '◎ Transcribing...'
              : isPreparing
                ? '◎ Preparing mic — please wait...'
                : isRecording
                  ? '● Recording — click to stop'
                  : '○ Click to record'}
        </p>
      </div>

      {/* Transcript area */}
      <div className="flex-1 flex flex-col min-h-0 space-y-2">
        <textarea
          ref={textareaRef}
          value={transcript}
          onChange={(e) => setTranscript(e.target.value)}
          placeholder="Transcript appears here..."
          className="w-full flex-1 min-h-[60px] p-2 rounded text-sm resize-none focus:outline-none overflow-y-auto"
          style={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-primary)', color: 'var(--text-primary)' }}
        />

        {/* Actions */}
        <div className="flex justify-between items-center">
          <button
            onClick={handleClear}
            disabled={!transcript}
            className="p-2 rounded-lg transition-colors hover:bg-red-900/40 disabled:cursor-not-allowed"
            style={{ color: transcript ? '#f87171' : 'var(--text-secondary)', opacity: transcript ? 1 : 0.4 }}
            title="Clear transcript"
          >
            <Trash2 size={18} strokeWidth={2} />
          </button>
          <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
            {transcript ? `${transcript.split(/\s+/).filter(Boolean).length} words` : ''}
          </span>
          <button
            onClick={handleCopy}
            disabled={!transcript}
            className="p-2 rounded-lg transition-colors hover:bg-cyan-900/40 disabled:cursor-not-allowed"
            style={{ color: transcript ? (copied ? '#34d399' : '#67e8f9') : 'var(--text-secondary)', opacity: transcript ? 1 : 0.4 }}
            title="Copy to clipboard"
          >
            {copied ? <Check size={18} strokeWidth={2} /> : <Copy size={18} strokeWidth={2} />}
          </button>
        </div>
      </div>
      </>

    </div>
  )
}
