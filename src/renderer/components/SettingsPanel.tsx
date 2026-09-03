/**
 * SettingsPanel — sole UI for all user-facing configuration.
 *
 * Renders the entire settings window content (`settings.tsx` mounts this with
 * `isPopup={true}`). The panel is organized into 5 tabs surfaced by a left
 * sidebar nav (`NAV_ITEMS`); the active tab is held in the `category` state
 * and gates which sections render. Tabs:
 *   - Account — sign-in/account pill, subscription
 *   - Dictation — audio device, voice recognition, quick dictation, AI cleanup
 *   - Window — always-on-top, minimize-to-tray, global hotkey
 *   - History — voice buffer (capacity, usage bar, `<VoiceHistory>`)
 *   - Appearance — theme picker, About
 *
 * Layout: when `isPopup` is true (Tauri settings window), the panel fills the
 * window with `h-screen w-screen` so it scales as the window is resized. When
 * `isPopup` is false (embedded as an in-app modal), it falls back to the
 * legacy centered `max-w-md` card with a dark backdrop.
 *
 * Setting changes are written to `localStorage` immediately and broadcast via
 * `ipc.broadcastSettings()` so the dictation window picks them up live.
 * The backend filters incoming broadcasts against an allow-list — see
 * `src/main/main.ts` `BROADCASTABLE_SETTINGS`.
 */

import { useState, useEffect } from 'react'
import { Settings, Mic, X, RefreshCw, Sparkles, Loader2, CreditCard, MessageSquare, Pin, Palette, LogIn, User, HardDrive, Trash2, FolderOpen, KeyRound, Eye, EyeOff } from 'lucide-react'
import { THEMES, getStoredTheme, setStoredTheme } from '../themes'
import { VoiceHistory } from './VoiceHistory'
import * as ipc from '../lib/tauri-ipc'
import type { AppUser } from '../lib/tauri-ipc'
import * as auth from '../lib/auth'

interface SettingsPanelProps {
  /** Render as visible (legacy modal flag — `isPopup` mode ignores this). */
  isOpen: boolean
  /** Called when the user dismisses the panel (modal mode) or closes the window. */
  onClose: () => void
  /** Currently authenticated user, or `null` if signed out. */
  user?: AppUser | null
  /** True when mounted as a standalone Tauri window rather than an in-app modal. */
  isPopup?: boolean
}

type SubscriptionStatus = 'free' | 'pro' | 'team' | 'loading'

type SettingsCategory = 'account' | 'apikeys' | 'dictation' | 'window' | 'history' | 'appearance'

const NAV_ITEMS: { id: SettingsCategory; label: string; Icon: typeof User }[] = [
  { id: 'account', label: 'Account', Icon: User },
  { id: 'apikeys', label: 'Keys', Icon: KeyRound },
  { id: 'dictation', label: 'Dictation', Icon: Mic },
  { id: 'window', label: 'Window', Icon: Pin },
  { id: 'history', label: 'History', Icon: HardDrive },
  { id: 'appearance', label: 'Appearance', Icon: Palette },
]

