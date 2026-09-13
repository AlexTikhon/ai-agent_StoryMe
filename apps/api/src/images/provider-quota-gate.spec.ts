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

  it('cancels a pending acquire and releases a permit that Redis grants late', async () => {
    let resolveAcquire!: (value: unknown) => void;
    const redis = {
      eval: vi
        .fn()
        .mockImplementationOnce(() => new Promise((resolve) => (resolveAcquire = resolve)))
        .mockResolvedValue(1),
    };
    const controller = new AbortController();
    const pending = new RedisProviderQuotaGate(redis as never).acquire(
      'openai:project:image:model',
      0,
      5000,
      1,
      300000,
      controller.signal,
    );
    controller.abort('cancelled');
    await expect(pending).rejects.toMatchObject({ name: 'ProviderCancellationError' });

    resolveAcquire([1, 0]);
    await vi.waitFor(() => expect(redis.eval).toHaveBeenCalledTimes(2));
  });

  it('times out a delayed Redis acquire and compensates a late reservation', async () => {
    vi.useFakeTimers();
    try {
      let resolveAcquire!: (value: unknown) => void;
      const redis = {
        eval: vi
          .fn()
          .mockImplementationOnce(() => new Promise((resolve) => (resolveAcquire = resolve)))
          .mockResolvedValue(1),
      };
      const pending = new RedisProviderQuotaGate(redis as never).acquire(
        'openai:project:image:model',
        0,
        5000,
        1,
        300000,
      );
      const assertion = expect(pending).rejects.toMatchObject({
        reason: 'provider_transient_failure',
      });
      await vi.advanceTimersByTimeAsync(2000);
      await assertion;
      resolveAcquire([1, 0]);
      await vi.advanceTimersByTimeAsync(0);
      expect(redis.eval).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds release when Redis never answers', async () => {
    vi.useFakeTimers();
    try {
      const redis = {
        eval: vi
          .fn()
          .mockResolvedValueOnce([1, 0])
          .mockImplementationOnce(() => new Promise(() => undefined)),
      };
      const permit = await new RedisProviderQuotaGate(redis as never).acquire(
        'openai:project:image:model',
        0,
        5000,
        1,
        300000,
      );
      const released = permit.release();
      await vi.advanceTimersByTimeAsync(2000);
      await expect(released).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
