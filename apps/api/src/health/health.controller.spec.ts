import { describe, it, expect, vi } from 'vitest';
import type { HealthCheckResult, HealthCheckService } from '@nestjs/terminus';
import type { PrismaService } from '../database/prisma.service';
import type { RedisService } from '../cache/redis.service';
import { DbHealthIndicator, HealthController, RedisHealthIndicator } from './health.controller';

describe('DbHealthIndicator', () => {
  it('reports up when the DB query succeeds', async () => {
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
    } as unknown as PrismaService;
    const indicator = new DbHealthIndicator(prisma);

    const result = await indicator.isHealthy('db');

    expect(result).toEqual({ db: { status: 'up' } });
  });

  it('reports down with the error message when the DB query throws', async () => {
    const prisma = {
      $queryRaw: vi.fn().mockRejectedValue(new Error('connection refused')),
    } as unknown as PrismaService;
    const indicator = new DbHealthIndicator(prisma);

    const result = await indicator.isHealthy('db');

    expect(result).toEqual({ db: { status: 'down', message: 'connection refused' } });
  });
});

describe('RedisHealthIndicator', () => {
  it('reports up when ping returns PONG', async () => {
    const redis = { ping: vi.fn().mockResolvedValue('PONG') } as unknown as RedisService;
    const indicator = new RedisHealthIndicator(redis);

    const result = await indicator.isHealthy('redis');

    expect(result).toEqual({ redis: { status: 'up' } });
  });

  it('reports down when ping returns an unexpected value', async () => {
    const redis = { ping: vi.fn().mockResolvedValue('WAT') } as unknown as RedisService;
    const indicator = new RedisHealthIndicator(redis);

    const result = await indicator.isHealthy('redis');

    expect(result).toEqual({ redis: { status: 'down' } });
  });

  it('reports down with the error message when ping throws', async () => {
    const redis = {
      ping: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    } as unknown as RedisService;
    const indicator = new RedisHealthIndicator(redis);

    const result = await indicator.isHealthy('redis');

    expect(result).toEqual({ redis: { status: 'down', message: 'ECONNREFUSED' } });
  });
});

describe('HealthController', () => {
  it('checks both db and redis indicators through HealthCheckService', async () => {
    const expected: HealthCheckResult = {
      status: 'ok',
      info: { db: { status: 'up' }, redis: { status: 'up' } },
      error: {},
      details: { db: { status: 'up' }, redis: { status: 'up' } },
    };
    const health = {
      check: vi.fn().mockImplementation(async (indicators: Array<() => unknown>) => {
        await Promise.all(indicators.map((fn) => fn()));
        return expected;
      }),
    } as unknown as HealthCheckService;
    const dbHealth = {
      isHealthy: vi.fn().mockResolvedValue({ db: { status: 'up' } }),
    } as unknown as DbHealthIndicator;
    const redisHealth = {
      isHealthy: vi.fn().mockResolvedValue({ redis: { status: 'up' } }),
    } as unknown as RedisHealthIndicator;
    const controller = new HealthController(health, dbHealth, redisHealth);

    const result = await controller.check();

    expect(result).toEqual(expected);
    expect(dbHealth.isHealthy).toHaveBeenCalledWith('db');
    expect(redisHealth.isHealthy).toHaveBeenCalledWith('redis');
  });
});
