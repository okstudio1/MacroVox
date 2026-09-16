// @vitest-environment jsdom

import { act, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  getUser: vi.fn(),
  authListener: undefined as undefined | ((user: { id: string } | null, event: string) => void),
  remoteListener: undefined as undefined | (() => void),
}))

vi.mock('../../components/SettingsPanel', () => ({
  SettingsPanel: ({ user }: { user: { id: string } | null }) => (
    <div data-testid="settings-user">{user?.id || 'anonymous'}</div>
  ),
}))

vi.mock('../../ThemeContext', () => ({
  ThemeProvider: ({ children }: { children: ReactNode }) => children,
}))

vi.mock('../disable-context-menu', () => ({ disableContextMenu: () => {} }))

vi.mock('../auth', () => ({
  getUser: harness.getUser,
  onAuthStateChange: (callback: typeof harness.authListener) => {
    harness.authListener = callback
    return () => {}
  },
}))

vi.mock('../tauri-ipc', () => ({
  emitAuthStateChanged: vi.fn().mockResolvedValue(undefined),
  onAuthStateChanged: (callback: () => void) => {
    harness.remoteListener = callback
    return () => {}
  },
}))

import { SettingsApp } from '../../settings'

describe('Settings auth sequencing', () => {
  beforeEach(() => {
    harness.getUser.mockReset()
    harness.authListener = undefined
    harness.remoteListener = undefined
  })

  it('does not restore a stale user after a sign-out event', async () => {
    let resolveInitial: (value: { success: true; user: { id: string } }) => void = () => {}
    harness.getUser.mockReturnValue(new Promise(resolve => { resolveInitial = resolve }))
    render(<SettingsApp />)
    await waitFor(() => expect(harness.authListener).toBeDefined())

    act(() => harness.authListener?.(null, 'SIGNED_OUT'))
    await act(async () => {
      resolveInitial({ success: true, user: { id: 'stale-user' } })
      await Promise.resolve()
    })
    expect(screen.getByTestId('settings-user').textContent).toBe('anonymous')
  })

  it('keeps the newest cross-window refresh result', async () => {
    let resolveInitial: (value: { success: true; user: { id: string } }) => void = () => {}
    let resolveRemote: (value: { success: true; user: { id: string } }) => void = () => {}
    harness.getUser
      .mockReturnValueOnce(new Promise(resolve => { resolveInitial = resolve }))
      .mockReturnValueOnce(new Promise(resolve => { resolveRemote = resolve }))
    render(<SettingsApp />)
    await waitFor(() => expect(harness.remoteListener).toBeDefined())

    act(() => { harness.remoteListener?.() })
    await waitFor(() => expect(harness.getUser).toHaveBeenCalledTimes(2))
    await act(async () => {
      resolveRemote({ success: true, user: { id: 'current-user' } })
      await Promise.resolve()
    })
    await screen.findByText('current-user')
    await act(async () => {
      resolveInitial({ success: true, user: { id: 'stale-user' } })
      await Promise.resolve()
    })
    expect(screen.getByTestId('settings-user').textContent).toBe('current-user')
  })
})
