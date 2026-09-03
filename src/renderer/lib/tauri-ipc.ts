/**
 * MacroVox — Tauri IPC bridge.
 *
 * Replaces `window.electronAPI.*` with typed wrappers around
 * `@tauri-apps/api` `invoke()` / `listen()`.
 *
 * Naming mirrors the old ElectronAPI interface exactly so callers only
 * need to change the import, not the call sites.
 *
 * Command name mapping (JS camelCase → Rust snake_case auto-converted by Tauri):
 *   invoke("audio_list_devices")   ↔  audio_list_devices()
 *   invoke("deepgram_start", {...}) ↔  deepgram_start(credential: DeepgramCredential)
 *   etc.
 *
 * Event name mapping (emitted from Rust via app.emit()):
 *   "deepgram:transcript"    payload: TranscriptEvent
 *   "quick-dictation-start"  payload: null
 *   "quick-dictation-toggle" payload: null
 *   "theme-changed"          payload: string  (themeId)
 *   "settings-changed"       payload: Record<string, string>
 *
 * Auth note (Phase 6): auth functions have been removed from this IPC bridge.
 * Import them from `./auth` instead:
 *   getUser, signInEmail, signUpEmail, signOut, signInWithOAuth,
 *   resetPassword, getSubscription, getManagedKeys, checkout, billingPortal
 */

import { invoke } from '@tauri-apps/api/core'
import { emit, listen } from '@tauri-apps/api/event'
import type { UnlistenFn } from '@tauri-apps/api/event'

// Re-export AppUser so existing component imports (`from '../lib/tauri-ipc'`) still resolve.
export type { AppUser } from './auth'

import type { DeepgramCredential } from './deepgramCredential'
export type { DeepgramCredential } from './deepgramCredential'

// ── Shared response types ─────────────────────────────────────────────────────

export interface OkResult {
  success: boolean
  error?: string
}

export interface AudioDevicesResult {
  success: boolean
  devices: string[]
  selected: string | null
  error?: string
}

export interface RecordingStopResult {
  success: boolean
  transcript?: string
  confidence?: number
  duration?: number
  error?: string
}

export interface TranscriptEvent {
  transcript: string
  isFinal: boolean
}

// ── Event helpers ─────────────────────────────────────────────────────────────

/**
 * Subscribes to a Tauri backend event.  Returns a synchronous cleanup function
 * (same shape as the old Electron `on*` callbacks).  The `listen()` call is
 * async internally; the cleanup correctly cancels the subscription once it
 * resolves.
 */
function makeListener<T>(
  eventName: string,
  callback: (payload: T) => void,
): () => void {
  let unlisten: UnlistenFn | undefined
  let cancelled = false
  listen<T>(eventName, (event) => {
    if (!cancelled) callback(event.payload)
  }).then((fn) => {
    if (cancelled) {
      // Cleanup was called before listen() resolved (React StrictMode race)
      fn()
    } else {
      unlisten = fn
    }
  })
  return () => {
    cancelled = true
    unlisten?.()
  }
}

// ── Audio ─────────────────────────────────────────────────────────────────────

export const listAudioDevices = (): Promise<AudioDevicesResult> =>
  invoke('audio_list_devices')

export const setAudioDevice = (deviceName: string): Promise<OkResult> =>
  invoke('audio_set_device', { deviceName })

export const startAudio = (): Promise<OkResult> =>
  invoke('audio_start')

export const stopAudio = (): Promise<OkResult> =>
  invoke('audio_stop')

export const getAudioLevel = (): Promise<number> =>
  invoke('audio_get_level')

// ── Deepgram streaming ────────────────────────────────────────────────────────

export const startDeepgram = (credential: DeepgramCredential): Promise<OkResult> =>
  invoke('deepgram_start', { credential })

export const stopDeepgram = (): Promise<OkResult> =>
  invoke('deepgram_stop')

export const onTranscript = (
  callback: (data: TranscriptEvent) => void,
): () => void => makeListener('deepgram:transcript', callback)

export const onStreamingError = (
  callback: (data: { error: string }) => void,
): () => void => makeListener('deepgram:error', callback)

// ── Buffered recording ────────────────────────────────────────────────────────

export const startRecording = (): Promise<OkResult> =>
  invoke('recording_start')

export const stopRecording = (credential: DeepgramCredential): Promise<RecordingStopResult> =>
  invoke('recording_stop', { credential })

export const cancelRecording = (): Promise<OkResult> =>
  invoke('recording_cancel')

// ── Local STT (whisper-rs, local-stt feature) ─────────────────────────────────

/**
 * Transcribes the current recording buffer using local whisper-rs (offline STT).
 * Call after `startRecording()` + user speaks, as an alternative to `stopRecording`.
 *
 * Requires the Tauri backend to be compiled with `--features local-stt` and a
 * GGML model file downloaded to `modelPath` (e.g. `ggml-base.en.bin`).
 * Returns `{ success: false, error: "local-stt feature not enabled" }` otherwise.
 */
export const whisperTranscribe = (modelPath: string): Promise<RecordingStopResult> =>
  invoke('whisper_transcribe', { modelPath })

// ── Clipboard & auto-paste ────────────────────────────────────────────────────

export const copyToClipboard = (text: string): Promise<OkResult> =>
  invoke('clipboard_write', { text })

