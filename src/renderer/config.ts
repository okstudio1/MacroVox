// Centralized API configuration for the MacroVox renderer.
// All network endpoints live here — never hardcode URLs in hooks or components.

// Netlify site URL — use local dev server when running in Vite dev mode
export const SITE_URL = import.meta.env.DEV
  ? 'http://localhost:8888'
  : 'https://macrovox.tech'

// Supabase Edge Functions (proxied through Netlify or direct)
export const API = {
  claudeProxy:      `${SITE_URL}/.netlify/functions/claude-proxy`,
  deepgramProxy:    `${SITE_URL}/.netlify/functions/deepgram-proxy`,
  // Exchanges a Supabase session for a short-lived Deepgram token, so the
  // managed key never reaches this process. See lib/deepgramCredential.ts.
  deepgramGrant:    `${SITE_URL}/.netlify/functions/deepgram-grant`,
} as const

// Haiku for fast cleanup tasks; Sonnet for quality writing generation
export const ANTHROPIC_MODEL_CLEANUP  = 'claude-haiku-4-5-20251001'
export const ANTHROPIC_MODEL_WRITING  = 'claude-sonnet-4-20250514'

// Direct Anthropic Messages API — used only when the user supplies their own
// key in Settings → API Keys (bring-your-own-key mode). Managed/subscriber
// traffic still goes through `API.claudeProxy` so the org key stays server-side.
// `connect-src` in tauri.conf.json must allow this origin for the call to land.
export const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
export const ANTHROPIC_VERSION = '2023-06-01'
