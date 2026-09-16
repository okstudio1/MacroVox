import { describe, expect, it, vi } from 'vitest'
import { reserveQuota, type QuotaRpcClient } from '../_shared/quota'

describe('atomic quota client', () => {
  it('fails closed when the database RPC fails', async () => {
    const client = {
      rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'database down' } }),
    } as unknown as QuotaRpcClient
    await expect(reserveQuota(client, 'user-1', 'claude', 200)).rejects.toThrow(
      'Quota storage unavailable',
    )
  })

  it('fails closed on an invalid RPC response', async () => {
    const client = {
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    } as unknown as QuotaRpcClient
    await expect(reserveQuota(client, 'user-1', 'claude', 200)).rejects.toThrow(
      'invalid result',
    )
  })

  it('uses one reservation call as the allow or deny decision', async () => {
    let remaining = 2
    const client = {
      rpc: vi.fn().mockImplementation(async () => ({
        data: remaining-- > 0,
        error: null,
      })),
    } as unknown as QuotaRpcClient

    const outcomes = await Promise.all([
      reserveQuota(client, 'user-1', 'claude', 2),
      reserveQuota(client, 'user-1', 'claude', 2),
      reserveQuota(client, 'user-1', 'claude', 2),
    ])
    expect(outcomes).toEqual([true, true, false])
  })
})
