/**
 * Unit tests for deepgram-grant Netlify function.
 *
 * The gate is the same one claude-proxy uses, so the interesting cases are the
 * ones specific to handing out a credential: that an unauthenticated or
 * unsubscribed caller never reaches Deepgram at all, that the managed key is
 * sent upstream and never returned downstream, and that a short TTL is asked
 * for rather than accepting whatever the default happens to be.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetUser = vi.fn()
const mockFrom = vi.fn()

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  }),
}))

process.env.SUPABASE_URL = 'https://example.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key'
process.env.DEEPGRAM_MANAGED_KEY = 'test-deepgram-key'

const { handler } = await import('../deepgram-grant')

function makeEvent(overrides: Partial<{
  httpMethod: string
  headers: Record<string, string>
  body: string
}> = {}) {
  return {
    httpMethod: 'POST',
    headers: {
      authorization: 'Bearer test-token',
      origin: 'https://tauri.localhost',
    },
    body: '',
    isBase64Encoded: false,
    rawUrl: '',
    rawQuery: '',
    path: '/.netlify/functions/deepgram-grant',
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

function mockGrantOk(token = 'granted-jwt') {
  return vi.spyOn(global, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ access_token: token, expires_in: 60 }),
  } as Response)
}

describe('deepgram-grant', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 204 for OPTIONS preflight', async () => {
    const result = await handler(makeEvent({ httpMethod: 'OPTIONS' }), {} as never, vi.fn())
    expect(result?.statusCode).toBe(204)
  })

  it('returns 405 for GET', async () => {
    const result = await handler(makeEvent({ httpMethod: 'GET' }), {} as never, vi.fn())
    expect(result?.statusCode).toBe(405)
  })

  it('returns 403 for an origin that is not allowed', async () => {
    const result = await handler(
      makeEvent({ headers: { origin: 'https://evil.example', authorization: 'Bearer test-token' } }),
      {} as never,
      vi.fn(),
    )
    expect(result?.statusCode).toBe(403)
  })

  it('returns 401 without an Authorization header, and never calls Deepgram', async () => {
    const fetchSpy = mockGrantOk()

    const result = await handler(
      makeEvent({ headers: { origin: 'https://tauri.localhost' } }),
      {} as never,
      vi.fn(),
    )

    expect(result?.statusCode).toBe(401)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('returns 401 for a rejected Supabase token, and never calls Deepgram', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'bad token' } })
    const fetchSpy = mockGrantOk()

    const result = await handler(makeEvent(), {} as never, vi.fn())

    expect(result?.statusCode).toBe(401)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('returns 403 without a Pro subscription, and never calls Deepgram', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-123' } }, error: null })
    mockFrom.mockImplementation(() => ({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: { status: 'free' }, error: null }),
        }),
      }),
    }))
    const fetchSpy = mockGrantOk()

    const result = await handler(makeEvent(), {} as never, vi.fn())

    expect(result?.statusCode).toBe(403)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('returns 429 over the rate limit, and never calls Deepgram', async () => {
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
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              gte: vi.fn().mockResolvedValue({ count: 500, error: null }),
            }),
          }),
        }),
        insert: vi.fn().mockResolvedValue(undefined),
      }
    })
    const fetchSpy = mockGrantOk()

    const result = await handler(makeEvent(), {} as never, vi.fn())

    expect(result?.statusCode).toBe(429)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('grants a short-lived token to a Pro user', async () => {
    mockProUser()
    const fetchSpy = mockGrantOk('granted-jwt')

    const result = await handler(makeEvent(), {} as never, vi.fn())

    expect(result?.statusCode).toBe(200)
    expect(JSON.parse(result!.body as string)).toEqual({ access_token: 'granted-jwt', expires_in: 60 })
    fetchSpy.mockRestore()
  })

  it('sends the managed key upstream and asks for a short TTL', async () => {
    mockProUser()
    const fetchSpy = mockGrantOk()

    await handler(makeEvent(), {} as never, vi.fn())

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.deepgram.com/v1/auth/grant',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Token test-deepgram-key' }),
        body: JSON.stringify({ ttl_seconds: 60 }),
      }),
    )
    fetchSpy.mockRestore()
  })

  it('never returns the managed key to the caller', async () => {
    mockProUser()
    const fetchSpy = mockGrantOk()

    const result = await handler(makeEvent(), {} as never, vi.fn())

    expect(result!.body as string).not.toContain('test-deepgram-key')
    fetchSpy.mockRestore()
  })

  it('does not let a token be cached', async () => {
    mockProUser()
    const fetchSpy = mockGrantOk()

    const result = await handler(makeEvent(), {} as never, vi.fn())

    expect(result?.headers?.['Cache-Control']).toBe('no-store')
    fetchSpy.mockRestore()
  })

  it('returns 502 when Deepgram refuses, without echoing its response', async () => {
    mockProUser()
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ err_msg: 'Token test-deepgram-key is invalid' }),
    } as Response)

    const result = await handler(makeEvent(), {} as never, vi.fn())

    expect(result?.statusCode).toBe(502)
    expect(result!.body as string).not.toContain('test-deepgram-key')
    fetchSpy.mockRestore()
  })

  it('returns 502 when the grant response carries no token', async () => {
    mockProUser()
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as Response)

    const result = await handler(makeEvent(), {} as never, vi.fn())
    expect(result?.statusCode).toBe(502)
    fetchSpy.mockRestore()
  })

  it('returns 502 when the grant request throws', async () => {
    mockProUser()
    const fetchSpy = vi.spyOn(global, 'fetch').mockRejectedValue(new Error('network error'))

    const result = await handler(makeEvent(), {} as never, vi.fn())
    expect(result?.statusCode).toBe(502)
    fetchSpy.mockRestore()
  })
})
