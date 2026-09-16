/**
 * Netlify Function: deepgram-proxy
 *
 * Proxies Deepgram transcription requests for authenticated Pro/Team subscribers.
 *
 * NOTE: In the current MacroVox architecture, Deepgram is called directly from
 * the Rust backend using a managed API key retrieved from Supabase. This function
 * exists for future use, for example if transcription is moved server-side or for
 * a web-only variant of the app.
 *
 * Request (multipart/form-data or raw audio):
 *   Authorization: Bearer <supabase_jwt>
 *   Body: audio file binary
 *   Query params: ?model=nova-3&punctuate=true&language=en
 *
 * Response: Deepgram transcription JSON
 *
 * Required Netlify environment variables:
 *   SUPABASE_URL: Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY: Supabase service role key
 *   DEEPGRAM_MANAGED_KEY: Deepgram API key for Pro users
 */

import type { Handler } from '@netlify/functions'
import { createClient } from '@supabase/supabase-js'
import { reserveQuota } from './_shared/quota'

const MAX_AUDIO_SIZE = 25 * 1024 * 1024 // 25 MB
const ALLOWED_AUDIO_TYPES = ['audio/wav', 'audio/webm', 'audio/mp3', 'audio/mpeg', 'audio/flac', 'audio/ogg', 'audio/mp4']
const ALLOWED_LANGUAGES = ['en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'ja', 'ko', 'zh', 'ru', 'hi', 'ar']
const ALLOWED_MODELS = ['nova-3', 'nova-2', 'nova-2-general', 'nova', 'enhanced', 'base']
const RATE_LIMIT_MAX_CALLS = 300 // per user per hour

// Local dev: skip auth when running under `netlify dev`.
// Triple-gated; see claude-proxy for rationale.
const isDevBypass =
  process.env.NETLIFY_DEV === 'true' &&
  process.env.DEV_BYPASS_AUTH === 'true' &&
  process.env.CONTEXT !== 'production'

const MAX_KEYWORDS = 50
const MAX_KEYWORD_LENGTH = 100

function buildCorsHeaders(corsOrigin: string | null): Record<string, string> {
  const base: Record<string, string> = {
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  }
  if (corsOrigin) base['Access-Control-Allow-Origin'] = corsOrigin
  return base
}

export const handler: Handler = async (event) => {
  const origin = (event.headers['origin'] ?? '').toLowerCase()
  const allowedOrigins = [
    'https://macrovox.tech',
    'tauri://localhost',
    'http://tauri.localhost',
    'https://tauri.localhost',
  ]
  if (isDevBypass) allowedOrigins.push('http://localhost:8888', 'http://localhost:5173')
  const corsOrigin = allowedOrigins.includes(origin) ? origin : null

  const corsHeaders = buildCorsHeaders(corsOrigin)

  // Reject requests from unknown origins
  if (!corsOrigin) {
    return { statusCode: 403, headers: corsHeaders, body: JSON.stringify({ error: 'Origin not allowed' }) }
  }

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' }
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: 'Method Not Allowed' }
  }

  // Reject oversized audio payloads
  const bodySize = Buffer.byteLength(event.body || '', event.isBase64Encoded ? 'base64' : 'utf8')
  if (bodySize > MAX_AUDIO_SIZE) {
    return {
      statusCode: 413,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Audio file too large (max 25 MB)' }),
    }
  }

  // Validate Content-Type with an exact match so ambiguous values like
  // `audio/wav+png` can't slip through a permissive startsWith() check. We
  // split on ';' first so `audio/ogg; codecs=opus` still matches `audio/ogg`.
  const rawContentType = (event.headers['content-type'] ?? 'audio/wav').toLowerCase()
  const contentType = rawContentType.split(';')[0].trim()
  if (!ALLOWED_AUDIO_TYPES.includes(contentType)) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid audio format' }),
    }
  }

  // ── Auth, subscription & rate-limit checks (skipped in local dev) ───────
  if (!isDevBypass) {
    const authHeader = event.headers['authorization'] || event.headers['Authorization']
    const token = authHeader?.replace(/^Bearer\s+/i, '')
    if (!token) {
      return {
        statusCode: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Unauthorized' }),
      }
    }

    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )

    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) {
      return {
        statusCode: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Invalid token' }),
      }
    }

    const { data: sub } = await supabase
      .from('subscriptions')
      .select('status')
      .eq('user_id', user.id)
      .single()

    if (!sub || !['pro', 'team'].includes(sub.status)) {
      return {
        statusCode: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Pro subscription required' }),
      }
    }

    let allowed: boolean
    try {
      allowed = await reserveQuota(supabase, user.id, 'deepgram', RATE_LIMIT_MAX_CALLS)
    } catch (error) {
      console.error('[deepgram-proxy] Quota reservation failed:', error instanceof Error ? error.message : 'unknown')
      return {
        statusCode: 503,
        headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body: JSON.stringify({ error: 'Usage service unavailable' }),
      }
    }
    if (!allowed) {
      return {
        statusCode: 429,
        headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Retry-After': '3600' },
        body: JSON.stringify({ error: 'Rate limit exceeded; try again later' }),
      }
    }
  }

  const deepgramKey = process.env.DEEPGRAM_MANAGED_KEY
  if (!deepgramKey) {
    return {
      statusCode: 503,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Transcription service not configured' }),
    }
  }

  // Build the Deepgram URL from allowlisted parameters.
  const params = event.queryStringParameters ?? {}
  const rawMultiValue = event.multiValueQueryStringParameters ?? {}
  const model = ALLOWED_MODELS.includes(params.model ?? '') ? params.model! : 'nova-3'
  const language = ALLOWED_LANGUAGES.includes(params.language ?? '') ? params.language! : 'en'
  const qs = new URLSearchParams({
    model,
    punctuate: params.punctuate === 'false' ? 'false' : 'true',
    language,
    smart_format: params.smart_format === 'false' ? 'false' : 'true',
  })
  if (params.numerals === 'true') qs.set('numerals', 'true')

  // Keyword boost matches the per-keyword shape Deepgram accepts. Capped at
  // MAX_KEYWORDS entries and MAX_KEYWORD_LENGTH characters each so a caller
  // can't smuggle additional query parameters by stuffing huge strings.
  const rawKeywords = rawMultiValue.keywords
    ?? (params.keywords ? [params.keywords] : [])
  for (const kw of rawKeywords.slice(0, MAX_KEYWORDS)) {
    if (typeof kw === 'string' && kw.length > 0 && kw.length <= MAX_KEYWORD_LENGTH) {
      qs.append('keywords', kw)
    }
  }

  const deepgramUrl = `https://api.deepgram.com/v1/listen?${qs.toString()}`

  const body = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64')
    : Buffer.from(event.body || '', 'utf8')

  try {
    const resp = await fetch(deepgramUrl, {
      method: 'POST',
      headers: {
        Authorization: `Token ${deepgramKey}`,
        'Content-Type': contentType,
      },
      body,
    })

    const data = await resp.text()
    return {
      statusCode: resp.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: data,
    }
  } catch (err) {
    console.error('[deepgram-proxy] Error:', err instanceof Error ? err.message : 'unknown')
    return {
      statusCode: 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Upstream error' }),
    }
  }
}
