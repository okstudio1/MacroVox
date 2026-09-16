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
import { getVersion } from '@tauri-apps/api/app'

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
  /** A check has completed without error, so `available` is meaningful. */
  checked: boolean
  /** Version of the running build, for display next to the check control. */
  currentVersion: string | null
}

export function useUpdater() {
  const [state, setState] = useState<UpdateState>({
    checking: false,
    available: false,
    downloading: false,
    version: null,
    error: null,
    checked: false,
    currentVersion: null,
  })

  // The running version is shown beside the check control, so a user can tell
  // what they have without hunting for it.
  useEffect(() => {
    let cancelled = false
    getVersion()
      .then(version => {
        if (!cancelled) setState(prev => ({ ...prev, currentVersion: version }))
      })
      .catch(err => {
        console.warn('[Updater] Could not read the app version:', err)
      })
    return () => {
      cancelled = true
    }
  }, [])

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
          checked: true,
        }))
        return update
      }
      setState(prev => ({
        ...prev,
        checking: false,
        available: false,
        version: null,
        checked: true,
      }))
      return null
    } catch (err) {
      console.warn('[Updater] Check failed:', err)
      setState(prev => ({
        ...prev,
        checking: false,
        error: String(err),
        checked: false,
      }))
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
