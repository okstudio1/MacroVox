/**
 * Tests for the shared recordings helper: the "transcribe a stored
 * recording" flow used by both VoiceHistory (settings window) and
 * RecordingsPanel (dictation HUD), plus its duration/date formatters.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockReprocess, mockUpdateTranscript } = vi.hoisted(() => ({
  mockReprocess: vi.fn(),
  mockUpdateTranscript: vi.fn(),
}))

vi.mock('../tauri-ipc', () => ({
  voiceBufferReprocess: mockReprocess,
  voiceBufferUpdateTranscript: mockUpdateTranscript,
}))

import { transcribeRecording, formatDuration, formatRecordingDate } from '../recordings'

describe('transcribeRecording', () => {
  beforeEach(() => {
    mockReprocess.mockReset()
    mockUpdateTranscript.mockReset()
    mockUpdateTranscript.mockResolvedValue({ success: true })
  })

  it('persists the raw transcript when aiCleanup is false', async () => {
    mockReprocess.mockResolvedValue({ success: true, transcript: 'raw text' })
    const postProcess = vi.fn(async (t: string) => t.toUpperCase())

    const out = await transcribeRecording('file.ogg', { kind: 'api_key', value: 'dg-key' }, postProcess, { aiCleanup: false })

    expect(out).toEqual({ success: true, transcript: 'raw text' })
    expect(postProcess).not.toHaveBeenCalled()
    expect(mockUpdateTranscript).toHaveBeenCalledWith('file.ogg', 'raw text')
  })

  it('persists the cleaned transcript when aiCleanup is true and cleanup succeeds', async () => {
    mockReprocess.mockResolvedValue({ success: true, transcript: 'raw text' })
    const postProcess = vi.fn(async () => 'Cleaned text.')

    const out = await transcribeRecording('file.ogg', { kind: 'api_key', value: 'dg-key' }, postProcess, { aiCleanup: true })

    expect(out).toEqual({ success: true, transcript: 'Cleaned text.' })
    expect(postProcess).toHaveBeenCalledWith('raw text')
    expect(mockUpdateTranscript).toHaveBeenCalledWith('file.ogg', 'Cleaned text.')
  })

  it('falls back to the raw transcript when cleanup returns nothing usable', async () => {
    mockReprocess.mockResolvedValue({ success: true, transcript: 'raw text' })
    const postProcess = vi.fn(async () => null)

    const out = await transcribeRecording('file.ogg', { kind: 'api_key', value: 'dg-key' }, postProcess, { aiCleanup: true })

    expect(out).toEqual({ success: true, transcript: 'raw text' })
    expect(mockUpdateTranscript).toHaveBeenCalledWith('file.ogg', 'raw text')
  })

  it('falls back to the raw transcript and still succeeds when cleanup throws', async () => {
    mockReprocess.mockResolvedValue({ success: true, transcript: 'raw text' })
    const postProcess = vi.fn(async () => { throw new Error('network down') })

    const out = await transcribeRecording('file.ogg', { kind: 'api_key', value: 'dg-key' }, postProcess, { aiCleanup: true })

    expect(out).toEqual({ success: true, transcript: 'raw text' })
    expect(mockUpdateTranscript).toHaveBeenCalledWith('file.ogg', 'raw text')
  })

  it('returns an error and never persists when reprocess fails', async () => {
    mockReprocess.mockResolvedValue({ success: false, error: 'Deepgram 401' })
    const postProcess = vi.fn()

    const out = await transcribeRecording('file.ogg', { kind: 'api_key', value: 'dg-key' }, postProcess, { aiCleanup: false })

    expect(out).toEqual({ success: false, error: 'Deepgram 401' })
    expect(postProcess).not.toHaveBeenCalled()
    expect(mockUpdateTranscript).not.toHaveBeenCalled()
  })

  it('treats an empty transcript as failure and never persists', async () => {
    mockReprocess.mockResolvedValue({ success: true, transcript: '' })
    const postProcess = vi.fn()

    const out = await transcribeRecording('file.ogg', { kind: 'api_key', value: 'dg-key' }, postProcess, { aiCleanup: false })

    expect(out).toEqual({ success: false, error: 'Transcription returned no text' })
    expect(mockUpdateTranscript).not.toHaveBeenCalled()
  })

  it('catches an exception from reprocess and returns its message', async () => {
    mockReprocess.mockRejectedValue(new Error('network unreachable'))
    const postProcess = vi.fn()

    const out = await transcribeRecording('file.ogg', { kind: 'api_key', value: 'dg-key' }, postProcess, { aiCleanup: false })

    expect(out).toEqual({ success: false, error: 'network unreachable' })
    expect(mockUpdateTranscript).not.toHaveBeenCalled()
  })

  it('still returns success with the transcript when persisting throws', async () => {
    mockReprocess.mockResolvedValue({ success: true, transcript: 'raw text' })
    mockUpdateTranscript.mockRejectedValue(new Error('disk full'))
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const postProcess = vi.fn(async (t: string) => t)

    const out = await transcribeRecording('file.ogg', { kind: 'api_key', value: 'dg-key' }, postProcess, { aiCleanup: false })

    expect(out).toEqual({ success: true, transcript: 'raw text' })
    expect(consoleWarnSpy).toHaveBeenCalled()
    consoleWarnSpy.mockRestore()
  })
})

describe('formatDuration', () => {
  it.each([
    [7, '0:07'],
    [754, '12:34'],
    [3723, '1:02:03'],
    [0, '0:00'],
    [59, '0:59'],
    [3600, '1:00:00'],
  ])('formats %i seconds as %s', (secs, expected) => {
    expect(formatDuration(secs)).toBe(expected)
  })

  it('returns 0:00 for NaN', () => {
    expect(formatDuration(NaN)).toBe('0:00')
  })

  it('returns 0:00 for negative values', () => {
    expect(formatDuration(-5)).toBe('0:00')
  })

  it('returns 0:00 for Infinity', () => {
    expect(formatDuration(Infinity)).toBe('0:00')
  })
})

describe('formatRecordingDate', () => {
  const now = new Date(2026, 8, 15, 18, 0, 0) // Sep 15, 2026, 18:00 local

  it('formats a timestamp from today as "Today HH:mm"', () => {
    const iso = new Date(2026, 8, 15, 9, 5, 0).toISOString()
    expect(formatRecordingDate(iso, now)).toBe('Today 09:05')
  })

  it('formats a timestamp from yesterday as "Yesterday HH:mm"', () => {
    const iso = new Date(2026, 8, 14, 14, 32, 0).toISOString()
    expect(formatRecordingDate(iso, now)).toBe('Yesterday 14:32')
  })

  it('formats a same-year timestamp as "Mon D, HH:mm"', () => {
    const iso = new Date(2026, 8, 12, 14, 32, 0).toISOString()
    expect(formatRecordingDate(iso, now)).toBe('Sep 12, 14:32')
  })

  it('formats a different-year timestamp as "Mon D, YYYY" with no time', () => {
    const iso = new Date(2025, 8, 12, 14, 32, 0).toISOString()
    expect(formatRecordingDate(iso, now)).toBe('Sep 12, 2025')
  })

  it('returns an empty string for invalid input', () => {
    expect(formatRecordingDate('not-a-date', now)).toBe('')
  })
})
