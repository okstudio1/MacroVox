// @vitest-environment jsdom
/**
 * Tests for RecordingsPanel, the dictation HUD side panel that lists
 * voice-buffer recordings and lets the user play, transcribe, copy, and
 * delete them.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

const RECORDINGS = [
  {
    file: 'rec-older.ogg',
    timestamp: '2026-09-10T09:00:00.000Z',
    duration_secs: 12,
    size_bytes: 1000,
    transcript: 'Hello there, this is an older recording.',
  },
  {
    file: 'rec-newer.ogg',
    timestamp: '2026-09-14T09:00:00.000Z',
    duration_secs: 754,
    size_bytes: 2000,
    transcript: '',
  },
]

const {
  mockVoiceBufferList,
  mockOnVoiceBufferUpdated,
  mockCopyToClipboard,
  mockVoiceBufferDelete,
  mockVoiceBufferReprocess,
  mockVoiceBufferUpdateTranscript,
  mockVoiceBufferGetAudio,
  mockResolveCredential,
} = vi.hoisted(() => ({
  mockVoiceBufferList: vi.fn(),
  mockOnVoiceBufferUpdated: vi.fn(() => () => {}),
  mockCopyToClipboard: vi.fn(async () => ({ success: true })),
  mockVoiceBufferDelete: vi.fn(async () => ({ success: true })),
  mockVoiceBufferReprocess: vi.fn(),
  mockVoiceBufferUpdateTranscript: vi.fn(async () => ({ success: true })),
  mockVoiceBufferGetAudio: vi.fn(async () => ({ base64: 'AAAA', mime: 'audio/wav' })),
  mockResolveCredential: vi.fn(async () => ({
    success: true,
    credential: { kind: 'api_key', value: 'dg-key' },
  })),
}))

vi.mock('../../lib/tauri-ipc', () => ({
  voiceBufferList: mockVoiceBufferList,
  onVoiceBufferUpdated: mockOnVoiceBufferUpdated,
  copyToClipboard: mockCopyToClipboard,
  voiceBufferDelete: mockVoiceBufferDelete,
  voiceBufferReprocess: mockVoiceBufferReprocess,
  voiceBufferUpdateTranscript: mockVoiceBufferUpdateTranscript,
  voiceBufferGetAudio: mockVoiceBufferGetAudio,
}))

// Stubbed so the panel does not pull in the real Supabase client, which needs
// VITE_SUPABASE_* env that tests deliberately do not set.
vi.mock('../../lib/deepgramCredential', () => ({
  ownKey: () => 'dg-key',
  resolveDeepgramCredential: mockResolveCredential,
}))

vi.mock('../../hooks/usePostProcessing', () => ({
  usePostProcessing: () => ({
    postProcess: vi.fn(async (t: string) => t),
    isPostProcessing: false,
  }),
}))

import { RecordingsPanel } from '../RecordingsPanel'

function renderPanel(overrides: Partial<React.ComponentProps<typeof RecordingsPanel>> = {}) {
  const onOpenTranscript = vi.fn()
  const onClose = vi.fn()
  const utils = render(
    <RecordingsPanel
      canTranscribe
      user={null}
      aiCleanupEnabled={false}
      onOpenTranscript={onOpenTranscript}
      onClose={onClose}
      {...overrides}
    />,
  )
  return { ...utils, onOpenTranscript, onClose }
}

describe('RecordingsPanel', () => {
  beforeEach(() => {
    mockVoiceBufferList.mockReset()
    mockVoiceBufferList.mockResolvedValue(RECORDINGS)
    mockOnVoiceBufferUpdated.mockClear()
    mockCopyToClipboard.mockClear()
    mockVoiceBufferDelete.mockClear()
    mockVoiceBufferReprocess.mockReset()
    mockVoiceBufferUpdateTranscript.mockClear()
    mockVoiceBufferGetAudio.mockClear()
  })

  it('renders both rows newest first with formatted duration', async () => {
    renderPanel()

    const rows = await screen.findAllByRole('listitem')
    expect(rows).toHaveLength(2)

    // Newest first: rec-newer.ogg (Sep 14) before rec-older.ogg (Sep 10).
    expect(within(rows[0]).getByText('12:34')).toBeInTheDocument()
    expect(within(rows[1]).getByText('0:12')).toBeInTheDocument()
  })

  it('calls onOpenTranscript when a row with a transcript is clicked', async () => {
    const { onOpenTranscript } = renderPanel()

    const rows = await screen.findAllByRole('listitem')
    // rec-older.ogg (has a transcript) renders second, newest first.
    const olderRow = rows[1]
    fireEvent.click(within(olderRow).getByText(/Hello there/))

    expect(onOpenTranscript).toHaveBeenCalledWith('Hello there, this is an older recording.')
  })

  it('disables Transcribe when transcription is unavailable', async () => {
    renderPanel({ canTranscribe: false })

    const rows = await screen.findAllByRole('listitem')
    const newerRow = rows[0] // rec-newer.ogg, no transcript
    const transcribeBtn = within(newerRow).getByRole('button', { name: /transcribe recording/i })
    expect(transcribeBtn).toBeDisabled()
    expect(transcribeBtn).toHaveAttribute('title', 'Add a Deepgram key in Settings, or sign in, to transcribe')
  })

  it('transcribes an untranscribed row and opens the result', async () => {
    mockVoiceBufferReprocess.mockResolvedValue({ success: true, transcript: 'Brand new transcript' })
    const { onOpenTranscript } = renderPanel({ canTranscribe: true })

    const rows = await screen.findAllByRole('listitem')
    const newerRow = rows[0]
    const transcribeBtn = within(newerRow).getByRole('button', { name: /transcribe recording/i })
    fireEvent.click(transcribeBtn)

    await waitFor(() => {
      expect(mockVoiceBufferReprocess).toHaveBeenCalledWith('rec-newer.ogg', {
        kind: 'api_key',
        value: 'dg-key',
      })
    })
    await waitFor(() => {
      expect(mockVoiceBufferUpdateTranscript).toHaveBeenCalledWith('rec-newer.ogg', 'Brand new transcript')
    })
    await waitFor(() => {
      expect(onOpenTranscript).toHaveBeenCalledWith('Brand new transcript')
    })
  })

  it('requires two clicks to delete a recording', async () => {
    renderPanel()

    const rows = await screen.findAllByRole('listitem')
    const olderRow = rows[1]
    const deleteBtn = within(olderRow).getByRole('button', { name: /delete recording/i })

    fireEvent.click(deleteBtn)
    expect(mockVoiceBufferDelete).not.toHaveBeenCalled()

    const confirmBtn = within(olderRow).getByRole('button', { name: /confirm delete recording/i })
    fireEvent.click(confirmBtn)

    await waitFor(() => {
      expect(mockVoiceBufferDelete).toHaveBeenCalledWith('rec-older.ogg')
    })
  })

  it('calls onClose when the close button is clicked', async () => {
    const { onClose } = renderPanel()
    await screen.findAllByRole('listitem')

    fireEvent.click(screen.getByRole('button', { name: /close recordings/i }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('shows the empty state when there are no recordings', async () => {
    mockVoiceBufferList.mockResolvedValue([])
    renderPanel()

    expect(await screen.findByText(/no recordings yet/i)).toBeInTheDocument()
  })
})
