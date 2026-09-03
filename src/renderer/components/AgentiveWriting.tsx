/**
 * AgentiveWriting — voice → AI-generated content (email/message/document).
 *
 * Records the user's spoken command, transcribes it through Deepgram, then
 * sends the transcript to Claude (via `useAgentiveWriting`) which infers the
 * format and tone and produces finished writing. The user can edit the
 * transcribed command and click "regenerate" to try again without re-recording.
 *
 * **Deferred from v1 UI** per `project_writing_tab_deferred` — this component
 * is kept in tree for the post-launch revival but no parent currently mounts it.
 */

import { useState, useRef } from 'react'
import { Mic, MicOff, Copy, Check, RefreshCw, Loader2 } from 'lucide-react'
import { useAgentiveWriting } from '../hooks/useAgentiveWriting'
import { resolveDeepgramCredential } from '../lib/deepgramCredential'
import * as ipc from '../lib/tauri-ipc'
import type { AppUser } from '../lib/tauri-ipc'

interface Props {
  /** Authenticated user (drives Pro/Team gating in `useAgentiveWriting`). */
  user: AppUser | null
  /** Deepgram API key from the user's managed-keys row. */
  /** Whether transcription is available. Not a credential: see lib/deepgramCredential.ts. */
  canTranscribe: boolean
}

