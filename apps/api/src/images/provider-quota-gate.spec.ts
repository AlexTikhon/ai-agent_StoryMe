import { describe, expect, it, vi } from 'vitest';
import { RedisProviderQuotaGate } from './provider-quota-gate';

describe('RedisProviderQuotaGate', () => {
  it('uses one provider-scoped atomic Redis reservation shared by callers', async () => {
    const redis = {
      eval: vi
        .fn()
        .mockResolvedValueOnce([1, 0])
        .mockResolvedValueOnce([0, 25])
        .mockResolvedValueOnce([1, 0])
        .mockResolvedValue(1),
    };
    vi.useFakeTimers();
    try {
      const gateA = new RedisProviderQuotaGate(redis as never);
      const gateB = new RedisProviderQuotaGate(redis as never);
      const first = gateA.acquire('openai:image:model', 1000, 5000, 1, 300000);
      const second = gateB.acquire('openai:image:model', 1000, 5000, 1, 300000);
      await vi.runAllTimersAsync();
      const firstPermit = await first;
      const secondPermit = await second;
      expect(firstPermit.waitMs).toBe(0);
      expect(secondPermit.waitMs).toBe(25);
      expect(redis.eval.mock.calls[0]?.[2]).toBe('provider-quota:openai:image:model:rate');
      expect(redis.eval.mock.calls[0]?.[3]).toBe('provider-quota:openai:image:model:concurrency');
      await firstPermit.release();
      await firstPermit.release();
      await secondPermit.release();
      // Each permit releases exactly once, even if a caller's finally path repeats.
      expect(redis.eval).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed when the bounded shared wait cannot be reserved', async () => {
    const gate = new RedisProviderQuotaGate({ eval: vi.fn().mockResolvedValue([0, 25]) } as never);
    await expect(gate.acquire('openai:image:model', 1000, 10, 1, 300000)).rejects.toMatchObject({
      reason: 'provider_transient_failure',
    });
  });

  it('fails closed with a typed transient outcome when Redis is unavailable', async () => {
    const gate = new RedisProviderQuotaGate({
      eval: vi.fn().mockRejectedValue(new Error('redis unavailable')),
    } as never);
    await expect(gate.acquire('openai:image:model', 1000, 10, 1, 300000)).rejects.toMatchObject({
      reason: 'provider_transient_failure',
    });
  });
});
