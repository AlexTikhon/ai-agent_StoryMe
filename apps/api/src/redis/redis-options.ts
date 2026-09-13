import type { RedisOptions } from 'ioredis';

export const REDIS_CONTROL_COMMAND_TIMEOUT_MS = 2_000;

/** Short request/control profile: bounded, no offline command accumulation. */
export function redisControlOptions() {
  return {
    connectTimeout: 2_000,
    commandTimeout: REDIS_CONTROL_COMMAND_TIMEOUT_MS,
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
    enableOfflineQueue: false,
    retryStrategy: (attempt) => (attempt <= 3 ? Math.min(attempt * 100, 500) : null),
  } satisfies RedisOptions;
}

/** BullMQ workers require blocking commands and therefore unlimited request
 * retries. Producers use the bounded profile and fail closed instead. */
export function redisQueueOptions(workerProcess: boolean) {
  return workerProcess
    ? {
        connectTimeout: 2_000,
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        enableOfflineQueue: true,
        retryStrategy: (attempt: number) => Math.min(attempt * 250, 2_000),
      }
    : { ...redisControlOptions(), enableReadyCheck: false };
}