export const autoPaste = (): Promise<OkResult> =>
  invoke('dictation_auto_paste')

// ── Window / app settings ─────────────────────────────────────────────────────

export const setDictationAlwaysOnTop = (value: boolean): Promise<OkResult> =>
  invoke('dictation_set_always_on_top', { value })

export const openSettingsWindow = (): Promise<OkResult> =>
  invoke('settings_open_window')

export const setMinimizeToTray = (value: boolean): Promise<OkResult> =>
  invoke('app_set_minimize_to_tray', { value })

export interface PlatformInfo {
  os: string
  is_wayland: boolean
}

export const getPlatformInfo = (): Promise<PlatformInfo> =>
  invoke('platform_info')

// ── Theme & settings broadcast ────────────────────────────────────────────────

export const broadcastThemeChange = (themeId: string): Promise<OkResult> =>
  invoke('theme_broadcast', { themeId })

export const broadcastSettings = (
  settings: Record<string, string>,
): Promise<OkResult> => invoke('settings_broadcast', { settings })

// ── Global hotkey ────────────────────────────────────────────────────────────

export const updateGlobalHotkey = (shortcut: string): Promise<OkResult> =>
  invoke('update_global_hotkey', { shortcut })

// ── Voice buffer ─────────────────────────────────────────────────────────────

export interface VoiceRecording {
  file: string
  timestamp: string
  duration_secs: number
  size_bytes: number
  transcript: string
}

export interface VoiceBufferInfo {
  enabled: boolean
  max_size_bytes: number
  current_size_bytes: number
  recording_count: number
  total_duration_secs: number
  storage_path: string
}

export const voiceBufferList = (): Promise<VoiceRecording[]> =>
  invoke('voice_buffer_list')

export const voiceBufferInfo = (): Promise<VoiceBufferInfo> =>
  invoke('voice_buffer_info')

/**
 * Broadcasts a "voice-buffer-updated" event across all webviews so the
 * settings window can refresh its recordings list / usage bar after a save
 * happens in the dictation HUD. Uses Tauri's event system because
 * `window.dispatchEvent` does not cross webview boundaries.
 */
export const emitVoiceBufferUpdated = (): Promise<void> =>
  emit('voice-buffer-updated')

/** Subscribes to cross-window voice-buffer change notifications. */
export const onVoiceBufferUpdated = (callback: () => void): (() => void) =>
  makeListener<unknown>('voice-buffer-updated', () => callback())

export interface AudioDataResult {
  base64: string
  mime: string
}

export const voiceBufferGetAudio = (filename: string): Promise<AudioDataResult> =>
  invoke('voice_buffer_get_audio', { filename })

export const voiceBufferDelete = (filename: string): Promise<OkResult> =>
  invoke('voice_buffer_delete', { filename })

export const voiceBufferClear = (): Promise<OkResult> =>
  invoke('voice_buffer_clear')

export const voiceBufferSave = (transcript: string): Promise<OkResult> =>
  invoke('voice_buffer_save', { transcript })

export const voiceBufferUpdateTranscript = (filename: string, transcript: string): Promise<OkResult> =>
  invoke('voice_buffer_update_transcript', { filename, transcript })

export const voiceBufferReprocess = (filename: string, credential: DeepgramCredential): Promise<RecordingStopResult> =>
  invoke('voice_buffer_reprocess', { filename, credential })

export const voiceBufferOpenFolder = (): Promise<OkResult> =>
  invoke('voice_buffer_open_folder')

// ── Events ────────────────────────────────────────────────────────────────────

export const onQuickDictationStart = (callback: () => void): () => void =>
  makeListener('quick-dictation-start', callback)

export const onQuickDictationToggle = (callback: () => void): () => void =>
  makeListener('quick-dictation-toggle', callback)

export const onThemeChange = (
  callback: (themeId: string) => void,
): () => void => makeListener('theme-changed', callback)

// Keys we accept from a settings-changed broadcast. Anything else gets dropped
// before being forwarded to the React callback (which writes straight to
// localStorage). Some of these values feed into Claude system prompts, so a
// broadcast that includes an unexpected key is a prompt-injection vector.
const ALLOWED_SETTINGS_KEYS = new Set([
  'deepgram_keywords',
  'minimize_to_tray',
  'theme',
  'dictation_auto_copy',
  'dictation_clear_on_new',
  'dictation_auto_cutoff',
  'dictation_auto_paste',
  'dictation_ai_cleanup',
  'transcription_mode',
  'transcription_language',
  'number_format',
  'voice_buffer_enabled',
  'voice_buffer_max_size',
  'post_processing_context',
  'writing_style_profile',
  'global_hotkey',
  // Bring-your-own API keys. Credentials, not prompt content — they're attached
  // as request headers, never interpolated into a Claude prompt, so they don't
  // carry the prompt-injection risk the other entries guard against.
  'user_deepgram_key',
  'user_anthropic_key',
])

export const onSettingsChanged = (
  callback: (settings: Record<string, string>) => void,
): () => void => makeListener('settings-changed', (raw: Record<string, string>) => {
  const filtered: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (ALLOWED_SETTINGS_KEYS.has(key) && typeof value === 'string') {
      filtered[key] = value
    } else {
      console.warn('[settings] dropped unknown key from broadcast:', key)
    }
  }
  callback(filtered)
})

