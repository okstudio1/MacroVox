// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  transcriptListener: undefined as undefined | ((event: { transcript: string; isFinal: boolean; sessionId: number }) => void),
  streamingErrorListener: undefined as undefined | ((event: { error: string; sessionId: number }) => void),
  startDeepgram: vi.fn(),
  stopDeepgram: vi.fn(),
  startRecording: vi.fn(),
  stopRecording: vi.fn(),
  stopAudio: vi.fn(),
  copyToClipboard: vi.fn(),
  autoPaste: vi.fn(),
  postProcess: vi.fn(),
  cancelPostProcessing: vi.fn(),
  authListener: undefined as undefined | ((user: { id: string; email: string; displayName: string; avatarUrl: null; authMethod: 'email' } | null, event: string) => void),
  getUser: vi.fn(),
  hasManagedTranscription: vi.fn(),
  ownKey: vi.fn(),
  resolveDeepgramCredential: vi.fn(),
  settingsListeners: [] as Array<(settings: Record<string, string>) => void>,
  quickStartListener: undefined as undefined | (() => void),
}))

vi.mock('../tauri-ipc', () => ({
  onSettingsChanged: (callback: (settings: Record<string, string>) => void) => {
    harness.settingsListeners.push(callback)
    return () => {}
  },
  setDictationAlwaysOnTop: vi.fn().mockResolvedValue({ success: true }),
  setAudioDevice: vi.fn().mockResolvedValue({ success: true }),
  onTranscript: (callback: typeof harness.transcriptListener) => {
    harness.transcriptListener = callback
    return () => {}
  },
  onStreamingError: (callback: typeof harness.streamingErrorListener) => {
    harness.streamingErrorListener = callback
    return () => {}
  },
  onQuickDictationStart: (callback: () => void) => {
    harness.quickStartListener = callback
    return () => {}
  },
  onQuickDictationToggle: () => () => {},
  onAuthStateChanged: () => () => {},
  emitAuthStateChanged: vi.fn().mockResolvedValue(undefined),
  startDeepgram: harness.startDeepgram,
  stopDeepgram: harness.stopDeepgram,
  startRecording: harness.startRecording,
  stopRecording: harness.stopRecording,
  stopAudio: harness.stopAudio,
  getAudioLevel: vi.fn().mockResolvedValue(0),
  copyToClipboard: harness.copyToClipboard,
  autoPaste: harness.autoPaste,
  voiceBufferSave: vi.fn().mockResolvedValue({ success: true }),
  emitVoiceBufferUpdated: vi.fn().mockResolvedValue(undefined),
  openSettingsWindow: vi.fn().mockResolvedValue({ success: true }),
}))

vi.mock('../auth', () => ({
  getUser: harness.getUser,
  hasManagedTranscription: harness.hasManagedTranscription,
  onAuthStateChange: (callback: typeof harness.authListener) => {
    harness.authListener = callback
    return () => {}
  },
}))

vi.mock('../deepgramCredential', () => ({
  ownKey: harness.ownKey,
  resolveDeepgramCredential: harness.resolveDeepgramCredential,
}))

vi.mock('../../hooks/usePostProcessing', () => ({
  usePostProcessing: () => ({
    postProcess: harness.postProcess,
    isPostProcessing: false,
    cancelPostProcessing: harness.cancelPostProcessing,
  }),
}))

vi.mock('../../components/UpdateNotice', () => ({ UpdateNotice: () => <div data-testid="update-notice" /> }))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ startDragging: vi.fn(), minimize: vi.fn(), close: vi.fn() }),
}))

import { DictationMode } from '../../components/DictationMode'

async function readyRecordButton() {
  const button = await screen.findByRole('button', { name: 'Start dictation' })
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
  return button
}

