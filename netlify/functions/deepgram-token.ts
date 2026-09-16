import type { Handler } from '@netlify/functions'
import { createClient } from '@supabase/supabase-js'
import { reserveQuota } from './_shared/quota'

const GRANT_TTL_SECONDS = 30
const DEFAULT_RATE_LIMIT = 120
const ALLOWED_ORIGINS = [
  'https://macrovox.tech',
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
]

function headers(origin: string | null): Record<string, string> {
  return {
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Cache-Control': 'no-store',
    'Vary': 'Origin',
    ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
  }
}

function response(statusCode: number, corsHeaders: Record<string, string>, body: Record<string, unknown>) {
  return {
    statusCode,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

function configuredRateLimit(): number {
  const parsed = Number.parseInt(process.env.DEEPGRAM_TOKEN_RATE_LIMIT ?? '', 10)
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 1000 ? parsed : DEFAULT_RATE_LIMIT
}

export const handler: Handler = async (event) => {
  const origin = (event.headers['origin'] ?? '').toLowerCase()
  const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : null
  const corsHeaders = headers(corsOrigin)

  if (!corsOrigin) return response(403, corsHeaders, { error: 'Origin not allowed' })
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders, body: '' }
  if (event.httpMethod !== 'POST') return response(405, corsHeaders, { error: 'Method not allowed' })
  if (Buffer.byteLength(event.body || '', 'utf8') > 1024) {
    return response(413, corsHeaders, { error: 'Payload too large' })
  }

  const authHeader = event.headers['authorization'] || event.headers['Authorization']
  const token = authHeader?.replace(/^Bearer\s+/i, '')
  if (!token) return response(401, corsHeaders, { error: 'Unauthorized' })

  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
  const { data: { user }, error: authError } = await supabase.auth.getUser(token)
  if (authError || !user) return response(401, corsHeaders, { error: 'Invalid token' })

  const { data: subscription, error: subscriptionError } = await supabase
    .from('subscriptions')
    .select('status')
    .eq('user_id', user.id)
    .single()
  if (subscriptionError || !subscription || !['pro', 'team'].includes(subscription.status)) {
    return response(403, corsHeaders, { error: 'Pro subscription required' })
  }

  try {
    const allowed = await reserveQuota(
      supabase,
      user.id,
      'deepgram_token',
      configuredRateLimit(),
    )
    if (!allowed) {
      return {
        ...response(429, corsHeaders, { error: 'Token issuance limit exceeded' }),
        headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Retry-After': '3600' },
      }
    }
  } catch (error) {
    console.error('[deepgram-token] Quota reservation failed:', error instanceof Error ? error.message : 'unknown')
    return response(503, corsHeaders, { error: 'Usage service unavailable' })
  }

  const managedKey = process.env.DEEPGRAM_MANAGED_KEY
  if (!managedKey) return response(503, corsHeaders, { error: 'Transcription service not configured' })

  try {
    const upstream = await fetch('https://api.deepgram.com/v1/auth/grant', {
      method: 'POST',
      headers: {
        'Authorization': `Token ${managedKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl_seconds: GRANT_TTL_SECONDS }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!upstream.ok) {
      console.error('[deepgram-token] Grant request failed:', upstream.status)
      return response(502, corsHeaders, { error: 'Token service unavailable' })
    }

    const grant = await upstream.json() as { access_token?: unknown; expires_in?: unknown }
    if (
      typeof grant.access_token !== 'string' || grant.access_token.trim().length === 0 ||
      typeof grant.expires_in !== 'number' || !Number.isFinite(grant.expires_in) ||
      grant.expires_in <= 0 || grant.expires_in > 60
    ) {
      return response(502, corsHeaders, { error: 'Invalid token service response' })
    }
    return response(200, corsHeaders, {
      access_token: grant.access_token,
      expires_in: grant.expires_in,
    })
  } catch (error) {
    console.error('[deepgram-token] Grant request failed:', error instanceof Error ? error.message : 'unknown')
    return response(502, corsHeaders, { error: 'Token service unavailable' })
  }
}
