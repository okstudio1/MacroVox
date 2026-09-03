/**
 * Netlify Function: deepgram-grant
 *
 * Issues a short-lived Deepgram token so the desktop client can open a
 * streaming WebSocket without ever holding the managed API key.
 *
 * Why this exists:
 *   Streaming transcription is a socket held open for the length of a
 *   recording, so a request-and-response function cannot proxy it. Until now
 *   that meant handing the managed Deepgram key to the client and letting the
 *   Rust backend dial Deepgram itself, which put a shared vendor credential in
 *   a desktop process on every Pro and Team machine.
 *
 *   Deepgram's `/v1/auth/grant` closes that without a proxy. Granting a token
 *   IS request-and-response, so it fits here. The token only has to be valid
 *   at connect time; the socket then stays open as long as the user talks. So
 *   a 60 second token covers a recording of any length, and the blast radius
 *   of a leak drops from "a permanent key" to "one connection, for one
 *   minute".
 *
 * Security model, identical to claude-proxy:
 *   1. Caller sends `Authorization: Bearer <supabase_jwt>`.
 *   2. This function verifies the JWT with Supabase.
 *   3. Checks the user has a Pro or Team subscription.
 *   4. Rate limits per user per hour.
 *   5. Only then exchanges the managed key for a short-lived token.
 *
 * Response: { access_token: string, expires_in: number }
 *
 * The client sends the result as `Authorization: Bearer <access_token>`, which
 * is a different scheme from a raw Deepgram key (`Token <key>`). Bring your own
 * key still uses `Token`.
 *
 * Required Netlify environment variables:
 *   SUPABASE_URL              Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY Supabase service role key (for admin auth verify)
 *   DEEPGRAM_MANAGED_KEY      Deepgram API key, Member or higher
 */

import type { Handler } from '@netlify/functions'
import { createClient } from '@supabase/supabase-js'

const GRANT_URL = 'https://api.deepgram.com/v1/auth/grant'

// Deepgram defaults to 30 s and allows up to 3600. The token is only checked
// during the WebSocket handshake, so this needs to cover app start plus the
// pre-warm connect, not the recording. Short is the point.
const TOKEN_TTL_SECONDS = 60

const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000 // 1 hour
// One grant per recording, plus the pre-warm at app start and a retry or two.
// Well clear of normal dictation, low enough to notice a script.
const RATE_LIMIT_MAX_CALLS = 500

// Local dev: skip auth when running under `netlify dev`.
// Triple-gate the bypass so a single mis-set env var can't disable auth in
// prod: (1) NETLIFY_DEV is set only by the local runtime, never by deployed
// functions; (2) the operator still has to opt in with DEV_BYPASS_AUTH=true;
// (3) CONTEXT must not be 'production'.
const isDevBypass =
  process.env.NETLIFY_DEV === 'true' &&
  process.env.DEV_BYPASS_AUTH === 'true' &&
  process.env.CONTEXT !== 'production'

function buildCorsHeaders(corsOrigin: string | null): Record<string, string> {
  const base: Record<string, string> = {
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  }
  // Omit the ACAO header entirely for disallowed origins. An empty string is
  // non-portable and some middleboxes treat it as "echo the request origin."
  if (corsOrigin) base['Access-Control-Allow-Origin'] = corsOrigin
  return base
}

export const handler: Handler = async (event) => {
  const origin = (event.headers['origin'] ?? '').toLowerCase()
  const allowedOrigins = ['https://macrovox.tech', 'tauri://localhost', 'https://tauri.localhost']
  if (isDevBypass) allowedOrigins.push('http://localhost:8888', 'http://localhost:5173')
  const corsOrigin = allowedOrigins.includes(origin) ? origin : null

  const corsHeaders = buildCorsHeaders(corsOrigin)
  const jsonHeaders = { ...corsHeaders, 'Content-Type': 'application/json' }

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

  // Auth, subscription and rate-limit checks (skipped in local dev)
  if (!isDevBypass) {
    const authHeader = event.headers['authorization'] || event.headers['Authorization']
    const token = authHeader?.replace(/^Bearer\s+/i, '')
    if (!token) {
      return { statusCode: 401, headers: jsonHeaders, body: JSON.stringify({ error: 'Unauthorized' }) }
    }

    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )

    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) {
      return { statusCode: 401, headers: jsonHeaders, body: JSON.stringify({ error: 'Invalid token' }) }
    }

    const { data: sub } = await supabase
      .from('subscriptions')
      .select('status')
      .eq('user_id', user.id)
      .single()

    if (!sub || !['pro', 'team'].includes(sub.status)) {
      return { statusCode: 403, headers: jsonHeaders, body: JSON.stringify({ error: 'Pro subscription required' }) }
    }

    const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString()
    const { count: recentCalls } = await supabase
      .from('api_usage')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('service', 'deepgram_grant')
      .gte('created_at', windowStart)

    if ((recentCalls ?? 0) >= RATE_LIMIT_MAX_CALLS) {
      return {
        statusCode: 429,
        headers: { ...jsonHeaders, 'Retry-After': '3600' },
        body: JSON.stringify({ error: 'Rate limit exceeded, try again later' }),
      }
    }

    supabase.from('api_usage').insert({ user_id: user.id, service: 'deepgram_grant' })
      .then(
        () => {},
        err => console.error('[deepgram-grant] Failed to log API usage:', err),
      )
  }

  const managedKey = process.env.DEEPGRAM_MANAGED_KEY
  if (!managedKey) {
    console.error('[deepgram-grant] DEEPGRAM_MANAGED_KEY is not set')
    return { statusCode: 500, headers: jsonHeaders, body: JSON.stringify({ error: 'Server misconfigured' }) }
  }

  try {
    const resp = await fetch(GRANT_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Token ${managedKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl_seconds: TOKEN_TTL_SECONDS }),
    })

    if (!resp.ok) {
      // Never echo the upstream body. An error response can quote the request,
      // and the request carries the managed key.
      console.error('[deepgram-grant] Grant failed with status', resp.status)
      return { statusCode: 502, headers: jsonHeaders, body: JSON.stringify({ error: 'Could not obtain a token' }) }
    }

    const granted = await resp.json() as { access_token?: string, expires_in?: number }
    if (!granted.access_token) {
      console.error('[deepgram-grant] Grant response had no access_token')
      return { statusCode: 502, headers: jsonHeaders, body: JSON.stringify({ error: 'Could not obtain a token' }) }
    }

    return {
      statusCode: 200,
      // A credential, however short-lived. Nothing caches this.
      headers: { ...jsonHeaders, 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        access_token: granted.access_token,
        expires_in: granted.expires_in ?? TOKEN_TTL_SECONDS,
      }),
    }
  } catch (err) {
    console.error('[deepgram-grant] Grant request threw:', err instanceof Error ? err.message : 'unknown')
    return { statusCode: 502, headers: jsonHeaders, body: JSON.stringify({ error: 'Could not obtain a token' }) }
  }
}