export function AgentiveWriting({ user, canTranscribe }: Props) {
  const [isRecording, setIsRecording] = useState(false)
  const [isPreparing, setIsPreparing] = useState(false)
  const [command, setCommand]         = useState('')
  const [output, setOutput]           = useState('')
  const [copied, setCopied]           = useState(false)
  const [error, setError]             = useState<string | null>(null)
  const [audioLevel, setAudioLevel]   = useState(0)
  const audioLevelIntervalRef         = useRef<NodeJS.Timeout | null>(null)

  const { generate, isGenerating } = useAgentiveWriting({
    useProxy: !!user,
    userId: user?.id,
  })

  const handleStartRecording = async () => {
    if (!canTranscribe) return
    setError(null)
    setIsPreparing(true)
    setAudioLevel(0)

    const result = await ipc.startRecording()
    if (!result.success) {
      setError(result.error || 'Failed to start recording')
      setIsPreparing(false)
      return
    }

    setIsPreparing(false)
    setIsRecording(true)

    audioLevelIntervalRef.current = setInterval(async () => {
      const level = await ipc.getAudioLevel()
      setAudioLevel(level)
    }, 50)
  }

  const handleStopAndGenerate = async () => {
    if (!canTranscribe) return

    if (audioLevelIntervalRef.current) {
      clearInterval(audioLevelIntervalRef.current)
      audioLevelIntervalRef.current = null
    }
    setIsRecording(false)
    setAudioLevel(0)

    const credential = await resolveDeepgramCredential()
    if (!credential.success) {
      setError(credential.error)
      return
    }

    const result = await ipc.stopRecording(credential.credential)
    if (!result.success || !result.transcript) {
      setError(result.error || 'Nothing was transcribed')
      return
    }

    const spokenCommand = result.transcript
    setCommand(spokenCommand)

    const generated = await generate(spokenCommand)
    if (generated) {
      setOutput(generated)
    } else {
      setError('Generation failed — check your subscription')
    }
  }

  const handleRegenerate = async () => {
    if (!command || isGenerating) return
    setError(null)
    const generated = await generate(command)
    if (generated) {
      setOutput(generated)
    } else {
      setError('Generation failed — check your subscription')
    }
  }

  const handleCopy = async () => {
    if (!output) return
    try {
      await ipc.copyToClipboard(output)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError('Copy failed')
    }
  }

  const canRecord = canTranscribe && !isRecording && !isPreparing && !isGenerating

  return (
    <div className="flex flex-col gap-3 flex-1 min-h-0">

      {/* Error */}
      {error && (
        <div
          className="text-xs px-2 py-1 rounded"
          style={{ color: 'var(--danger)', backgroundColor: 'var(--danger-bg)', border: '1px solid var(--danger)' }}
        >
          {error}
        </div>
      )}

      {/* Mic + status row */}
      <div className="flex items-center gap-3">
        <button
          onClick={isRecording ? handleStopAndGenerate : handleStartRecording}
          disabled={!canRecord && !isRecording}
          className="shrink-0 w-10 h-10 rounded-full flex items-center justify-center transition-all shadow-md"
          style={{
            backgroundColor: isRecording ? 'var(--danger)' : 'var(--accent-primary)',
            opacity: (!canTranscribe || isPreparing || isGenerating) && !isRecording ? 0.5 : 1,
          }}
          title={isRecording ? 'Stop & generate' : 'Speak your request'}
        >
          {isPreparing ? (
            <Loader2 className="w-4 h-4 text-white animate-spin" />
          ) : isRecording ? (
            <MicOff className="w-4 h-4 text-white" />
          ) : (
            <Mic className="w-4 h-4 text-white" />
          )}
        </button>

        {/* Waveform while recording, status/command otherwise */}
        {isRecording ? (
          <div className="flex items-center gap-[2px] h-6 flex-1">
            {[...Array(9)].map((_, i) => {
              const dist      = Math.abs(i - 4)
              const amplified = Math.min(audioLevel * 4, 1)
              const barLevel  = Math.max(0.08, amplified - dist * 0.07)
              return (
                <div
                  key={i}
                  className="w-[2px] rounded-full transition-all duration-[60ms]"
                  style={{
                    backgroundColor: 'var(--danger)',
                    height:  `${2 + barLevel * 20}px`,
                    opacity: 0.3 + barLevel * 0.7,
                  }}
                />
              )
            })}
          </div>
        ) : (
          <p
            className="text-xs flex-1 truncate italic"
            style={{ color: command ? 'var(--text-secondary)' : 'var(--text-muted)' }}
          >
            {!canTranscribe
              ? 'Sign in & subscribe to start'
              : isGenerating
                ? '◎ Writing...'
                : command
                  ? `"${command}"`
                  : 'Speak what you want written'}
          </p>
        )}
      </div>

      {/* Generated output */}
      <textarea
        value={output}
        onChange={(e) => setOutput(e.target.value)}
        placeholder="Generated content appears here…"
        className="flex-1 min-h-[100px] p-2 rounded text-sm resize-none focus:outline-none overflow-y-auto"
        style={{
          backgroundColor: 'var(--bg-secondary)',
          border: `1px solid ${isGenerating ? 'var(--accent-primary)' : 'var(--border-primary)'}`,
          color:  'var(--text-primary)',
          transition: 'border-color 0.2s',
        }}
      />

      {/* Action bar */}
      <div className="flex justify-between items-center">
        <button
          onClick={handleRegenerate}
          disabled={!command || isGenerating}
          className="p-2 rounded-lg transition-colors hover:bg-purple-900/40 disabled:cursor-not-allowed"
          style={{
            color:   command && !isGenerating ? 'var(--accent-secondary)' : 'var(--text-secondary)',
            opacity: command && !isGenerating ? 1 : 0.4,
          }}
          title="Regenerate"
        >
          {isGenerating
            ? <Loader2 size={18} strokeWidth={2} className="animate-spin" />
            : <RefreshCw size={18} strokeWidth={2} />}
        </button>

        <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
          {output ? `${output.split(/\s+/).filter(Boolean).length} words` : ''}
        </span>

        <button
          onClick={handleCopy}
          disabled={!output}
          className="p-2 rounded-lg transition-colors hover:bg-cyan-900/40 disabled:cursor-not-allowed"
          style={{
            color:   output ? (copied ? '#34d399' : '#67e8f9') : 'var(--text-secondary)',
            opacity: output ? 1 : 0.4,
          }}
          title="Copy to clipboard"
        >
          {copied ? <Check size={18} strokeWidth={2} /> : <Copy size={18} strokeWidth={2} />}
        </button>
      </div>

    </div>
  )
}
