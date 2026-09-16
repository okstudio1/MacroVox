// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  copyToClipboard: vi.fn(),
  voiceBufferDelete: vi.fn(),
}))

vi.mock('../tauri-ipc', () => ({
  voiceBufferList: vi.fn().mockResolvedValue([{
    file: 'recording.opus',
    transcript: 'keep this transcript',
    timestamp: '2026-09-15T12:00:00Z',
    duration_secs: 2,
    size_bytes: 100,
  }]),
  onVoiceBufferUpdated: () => () => {},
  copyToClipboard: harness.copyToClipboard,
  voiceBufferDelete: harness.voiceBufferDelete,
  voiceBufferGetAudio: vi.fn(),
  voiceBufferReprocess: vi.fn(),
  voiceBufferUpdateTranscript: vi.fn(),
}))

vi.mock('../../hooks/usePostProcessing', () => ({
  usePostProcessing: () => ({ postProcess: vi.fn() }),
}))

import { VoiceHistory } from '../../components/VoiceHistory'

describe('VoiceHistory action failures', () => {
  beforeEach(() => {
    harness.copyToClipboard.mockReset().mockResolvedValue({ success: false, error: 'clipboard unavailable' })
    harness.voiceBufferDelete.mockReset().mockResolvedValue({ success: false, error: 'file is locked' })
  })

  it('keeps failed deletes visible and only reports copy success after a successful write', async () => {
    render(<VoiceHistory user={null} />)
    const transcriptRows = await screen.findAllByText('keep this transcript')
    fireEvent.click(transcriptRows[0])

    fireEvent.click(await screen.findByRole('button', { name: 'Copy' }))
    await screen.findByRole('alert')
    expect(screen.getByRole('alert').textContent).toBe('clipboard unavailable')
    expect(screen.queryByText('Copied')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('file is locked'))
    expect(screen.getAllByText('keep this transcript').length).toBeGreaterThan(0)
  })
})
