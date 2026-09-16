/**
 * Entry point for the settings window (settings.html)
 */
import { Component, StrictMode, useState, useEffect, useCallback, useRef } from 'react'
import type { ReactNode, ErrorInfo } from 'react'
import { createRoot } from 'react-dom/client'
import { ThemeProvider } from './ThemeContext'
import { SettingsPanel } from './components/SettingsPanel'
import type { AppUser } from './lib/auth'
import * as auth from './lib/auth'
import * as ipc from './lib/tauri-ipc'
import { disableContextMenu } from './lib/disable-context-menu'
import './index.css'

window.addEventListener('unhandledrejection', (event) => {
  console.error('[UnhandledRejection]', event.reason)
  event.preventDefault()
})

disableContextMenu()

class ErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null }
  static getDerivedStateFromError(error: Error) {
    return { error: error.message }
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Settings render error:', error, info.componentStack)
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, color: '#ef4444', background: '#0a0f14', fontFamily: 'monospace', height: '100vh' }}>
          <h2 style={{ color: '#cbd5e1' }}>Settings failed to load</h2>
          <pre style={{ whiteSpace: 'pre-wrap', marginTop: 12 }}>{this.state.error}</pre>
        </div>
      )
    }
    return this.props.children
  }
}

export function SettingsApp() {
  const [user, setUser] = useState<AppUser | null>(null)
  const currentUserIdRef = useRef<string | null>(null)
  const authLoadGenerationRef = useRef(0)

  const refreshUser = useCallback(async () => {
    const loadGeneration = ++authLoadGenerationRef.current
    try {
      const result = await auth.getUser()
      if (loadGeneration !== authLoadGenerationRef.current) return
      const nextUser = result.success && result.user ? result.user : null
      currentUserIdRef.current = nextUser?.id ?? null
      setUser(nextUser)
    } catch {
      if (loadGeneration !== authLoadGenerationRef.current) return
      currentUserIdRef.current = null
      setUser(null)
    }
  }, [])

  useEffect(() => {
    refreshUser()
    const cleanupLocal = auth.onAuthStateChange((nextUser, event) => {
      authLoadGenerationRef.current += 1
      const nextUserId = nextUser?.id ?? null
      const identityChanged = currentUserIdRef.current !== nextUserId
      currentUserIdRef.current = nextUserId
      setUser(nextUser)
      if (event === 'TOKEN_REFRESHED' || !identityChanged) return
      ipc.emitAuthStateChanged().catch(() => {})
    })
    const cleanupRemote = ipc.onAuthStateChanged(refreshUser)
    return () => {
      cleanupLocal()
      cleanupRemote()
    }
  }, [refreshUser])

  return (
    <ErrorBoundary>
      <ThemeProvider>
        <SettingsPanel isOpen={true} onClose={async () => {
          const { getCurrentWindow } = await import('@tauri-apps/api/window')
          getCurrentWindow().hide()
        }} user={user} isPopup={true} />
      </ThemeProvider>
    </ErrorBoundary>
  )
}

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <StrictMode>
      <SettingsApp />
    </StrictMode>
  )
}
