/**
 * Unit tests for deepgram-proxy Netlify function.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

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

process.env.SUPABASE_URL = 'https://example.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key'
process.env.DEEPGRAM_MANAGED_KEY = 'test-deepgram-key'

const { handler } = await import('../deepgram-proxy')

function makeEvent(overrides: Partial<{
  httpMethod: string
  headers: Record<string, string>
  body: string
  isBase64Encoded: boolean
}> = {}) {
  return {
    httpMethod: 'POST',
    headers: {
      authorization: 'Bearer test-token',
      'content-type': 'audio/wav',
      origin: 'http://tauri.localhost',
    },
    body: '',
    isBase64Encoded: false,
    rawUrl: '',
    rawQuery: '',
    path: '/.netlify/functions/deepgram-proxy',
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

describe('deepgram-proxy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRpc.mockResolvedValue({ data: true, error: null })
  })

  it('returns 204 for OPTIONS preflight', async () => {
    const result = await handler(makeEvent({ httpMethod: 'OPTIONS' }), {} as never, vi.fn())
    expect(result?.statusCode).toBe(204)
  })

  it('returns 405 for GET', async () => {
    const result = await handler(makeEvent({ httpMethod: 'GET' }), {} as never, vi.fn())
    expect(result?.statusCode).toBe(405)
  })

  it('returns 401 when no Authorization header', async () => {
    const result = await handler(
      makeEvent({ headers: { 'content-type': 'audio/wav', origin: 'https://tauri.localhost' } }),
      {} as never,
      vi.fn(),
    )
    expect(result?.statusCode).toBe(401)
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
  })

  it('returns 503 when DEEPGRAM_MANAGED_KEY is not set', async () => {
    mockProUser()
    const saved = process.env.DEEPGRAM_MANAGED_KEY
    delete process.env.DEEPGRAM_MANAGED_KEY

    const result = await handler(makeEvent(), {} as never, vi.fn())
    expect(result?.statusCode).toBe(503)

    process.env.DEEPGRAM_MANAGED_KEY = saved
  })

  it('forwards audio to Deepgram and returns response for Pro user', async () => {
    mockProUser()

    const fakeDeepgramResponse = { results: { channels: [{ alternatives: [{ transcript: 'hello world' }] }] } }
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      status: 200,
      text: async () => JSON.stringify(fakeDeepgramResponse),
    } as Response)

    const result = await handler(makeEvent({ body: Buffer.from('fake-audio').toString('base64'), isBase64Encoded: true }), {} as never, vi.fn())

    expect(result?.statusCode).toBe(200)
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('api.deepgram.com'),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Token test-deepgram-key' }),
      }),
    )
    fetchSpy.mockRestore()
  })

  it('returns 502 when Deepgram fetch throws', async () => {
    mockProUser()
    const fetchSpy = vi.spyOn(global, 'fetch').mockRejectedValue(new Error('network error'))

    const result = await handler(makeEvent(), {} as never, vi.fn())
    expect(result?.statusCode).toBe(502)

    fetchSpy.mockRestore()
  })

  it('rejects a lookalike Windows app origin', async () => {
    const result = await handler(makeEvent({
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'audio/wav',
        origin: 'http://tauri.localhost.evil.example',
      },
    }), {} as never, vi.fn())
    expect(result?.statusCode).toBe(403)
  })

  it('fails closed when quota storage is unavailable', async () => {
    mockProUser()
    mockRpc.mockResolvedValue({ data: null, error: { message: 'database down' } })
    const fetchSpy = vi.spyOn(global, 'fetch')
    const result = await handler(makeEvent(), {} as never, vi.fn())
    expect(result?.statusCode).toBe(503)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
