/**
 * Entry point for the dictation window (dictation.html)
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ThemeProvider } from './ThemeContext'
import { DictationMode } from './components/DictationMode'
import { disableContextMenu } from './lib/disable-context-menu'
import { perfMark } from './lib/tauri-ipc'
import './index.css'

window.addEventListener('unhandledrejection', (event) => {
  console.error('[UnhandledRejection]', event.reason)
  event.preventDefault()
})

disableContextMenu()

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <StrictMode>
      <ThemeProvider>
        <DictationMode />
      </ThemeProvider>
    </StrictMode>
  )

  // Perf: report time-to-first-paint once the browser has rendered a frame.
  // Double rAF guarantees at least one paint has flushed. We pass the WebView's
  // own navigation-relative timing too, so the Rust log shows both the engine's
  // document-load cost and the process-start-relative number.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const navMs = Math.round(performance.now())
    void perfMark(`dictation_first_paint (webview nav+${navMs}ms)`).catch(() => {})
  }))
}