export function SettingsPanel({ isOpen, onClose, user, isPopup = false }: SettingsPanelProps) {
  const [authTab, setAuthTab] = useState<'signin' | 'signup'>('signin')
  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [authLoading, setAuthLoading] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)
  const [authSuccess, setAuthSuccess] = useState<string | null>(null)
  const [devices, setDevices] = useState<string[]>([])
  const [selectedDevice, setSelectedDevice] = useState<string | null>(() =>
    localStorage.getItem('selected_mic_device')
  )
  const [isLoading, setIsLoading] = useState(false)

  const [subscriptionStatus, setSubscriptionStatus] = useState<SubscriptionStatus>('loading')
  const [platformInfo, setPlatformInfo] = useState<ipc.PlatformInfo | null>(null)

  const [autoCopyOnStop, setAutoCopyOnStop] = useState(() =>
    localStorage.getItem('dictation_auto_copy') !== 'false'
  )
  const [clearOnNewRecording, setClearOnNewRecording] = useState(() =>
    localStorage.getItem('dictation_clear_on_new') === 'true'
  )
  const [autoCutoffSeconds, setAutoCutoffSeconds] = useState(() =>
    localStorage.getItem('dictation_auto_cutoff') || '30'
  )
  const [alwaysOnTop, setAlwaysOnTop] = useState(() =>
    localStorage.getItem('dictation_always_on_top') !== 'false'
  )
  const [dictationEnabled, setDictationEnabled] = useState(() =>
    localStorage.getItem('deepgram_dictation') !== 'false'
  )
  const [transcriptionMode, setTranscriptionMode] = useState(() =>
    localStorage.getItem('transcription_mode') || 'batch'
  )
  const [postProcessingContext, setPostProcessingContext] = useState(() =>
    localStorage.getItem('post_processing_context') || ''
  )
  const [autoPasteEnabled, setAutoPasteEnabled] = useState(() =>
    localStorage.getItem('dictation_auto_paste') === 'true'
  )
  const [aiCleanupEnabled, setAiCleanupEnabled] = useState(() =>
    localStorage.getItem('dictation_ai_cleanup') !== 'false'
  )
  const [minimizeToTray, setMinimizeToTray] = useState(() =>
    localStorage.getItem('minimize_to_tray') === 'true'
  )
  const [keywordBoosts, setKeywordBoosts] = useState(() =>
    localStorage.getItem('deepgram_keywords') || ''
  )
  const [numberFormat, setNumberFormat] = useState(() =>
    localStorage.getItem('number_format') || 'smart'
  )
  const [globalHotkey, setGlobalHotkey] = useState(() =>
    localStorage.getItem('global_hotkey') || 'Ctrl+Space'
  )
  const [isCapturingHotkey, setIsCapturingHotkey] = useState(false)
  const [hotkeyError, setHotkeyError] = useState<string | null>(null)
  const [transcriptionLanguage, setTranscriptionLanguage] = useState(() =>
    localStorage.getItem('transcription_language') || 'en'
  )
  const [selectedTheme, setSelectedTheme] = useState(() => getStoredTheme())
  const [category, setCategory] = useState<SettingsCategory>('account')
  const [voiceBufferEnabled, setVoiceBufferEnabled] = useState(() =>
    localStorage.getItem('voice_buffer_enabled') !== 'false'
  )
  const [voiceBufferMaxSize, setVoiceBufferMaxSize] = useState(() =>
    localStorage.getItem('voice_buffer_max_size') || String(100 * 1024 * 1024)
  )
  const [voiceBufferInfo, setVoiceBufferInfo] = useState<ipc.VoiceBufferInfo | null>(null)

  // Bring-your-own API keys. Persisted to localStorage and broadcast so the
  // dictation window picks them up live (see ALLOWED_SETTINGS_KEYS in tauri-ipc).
  const [userDeepgramKey, setUserDeepgramKey] = useState(() =>
    localStorage.getItem('user_deepgram_key') || ''
  )
  const [userAnthropicKey, setUserAnthropicKey] = useState(() =>
    localStorage.getItem('user_anthropic_key') || ''
  )
  const [showDeepgramKey, setShowDeepgramKey] = useState(false)
  const [showAnthropicKey, setShowAnthropicKey] = useState(false)

  // Load voice buffer info and API key for reprocessing
  useEffect(() => {
    ipc.voiceBufferInfo().then(setVoiceBufferInfo).catch(() => {})
  }, [voiceBufferEnabled])

  // Keep the storage usage bar in sync when the dictation HUD saves a new
  // recording. Uses Tauri's cross-webview event bus — the dictation window
  // and settings window are separate webviews, so DOM events don't cross.
  useEffect(() => {
    return ipc.onVoiceBufferUpdated(() => {
      ipc.voiceBufferInfo().then(setVoiceBufferInfo).catch(() => {})
    })
  }, [])

  // One-time platform probe so the UI can reflect runtime limits (e.g.,
  // auto-paste isn't available on Wayland — enigo can't inject keys there).
  useEffect(() => {
    ipc.getPlatformInfo().then(setPlatformInfo).catch(() => {})
  }, [])

  const handleEmailAuth = async () => {
    if (!authEmail || !authPassword) return
    setAuthLoading(true)
    setAuthError(null)
    setAuthSuccess(null)
    try {
      const result = authTab === 'signin'
        ? await auth.signInEmail(authEmail, authPassword)
        : await auth.signUpEmail(authEmail, authPassword)
      if (result.success) {
        if (authTab === 'signup') {
          setAuthSuccess('Check your email to confirm your account.')
        } else {
          onClose()
        }
      } else {
        setAuthError(result.error || 'Authentication failed')
      }
    } catch {
      setAuthError('Something went wrong')
    } finally {
      setAuthLoading(false)
    }
  }

  const handleOAuth = async (provider: 'google' | 'facebook') => {
    setAuthLoading(true)
    setAuthError(null)
    try {
      await auth.signInWithOAuth(provider)
    } catch {
      setAuthError('OAuth sign-in failed')
    } finally {
      setAuthLoading(false)
    }
  }

  useEffect(() => {
    const checkSub = async () => {
      if (!user) {
        setSubscriptionStatus('free')
        return
      }
      try {
        const subResult = await auth.getSubscription()
        if (subResult.success && subResult.subscription) {
          setSubscriptionStatus(subResult.subscription.status)
        } else {
          setSubscriptionStatus('free')
        }
      } catch {
        setSubscriptionStatus('free')
      }
    }
    if (isOpen) checkSub()
  }, [user, isOpen])

  const loadDevices = async () => {
    setIsLoading(true)
    try {
      const result = await ipc.listAudioDevices()
      if (result.success) {
        setDevices(result.devices)
        const stored = localStorage.getItem('selected_mic_device')
        // Prefer the stored choice if it's still in the device list; if the
        // backend hasn't been told yet (fresh process), re-send it.
        if (stored && result.devices.includes(stored)) {
          setSelectedDevice(stored)
          if (result.selected !== stored) {
            ipc.setAudioDevice(stored).catch(() => {})
          }
        } else {
          setSelectedDevice(result.selected)
        }
      }
    } catch (error) {
      console.warn('[Settings] Failed to load devices')
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    if (isOpen) {
      loadDevices()
      // Sync all current settings to backend so it has the correct state after a restart
      const allSettings: Record<string, string> = {}
      const keys = [
        'dictation_auto_copy', 'dictation_clear_on_new', 'dictation_auto_cutoff',
        'dictation_always_on_top', 'deepgram_dictation', 'transcription_mode',
        'post_processing_context', 'dictation_auto_paste', 'dictation_ai_cleanup',
        'deepgram_keywords', 'number_format', 'transcription_language',
        'global_hotkey', 'minimize_to_tray',
        'voice_buffer_enabled', 'voice_buffer_max_size',
      ]
      keys.forEach(k => {
        const v = localStorage.getItem(k)
        if (v !== null) allSettings[k] = v
      })
      ipc.broadcastSettings(allSettings)
    }
  }, [isOpen])

  const handleDeviceSelect = async (device: string) => {
    try {
      await ipc.setAudioDevice(device)
      setSelectedDevice(device || null)
      if (device) {
        localStorage.setItem('selected_mic_device', device)
      } else {
        localStorage.removeItem('selected_mic_device')
      }
    } catch (error) {
      console.warn('[Settings] Failed to set device')
    }
  }

  const saveSetting = (key: string, value: string) => {
    localStorage.setItem(key, value)
    ipc.broadcastSettings({ [key]: value })
  }

  const handleAutoCopyToggle = (value: boolean) => {
    setAutoCopyOnStop(value)
    saveSetting('dictation_auto_copy', String(value))
  }

  const handleClearOnNewToggle = (value: boolean) => {
    setClearOnNewRecording(value)
    saveSetting('dictation_clear_on_new', String(value))
  }

  const handleAutoCutoffChange = (value: string) => {
    setAutoCutoffSeconds(value)
    saveSetting('dictation_auto_cutoff', value)
  }

  const handleAlwaysOnTopToggle = async (value: boolean) => {
    setAlwaysOnTop(value)
    saveSetting('dictation_always_on_top', String(value))
    await ipc.setDictationAlwaysOnTop(value)
  }

  const handleMinimizeToTrayToggle = async (value: boolean) => {
    setMinimizeToTray(value)
    saveSetting('minimize_to_tray', String(value))
    await ipc.setMinimizeToTray(value)
  }

  const isPro = subscriptionStatus === 'pro' || subscriptionStatus === 'team'

  const handleUpgrade = async () => {
    if (!user) return
    await auth.checkout('pro')
  }

  const handleManageSubscription = async () => {
    if (!user) return
    await auth.billingPortal()
  }

  const handleAutoPasteToggle = (value: boolean) => {
    setAutoPasteEnabled(value)
    saveSetting('dictation_auto_paste', String(value))
  }

  const handleAiCleanupToggle = (value: boolean) => {
    setAiCleanupEnabled(value)
    saveSetting('dictation_ai_cleanup', String(value))
  }

  const handleKeywordBoostsChange = (value: string) => {
    setKeywordBoosts(value)
    saveSetting('deepgram_keywords', value)
  }

  // Trim on save so a stray space pasted with the key doesn't break the header.
  const handleUserDeepgramKeyChange = (value: string) => {
    setUserDeepgramKey(value)
    saveSetting('user_deepgram_key', value.trim())
  }

  const handleUserAnthropicKeyChange = (value: string) => {
    setUserAnthropicKey(value)
    saveSetting('user_anthropic_key', value.trim())
  }

  const handleThemeChange = (themeId: string) => {
    setSelectedTheme(themeId)
    setStoredTheme(themeId)
    window.dispatchEvent(new CustomEvent('theme-change', { detail: themeId }))
  }

  const formatHoursMinutes = (secs: number) => {
    if (secs < 60) return `${Math.floor(secs)}s`
    if (secs < 3600) return `${Math.floor(secs / 60)}m`
    const h = Math.floor(secs / 3600)
    const m = Math.floor((secs % 3600) / 60)
    return m > 0 ? `${h}h ${m}m` : `${h}h`
  }

  if (!isOpen) return null

  return (
    <div
      className={isPopup ? 'flex flex-col font-mono h-screen w-screen' : 'fixed inset-0 flex items-center justify-center z-50'}
      style={{ backgroundColor: isPopup ? 'var(--bg-secondary)' : 'var(--bg-primary)' }}
    >
      <div
        className={
          isPopup
            ? 'flex flex-col flex-1 min-h-0 w-full font-mono'
            : 'rounded-lg w-full max-w-md mx-4 shadow-xl max-h-[90vh] flex flex-col font-mono'
        }
        style={{
          backgroundColor: 'var(--bg-secondary)',
          ...(isPopup ? {} : { border: '1px solid var(--border-primary)' }),
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 shrink-0" style={{ borderBottom: '1px solid var(--border-primary)' }}>
          <div className="flex items-center gap-2">
            <Settings size={18} style={{ color: 'var(--accent-primary)' }} />
            <h2 className="text-lg font-semibold uppercase tracking-wider" style={{ color: 'var(--accent-primary)' }}>Settings</h2>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-red-900/30 rounded text-slate-500 hover:text-red-400">
            <X size={20} />
          </button>
        </div>

        {/* Content - Sidebar nav + scrollable panel */}
        <div className="flex flex-1 min-h-0">
          {/* Sidebar nav */}
          <nav className="w-[110px] shrink-0 py-2 overflow-y-auto" style={{ borderRight: '1px solid var(--border-primary)' }}>
            {NAV_ITEMS.map(({ id, label, Icon }) => {
              const active = category === id
              return (
                <button
                  key={id}
                  onClick={() => setCategory(id)}
                  className="w-full flex items-center gap-2 px-3 py-2.5 text-sm transition-colors text-left"
                  style={{
                    backgroundColor: active ? 'var(--bg-primary)' : 'transparent',
                    color: active ? 'var(--accent-primary)' : 'var(--text-secondary)',
                    borderLeft: active ? '2px solid var(--accent-primary)' : '2px solid transparent',
                  }}
                >
                  <Icon size={14} style={{ color: active ? 'var(--accent-primary)' : 'var(--text-muted)' }} />
                  {label}
                </button>
              )
            })}
          </nav>

          {/* Active category content */}
          <div className="p-4 space-y-6 overflow-y-auto flex-1">

          {/* Sign-In Section */}
          {category === 'account' && !user && (
            <section>
              <h3 className="text-sm font-semibold flex items-center gap-2 mb-3 uppercase tracking-wider" style={{ color: 'var(--accent-primary)' }}>
                <User size={16} style={{ color: 'var(--accent-secondary)' }} />
                Account
              </h3>
              <div className="rounded-lg p-4" style={{ backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-primary)' }}>
                <div className="flex rounded overflow-hidden mb-4" style={{ border: '1px solid var(--border-primary)' }}>
                  {(['signin', 'signup'] as const).map(tab => (
                    <button
                      key={tab}
                      onClick={() => { setAuthTab(tab); setAuthError(null); setAuthSuccess(null) }}
                      className="flex-1 py-1.5 text-xs font-semibold uppercase tracking-wider transition-colors"
                      style={{
                        backgroundColor: authTab === tab ? 'var(--accent-primary)' : 'transparent',
                        color: authTab === tab ? '#fff' : 'var(--text-muted)',
                      }}
                    >
                      {tab === 'signin' ? 'Sign In' : 'Sign Up'}
                    </button>
                  ))}
                </div>

                <div className="space-y-2">
                  <input
                    type="email"
                    placeholder="Email"
                    value={authEmail}
                    onChange={e => setAuthEmail(e.target.value)}
                    className="w-full px-3 py-2 rounded text-sm focus:outline-none"
                    style={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-primary)', color: 'var(--text-primary)' }}
                  />
                  <input
                    type="password"
                    placeholder="Password"
                    value={authPassword}
                    onChange={e => setAuthPassword(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleEmailAuth()}
                    className="w-full px-3 py-2 rounded text-sm focus:outline-none"
                    style={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-primary)', color: 'var(--text-primary)' }}
                  />
                </div>

                {authError && <p className="text-xs mt-2" style={{ color: 'var(--danger)' }}>{authError}</p>}
                {authSuccess && <p className="text-xs mt-2" style={{ color: 'var(--accent-primary)' }}>{authSuccess}</p>}

                <button
                  onClick={handleEmailAuth}
                  disabled={authLoading || !authEmail || !authPassword}
                  className="w-full mt-3 py-2 rounded text-white text-sm font-semibold tracking-wide flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  style={{ backgroundColor: 'var(--accent-primary)' }}
                >
                  {authLoading ? <Loader2 size={14} className="animate-spin" /> : <LogIn size={14} />}
                  {authTab === 'signin' ? 'Sign In' : 'Create Account'}
                </button>
              </div>
            </section>
          )}

          {/* Signed-in account pill */}
          {category === 'account' && user && (
            <section>
              <h3 className="text-sm font-semibold flex items-center gap-2 mb-3 uppercase tracking-wider" style={{ color: 'var(--accent-primary)' }}>
                <User size={16} style={{ color: 'var(--accent-secondary)' }} />
                Account
              </h3>
              <div className="flex items-center justify-between rounded-lg px-3 py-2" style={{ backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-primary)' }}>
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold" style={{ backgroundColor: 'var(--accent-primary)', color: '#fff' }}>
                    {(user.displayName || user.email || '?')[0].toUpperCase()}
                  </div>
                  <span className="text-xs text-slate-300 truncate max-w-[180px]">{user.displayName || user.email}</span>
                </div>
                <button
                  onClick={async () => { await auth.signOut(); onClose() }}
                  className="text-xs hover:underline" style={{ color: 'var(--text-muted)' }}
                >
                  Sign out
                </button>
              </div>
            </section>
          )}

          {/* API Keys — bring your own */}
          {category === 'apikeys' && (
            <section>
              <h3 className="text-sm font-semibold flex items-center gap-2 mb-3 uppercase tracking-wider" style={{ color: 'var(--accent-primary)' }}>
                <KeyRound size={16} style={{ color: 'var(--accent-secondary)' }} />
                Your API Keys
              </h3>
              <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
                Bring your own keys to run MacroVox without a subscription. Keys are
                stored locally on this device and sent only to Deepgram and Anthropic
                — never to OK Studio's servers. Leave blank to use the managed plan.
              </p>

              <div className="space-y-4">
                {/* Deepgram */}
                <div>
                  <label className="text-sm text-slate-200">Deepgram API key</label>
                  <p className="text-xs text-slate-500 mb-1.5">Powers speech-to-text. Required to record with your own key.</p>
                  <div className="flex items-center gap-2">
                    <input
                      type={showDeepgramKey ? 'text' : 'password'}
                      value={userDeepgramKey}
                      onChange={(e) => handleUserDeepgramKeyChange(e.target.value)}
                      placeholder="••••••••••••••••••••••••••••••••"
                      spellCheck={false}
                      autoComplete="off"
                      className="flex-1 px-3 py-2 rounded text-sm font-mono focus:outline-none"
                      style={{ backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-primary)', color: 'var(--text-primary)' }}
                    />
                    <button
                      onClick={() => setShowDeepgramKey(v => !v)}
                      className="p-2 rounded hover:bg-white/10"
                      style={{ color: 'var(--text-muted)' }}
                      title={showDeepgramKey ? 'Hide key' : 'Show key'}
                    >
                      {showDeepgramKey ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                  <p className="text-[10px] text-slate-600 mt-1">Get one at console.deepgram.com</p>
                </div>

                {/* Anthropic */}
                <div>
                  <label className="text-sm text-slate-200">Anthropic API key</label>
                  <p className="text-xs text-slate-500 mb-1.5">Powers AI cleanup. Optional — without it, transcripts are still copied raw.</p>
                  <div className="flex items-center gap-2">
                    <input
                      type={showAnthropicKey ? 'text' : 'password'}
                      value={userAnthropicKey}
                      onChange={(e) => handleUserAnthropicKeyChange(e.target.value)}
                      placeholder="sk-ant-••••••••••••••••••••••••"
                      spellCheck={false}
                      autoComplete="off"
                      className="flex-1 px-3 py-2 rounded text-sm font-mono focus:outline-none"
                      style={{ backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-primary)', color: 'var(--text-primary)' }}
                    />
                    <button
                      onClick={() => setShowAnthropicKey(v => !v)}
                      className="p-2 rounded hover:bg-white/10"
                      style={{ color: 'var(--text-muted)' }}
                      title={showAnthropicKey ? 'Hide key' : 'Show key'}
                    >
                      {showAnthropicKey ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                  <p className="text-[10px] text-slate-600 mt-1">Get one at console.anthropic.com</p>
                </div>

                {(userDeepgramKey.trim() || userAnthropicKey.trim()) && (
                  <p className="text-xs rounded px-3 py-2" style={{ color: 'var(--accent-hover)', backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-primary)' }}>
                    Saved. Your own key{userDeepgramKey.trim() && userAnthropicKey.trim() ? 's are' : ' is'} active — it takes effect on your next recording.
                  </p>
                )}
              </div>
            </section>
          )}

          {/* Theme Selector */}
          {category === 'appearance' && (
          <section>
            <h3 className="text-sm font-semibold flex items-center gap-2 mb-3 uppercase tracking-wider" style={{ color: 'var(--accent-primary)' }}>
              <Palette size={16} style={{ color: 'var(--accent-secondary)' }} />
              Theme
            </h3>
            <div className="grid grid-cols-2 gap-2">
              {THEMES.map(theme => (
                <button
                  key={theme.id}
                  onClick={() => handleThemeChange(theme.id)}
                  className={`p-3 rounded-lg border transition-all text-left ${
                    selectedTheme === theme.id
                      ? 'border-cyan-500 bg-cyan-900/20'
                      : 'border-slate-700 hover:border-slate-600 bg-[#0a0f14]'
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <div className="w-4 h-4 rounded-full border border-slate-600" style={{ backgroundColor: theme.colors.accentPrimary }} />
                    <span className="text-sm font-medium text-slate-200">{theme.name}</span>
                  </div>
                  <p className="text-xs text-slate-500">{theme.description}</p>
                </button>
              ))}
            </div>
          </section>
          )}

          {/* Quick Dictation */}
          {category === 'dictation' && (
          <section>
            <h3 className="text-sm font-semibold flex items-center gap-2 mb-3 uppercase tracking-wider" style={{ color: 'var(--accent-primary)' }}>
              <MessageSquare size={16} style={{ color: 'var(--accent-secondary)' }} />
              Quick Dictation
            </h3>
            <div className="space-y-3">
              {[
                { label: 'Auto-copy on stop', desc: 'Instantly copy transcript to clipboard when you stop recording', value: autoCopyOnStop, onChange: handleAutoCopyToggle, disabled: false },
                {
                  label: 'Auto-paste on stop',
                  desc: platformInfo?.is_wayland
                    ? 'Unavailable on Wayland — key injection is blocked. The transcript still copies to your clipboard; paste it with Ctrl+V.'
                    : 'Paste into the app you were typing in — text lands where your cursor was',
                  value: platformInfo?.is_wayland ? false : autoPasteEnabled,
                  onChange: handleAutoPasteToggle,
                  disabled: !!platformInfo?.is_wayland,
                },
                { label: 'Clear on new recording', desc: 'Delete previous transcript when starting a new one', value: clearOnNewRecording, onChange: handleClearOnNewToggle, disabled: false },
              ].map(({ label, desc, value, onChange, disabled }) => (
                <label
                  key={label}
                  className={`flex items-center justify-between ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
                >
                  <div>
                    <span className="text-sm text-slate-200">{label}</span>
                    <p className="text-xs text-slate-500">{desc}</p>
                  </div>
                  <div
                    onClick={() => { if (!disabled) onChange(!value) }}
                    className={`w-10 h-5 rounded-full transition-colors ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                    style={{ backgroundColor: value ? 'var(--accent-primary)' : 'var(--bg-tertiary)' }}
                  >
                    <div className={`w-4 h-4 rounded-full bg-white mt-0.5 transition-transform ${value ? 'translate-x-5' : 'translate-x-0.5'}`} />
                  </div>
                </label>
              ))}

              <div className="flex items-center justify-between">
                <div>
                  <span className="text-sm text-slate-200">Auto-cutoff</span>
                  <p className="text-xs text-slate-500">Automatically stop recording after duration</p>
                </div>
                <select
                  value={autoCutoffSeconds}
                  onChange={(e) => handleAutoCutoffChange(e.target.value)}
                  className="px-2 py-1 rounded text-sm focus:outline-none"
                  style={{ backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-primary)', color: 'var(--text-primary)' }}
                >
                  <option value="15">15 sec</option>
                  <option value="30">30 sec</option>
                  <option value="45">45 sec</option>
                  <option value="60">60 sec</option>
                </select>
              </div>
            </div>
          </section>
          )}

          {/* Voice Recognition */}
          {category === 'dictation' && (
          <section>
            <h3 className="text-sm font-semibold flex items-center gap-2 mb-3 uppercase tracking-wider" style={{ color: 'var(--accent-primary)' }}>
              <Mic size={16} style={{ color: 'var(--accent-secondary)' }} />
              Voice Recognition
            </h3>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-sm text-slate-200">Transcription mode</span>
                  <p className="text-xs text-slate-500">
                    {transcriptionMode === 'streaming'
                      ? 'Words appear as you speak (real-time)'
                      : 'Full transcript after you stop (higher accuracy)'}
                  </p>
                </div>
                <select
                  value={transcriptionMode}
                  onChange={(e) => { setTranscriptionMode(e.target.value); saveSetting('transcription_mode', e.target.value) }}
                  className="px-2 py-1 rounded text-sm focus:outline-none"
                  style={{ backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-primary)', color: 'var(--text-primary)' }}
                >
                  <option value="batch">Batch</option>
                  <option value="streaming">Streaming</option>
                </select>
              </div>

              <label className="flex items-center justify-between cursor-pointer">
                <div>
                  <span className="text-sm text-slate-200">Dictation commands</span>
                  <p className="text-xs text-slate-500">Say "period", "comma", "new line" to insert punctuation</p>
                </div>
                <div
                  onClick={() => { const next = !dictationEnabled; setDictationEnabled(next); saveSetting('deepgram_dictation', String(next)) }}
                  className="w-10 h-5 rounded-full transition-colors cursor-pointer"
                  style={{ backgroundColor: dictationEnabled ? 'var(--accent-primary)' : 'var(--bg-tertiary)' }}
                >
                  <div className={`w-4 h-4 rounded-full bg-white mt-0.5 transition-transform ${dictationEnabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
                </div>
              </label>

              <div>
                <span className="text-sm text-slate-200">Language</span>
                <p className="text-xs text-slate-500 mb-2">Speech recognition language</p>
                <select
                  value={transcriptionLanguage}
                  onChange={(e) => {
                    setTranscriptionLanguage(e.target.value)
                    saveSetting('transcription_language', e.target.value)
                  }}
                  className="w-full px-3 py-2 rounded text-sm focus:outline-none"
                  style={{ backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-primary)', color: 'var(--text-primary)' }}
                >
                  {[
                    { code: 'en', label: 'English' },
                    { code: 'es', label: 'Spanish' },
                    { code: 'fr', label: 'French' },
                    { code: 'de', label: 'German' },
                    { code: 'pt', label: 'Portuguese' },
                    { code: 'it', label: 'Italian' },
                    { code: 'nl', label: 'Dutch' },
                    { code: 'ja', label: 'Japanese' },
                    { code: 'ko', label: 'Korean' },
                    { code: 'zh', label: 'Chinese (Mandarin)' },
                    { code: 'hi', label: 'Hindi' },
                    { code: 'ru', label: 'Russian' },
                    { code: 'sv', label: 'Swedish' },
                    { code: 'da', label: 'Danish' },
                    { code: 'no', label: 'Norwegian' },
                    { code: 'fi', label: 'Finnish' },
                    { code: 'pl', label: 'Polish' },
                    { code: 'uk', label: 'Ukrainian' },
                    { code: 'tr', label: 'Turkish' },
                    { code: 'ar', label: 'Arabic' },
                  ].map(({ code, label }) => (
                    <option key={code} value={code}>{label}</option>
                  ))}
                </select>
              </div>

              <div>
                <span className="text-sm text-slate-200">Keyword boosting</span>
                <p className="text-xs text-slate-500 mb-2">Words or phrases to boost recognition accuracy — one per line</p>
                <textarea
                  value={keywordBoosts}
                  onChange={(e) => handleKeywordBoostsChange(e.target.value)}
                  placeholder={'MacroVox\nOAuth\nrefactor\nyour-custom-term'}
                  rows={3}
                  className="w-full px-3 py-2 rounded text-sm focus:outline-none resize-none font-mono"
                  style={{ backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-primary)', color: 'var(--text-primary)' }}
                />
              </div>
            </div>
          </section>
          )}

          {/* AI Post-Processing */}
          {category === 'dictation' && (
          <section>
            <h3 className="text-sm font-semibold flex items-center gap-2 mb-3 uppercase tracking-wider" style={{ color: 'var(--accent-primary)' }}>
              <Sparkles size={16} style={{ color: 'var(--accent-secondary)' }} />
              AI Post-Processing
            </h3>
            <div className="space-y-3">
              <label className="flex items-center justify-between cursor-pointer">
                <div>
                  <span className="text-sm text-slate-200">AI cleanup</span>
                  <p className="text-xs text-slate-500">Claude cleans up transcripts automatically after every recording</p>
                </div>
                <div
                  onClick={() => handleAiCleanupToggle(!aiCleanupEnabled)}
                  className="w-10 h-5 rounded-full transition-colors cursor-pointer"
                  style={{ backgroundColor: aiCleanupEnabled ? 'var(--accent-primary)' : 'var(--bg-tertiary)' }}
                >
                  <div className={`w-4 h-4 rounded-full bg-white mt-0.5 transition-transform ${aiCleanupEnabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
                </div>
              </label>
              <div>
                <span className="text-sm text-slate-200">Number formatting</span>
                <p className="text-xs text-slate-500 mb-2">How numbers appear in transcripts</p>
                <div className="flex gap-2">
                  {([
                    { value: 'smart', label: 'Smart' },
                    { value: 'digits', label: 'Always digits' },
                    { value: 'words', label: 'Always words' },
                  ] as const).map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => {
                        setNumberFormat(opt.value)
                        saveSetting('number_format', opt.value)
                      }}
                      className="px-3 py-1.5 rounded text-xs font-medium transition-colors"
                      style={{
                        backgroundColor: numberFormat === opt.value ? 'var(--accent-primary)' : 'var(--bg-primary)',
                        color: numberFormat === opt.value ? 'white' : 'var(--text-secondary)',
                        border: `1px solid ${numberFormat === opt.value ? 'var(--accent-primary)' : 'var(--border-primary)'}`,
                      }}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <p className="text-[10px] text-slate-600 mt-1.5">
                  {numberFormat === 'smart' && 'Context-aware: digits for currency, dates, measurements, and item labels (e.g. "$5", "3pm", "survey 3", "step 2"); words for small standalone counts (e.g. "twenty-one people"). Requires AI cleanup.'}
                  {numberFormat === 'digits' && 'All numbers as digits, e.g. "42", "3", "1000".'}
                  {numberFormat === 'words' && 'All numbers spelled out, e.g. "forty-two", "three".'}
                </p>
              </div>
              <div>
                <span className="text-sm text-slate-200">Accessibility context</span>
                <p className="text-xs text-slate-500 mb-2">Describe your speech patterns so Claude can better correct errors</p>
                <textarea
                  value={postProcessingContext}
                  onChange={(e) => { setPostProcessingContext(e.target.value); saveSetting('post_processing_context', e.target.value) }}
                  placeholder={"e.g. I have a speech impediment that affects 'r' and 'l' sounds."}
                  rows={3}
                  className="w-full px-3 py-2 rounded text-sm focus:outline-none resize-none"
                  style={{ backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-primary)', color: 'var(--text-primary)' }}
                />
              </div>
            </div>
          </section>
          )}

          {/* Dictation Window */}
          {category === 'window' && (
          <section>
            <h3 className="text-sm font-semibold flex items-center gap-2 mb-3 uppercase tracking-wider" style={{ color: 'var(--accent-primary)' }}>
              <Pin size={16} style={{ color: 'var(--accent-secondary)' }} />
              Dictation Window
            </h3>
            <div className="space-y-3">
              {[
                { label: 'Always on top', desc: 'Keep dictation window above other windows', value: alwaysOnTop, onChange: handleAlwaysOnTopToggle },
                { label: 'Minimize to tray on close', desc: 'Clicking X hides the main window instead of quitting', value: minimizeToTray, onChange: handleMinimizeToTrayToggle },
              ].map(({ label, desc, value, onChange }) => (
                <label key={label} className="flex items-center justify-between cursor-pointer">
                  <div>
                    <span className="text-sm text-slate-200">{label}</span>
                    <p className="text-xs text-slate-500">{desc}</p>
                  </div>
                  <div
                    onClick={() => onChange(!value)}
                    className="w-10 h-5 rounded-full transition-colors cursor-pointer"
                    style={{ backgroundColor: value ? 'var(--accent-primary)' : 'var(--bg-tertiary)' }}
                  >
                    <div className={`w-4 h-4 rounded-full bg-white mt-0.5 transition-transform ${value ? 'translate-x-5' : 'translate-x-0.5'}`} />
                  </div>
                </label>
              ))}

              {/* Global hotkey */}
              <div>
                <span className="text-sm text-slate-200">Global hotkey</span>
                <p className="text-xs text-slate-500 mb-2">Keyboard shortcut to toggle dictation from any app</p>
                <div className="flex items-center gap-2">
                  {isCapturingHotkey ? (
                    <div
                      tabIndex={0}
                      autoFocus
                      onKeyDown={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        // Ignore bare modifier presses
                        if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return

                        const parts: string[] = []
                        if (e.ctrlKey) parts.push('Ctrl')
                        if (e.altKey) parts.push('Alt')
                        if (e.shiftKey) parts.push('Shift')
                        if (e.metaKey) parts.push('Super')

                        // Map key name
                        let keyName = e.key
                        if (keyName === ' ') keyName = 'Space'
                        else if (keyName.length === 1) keyName = keyName.toUpperCase()
                        parts.push(keyName)

                        const combo = parts.join('+')
                        setIsCapturingHotkey(false)
                        setHotkeyError(null)

                        // Try to register the new hotkey
                        ipc.updateGlobalHotkey(combo).then((res) => {
                          if (res.success) {
                            setGlobalHotkey(combo)
                            saveSetting('global_hotkey', combo)
                          } else {
                            setHotkeyError(res.error || 'Failed to register hotkey')
                          }
                        })
                      }}
                      onBlur={() => setIsCapturingHotkey(false)}
                      className="flex-1 px-3 py-2 rounded text-sm text-center animate-pulse"
                      style={{
                        backgroundColor: 'var(--bg-primary)',
                        border: '2px solid var(--accent-primary)',
                        color: 'var(--accent-primary)',
                        outline: 'none',
                      }}
                    >
                      Press a key combination...
                    </div>
                  ) : (
                    <>
                      <span
                        className="flex-1 px-3 py-2 rounded text-sm font-mono"
                        style={{ backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-primary)', color: 'var(--text-primary)' }}
                      >
                        {globalHotkey}
                      </span>
                      <button
                        onClick={() => { setIsCapturingHotkey(true); setHotkeyError(null) }}
                        className="px-3 py-2 rounded text-xs font-medium transition-colors"
                        style={{ backgroundColor: 'var(--accent-primary)', color: 'white' }}
                      >
                        Change
                      </button>
                    </>
                  )}
                </div>
                {hotkeyError && (
                  <p className="text-xs mt-1" style={{ color: '#f87171' }}>{hotkeyError}</p>
                )}
              </div>
            </div>
          </section>
          )}

          {/* Audio Input */}
          {category === 'dictation' && (
          <section>
            <h3 className="text-sm font-semibold flex items-center gap-2 mb-3 uppercase tracking-wider" style={{ color: 'var(--accent-primary)' }}>
              <Mic size={16} style={{ color: 'var(--accent-secondary)' }} />
              Audio Input
            </h3>
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs text-slate-400">Microphone</label>
                <button onClick={loadDevices} disabled={isLoading} className="p-1 rounded" style={{ color: 'var(--text-muted)' }} title="Refresh devices">
                  <RefreshCw size={12} className={isLoading ? 'animate-spin' : ''} />
                </button>
              </div>
              <select
                value={selectedDevice || ''}
                onChange={(e) => handleDeviceSelect(e.target.value)}
                className="w-full px-3 py-2 rounded text-sm focus:outline-none"
                style={{ backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-primary)', color: 'var(--text-primary)' }}
              >
                <option value="">Auto-detect</option>
                {devices.map((device) => (
                  <option key={device} value={device}>{device}</option>
                ))}
              </select>
            </div>
          </section>
          )}

          {/* Voice Buffer */}
          {category === 'history' && (
          <section>
            <h3 className="text-sm font-semibold flex items-center gap-2 mb-3 uppercase tracking-wider" style={{ color: 'var(--accent-primary)' }}>
              <HardDrive size={16} style={{ color: 'var(--accent-secondary)' }} />
              Dictation History
            </h3>
            <div className="space-y-3">
              <label className="flex items-center justify-between cursor-pointer">
                <div>
                  <span className="text-sm text-slate-200">Save recordings</span>
                  <p className="text-xs text-slate-500">Keep recent dictations for playback (Opus compressed)</p>
                </div>
                <div
                  onClick={() => {
                    const next = !voiceBufferEnabled
                    setVoiceBufferEnabled(next)
                    saveSetting('voice_buffer_enabled', String(next))
                  }}
                  className="w-10 h-5 rounded-full transition-colors cursor-pointer"
                  style={{ backgroundColor: voiceBufferEnabled ? 'var(--accent-primary)' : 'var(--bg-tertiary)' }}
                >
                  <div className={`w-4 h-4 rounded-full bg-white mt-0.5 transition-transform ${voiceBufferEnabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
                </div>
              </label>

              {voiceBufferEnabled && (
                <>
                  <div>
                    <span className="text-sm text-slate-200">Storage limit</span>
                    <p className="text-xs text-slate-500 mb-1">Oldest recordings are deleted when the limit is reached</p>
                    <select
                      value={voiceBufferMaxSize}
                      onChange={(e) => {
                        setVoiceBufferMaxSize(e.target.value)
                        saveSetting('voice_buffer_max_size', e.target.value)
                      }}
                      className="w-full px-3 py-1.5 rounded text-sm focus:outline-none"
                      style={{ backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-primary)', color: 'var(--text-primary)' }}
                    >
                      <option value={String(50 * 1024 * 1024)}>50 MB (~7 hr)</option>
                      <option value={String(100 * 1024 * 1024)}>100 MB (~14 hr)</option>
                      <option value={String(250 * 1024 * 1024)}>250 MB (~35 hr)</option>
                      <option value={String(500 * 1024 * 1024)}>500 MB (~70 hr)</option>
                    </select>
                  </div>

                  {/* Storage usage */}
                  {voiceBufferInfo && voiceBufferInfo.max_size_bytes > 0 && (
                    <div className="space-y-2">
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                            {voiceBufferInfo.recording_count} recording{voiceBufferInfo.recording_count !== 1 ? 's' : ''}
                            {voiceBufferInfo.total_duration_secs > 0 && ` · ${formatHoursMinutes(voiceBufferInfo.total_duration_secs)}`}
                          </span>
                          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                            {(voiceBufferInfo.current_size_bytes / (1024 * 1024)).toFixed(1)} / {(voiceBufferInfo.max_size_bytes / (1024 * 1024)).toFixed(0)} MB
                          </span>
                        </div>
                        {/* Progress bar */}
                        <div className="w-full h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--bg-primary)' }}>
                          <div
                            className="h-full rounded-full transition-all"
                            style={{
                              width: `${Math.min(100, (voiceBufferInfo.current_size_bytes / voiceBufferInfo.max_size_bytes) * 100)}%`,
                              backgroundColor: voiceBufferInfo.current_size_bytes / voiceBufferInfo.max_size_bytes > 0.9
                                ? 'var(--danger, #ef4444)'
                                : 'var(--accent-primary)',
                            }}
                          />
                        </div>
                      </div>

                      {/* Actions row */}
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => ipc.voiceBufferOpenFolder()}
                          className="flex items-center gap-1 text-xs px-2 py-1 rounded hover:bg-white/10 transition-colors"
                          style={{ color: 'var(--text-secondary)' }}
                          title="Open storage folder"
                        >
                          <FolderOpen size={12} /> Open folder
                        </button>
                        {voiceBufferInfo.recording_count > 0 && (
                          <button
                            onClick={async () => {
                              await ipc.voiceBufferClear()
                              const info = await ipc.voiceBufferInfo()
                              setVoiceBufferInfo(info)
                            }}
                            className="flex items-center gap-1 text-xs px-2 py-1 rounded hover:bg-red-900/40 transition-colors"
                            style={{ color: '#f87171' }}
                          >
                            <Trash2 size={12} /> Clear all
                          </button>
                        )}
                      </div>
                    </div>
                  )}

                  <VoiceHistory user={user ? { id: user.id } : null} />
                </>
              )}
            </div>
          </section>
          )}

          {/* Subscription */}
          {category === 'account' && user && (
            <section>
              <h3 className="text-sm font-semibold flex items-center gap-2 mb-3 uppercase tracking-wider" style={{ color: 'var(--accent-primary)' }}>
                <CreditCard size={16} style={{ color: 'var(--accent-secondary)' }} />
                Subscription
              </h3>
              {subscriptionStatus === 'loading' ? (
                <div className="flex items-center gap-2 text-slate-400">
                  <Loader2 size={14} className="animate-spin" />
                  <span className="text-sm">Checking subscription...</span>
                </div>
              ) : isPro ? (
                <div className="rounded-lg p-3" style={{ backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-accent)' }}>
                  <div className="flex items-center gap-2 mb-2">
                    <Sparkles size={16} style={{ color: 'var(--accent-primary)' }} />
                    <span className="text-sm font-semibold" style={{ color: 'var(--accent-hover)' }}>
                      {subscriptionStatus === 'team' ? 'Team' : 'Pro'} Plan
                    </span>
                  </div>
                  <p className="text-xs text-slate-400 mb-3">Unlimited dictation with AI cleanup, keyword boosting, and voice buffer.</p>
                  <button onClick={handleManageSubscription} className="text-xs hover:underline flex items-center gap-1" style={{ color: 'var(--accent-primary)' }}>
                    <CreditCard size={12} />
                    Manage subscription
                  </button>
                </div>
              ) : (
                <div className="rounded-lg p-3" style={{ backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-primary)' }}>
                  <p className="text-sm mb-2" style={{ color: 'var(--text-primary)' }}>No Active Subscription</p>
                  <p className="text-xs text-slate-400 mb-3">Subscribe for unlimited dictation with AI cleanup and all features.</p>
                  <button onClick={handleUpgrade} className="w-full py-2 text-white text-sm rounded flex items-center justify-center gap-2 font-medium tracking-wide" style={{ backgroundColor: 'var(--accent-primary)' }}>
                    <Sparkles size={14} />
                    Subscribe — \$6.99/mo
                  </button>
                </div>
              )}
            </section>
          )}

          {/* About & Shortcuts */}
          {category === 'appearance' && (
          <section>
            <h3 className="text-sm font-semibold mb-3 uppercase tracking-wider" style={{ color: 'var(--accent-primary)' }}>About</h3>
            <div className="rounded p-3 space-y-3" style={{ backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-primary)' }}>
              <div>
                <p className="text-sm font-semibold" style={{ color: 'var(--accent-primary)' }}>MacroVox</p>
                <p className="text-xs text-slate-400 mt-0.5">Voice Dictation for Windows</p>
                <p className="text-xs text-slate-500 mt-1">© 2026 OK Studio</p>
              </div>
              <div className="pt-2" style={{ borderTop: '1px solid var(--border-primary)' }}>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-400">Toggle Dictation</span>
                  <kbd className="px-2 py-0.5 rounded font-mono" style={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-primary)', color: 'var(--accent-hover)' }}>{globalHotkey}</kbd>
                </div>
              </div>
            </div>
          </section>
          )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-4 py-3 flex justify-end shrink-0" style={{ borderTop: '1px solid var(--border-primary)' }}>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm text-white transition-colors font-medium tracking-wide"
            style={{ backgroundColor: 'var(--accent-primary)' }}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
