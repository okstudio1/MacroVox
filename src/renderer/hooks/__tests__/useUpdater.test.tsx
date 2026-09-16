// @vitest-environment jsdom
/**
 * The updater is the one path that cannot be fixed by a later update, so its
 * states are pinned here: what the UI is told after a check finds something,
 * finds nothing, or fails, and that a failed install never leaves the hook
 * claiming it is still working.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

const { mockCheck, mockRelaunch, mockGetVersion } = vi.hoisted(() => ({
  mockCheck: vi.fn(),
  mockRelaunch: vi.fn(),
  mockGetVersion: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-updater', () => ({ check: mockCheck }))
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: mockRelaunch }))
vi.mock('@tauri-apps/api/app', () => ({ getVersion: mockGetVersion }))

import { useUpdater } from '../useUpdater'

/** A stand-in for the plugin's Update handle. */
function updateHandle(version: string, install = vi.fn().mockResolvedValue(undefined)) {
  return { version, downloadAndInstall: install }
}

describe('useUpdater', () => {
  beforeEach(() => {
    mockCheck.mockReset()
    mockRelaunch.mockReset().mockResolvedValue(undefined)
    mockGetVersion.mockReset().mockResolvedValue('1.0.9')
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

  it('installs and relaunches when asked', async () => {
    const install = vi.fn().mockResolvedValue(undefined)
    mockCheck.mockResolvedValue(updateHandle('1.1.0', install))
    const { result } = renderHook(() => useUpdater())

    await act(async () => {
      await result.current.downloadAndInstall()
    })

    expect(install).toHaveBeenCalledOnce()
    expect(mockRelaunch).toHaveBeenCalledOnce()
  })

  it('clears the downloading flag when an install fails', async () => {
    const install = vi.fn().mockRejectedValue(new Error('signature rejected'))
    mockCheck.mockResolvedValue(updateHandle('1.1.0', install))
    const { result } = renderHook(() => useUpdater())

    await act(async () => {
      await result.current.downloadAndInstall()
    })

    expect(result.current.downloading).toBe(false)
    expect(result.current.error).toContain('signature rejected')
    // A rejected payload must never restart into a half-applied update.
    expect(mockRelaunch).not.toHaveBeenCalled()
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
