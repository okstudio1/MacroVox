// @vitest-environment jsdom
/**
 * The updater is the one path that cannot be fixed by a later update, so its
 * states are pinned here: what the UI is told after a check finds something,
 * finds nothing, or fails, and that a failed install never leaves the hook
 * claiming it is still working.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

const { mockCheck, mockGetVersion, mockInstallUpdate } = vi.hoisted(() => ({
  mockCheck: vi.fn(),
  mockGetVersion: vi.fn(),
  mockInstallUpdate: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-updater', () => ({ check: mockCheck }))
vi.mock('@tauri-apps/api/app', () => ({ getVersion: mockGetVersion }))
// Installing goes through the backend so the installer's signature can be
// checked between download and execution.
vi.mock('../../lib/tauri-ipc', () => ({ installUpdate: mockInstallUpdate }))

import { useUpdater } from '../useUpdater'

/** A stand-in for the plugin's Update handle, which only reports a version. */
function updateHandle(version: string) {
  return { version }
}

describe('useUpdater', () => {
  beforeEach(() => {
    mockCheck.mockReset()
    mockGetVersion.mockReset().mockResolvedValue('1.0.9')
    mockInstallUpdate.mockReset().mockResolvedValue({ success: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports the running version so the UI can show it', async () => {
    mockCheck.mockResolvedValue(null)
    const { result } = renderHook(() => useUpdater())
    await waitFor(() => expect(result.current.currentVersion).toBe('1.0.9'))
  })

  it('surfaces an available update with its version', async () => {
    mockCheck.mockResolvedValue(updateHandle('1.1.0'))
    const { result } = renderHook(() => useUpdater())

    await act(async () => {
      await result.current.checkForUpdate()
    })

    expect(result.current.available).toBe(true)
    expect(result.current.version).toBe('1.1.0')
    expect(result.current.checked).toBe(true)
    expect(result.current.error).toBeNull()
    expect(result.current.checking).toBe(false)
  })

  it('records a completed check when there is nothing newer', async () => {
    mockCheck.mockResolvedValue(null)
    const { result } = renderHook(() => useUpdater())

    await act(async () => {
      await result.current.checkForUpdate()
    })

    // `checked` is what lets the UI say "up to date" instead of staying blank.
    expect(result.current.checked).toBe(true)
    expect(result.current.available).toBe(false)
    expect(result.current.version).toBeNull()
  })

  it('reports a failed check without claiming to be up to date', async () => {
    mockCheck.mockRejectedValue(new Error('endpoint unreachable'))
    const { result } = renderHook(() => useUpdater())

    await act(async () => {
      await result.current.checkForUpdate()
    })

    expect(result.current.error).toContain('endpoint unreachable')
    expect(result.current.checking).toBe(false)
    // A network failure is not evidence that the build is current.
    expect(result.current.checked).toBe(false)
    expect(result.current.available).toBe(false)
  })

  it('installs through the backend so the signature is checked', async () => {
    mockCheck.mockResolvedValue(updateHandle('1.1.0'))
    const { result } = renderHook(() => useUpdater())

    await act(async () => {
      await result.current.downloadAndInstall()
    })

    expect(mockInstallUpdate).toHaveBeenCalledOnce()
    expect(result.current.error).toBeNull()
  })

  it('surfaces a refusal from the signature check', async () => {
    // What the backend returns when a pin does not hold. Reaching the renderer
    // at all means nothing was installed, since a successful install exits the
    // process instead of replying.
    mockInstallUpdate.mockResolvedValue({
      success: false,
      error: 'This update was refused because installer is signed with an unexpected certificate. Nothing was installed.',
    })
    mockCheck.mockResolvedValue(updateHandle('1.1.0'))
    const { result } = renderHook(() => useUpdater())

    await act(async () => {
      await result.current.downloadAndInstall()
    })

    expect(result.current.downloading).toBe(false)
    expect(result.current.error).toContain('unexpected certificate')
  })

  it('clears the downloading flag when the install call itself throws', async () => {
    mockInstallUpdate.mockRejectedValue(new Error('ipc unavailable'))
    mockCheck.mockResolvedValue(updateHandle('1.1.0'))
    const { result } = renderHook(() => useUpdater())

    await act(async () => {
      await result.current.downloadAndInstall()
    })

    expect(result.current.downloading).toBe(false)
    expect(result.current.error).toContain('ipc unavailable')
  })

  it('checks once on its own shortly after mount', async () => {
    vi.useFakeTimers()
    mockCheck.mockResolvedValue(null)
    renderHook(() => useUpdater())

    expect(mockCheck).not.toHaveBeenCalled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(mockCheck).toHaveBeenCalledOnce()
  })
})
