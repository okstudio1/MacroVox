/**
 * MacroVox: pure helpers for the dictation HUD's mode toggle and side panel.
 *
 * Kept free of React and Tauri so the branching that decides what the global
 * hotkey does in each mode, and how the window resizes around the Recordings
 * panel, can be unit-tested directly.
 */

export type HudMode = 'dictate' | 'record'

/** localStorage key the HUD persists its mode under (HUD-local, not broadcast). */
export const HUD_MODE_KEY = 'hud_mode'

/** Default HUD window size from tauri.conf.json (logical pixels). */
export const BASE_WIDTH = 380
export const BASE_HEIGHT = 400
/** Width of the Recordings side panel (matches RecordingsPanel's w-[300px]). */
export const PANEL_WIDTH = 300

export function loadHudMode(storage: Pick<Storage, 'getItem'> = localStorage): HudMode {
  try {
    return storage.getItem(HUD_MODE_KEY) === 'record' ? 'record' : 'dictate'
  } catch {
    return 'dictate'
  }
}

export function saveHudMode(mode: HudMode, storage: Pick<Storage, 'setItem'> = localStorage): void {
  try {
    storage.setItem(HUD_MODE_KEY, mode)
  } catch {
    // Storage unavailable (private mode, quota): the toggle still works for
    // this session, it just will not be remembered.
  }
}

export type HotkeyAction =
  | 'start-dictation'
  | 'stop-dictation'
  | 'start-capture'
  | 'stop-capture'
  | 'none'

export interface HotkeyContext {
  hudMode: HudMode
  isRecording: boolean
  /** A start or stop is already in flight (preparing mic, transcribing, saving). */
  busy: boolean
  /** A Deepgram key is available. Dictation needs one; record-only does not. */
  hasKey: boolean
}

/**
 * Decides what a global-hotkey event should do in the current HUD state.
 *
 * `toggle` is the Ctrl+Space press while the HUD is visible (start or stop);
 * `start` is the start-only event the backend fires when the hotkey first
 * shows the window.
 */
export function resolveHotkeyAction(ctx: HotkeyContext, kind: 'toggle' | 'start'): HotkeyAction {
  if (ctx.isRecording) {
    if (kind === 'start') return 'none'
    return ctx.hudMode === 'record' ? 'stop-capture' : 'stop-dictation'
  }
  if (ctx.busy) return 'none'
  if (ctx.hudMode === 'record') return 'start-capture'
  return ctx.hasKey ? 'start-dictation' : 'none'
}

/**
 * Window width to use after opening or closing the side panel, given the
 * current logical width. Never shrinks below the base width so a window the
 * user already narrowed cannot end up unusably small.
 */
export function widthForPanel(currentWidth: number, panelOpen: boolean): number {
  if (panelOpen) return Math.max(BASE_WIDTH, currentWidth) + PANEL_WIDTH
  return Math.max(BASE_WIDTH, currentWidth - PANEL_WIDTH)
}
