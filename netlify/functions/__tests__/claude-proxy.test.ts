/**
 * Unit tests for claude-proxy Netlify function.
 *
 * Tests the auth gating and request validation logic using mocked Supabase
 * and Anthropic SDK responses. No real network calls are made.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockGetUser = vi.fn()
const mockFrom = vi.fn()
const mockRpc = vi.fn()

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
    rpc: mockRpc,
  }),
}))

const mockMessagesCreate = vi.fn()
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: mockMessagesCreate }
  },
}))

// Set required env vars before importing the handler
process.env.SUPABASE_URL = 'https://example.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key'
process.env.ANTHROPIC_MANAGED_KEY = 'test-anthropic-key'

// Lazy import AFTER env vars and mocks are set
const { handler } = await import('../claude-proxy')

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<{
  httpMethod: string
  headers: Record<string, string>
  body: string
}> = {}) {
  return {
    httpMethod: 'POST',
    headers: { authorization: 'Bearer test-token', 'Content-Type': 'application/json', origin: 'http://tauri.localhost' },
    body: JSON.stringify({
      user_id: 'user-123',
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      system: 'You are helpful.',
      messages: [{ role: 'user', content: 'Hello' }],
    }),
    isBase64Encoded: false,
    rawUrl: '',
    rawQuery: '',
    path: '/.netlify/functions/claude-proxy',
    queryStringParameters: {},
    multiValueQueryStringParameters: {},
    multiValueHeaders: {},
    ...overrides,
  }
}

function mockProUser() {
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-123' } }, error: null })
  mockFrom.mockImplementation((table: string) => {
    if (table === 'subscriptions') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: { status: 'pro' }, error: null }),
          }),
        }),
      }
    }
    if (table === 'api_usage') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              gte: vi.fn().mockResolvedValue({ count: 0, error: null }),
            }),
          }),
        }),
        insert: vi.fn().mockResolvedValue(undefined),
      }
    }
    return {}
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('claude-proxy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRpc.mockResolvedValue({ data: true, error: null })
  })

  it('returns 204 for OPTIONS preflight', async () => {
    const result = await handler(makeEvent({ httpMethod: 'OPTIONS' }), {} as never, vi.fn())
    expect(result?.statusCode).toBe(204)
  })

  it('returns 405 for non-POST methods', async () => {
    const result = await handler(makeEvent({ httpMethod: 'GET' }), {} as never, vi.fn())
    expect(result?.statusCode).toBe(405)
  })

  it('returns 401 when no Authorization header', async () => {
    const result = await handler(
      makeEvent({ headers: { 'Content-Type': 'application/json', origin: 'https://tauri.localhost' } }),
      {} as never,
      vi.fn(),
    )
    expect(result?.statusCode).toBe(401)
    expect(JSON.parse(result?.body ?? '{}')).toMatchObject({ error: 'Unauthorized' })
  })

  it('returns 401 when token is invalid', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: new Error('Invalid JWT') })

    const result = await handler(makeEvent(), {} as never, vi.fn())
    expect(result?.statusCode).toBe(401)
    expect(JSON.parse(result?.body ?? '{}')).toMatchObject({ error: 'Invalid token' })
  })

  it('returns 403 when user is on free plan', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-123' } }, error: null })
    mockFrom.mockImplementation((table: string) => {
      if (table === 'subscriptions') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: { status: 'free' }, error: null }),
            }),
          }),
        }
      }
      return {}
    })

    const result = await handler(makeEvent(), {} as never, vi.fn())
    expect(result?.statusCode).toBe(403)
    expect(JSON.parse(result?.body ?? '{}')).toMatchObject({ error: 'Pro subscription required' })
  })

  it('returns 403 when user has no subscription row', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-123' } }, error: null })
    mockFrom.mockImplementation((table: string) => {
      if (table === 'subscriptions') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
          }),
        }
      }
      return {}
    })

    const result = await handler(makeEvent(), {} as never, vi.fn())
    expect(result?.statusCode).toBe(403)
  })

  it('returns 400 for invalid JSON body', async () => {
    mockProUser()
    const result = await handler(
      makeEvent({ body: 'not json' }),
      {} as never,
      vi.fn(),
    )
    expect(result?.statusCode).toBe(400)
  })

  it('returns 400 when messages array is missing', async () => {
    mockProUser()
    const result = await handler(
      makeEvent({ body: JSON.stringify({ user_id: 'user-123', model: 'claude-sonnet-4-20250514' }) }),
      {} as never,
      vi.fn(),
    )
    expect(result?.statusCode).toBe(400)
    expect(JSON.parse(result?.body ?? '{}')).toMatchObject({ error: 'messages is required' })
  })

  it('proxies request to Anthropic and returns response for Pro user', async () => {
    mockProUser()
    const fakeResponse = {
      id: 'msg_123',
      content: [{ type: 'text', text: 'Hello there!' }],
      model: 'claude-sonnet-4-20250514',
    }
    mockMessagesCreate.mockResolvedValue(fakeResponse)

    const result = await handler(makeEvent(), {} as never, vi.fn())
    expect(result?.statusCode).toBe(200)
    expect(JSON.parse(result?.body ?? '{}')).toMatchObject({ content: [{ text: 'Hello there!' }] })
  })

  it('accepts Team subscription', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-123' } }, error: null })
    mockFrom.mockImplementation((table: string) => {
      if (table === 'subscriptions') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: { status: 'team' }, error: null }),
            }),
          }),
        }
      }
      if (table === 'api_usage') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                gte: vi.fn().mockResolvedValue({ count: 0, error: null }),
              }),
            }),
          }),
          insert: vi.fn().mockResolvedValue(undefined),
        }
      }
      return {}
    })
    mockMessagesCreate.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })

    const result = await handler(makeEvent(), {} as never, vi.fn())
    expect(result?.statusCode).toBe(200)
  })

  it('clamps max_tokens to 4096', async () => {
    mockProUser()
    mockMessagesCreate.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })

    const body = JSON.stringify({
      user_id: 'user-123',
      model: 'claude-sonnet-4-20250514',
      max_tokens: 99999,
      messages: [{ role: 'user', content: 'Hi' }],
    })

    await handler(makeEvent({ body }), {} as never, vi.fn())

    expect(mockMessagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ max_tokens: 4096 }),
    )
  })

  it('rejects unknown model with 400 instead of silently substituting', async () => {
    mockProUser()
    mockMessagesCreate.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })

    const body = JSON.stringify({
      user_id: 'user-123',
      model: 'gpt-4o', // not in allowlist
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
    })

    const result = await handler(makeEvent({ body }), {} as never, vi.fn())

    expect(result?.statusCode).toBe(400)
    expect(JSON.parse(result?.body ?? '{}').error).toBe('Unknown model')
    expect(mockMessagesCreate).not.toHaveBeenCalled()
  })

  it('returns 502 when Anthropic API throws', async () => {
    mockProUser()
    mockMessagesCreate.mockRejectedValue(new Error('API overloaded'))

    const result = await handler(makeEvent(), {} as never, vi.fn())
    expect(result?.statusCode).toBe(502)
    expect(JSON.parse(result?.body ?? '{}')).toMatchObject({ error: 'Upstream error' })
  })

  it('rejects a lookalike Windows app origin', async () => {
    const result = await handler(makeEvent({
      headers: {
        authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
        origin: 'http://tauri.localhost.evil.example',
      },
    }), {} as never, vi.fn())
    expect(result?.statusCode).toBe(403)
  })

  it('fails closed when quota storage is unavailable', async () => {
    mockProUser()
    mockRpc.mockResolvedValue({ data: null, error: { message: 'database down' } })
    const result = await handler(makeEvent(), {} as never, vi.fn())
    expect(result?.statusCode).toBe(503)
    expect(mockMessagesCreate).not.toHaveBeenCalled()
  })

  it('returns 429 when the atomic quota reservation is denied', async () => {
    mockProUser()
    mockRpc.mockResolvedValue({ data: false, error: null })
    const result = await handler(makeEvent(), {} as never, vi.fn())
    expect(result?.statusCode).toBe(429)
    expect(mockMessagesCreate).not.toHaveBeenCalled()
  })
})