describe('DictationMode stop lifecycle', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('user_deepgram_key', 'user-key')
    localStorage.setItem('dictation_ai_cleanup', 'false')
    localStorage.setItem('dictation_auto_cutoff', 'off')
    harness.startDeepgram.mockReset().mockResolvedValue({ success: true, sessionId: 7 })
    harness.stopDeepgram.mockReset().mockResolvedValue({ success: true, transcript: 'hello final words', sessionId: 7 })
    harness.startRecording.mockReset().mockResolvedValue({ success: true })
    harness.stopRecording.mockReset().mockResolvedValue({ success: true, transcript: 'batch result' })
    harness.stopAudio.mockReset().mockResolvedValue({ success: true })
    harness.copyToClipboard.mockReset().mockResolvedValue({ success: true })
    harness.autoPaste.mockReset().mockResolvedValue({ success: true })
    harness.postProcess.mockReset().mockResolvedValue(null)
    harness.cancelPostProcessing.mockReset()
    harness.getUser.mockReset().mockResolvedValue({ success: false })
    harness.hasManagedTranscription.mockReset().mockResolvedValue({ success: false, entitled: false })
    harness.ownKey.mockReset().mockImplementation(
      () => (localStorage.getItem('user_deepgram_key') || '').trim() || null,
    )
    harness.resolveDeepgramCredential.mockReset().mockImplementation(async () => {
      const own = (localStorage.getItem('user_deepgram_key') || '').trim()
      if (own) return { success: true, credential: { kind: 'api_key', value: own } }
      return { success: true, credential: { kind: 'access_token', value: 'granted-token' } }
    })
    harness.authListener = undefined
    harness.settingsListeners = []
    harness.quickStartListener = undefined
    harness.streamingErrorListener = undefined
  })

  it('uses the authoritative streaming stop transcript and ignores late events', async () => {
    localStorage.setItem('transcription_mode', 'streaming')
    render(<DictationMode />)
    expect(screen.getAllByTestId('update-notice')).toHaveLength(1)
    fireEvent.click(await readyRecordButton())
    await screen.findByRole('button', { name: 'Stop' })
    act(() => harness.transcriptListener?.({ transcript: 'hello', isFinal: true, sessionId: 7 }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(harness.copyToClipboard).toHaveBeenCalledWith('hello final words'))

    act(() => harness.transcriptListener?.({ transcript: 'stale tail', isFinal: true, sessionId: 7 }))
    expect((screen.getByPlaceholderText('Transcript appears here...') as HTMLTextAreaElement).value)
      .toBe('hello final words')
  })

  it('fails a streaming start when its worker errors before the start response arrives', async () => {
    localStorage.setItem('transcription_mode', 'streaming')
    let resolveStart: (value: { success: true; sessionId: number }) => void = () => {}
    harness.startDeepgram.mockReturnValue(new Promise(resolve => { resolveStart = resolve }))
    render(<DictationMode />)
    fireEvent.click(await readyRecordButton())
    await screen.findByText(/Preparing mic/)

    act(() => harness.streamingErrorListener?.({ error: 'stream worker closed', sessionId: 31 }))
    resolveStart({ success: true, sessionId: 31 })

    await screen.findByText('stream worker closed')
    await waitFor(() => expect(harness.stopDeepgram).toHaveBeenCalledWith(31))
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
  })

  it('does not apply a pending error from another session to a new start', async () => {
    localStorage.setItem('transcription_mode', 'streaming')
    let resolveStart: (value: { success: true; sessionId: number }) => void = () => {}
    harness.startDeepgram.mockReturnValue(new Promise(resolve => { resolveStart = resolve }))
    render(<DictationMode />)
    fireEvent.click(await readyRecordButton())
    await screen.findByText(/Preparing mic/)

    act(() => harness.streamingErrorListener?.({ error: 'old worker closed', sessionId: 30 }))
    resolveStart({ success: true, sessionId: 31 })

    await screen.findByRole('button', { name: 'Stop' })
    expect(harness.stopDeepgram).not.toHaveBeenCalled()
    expect(screen.queryByText('old worker closed')).toBeNull()
  })

  it('revokes managed recording access when the auth session is cleared', async () => {
    localStorage.removeItem('user_deepgram_key')
    harness.getUser.mockResolvedValue({
      success: true,
      user: {
        id: 'managed-user',
        email: 'managed@example.com',
        displayName: 'Managed User',
        avatarUrl: null,
        authMethod: 'email',
      },
    })
    harness.hasManagedTranscription.mockResolvedValue({ success: true, entitled: true })
    render(<DictationMode />)
    const button = await readyRecordButton()

    harness.getUser.mockResolvedValue({ success: false })
    harness.hasManagedTranscription.mockResolvedValue({ success: false, entitled: false })
    act(() => harness.authListener?.(null, 'SIGNED_OUT'))

    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true))
  })

  it('keeps stop available after auth and a personal key are lost during recording', async () => {
    localStorage.setItem('transcription_mode', 'streaming')
    harness.getUser.mockResolvedValue({
      success: true,
      user: {
        id: 'managed-user',
        email: 'managed@example.com',
        displayName: 'Managed User',
        avatarUrl: null,
        authMethod: 'email',
      },
    })
    render(<DictationMode />)
    fireEvent.click(await readyRecordButton())
    const stopButton = await screen.findByRole('button', { name: 'Stop' })

    localStorage.removeItem('user_deepgram_key')
    harness.getUser.mockResolvedValue({ success: false })
    harness.hasManagedTranscription.mockResolvedValue({ success: false, entitled: false })
    act(() => harness.authListener?.(null, 'SIGNED_OUT'))

    await waitFor(() => expect((stopButton as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(stopButton)
    await waitFor(() => expect(harness.stopDeepgram).toHaveBeenCalledWith(7))
  })

  it('starts a managed streaming session with a tagged access-token credential, never a bare string', async () => {
    localStorage.removeItem('user_deepgram_key')
    localStorage.setItem('transcription_mode', 'streaming')
    harness.getUser.mockResolvedValue({
      success: true,
      user: {
        id: 'managed-user',
        email: 'managed@example.com',
        displayName: 'Managed User',
        avatarUrl: null,
        authMethod: 'email',
      },
    })
    harness.hasManagedTranscription.mockResolvedValue({ success: true, entitled: true })
    render(<DictationMode />)
    fireEvent.click(await readyRecordButton())

    await screen.findByRole('button', { name: 'Stop' })
    expect(harness.startDeepgram).toHaveBeenCalledWith({ kind: 'access_token', value: 'granted-token' })
  })

  it('uses the latest selected transcription mode when the hotkey starts recording', async () => {
    localStorage.setItem('transcription_mode', 'batch')
    render(<DictationMode />)
    await readyRecordButton()

    act(() => {
      for (const listener of harness.settingsListeners) {
        listener({ transcription_mode: 'streaming' })
      }
    })
    act(() => { harness.quickStartListener?.() })

    await screen.findByRole('button', { name: 'Stop' })
    expect(harness.startDeepgram).toHaveBeenCalledWith({ kind: 'api_key', value: 'user-key' })
    expect(harness.startRecording).not.toHaveBeenCalled()
  })

  it('disposes a streaming session that finishes starting after invalidation', async () => {
    localStorage.setItem('transcription_mode', 'streaming')
    let resolveStart: (value: { success: true; sessionId: number }) => void = () => {}
    harness.startDeepgram.mockReturnValue(new Promise(resolve => { resolveStart = resolve }))
    render(<DictationMode />)
    fireEvent.click(await readyRecordButton())
    await screen.findByText(/Preparing mic/)

    act(() => harness.authListener?.({
      id: 'new-user',
      email: 'new@example.com',
      displayName: 'New User',
      avatarUrl: null,
      authMethod: 'email',
    }, 'SIGNED_IN'))
    resolveStart({ success: true, sessionId: 19 })

    await waitFor(() => expect(harness.stopDeepgram).toHaveBeenCalledWith(19))
    await screen.findByRole('button', { name: 'Start dictation' })
  })

  it('releases batch capture that finishes starting after invalidation', async () => {
    localStorage.setItem('transcription_mode', 'batch')
    let resolveStart: (value: { success: true }) => void = () => {}
    harness.startRecording.mockReturnValue(new Promise(resolve => { resolveStart = resolve }))
    render(<DictationMode />)
    fireEvent.click(await readyRecordButton())
    await screen.findByText(/Preparing mic/)

    act(() => harness.authListener?.({
      id: 'new-user',
      email: 'new@example.com',
      displayName: 'New User',
      avatarUrl: null,
      authMethod: 'email',
    }, 'SIGNED_IN'))
    resolveStart({ success: true })

    await waitFor(() => expect(harness.stopAudio).toHaveBeenCalledTimes(1))
    await screen.findByRole('button', { name: 'Start dictation' })
  })

  it('does not invalidate a pending start for a token refresh', async () => {
    localStorage.setItem('transcription_mode', 'streaming')
    let resolveStart: (value: { success: true; sessionId: number }) => void = () => {}
    harness.startDeepgram.mockReturnValue(new Promise(resolve => { resolveStart = resolve }))
    render(<DictationMode />)
    fireEvent.click(await readyRecordButton())
    await screen.findByText(/Preparing mic/)

    act(() => harness.authListener?.({
      id: 'user-1',
      email: 'user@example.com',
      displayName: 'User',
      avatarUrl: null,
      authMethod: 'email',
    }, 'TOKEN_REFRESHED'))
    resolveStart({ success: true, sessionId: 23 })

    await screen.findByRole('button', { name: 'Stop' })
    expect(harness.stopDeepgram).not.toHaveBeenCalled()
  })

  it('labels a partial streaming stop result as incomplete', async () => {
    localStorage.setItem('transcription_mode', 'streaming')
    harness.stopDeepgram.mockResolvedValue({
      success: false,
      transcript: 'partial words',
      sessionId: 7,
      error: 'finalization timed out',
    })
    render(<DictationMode />)
    fireEvent.click(await readyRecordButton())
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }))

    await screen.findByText('Transcript may be incomplete: finalization timed out')
    expect(harness.copyToClipboard).toHaveBeenCalledWith('partial words')
  })

  it('does not overwrite an edit made while streaming stop finalizes', async () => {
    localStorage.setItem('transcription_mode', 'streaming')
    let resolveStop: (value: { success: true; transcript: string; sessionId: number }) => void = () => {}
    harness.stopDeepgram.mockReturnValue(new Promise(resolve => { resolveStop = resolve }))
    render(<DictationMode />)
    fireEvent.click(await readyRecordButton())
    await screen.findByRole('button', { name: 'Stop' })
    act(() => harness.transcriptListener?.({ transcript: 'live words', isFinal: true, sessionId: 7 }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    const textarea = screen.getByPlaceholderText('Transcript appears here...')
    fireEvent.change(textarea, { target: { value: 'my edit during finalization' } })

    resolveStop({ success: true, transcript: 'authoritative final', sessionId: 7 })

    await waitFor(() => expect((textarea as HTMLTextAreaElement).value).toBe('my edit during finalization'))
    expect(harness.copyToClipboard).not.toHaveBeenCalled()
  })

  it('does not overwrite an edit made while batch transcription finishes', async () => {
    localStorage.setItem('transcription_mode', 'batch')
    let resolveStop: (value: { success: true; transcript: string }) => void = () => {}
    harness.stopRecording.mockReturnValue(new Promise(resolve => { resolveStop = resolve }))
    render(<DictationMode />)
    fireEvent.click(await readyRecordButton())
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(harness.stopRecording).toHaveBeenCalled())
    const textarea = screen.getByPlaceholderText('Transcript appears here...')
    fireEvent.change(textarea, { target: { value: 'my batch edit' } })

    resolveStop({ success: true, transcript: 'late batch result' })

    await waitFor(() => expect((textarea as HTMLTextAreaElement).value).toBe('my batch edit'))
    expect(harness.copyToClipboard).not.toHaveBeenCalled()
  })

  it('does not auto-paste when clipboard writing fails', async () => {
    localStorage.setItem('transcription_mode', 'batch')
    localStorage.setItem('dictation_auto_paste', 'true')
    harness.copyToClipboard.mockResolvedValue({ success: false, error: 'clipboard busy' })
    render(<DictationMode />)
    fireEvent.click(await readyRecordButton())
    await screen.findByRole('button', { name: 'Stop' })
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await screen.findByText('clipboard busy')
    expect(harness.autoPaste).not.toHaveBeenCalled()
  })

  it('does not let delayed cleanup overwrite a user edit', async () => {
    localStorage.setItem('transcription_mode', 'batch')
    localStorage.setItem('dictation_ai_cleanup', 'true')
    let resolveCleanup: (value: string | null) => void = () => {}
    harness.postProcess.mockReturnValue(new Promise(resolve => { resolveCleanup = resolve }))
    render(<DictationMode />)
    fireEvent.click(await readyRecordButton())
    await screen.findByRole('button', { name: 'Stop' })
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    const textarea = await screen.findByPlaceholderText('Transcript appears here...')
    await waitFor(() => expect((textarea as HTMLTextAreaElement).value).toBe('batch result'))

    fireEvent.change(textarea, { target: { value: 'my corrected ending' } })
    resolveCleanup('cleaned result')
    await waitFor(() => expect((textarea as HTMLTextAreaElement).value).toBe('my corrected ending'))
  })
})
