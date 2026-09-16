/**
 * MacroVox — Dictation window component.
 *
 * Owns the entire record/transcribe/post-process flow:
 *   1. Resolves local key access or managed transcription entitlement and
 *      listens for auth changes from either window.
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
 *
 * Modes: the "Dictate" / "Record" toggle under the titlebar picks between the
 * flow above and a record-only flow (`voiceBufferRecordStart` / `...Stop`)
 * that streams audio straight into the voice buffer with no length limit and
 * no transcription. The Recordings side panel (toggled from the titlebar)
 * lists both kinds of entry and can transcribe a recording on demand; the
 * window is widened by `PANEL_WIDTH` while it is open. Hotkey events follow
 * the current mode (see `resolveHotkeyAction`).
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { Mic, MicOff, Copy, Check, Trash2, Loader2, Settings, Minus, X, Disc, Square, History } from 'lucide-react'
import { usePostProcessing } from '../hooks/usePostProcessing'
import { UpdateNotice } from './UpdateNotice'
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window'
import * as ipc from '../lib/tauri-ipc'
import type { AppUser } from '../lib/tauri-ipc'
import * as auth from '../lib/auth'
import { ownKey, resolveDeepgramCredential } from '../lib/deepgramCredential'
import { RecordingsPanel } from './RecordingsPanel'
import { formatDuration } from '../lib/recordings'
import {
  loadHudMode, saveHudMode, resolveHotkeyAction, widthForPanel,
  BASE_HEIGHT, BASE_WIDTH, PANEL_WIDTH, type HudMode, type HotkeyAction,
} from '../lib/hud-mode'

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
  // 'dictate' = transcribe as before; 'record' = stream to a file, no limit.
  const [hudMode, setHudMode] = useState<HudMode>(() => loadHudMode())
  const [showRecordings, setShowRecordings] = useState(false)
  const [recordElapsed, setRecordElapsed] = useState(0)
  const [lastSavedFile, setLastSavedFile] = useState<string | null>(null)
  const [savedNotice, setSavedNotice] = useState<string | null>(null)
  const recordTimerRef = useRef<NodeJS.Timeout | null>(null)
  const recordStartedAtRef = useRef(0)
  const panelEverOpenedRef = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const autoStopTimerRef = useRef<NodeJS.Timeout | null>(null)
  const audioLevelIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const operationInProgressRef = useRef(false)
  const autoCutoffFiredRef = useRef(false)
  const activeSessionIdRef = useRef<number | null>(null)
  const recordingModeRef = useRef<'batch' | 'streaming'>('batch')
  const sessionBaseTranscriptRef = useRef('')
  const transcriptRef = useRef('')
  const transcriptRevisionRef = useRef(0)
  const recordingGenerationRef = useRef(0)
  const authLoadGenerationRef = useRef(0)
  const currentUserIdRef = useRef<string | null>(null)
  const startRecordingHandlerRef = useRef<() => Promise<void>>(async () => {})
  const stopRecordingHandlerRef = useRef<() => Promise<void>>(async () => {})
  const streamingStartPendingRef = useRef(false)
  const pendingStreamingErrorsRef = useRef(new Map<number, string>())
  const [interimTranscript, setInterimTranscript] = useState('')

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

  const { postProcess, isPostProcessing, cancelPostProcessing } = usePostProcessing({
    useProxy: !!user,
    userId: user?.id,
  })

  const commitTranscript = useCallback((value: string) => {
    transcriptRef.current = value
    transcriptRevisionRef.current += 1
    setTranscript(value)
  }, [])

  const copyTranscript = useCallback(async (text: string): Promise<boolean> => {
    const result = await ipc.copyToClipboard(text)
    if (!result.success) {
      setError(result.error || 'Copy failed')
      return false
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
    return true
  }, [])

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
      if (recordTimerRef.current) clearInterval(recordTimerRef.current)
    }
  }, [])

  // Listen for streaming transcripts from Deepgram
  useEffect(() => {
    const cleanupTranscript = ipc.onTranscript(({ transcript: text, isFinal, sessionId }) => {
      if (sessionId !== activeSessionIdRef.current) return
      if (isFinal && text) {
        streamingTranscriptRef.current = streamingTranscriptRef.current
          ? streamingTranscriptRef.current + ' ' + text
          : text
        transcriptRef.current = streamingTranscriptRef.current
        setTranscript(streamingTranscriptRef.current)
        setInterimTranscript('')
      } else {
        setInterimTranscript(text)
      }
    })
    const cleanupError = ipc.onStreamingError(({ error, sessionId }) => {
      if (activeSessionIdRef.current === null && streamingStartPendingRef.current) {
        if (!pendingStreamingErrorsRef.current.has(sessionId) && pendingStreamingErrorsRef.current.size >= 8) {
          const oldestSessionId = pendingStreamingErrorsRef.current.keys().next().value
          if (oldestSessionId !== undefined) pendingStreamingErrorsRef.current.delete(oldestSessionId)
        }
        pendingStreamingErrorsRef.current.set(sessionId, error)
        return
      }
      if (sessionId !== activeSessionIdRef.current) return
      setError(error)
      setIsRecording(false)
      setAudioLevel(0)
      activeSessionIdRef.current = null
      setInterimTranscript('')
      if (autoStopTimerRef.current) {
        clearTimeout(autoStopTimerRef.current)
        autoStopTimerRef.current = null
      }
      if (audioLevelIntervalRef.current) {
        clearInterval(audioLevelIntervalRef.current)
        audioLevelIntervalRef.current = null
      }
    })
    return () => { cleanupTranscript(); cleanupError() }
  }, [])

  const loadApiKey = useCallback(async () => {
    const loadGeneration = ++authLoadGenerationRef.current
    // Bring-your-own-key wins: if the user saved a Deepgram key in Settings then
    // API Keys, use it and skip the entitlement lookup entirely. This lets the
    // app run with no sign-in and no subscription.
    if (ownKey()) {
      if (loadGeneration === authLoadGenerationRef.current) {
        setCanTranscribe(true)
        setIsLoadingKey(false)
      }
      // Still resolve the user (if signed in) so account UI/post-processing
      // proxy stays available, but don't let a failure block recording.
      try {
        const userResult = await auth.getUser()
        if (loadGeneration === authLoadGenerationRef.current) {
          const nextUser = userResult.success && userResult.user ? userResult.user : null
          currentUserIdRef.current = nextUser?.id ?? null
          setUser(nextUser)
        }
      } catch {}
      return
    }

    try {
      const userResult = await auth.getUser()
      if (userResult.success && userResult.user) {
        if (loadGeneration !== authLoadGenerationRef.current) return
        currentUserIdRef.current = userResult.user.id
        setUser(userResult.user)
        try {
          // Entitlement only, read from the subscription. No key exists to come
          // back: see lib/deepgramCredential.ts for how a call authenticates.
          const entitlement = await auth.hasManagedTranscription()
          if (loadGeneration !== authLoadGenerationRef.current) return
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

    if (loadGeneration === authLoadGenerationRef.current) {
      currentUserIdRef.current = null
      setUser(null)
      setCanTranscribe(false)
      setIsLoadingKey(false)
    }
  }, [])

  useEffect(() => {
    loadApiKey()
  }, [loadApiKey])

  useEffect(() => {
    const invalidateAuthBoundWork = () => {
      authLoadGenerationRef.current += 1
      recordingGenerationRef.current += 1
      transcriptRevisionRef.current += 1
      cancelPostProcessing()
    }
    const cleanupLocal = auth.onAuthStateChange((nextUser, event) => {
      const nextUserId = nextUser?.id ?? null
      const identityChanged = currentUserIdRef.current !== nextUserId
      currentUserIdRef.current = nextUserId
      setUser(nextUser)
      if (event === 'TOKEN_REFRESHED' || !identityChanged) return
      invalidateAuthBoundWork()
      setCanTranscribe(!!ownKey())
      setIsLoadingKey(false)
      ipc.emitAuthStateChanged().catch(() => {})
      loadApiKey()
    })
    const cleanupRemote = ipc.onAuthStateChanged(() => {
      invalidateAuthBoundWork()
      loadApiKey()
    })
    return () => {
      cleanupLocal()
      cleanupRemote()
    }
  }, [cancelPostProcessing, loadApiKey])

  // Re-resolve access when a bring-your-own Deepgram key changes in Settings.
  useEffect(() => {
    const cleanup = ipc.onSettingsChanged((settings) => {
      if ('user_deepgram_key' in settings) {
        recordingGenerationRef.current += 1
        transcriptRevisionRef.current += 1
        cancelPostProcessing()
        loadApiKey()
      }
    })
    return cleanup
  }, [cancelPostProcessing, loadApiKey])

  const handleStartRecording = async () => {
    if (!canTranscribe || operationInProgressRef.current) return
    operationInProgressRef.current = true
    const generation = ++recordingGenerationRef.current
    recordingModeRef.current = transcriptionMode === 'streaming' ? 'streaming' : 'batch'
    setError(null)
    setInterimTranscript('')
    cancelPostProcessing()

    if (clearOnNewRecording) {
      commitTranscript('')
    }
    sessionBaseTranscriptRef.current = clearOnNewRecording ? '' : transcriptRef.current
    streamingTranscriptRef.current = ''

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
        pendingStreamingErrorsRef.current.clear()
        streamingStartPendingRef.current = true
        const result = await ipc.startDeepgram(credential.credential)
        streamingStartPendingRef.current = false
        if (generation !== recordingGenerationRef.current) {
          pendingStreamingErrorsRef.current.clear()
          if (result.success && result.sessionId !== undefined) {
            await ipc.stopDeepgram(result.sessionId).catch(() => {})
          }
          setIsPreparing(false)
          return
        }
        if (!result.success) {
          pendingStreamingErrorsRef.current.clear()
          setError(result.error || 'Failed to start streaming')
          setIsPreparing(false)
          return
        }
        if (result.sessionId === undefined) {
          pendingStreamingErrorsRef.current.clear()
          setError('Streaming session did not start correctly')
          setIsPreparing(false)
          return
        }
        const startupError = pendingStreamingErrorsRef.current.get(result.sessionId)
        pendingStreamingErrorsRef.current.clear()
        if (startupError) {
          await ipc.stopDeepgram(result.sessionId).catch(() => {})
          setError(startupError)
          setIsPreparing(false)
          return
        }
        activeSessionIdRef.current = result.sessionId
      } else {
        const result = await ipc.startRecording()
        if (generation !== recordingGenerationRef.current) {
          if (result.success) await ipc.stopAudio().catch(() => {})
          setIsPreparing(false)
          return
        }
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
        await stopRecordingHandlerRef.current()
        autoCutoffFiredRef.current = false
      }, seconds * 1000)
    }
    } catch (startError) {
      streamingStartPendingRef.current = false
      pendingStreamingErrorsRef.current.clear()
      setIsPreparing(false)
      setError(startError instanceof Error ? startError.message : 'Failed to start recording')
    } finally {
      operationInProgressRef.current = false
    }
  }

  const handleStopRecording = async () => {
    if (operationInProgressRef.current) return
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

    if (recordingModeRef.current === 'streaming') {
      setIsProcessing(true)
      const stopGeneration = recordingGenerationRef.current
      const stopRevision = transcriptRevisionRef.current
      const stoppingSessionId = activeSessionIdRef.current ?? undefined
      activeSessionIdRef.current = null
      setInterimTranscript('')
      const stopResult = await ipc.stopDeepgram(stoppingSessionId)
      setIsProcessing(false)
      const currentText = stopResult.transcript || ''
      if (!stopResult.success) {
        setError(stopResult.error
          ? `Transcript may be incomplete: ${stopResult.error}`
          : 'Transcript may be incomplete because streaming did not close cleanly')
      } else if (stopResult.limitReached) {
        setError('Recording stopped at the audio limit; the transcript may be incomplete')
      }
      if (currentText) {
        const baseText = autoCutoffFiredRef.current ? '' : sessionBaseTranscriptRef.current
        const rawText = baseText ? `${baseText} ${currentText}` : currentText
        if (
          stopGeneration !== recordingGenerationRef.current ||
          stopRevision !== transcriptRevisionRef.current
        ) return
        commitTranscript(rawText)
        // Optimistic: copy raw transcript immediately, don't wait for cleanup
        if (autoCopyOnStop) {
          const copiedSuccessfully = await copyTranscript(rawText)
          if (autoPasteEnabled && copiedSuccessfully) {
            const pasteResult = await ipc.autoPaste()
            if (!pasteResult.success) setError(pasteResult.error || 'Auto-paste failed')
          }
        }

        // AI cleanup in background — update clipboard if result differs.
        // Catch rejection so a failed proxy call doesn't leave isPostProcessing
        // stuck and doesn't surface as an unhandled rejection.
        if (aiCleanupEnabled) {
          const expectedRevision = transcriptRevisionRef.current
          const expectedGeneration = recordingGenerationRef.current
          postProcess(currentText)
            .then((cleaned) => {
              if (
                cleaned &&
                cleaned !== currentText &&
                expectedRevision === transcriptRevisionRef.current &&
                expectedGeneration === recordingGenerationRef.current &&
                transcriptRef.current === rawText
              ) {
                const cleanedFull = baseText ? `${baseText} ${cleaned}` : cleaned
                commitTranscript(cleanedFull)
                if (autoCopyOnStop) copyTranscript(cleanedFull)
              }
            })
            .catch(() => { setError('AI cleanup failed') })
        }
      } else if (!stopResult.success && stopResult.error) {
        setError(stopResult.error)
      }
    } else {
      setIsProcessing(true)
      const stopGeneration = recordingGenerationRef.current
      const stopRevision = transcriptRevisionRef.current
      const audioStopResult = await ipc.stopAudio()
      if (!audioStopResult.success) {
        setIsProcessing(false)
        setError(audioStopResult.error || 'Failed to stop microphone capture')
        return
      }
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
        const prevText = autoCutoffFiredRef.current ? '' : sessionBaseTranscriptRef.current
        const rawText = prevText ? prevText + ' ' + rawSegment : rawSegment
        if (
          stopGeneration !== recordingGenerationRef.current ||
          stopRevision !== transcriptRevisionRef.current
        ) return
        commitTranscript(rawText)

        if (autoCopyOnStop) {
          const copiedSuccessfully = await copyTranscript(rawText)
          if (autoPasteEnabled && copiedSuccessfully) {
            const pasteResult = await ipc.autoPaste()
            if (!pasteResult.success) setError(pasteResult.error || 'Auto-paste failed')
          }
        }

        if (aiCleanupEnabled) {
          const expectedRevision = transcriptRevisionRef.current
          const expectedGeneration = recordingGenerationRef.current
          postProcess(rawSegment)
            .then((cleaned) => {
              if (
                cleaned &&
                cleaned !== rawSegment &&
                expectedRevision === transcriptRevisionRef.current &&
                expectedGeneration === recordingGenerationRef.current &&
                transcriptRef.current === rawText
              ) {
                const cleanedFull = prevText ? `${prevText} ${cleaned}` : cleaned
                commitTranscript(cleanedFull)
                if (autoCopyOnStop) copyTranscript(cleanedFull)
              }
            })
            .catch(() => { setError('AI cleanup failed') })
        }
      } else if (!result.success && result.error) {
        setError(result.error)
      }
    }
    } catch (stopError) {
      setIsProcessing(false)
      setError(stopError instanceof Error ? stopError.message : 'Failed to stop recording')
    } finally {
      operationInProgressRef.current = false
    }
  }

  // ── Record-only mode ──────────────────────────────────────────────────────

  const switchMode = (mode: HudMode) => {
    if (isRecording || isPreparing || isProcessing) return
    setHudMode(mode)
    saveHudMode(mode)
    setError(null)
  }

  const setRecordingsOpen = async (open: boolean) => {
    setShowRecordings(open)
    if (open) panelEverOpenedRef.current = true
    // Widen or narrow the frameless window to make room for the panel. Best
    // effort: if the window API refuses, the panel just shares the current width.
    try {
      const win = getCurrentWindow()
      const size = (await win.innerSize()).toLogical(await win.scaleFactor())
      await win.setMinSize(new LogicalSize(open ? BASE_WIDTH + PANEL_WIDTH : BASE_WIDTH, BASE_HEIGHT))
      await win.setSize(new LogicalSize(widthForPanel(size.width, open), size.height))
    } catch {}
  }

  const handleStartCapture = async () => {
    if (operationInProgressRef.current) return
    operationInProgressRef.current = true
    setError(null)
    setSavedNotice(null)
    setIsPreparing(true)
    setAudioLevel(0)
    try {
      const result = await ipc.voiceBufferRecordStart()
      if (!result.success) {
        setError(result.error || 'Failed to start recording')
        return
      }
      setIsRecording(true)
      recordStartedAtRef.current = Date.now()
      setRecordElapsed(0)
      recordTimerRef.current = setInterval(() => {
        setRecordElapsed(Math.floor((Date.now() - recordStartedAtRef.current) / 1000))
      }, 1000)
      audioLevelIntervalRef.current = setInterval(async () => {
        const level = await ipc.getAudioLevel()
        setAudioLevel(level)
      }, 50)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setIsPreparing(false)
      operationInProgressRef.current = false
    }
  }

  const handleStopCapture = async () => {
    if (operationInProgressRef.current) return
    operationInProgressRef.current = true
    try {
      if (recordTimerRef.current) {
        clearInterval(recordTimerRef.current)
        recordTimerRef.current = null
      }
      if (audioLevelIntervalRef.current) {
        clearInterval(audioLevelIntervalRef.current)
        audioLevelIntervalRef.current = null
      }
      setIsRecording(false)
      setAudioLevel(0)
      setIsProcessing(true)
      // The backend emits voice-buffer-updated itself, so the panel refreshes.
      const result = await ipc.voiceBufferRecordStop()
      if (result.success && result.recording) {
        setLastSavedFile(result.recording.file)
        setSavedNotice(`Saved ${formatDuration(result.recording.duration_secs)} recording`)
        // First save of the session: reveal the list so the new entry and its
        // Transcribe button are obvious. Later saves respect the user's choice.
        if (!panelEverOpenedRef.current) setRecordingsOpen(true)
      } else {
        setError(result.error || 'Failed to save recording')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setIsProcessing(false)
      operationInProgressRef.current = false
    }
  }

  const handleOpenTranscript = (text: string) => {
    setTranscript(text)
    streamingTranscriptRef.current = text
    setError(null)
    if (autoCopyOnStop) {
      ipc.copyToClipboard(text)
        .then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 2000)
        })
        .catch(() => {})
    }
  }

  const handleCopy = async () => {
    if (!transcript) return
    try {
      await copyTranscript(transcript)
    } catch {
      setError('Copy failed')
    }
  }

  const handleClear = () => {
    recordingGenerationRef.current += 1
    cancelPostProcessing()
    commitTranscript('')
    setInterimTranscript('')
    setError(null)
  }

  startRecordingHandlerRef.current = handleStartRecording
  stopRecordingHandlerRef.current = handleStopRecording

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + 'px'
    }
  }, [transcript])

  // Handle Ctrl+Space quick dictation shortcut (events from backend)
  useEffect(() => {
    const context = { hudMode, isRecording, busy: isPreparing || isProcessing, hasKey: canTranscribe }
    const run = (action: HotkeyAction) => {
      switch (action) {
        case 'start-dictation': startRecordingHandlerRef.current(); break
        case 'stop-dictation': stopRecordingHandlerRef.current(); break
        case 'start-capture': handleStartCapture(); break
        case 'stop-capture': handleStopCapture(); break
        case 'none': break
      }
    }
    const cleanupStart = ipc.onQuickDictationStart(() => run(resolveHotkeyAction(context, 'start')))
    const cleanupToggle = ipc.onQuickDictationToggle(() => run(resolveHotkeyAction(context, 'toggle')))

    return () => {
      cleanupStart()
      cleanupToggle()
    }
  }, [canTranscribe, isRecording, isPreparing, isProcessing, hudMode])

  if (isLoadingKey) {
    return (
      <div className="h-screen w-screen flex items-center justify-center" style={{ backgroundColor: 'var(--bg-primary)' }}>
        <Loader2 className="w-6 h-6 animate-spin" style={{ color: 'var(--accent-primary)' }} />
      </div>
    )
  }

  return (
    <div className="h-screen w-screen flex flex-col select-none font-mono" style={{ backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)' }}>
      {/* Titlebar: drag the window by pressing anywhere on this bar */}
      <div
        className="h-8 shrink-0 mb-1 flex items-center justify-between cursor-grab active:cursor-grabbing"
        onMouseDown={(e) => {
          if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return
          getCurrentWindow().startDragging()
        }}
      >
        <div className="ml-4 flex-1 h-full" />
        <div className="flex items-center gap-1 pr-1">
          <button
            onClick={() => setRecordingsOpen(!showRecordings)}
            aria-pressed={showRecordings}
            className="h-7 px-2 rounded flex items-center gap-1 text-[11px] hover:bg-white/10"
            style={{ color: showRecordings ? 'var(--accent-primary)' : 'var(--text-muted)' }}
            title={showRecordings ? 'Hide recordings' : 'Show recordings'}
          >
            <History size={14} />
            Recordings
          </button>
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

      <UpdateNotice />

      {/* Main content: dictation column plus the optional recordings panel */}
      <div className="flex-1 flex flex-row min-h-0">
      <div className="flex-1 flex flex-col min-w-0 px-4 pb-4">
      {/* Mode toggle */}
      <div
        role="group"
        aria-label="Mode"
        className="shrink-0 flex gap-1 rounded-lg p-1 mb-2"
        style={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}
      >
        {(['dictate', 'record'] as const).map((mode) => {
          const active = hudMode === mode
          const locked = isRecording || isPreparing || isProcessing
          return (
            <button
              key={mode}
              onClick={() => switchMode(mode)}
              disabled={locked}
              aria-pressed={active}
              className="flex-1 min-h-[40px] flex items-center justify-center gap-2 rounded-md text-xs uppercase tracking-wider transition-colors disabled:cursor-not-allowed"
              style={{
                backgroundColor: active ? 'var(--accent-primary)' : 'transparent',
                color: active ? '#fff' : 'var(--text-muted)',
                opacity: locked && !active ? 0.5 : 1,
              }}
              title={mode === 'dictate'
                ? 'Transcribe speech to text'
                : 'Save audio only, no time limit. Transcribe later from Recordings.'}
            >
              {mode === 'dictate' ? <Mic size={14} /> : <Disc size={14} />}
              {mode === 'dictate' ? 'Dictate' : 'Record'}
            </button>
          )
        })}
      </div>

      <div className="shrink-0 flex flex-col items-center justify-center gap-3 pt-1">
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
            onClick={isRecording
              ? (hudMode === 'record' ? handleStopCapture : handleStopRecording)
              : (hudMode === 'record' ? handleStartCapture : handleStartRecording)}
            disabled={isProcessing || isPreparing || (hudMode === 'dictate' && !canTranscribe && !isRecording)}
            aria-label={isRecording ? 'Stop' : hudMode === 'record' ? 'Start recording' : 'Start dictation'}
            className={`relative z-10 w-14 h-14 rounded-full flex items-center justify-center transition-all shadow-lg ${((hudMode === 'dictate' && !canTranscribe && !isRecording) || isProcessing || isPreparing) ? 'opacity-50 cursor-not-allowed' : ''}`}
            style={{
              backgroundColor: isPreparing ? 'var(--warning, #d97706)' : isRecording ? 'var(--danger)' : 'var(--accent-primary)',
              border: `2px solid ${isPreparing ? 'var(--warning, #d97706)' : isRecording ? 'var(--danger)' : 'var(--accent-hover)'}`
            }}
          >
            {isProcessing || isPreparing ? (
              <Loader2 className="w-5 h-5 text-white animate-spin" />
            ) : hudMode === 'record' ? (
              isRecording
                ? <Square className="w-5 h-5 text-white" fill="currentColor" />
                : <Disc className="w-5 h-5 text-white" />
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
        <p className="text-xs uppercase tracking-wider" style={{ color: 'var(--text-muted)' }} aria-live="polite">
          {hudMode === 'record'
            ? (isProcessing
              ? '◎ Saving...'
              : isPreparing
                ? '◎ Preparing mic, please wait...'
                : isRecording
                  ? `● Recording ${formatDuration(recordElapsed)}, click to stop`
                  : savedNotice
                    ? `✓ ${savedNotice}`
                    : '○ Click to record (no time limit)')
            : !canTranscribe
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
          onChange={(e) => {
            recordingGenerationRef.current += 1
            cancelPostProcessing()
            commitTranscript(e.target.value)
          }}
          placeholder={hudMode === 'record'
            ? 'Transcribe a recording from the Recordings list to see its text here...'
            : 'Transcript appears here...'}
          className="w-full flex-1 min-h-[60px] p-2 rounded text-sm resize-none focus:outline-none overflow-y-auto"
          style={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-primary)', color: 'var(--text-primary)' }}
        />
        {interimTranscript && (
          <p className="px-2 text-xs italic" style={{ color: 'var(--text-muted)' }} aria-live="polite">
            {interimTranscript}
          </p>
        )}

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
      </div>
      {showRecordings && (
        <RecordingsPanel
          canTranscribe={canTranscribe}
          user={user}
          aiCleanupEnabled={aiCleanupEnabled}
          onOpenTranscript={handleOpenTranscript}
          onClose={() => setRecordingsOpen(false)}
          highlightFile={lastSavedFile}
        />
      )}
      </div>
    </div>
  )
}
