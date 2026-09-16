/**
 * Tests for the HUD mode helpers: what the global hotkey does in each mode,
 * how the window resizes around the Recordings panel, and mode persistence.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  resolveHotkeyAction,
  widthForPanel,
  loadHudMode,
  saveHudMode,
  HUD_MODE_KEY,
  BASE_WIDTH,
  PANEL_WIDTH,
} from '../hud-mode'

describe('resolveHotkeyAction', () => {
  const idleDictate = { hudMode: 'dictate' as const, isRecording: false, busy: false, hasKey: true }
  const idleRecord = { ...idleDictate, hudMode: 'record' as const }

  it('starts dictation on toggle or start when idle with a key', () => {
    expect(resolveHotkeyAction(idleDictate, 'toggle')).toBe('start-dictation')
    expect(resolveHotkeyAction(idleDictate, 'start')).toBe('start-dictation')
  })

  it('does nothing in dictate mode without a Deepgram key', () => {
    const ctx = { ...idleDictate, hasKey: false }
    expect(resolveHotkeyAction(ctx, 'toggle')).toBe('none')
    expect(resolveHotkeyAction(ctx, 'start')).toBe('none')
  })

  it('stops dictation on toggle while recording, but never on the start-only event', () => {
    const ctx = { ...idleDictate, isRecording: true }
    expect(resolveHotkeyAction(ctx, 'toggle')).toBe('stop-dictation')
    expect(resolveHotkeyAction(ctx, 'start')).toBe('none')
  })

  it('starts a capture in record mode even without a key', () => {
    expect(resolveHotkeyAction({ ...idleRecord, hasKey: false }, 'toggle')).toBe('start-capture')
    expect(resolveHotkeyAction({ ...idleRecord, hasKey: false }, 'start')).toBe('start-capture')
  })

  it('stops the capture on toggle in record mode', () => {
    const ctx = { ...idleRecord, isRecording: true }
    expect(resolveHotkeyAction(ctx, 'toggle')).toBe('stop-capture')
    expect(resolveHotkeyAction(ctx, 'start')).toBe('none')
  })

  it('ignores events while a start or stop is already in flight', () => {
    expect(resolveHotkeyAction({ ...idleDictate, busy: true }, 'toggle')).toBe('none')
    expect(resolveHotkeyAction({ ...idleRecord, busy: true }, 'toggle')).toBe('none')
  })
})

describe('widthForPanel', () => {
  it('adds the panel width when opening from the default size', () => {
    expect(widthForPanel(BASE_WIDTH, true)).toBe(BASE_WIDTH + PANEL_WIDTH)
  })

  it('removes the panel width when closing', () => {
    expect(widthForPanel(BASE_WIDTH + PANEL_WIDTH, false)).toBe(BASE_WIDTH)
  })

  it('keeps a user-widened window wider', () => {
    expect(widthForPanel(500, true)).toBe(500 + PANEL_WIDTH)
    expect(widthForPanel(900, false)).toBe(600)
  })

  it('never drops below the base width', () => {
    expect(widthForPanel(400, false)).toBe(BASE_WIDTH)
    expect(widthForPanel(200, true)).toBe(BASE_WIDTH + PANEL_WIDTH)
  })
})

describe('loadHudMode / saveHudMode', () => {
  const fakeStorage = () => {
    const map = new Map<string, string>()
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => { map.set(k, v) },
      map,
    }
  }

  it('defaults to dictate when nothing is stored or the value is unknown', () => {
    const s = fakeStorage()
    expect(loadHudMode(s)).toBe('dictate')
    s.setItem(HUD_MODE_KEY, 'bogus')
    expect(loadHudMode(s)).toBe('dictate')
  })

  it('round-trips record mode', () => {
    const s = fakeStorage()
    saveHudMode('record', s)
    expect(s.map.get(HUD_MODE_KEY)).toBe('record')
    expect(loadHudMode(s)).toBe('record')
  })

  it('survives a storage that throws', () => {
    const throwing = {
      getItem: vi.fn(() => { throw new Error('blocked') }),
      setItem: vi.fn(() => { throw new Error('blocked') }),
    }
    expect(loadHudMode(throwing)).toBe('dictate')
    expect(() => saveHudMode('record', throwing)).not.toThrow()
  })
})
