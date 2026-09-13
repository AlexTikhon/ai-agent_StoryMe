import { describe, expect, it } from 'vitest';
import { redisControlOptions, redisQueueOptions } from './redis-options';

describe('Redis connection profiles', () => {
  it('bounds control/HTTP commands and disables the offline queue', () => {
    expect(redisControlOptions()).toMatchObject({
      connectTimeout: 2000,
      commandTimeout: 2000,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
  });

  it('keeps unlimited retries only for the BullMQ worker blocking profile', () => {
    expect(redisQueueOptions(true)).toMatchObject({
      maxRetriesPerRequest: null,
      enableOfflineQueue: true,
    });
    expect(redisQueueOptions(false)).toMatchObject({
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
  });
});
