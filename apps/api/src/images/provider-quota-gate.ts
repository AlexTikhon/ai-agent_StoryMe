import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { REDIS_CLIENT_TOKEN } from '../redis/redis.module';
import {
  cancellableSleep,
  GenerationControlError,
  throwIfAborted,
} from '../common/provider-execution';

export interface ProviderQuotaGate {
  acquire(
    scope: string,
    minimumIntervalMs: number,
    maximumWaitMs: number,
    maximumConcurrency: number,
    leaseMs: number,
    signal?: AbortSignal,
  ): Promise<ProviderQuotaPermit>;
}

export interface ProviderQuotaPermit {
  readonly waitMs: number;
  release(): Promise<void>;
}

const ACQUIRE_SCRIPT = `
local redis_time = redis.call('TIME')
local now = redis_time[1] * 1000 + math.floor(redis_time[2] / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
local next_at = tonumber(redis.call('GET', KEYS[1]) or '0')
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[2]) then
  local earliest = redis.call('ZRANGE', KEYS[2], 0, 0, 'WITHSCORES')
  return {0, math.max(1, tonumber(earliest[2]) - now)}
end
if next_at > now then return {0, next_at - now} end
redis.call('ZADD', KEYS[2], now + tonumber(ARGV[3]), ARGV[4])
redis.call('PEXPIRE', KEYS[2], math.max(tonumber(ARGV[3]) * 2, 60000))
redis.call('SET', KEYS[1], now + tonumber(ARGV[1]), 'PX', math.max(tonumber(ARGV[1]) * 4, 60000))
return {1, 0}
`;

const RELEASE_SCRIPT = `return redis.call('ZREM', KEYS[1], ARGV[1])`;

/** Redis-server-time gate shared by every API/worker process and queue. */
@Injectable()
export class RedisProviderQuotaGate implements ProviderQuotaGate {
  constructor(@Inject(REDIS_CLIENT_TOKEN) private readonly redis: Redis) {}

  async acquire(
    scope: string,
    minimumIntervalMs: number,
    maximumWaitMs: number,
    maximumConcurrency: number,
    leaseMs: number,
    signal?: AbortSignal,
  ): Promise<ProviderQuotaPermit> {
    throwIfAborted(signal);
    const intervalMs = Math.max(0, Math.floor(minimumIntervalMs));
    const concurrency = Math.max(1, Math.floor(maximumConcurrency));
    const boundedLeaseMs = Math.max(1, Math.floor(leaseMs));
    const boundedWaitMs = Math.max(0, Math.floor(maximumWaitMs));
    const token = randomUUID();
    const rateKey = `provider-quota:${scope}:rate`;
    const concurrencyKey = `provider-quota:${scope}:concurrency`;
    const startedAt = Date.now();
    let totalWaitMs = 0;

    for (;;) {
      throwIfAborted(signal);
      let raw: unknown;
      try {
        raw = await this.redis.eval(
          ACQUIRE_SCRIPT,
          2,
          rateKey,
          concurrencyKey,
          String(intervalMs),
          String(concurrency),
          String(boundedLeaseMs),
          token,
        );
      } catch (cause) {
        throw new GenerationControlError(
          'provider_transient_failure',
          'Provider quota authorization is temporarily unavailable.',
          cause,
        );
      }
      const values = Array.isArray(raw) ? raw : [];
      const acquired = Number(values[0]);
      const suggestedWaitMs = Number(values[1]);
      if (acquired === 1) {
        let released = false;
        return {
          waitMs: totalWaitMs,
          release: async () => {
            if (released) return;
            released = true;
            try {
              await this.redis.eval(RELEASE_SCRIPT, 1, concurrencyKey, token);
            } catch {
              // The expiring lease is the crash/release-failure backstop.
            }
          },
        };
      }
      if (acquired !== 0 || !Number.isFinite(suggestedWaitMs) || suggestedWaitMs <= 0) {
        throw new GenerationControlError(
          'provider_transient_failure',
          'Provider quota authorization returned an invalid result.',
        );
      }
      const elapsedMs = Date.now() - startedAt;
      const remainingMs = boundedWaitMs - elapsedMs;
      if (remainingMs <= 0 || suggestedWaitMs > remainingMs) {
        throw new GenerationControlError(
          'provider_transient_failure',
          'Provider quota wait exceeded its authorized bound.',
        );
      }
      const waitMs = Math.max(1, Math.ceil(suggestedWaitMs));
      await cancellableSleep(waitMs, signal);
      totalWaitMs += waitMs;
    }
  }
}
