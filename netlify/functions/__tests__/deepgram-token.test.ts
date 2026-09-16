import { beforeEach, describe, expect, it, vi } from 'vitest'

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
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test-value'
process.env.DEEPGRAM_MANAGED_KEY = 'managed-test-value'

const { handler } = await import('../deepgram-token')

function event(overrides: Record<string, unknown> = {}) {
  return {
    httpMethod: 'POST',
    headers: { origin: 'http://tauri.localhost', authorization: 'Bearer token' },
    body: '{}',
    isBase64Encoded: false,
    rawUrl: '',
    rawQuery: '',
    path: '/.netlify/functions/deepgram-token',
    queryStringParameters: {},
    multiValueQueryStringParameters: {},
    multiValueHeaders: {},
    ...overrides,
  }
}

function proUser() {
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
  mockFrom.mockReturnValue({
    select: () => ({
      eq: () => ({
        single: async () => ({ data: { status: 'pro' }, error: null }),
      }),
    }),
  })
}

describe('deepgram-token', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    proUser()
    mockRpc.mockResolvedValue({ data: true, error: null })
  })

  it('rejects a lookalike Windows app origin', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch')
    const result = await handler(event({
      headers: {
        origin: 'http://tauri.localhost.evil.example',
        authorization: 'Bearer token',
      },
    }) as never, {} as never, vi.fn())
    expect(result?.statusCode).toBe(403)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('fails closed when quota storage fails', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'down' } })
    const fetchSpy = vi.spyOn(global, 'fetch')
    const result = await handler(event() as never, {} as never, vi.fn())
    expect(result?.statusCode).toBe(503)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('denies issuance when the atomic reservation rejects it', async () => {
    mockRpc.mockResolvedValue({ data: false, error: null })
    const fetchSpy = vi.spyOn(global, 'fetch')
    const result = await handler(event() as never, {} as never, vi.fn())
    expect(result?.statusCode).toBe(429)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('mints a fixed 30 second grant and disables caching', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'short-lived-token', expires_in: 30 }),
    } as Response)
    const result = await handler(event() as never, {} as never, vi.fn())
    expect(result?.statusCode).toBe(200)
    expect(result?.headers?.['Cache-Control']).toBe('no-store')
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.deepgram.com/v1/auth/grant',
      expect.objectContaining({ body: JSON.stringify({ ttl_seconds: 30 }) }),
    )
    fetchSpy.mockRestore()
  })
})
