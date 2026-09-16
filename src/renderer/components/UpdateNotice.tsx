import { Download, RefreshCw } from 'lucide-react'
import { useUpdater } from '../hooks/useUpdater'

/** Mounts the single live updater check and exposes explicit install controls. */
export function UpdateNotice() {
  const {
    available,
    checking,
    downloading,
    version,
    error,
    checkForUpdate,
    downloadAndInstall,
  } = useUpdater()

  if (!available && !error) return null

  return (
    <div
      role={error ? 'alert' : 'status'}
      aria-live="polite"
      className="mb-2 flex items-center gap-2 rounded px-2 py-1 text-xs"
      style={{
        color: error ? 'var(--danger)' : 'var(--text-primary)',
        backgroundColor: error ? 'var(--danger-bg)' : 'var(--bg-secondary)',
        border: `1px solid ${error ? 'var(--danger)' : 'var(--border-primary)'}`,
      }}
    >
      <span className="min-w-0 flex-1 truncate">
        {error ? `Update check failed: ${error}` : `MacroVox ${version || 'update'} is available`}
      </span>
      {error ? (
        <button
          type="button"
          onClick={() => checkForUpdate()}
          disabled={checking}
          className="flex shrink-0 items-center gap-1 rounded px-2 py-1 disabled:opacity-50"
          aria-label="Retry update check"
        >
          <RefreshCw size={12} className={checking ? 'animate-spin' : ''} /> Retry
        </button>
      ) : (
        <button
          type="button"
          onClick={() => downloadAndInstall()}
          disabled={downloading}
          className="flex shrink-0 items-center gap-1 rounded px-2 py-1 disabled:opacity-50"
          aria-label="Install update and restart MacroVox"
        >
          <Download size={12} /> {downloading ? 'Installing...' : 'Install'}
        </button>
      )}
    </div>
  )
}
