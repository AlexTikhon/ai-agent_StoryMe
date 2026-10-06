import { describe, expect, it } from 'vitest';
import { createAsyncLimiter } from './async-limiter';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('createAsyncLimiter', () => {
  it('never runs more than the configured number of tasks at once', async () => {
    const limiter = createAsyncLimiter(2);
    let running = 0;
    let peak = 0;
    const gates = Array.from({ length: 5 }, () => deferred());
    const results = gates.map((gate) =>
      limiter.run(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await gate.promise;
        running -= 1;
      }),
    );

    await Promise.resolve();
    expect(running).toBe(2);
    for (const gate of gates) {
      gate.resolve();
      await Promise.resolve();
    }
    await Promise.all(results);
    expect(peak).toBe(2);
  });

  it('drops a queued task whose signal aborts without ever starting it', async () => {
    const limiter = createAsyncLimiter(1);
    const gate = deferred();
    const first = limiter.run(() => gate.promise);
    const controller = new AbortController();
    let started = false;
    const queued = limiter.run(async () => {
      started = true;
    }, controller.signal);

    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    gate.resolve();
    await first;
    expect(started).toBe(false);
  });

  it('keeps draining the queue after a task fails', async () => {
    const limiter = createAsyncLimiter(1);
    const failing = limiter.run(async () => {
      throw new Error('boom');
    });
    const next = limiter.run(async () => 'ok');
    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ok');
  });
});
