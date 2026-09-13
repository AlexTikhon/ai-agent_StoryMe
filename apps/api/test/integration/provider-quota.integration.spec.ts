import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import Redis from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';

describe('shared provider quota (real Redis, two worker processes, fake provider)', () => {
  const redis = new Redis(process.env['REDIS_URL']!);
  afterAll(() => redis.quit());

  it('enforces provider-wide rate and concurrency across separate processes', async () => {
    const scope = `integration:image:${Date.now()}`;
    await redis.del(`provider-quota:${scope}:rate`, `provider-quota:${scope}:concurrency`);
    const arrivals: number[] = [];
    let active = 0;
    let maximumActive = 0;
    const server = createServer((_request, response) => {
      arrivals.push(Date.now());
      active++;
      maximumActive = Math.max(maximumActive, active);
      setTimeout(() => {
        active--;
        response.writeHead(200).end('ok');
      }, 100);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fake provider did not bind');
    const providerUrl = `http://127.0.0.1:${address.port}/images`;
    const runWorker = () =>
      new Promise<number | null>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            '-r',
            'ts-node/register/transpile-only',
            '-r',
            'tsconfig-paths/register',
            'test/integration/fixtures/provider-quota-worker.ts',
            scope,
            providerUrl,
          ],
          {
            env: { ...process.env, TS_NODE_PROJECT: 'tsconfig.scripts.json' },
            stdio: 'ignore',
          },
        );
        child.once('error', reject);
        child.once('exit', resolve);
      });
    try {
      expect(await Promise.all([runWorker(), runWorker()])).toEqual([0, 0]);
      expect(arrivals).toHaveLength(2);
      expect(maximumActive).toBe(1);
      expect(Math.abs(arrivals[1]! - arrivals[0]!)).toBeGreaterThanOrEqual(180);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await redis.del(`provider-quota:${scope}:rate`, `provider-quota:${scope}:concurrency`);
    }
  });
});
