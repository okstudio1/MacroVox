/**
 * useUpdater — checks for app updates on startup using Tauri's updater plugin.
 *
 * On launch, checks the configured endpoint for a newer version. The caller
 * presents the result and can explicitly start installation. The app restarts
 * after a successful update.
 */

import { useState, useEffect, useCallback } from 'react'
import { check } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'

/** Reactive state surfaced by `useUpdater` for the update-prompt UI. */
interface UpdateState {
  /** A `check()` call is in flight. */
  checking: boolean
  /** A newer version is available on the configured updater endpoint. */
  available: boolean
  /** A `downloadAndInstall()` call is in flight. */
  downloading: boolean
  /** Latest version string from the updater manifest, if `available`. */
  version: string | null
  /** Last error message from `check()` or `downloadAndInstall()`. */
  error: string | null
}

export function useUpdater() {
  const [state, setState] = useState<UpdateState>({
    checking: false,
    available: false,
    downloading: false,
    version: null,
    error: null,
  })

  const checkForUpdate = useCallback(async () => {
    setState(prev => ({ ...prev, checking: true, error: null }))
    try {
      const update = await check()
      if (update) {
        setState(prev => ({
          ...prev,
          checking: false,
          available: true,
          version: update.version,
        }))
        return update
      }
      setState(prev => ({ ...prev, checking: false }))
      return null
    } catch (err) {
      console.warn('[Updater] Check failed:', err)
      setState(prev => ({ ...prev, checking: false, error: String(err) }))
      return null
    }
  }, [])

  const downloadAndInstall = useCallback(async () => {
    setState(prev => ({ ...prev, downloading: true, error: null }))
    try {
      const update = await check()
      if (!update) {
        setState(prev => ({ ...prev, downloading: false, available: false }))
        return
      }

      await update.downloadAndInstall()
      await relaunch()
    } catch (err) {
      console.warn('[Updater] Download failed:', err)
      setState(prev => ({ ...prev, downloading: false, error: String(err) }))
    }
  }, [])

  // Check on startup (after a short delay to not block initial render)
  useEffect(() => {
    const timer = setTimeout(() => {
      checkForUpdate()
    }, 5000)
    return () => clearTimeout(timer)
  }, [checkForUpdate])

  return { ...state, checkForUpdate, downloadAndInstall }
}
