import type { Handler } from '@netlify/functions'
import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'
import { reserveQuota } from './_shared/quota'

const ALLOWED_MODELS = [
  'claude-sonnet-4-20250514',
  'claude-haiku-4-5-20251001',
  'claude-opus-4-6',
]
const MAX_TOKENS_LIMIT = 4096
const RATE_LIMIT_MAX_CALLS = 200
const MAX_BODY_SIZE = 512 * 1024
const MAX_SYSTEM_PROMPT_LENGTH = 10_000
const MAX_MESSAGE_LENGTH = 100_000

const isDevBypass =
  process.env.NETLIFY_DEV === 'true' &&
  process.env.DEV_BYPASS_AUTH === 'true' &&
  process.env.CONTEXT !== 'production'

function corsHeaders(corsOrigin: string | null): Record<string, string> {
  return {
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
    ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {}),
  }
}

function response(statusCode: number, headers: Record<string, string>, body: Record<string, unknown>) {
  return {
    statusCode,
    headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  }
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
  const headers = corsHeaders(corsOrigin)

  if (!corsOrigin) return response(403, headers, { error: 'Origin not allowed' })
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' }
  if (event.httpMethod !== 'POST') return response(405, headers, { error: 'Method not allowed' })
  if (Buffer.byteLength(event.body || '', 'utf8') > MAX_BODY_SIZE) {
    return response(413, headers, { error: 'Payload too large' })
  }

  let body: {
    user_id?: string
    model?: string
    max_tokens?: number
    system?: string
    messages?: Anthropic.MessageParam[]
  }
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return response(400, headers, { error: 'Invalid JSON body' })
  }

  const { user_id: bodyUserId, model, max_tokens, system, messages } = body
  if (!Array.isArray(messages) || messages.length === 0) {
    return response(400, headers, { error: 'messages is required' })
  }
  for (const message of messages) {
    if (
      !message || typeof message !== 'object' ||
      !['user', 'assistant'].includes(message.role) ||
      typeof message.content !== 'string'
    ) {
      return response(400, headers, { error: 'Invalid message format' })
    }
    if (message.content.length > MAX_MESSAGE_LENGTH) {
      return response(400, headers, { error: 'Message too long' })
    }
  }
  if (system !== undefined && typeof system !== 'string') {
    return response(400, headers, { error: 'Invalid system prompt' })
  }
  if (system && system.length > MAX_SYSTEM_PROMPT_LENGTH) {
    return response(400, headers, { error: 'System prompt too long' })
  }
  if (model !== undefined && !ALLOWED_MODELS.includes(model)) {
    return response(400, headers, { error: 'Unknown model', allowed: ALLOWED_MODELS })
  }
  if (max_tokens !== undefined && (!Number.isFinite(max_tokens) || max_tokens < 1)) {
    return response(400, headers, { error: 'Invalid max_tokens' })
  }

  const safeModel = model ?? 'claude-sonnet-4-20250514'
  const safeMaxTokens = Math.min(max_tokens ?? 2048, MAX_TOKENS_LIMIT)
  let authedUserId: string | null = null

  if (!isDevBypass) {
    const authHeader = event.headers['authorization'] || event.headers['Authorization']
    const token = authHeader?.replace(/^Bearer\s+/i, '')
    if (!token) return response(401, headers, { error: 'Unauthorized' })

    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) return response(401, headers, { error: 'Invalid token' })
    authedUserId = user.id
    if (bodyUserId && bodyUserId !== user.id) {
      return response(403, headers, { error: 'user_id mismatch' })
    }

    const { data: subscription, error: subscriptionError } = await supabase
      .from('subscriptions')
      .select('status')
      .eq('user_id', user.id)
      .single()
    if (subscriptionError || !subscription || !['pro', 'team'].includes(subscription.status)) {
      return response(403, headers, { error: 'Pro subscription required' })
    }

    try {
      const allowed = await reserveQuota(supabase, user.id, 'claude', RATE_LIMIT_MAX_CALLS)
      if (!allowed) {
        return {
          ...response(429, headers, { error: 'Rate limit exceeded; try again later' }),
          headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': '3600' },
        }
      }
    } catch (error) {
      console.error('[claude-proxy] Quota reservation failed:', error instanceof Error ? error.message : 'unknown')
      return response(503, headers, { error: 'Usage service unavailable' })
    }
  }

  if (authedUserId && bodyUserId && bodyUserId !== authedUserId) {
    return response(403, headers, { error: 'user_id mismatch' })
  }

  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_MANAGED_KEY! })
    const result = await anthropic.messages.create({
      model: safeModel,
      max_tokens: safeMaxTokens,
      ...(system ? { system } : {}),
      messages,
    })
    return response(200, headers, result as unknown as Record<string, unknown>)
  } catch (error) {
    console.error('[claude-proxy] Anthropic error:', error instanceof Error ? error.message : 'unknown')
    return response(502, headers, { error: 'Upstream error' })
  }
}
