export type QuotaService = 'claude' | 'deepgram' | 'deepgram_token'

export interface QuotaRpcClient {
  rpc(
    name: 'reserve_api_quota',
    args: {
      p_user_id: string
      p_service: QuotaService
      p_limit: number
      p_window_seconds: number
    },
  ): PromiseLike<{ data: unknown; error: { message?: string } | null }>
}

export async function reserveQuota(
  client: QuotaRpcClient,
  userId: string,
  service: QuotaService,
  limit: number,
  windowSeconds = 3600,
): Promise<boolean> {
  const { data, error } = await client.rpc('reserve_api_quota', {
    p_user_id: userId,
    p_service: service,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  })
  if (error) throw new Error(`Quota storage unavailable: ${error.message ?? 'unknown error'}`)
  if (typeof data !== 'boolean') throw new Error('Quota storage returned an invalid result')
  return data
}
