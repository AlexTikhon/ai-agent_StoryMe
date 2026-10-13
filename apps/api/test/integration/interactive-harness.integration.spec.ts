import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { InteractiveService } from '../../src/interactive/interactive.service';
import {
  AdmissionGate,
  Barrier,
  configWithCap,
  InteractiveTestKit,
  SCENARIO_ID,
  settleAll,
  startCommand,
  withAdmissionGate,
} from './fixtures/interactive-helpers';

const PARTIES = 6;
const POINT = { model: 'interactiveSession', method: 'findUnique' } as const;

interface Outcome {
  state: 'pending' | 'fulfilled' | 'rejected';
  reason?: unknown;
}

/** Records how a promise settled, so a test can assert "still pending" without awaiting it. */
function track(promise: Promise<unknown>): Outcome {
  const outcome: Outcome = { state: 'pending' };
  promise.then(
    () => {
      outcome.state = 'fulfilled';
    },
    (reason: unknown) => {
      outcome.state = 'rejected';
      outcome.reason = reason;
    },
  );
  return outcome;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('Interactive concurrency harness (real Postgres)', () => {
  // The smallest budget a PARTIES-way gate may use: participants plus the observer.
  const kit = new InteractiveTestKit(50, PARTIES + 1);

  beforeAll(() => kit.connect());
  afterAll(() => kit.disconnect());
  afterEach(() => {
    kit.narrator.barrier = null;
    return kit.cleanup();
  });

  it('completes a gated race on exactly the minimum connection budget', async () => {
    const userId = await kit.createUser();
    kit.narrator.barrier = new Barrier(PARTIES);
    const racing = kit.gatedService(POINT, PARTIES);

    const views = await settleAll(
      Array.from({ length: PARTIES }, () =>
        racing.createSession(userId, startCommand(SCENARIO_ID, 'budget-key')),
      ),
    );

    expect(new Set(views.map((v) => v.sessionId)).size).toBe(1);
    expect(await kit.eventCount(views[0]!.sessionId)).toBe(1);
  });

  it('refuses a gate its connection budget cannot hold instead of hanging', async () => {
    const undersized = new InteractiveTestKit(50, PARTIES);
    try {
      expect(() => undersized.gatedService(POINT, PARTIES)).toThrow(/needs 7 connections/);
    } finally {
      await undersized.disconnect();
    }
  });

  it('fails a gate that cannot open, for every participant, within its bound', async () => {
    const gate = new AdmissionGate(3, async () => 0, 50);

    const settled = await Promise.allSettled([gate.pass(), gate.pass()]);
    for (const result of settled) {
      expect(result.status).toBe('rejected');
      expect((result as PromiseRejectedResult).reason.message).toMatch(
        /never opened: 2 arrived \+ 0 blocked of 3/,
      );
    }
    // A participant arriving after the failure does not start a new wait.
    await expect(gate.pass()).rejects.toThrow(/never opened/);
  });

  it('fails a barrier that is never completed', async () => {
    await expect(new Barrier(2, 50).wait()).rejects.toThrow(/Barrier saw 1 of 2 callers/);
  });

  it('settles every started caller and leaves no open transaction when the gate cannot open', async () => {
    const userId = await kit.createUser();
    // Three parties but two callers: the gate can never see them all.
    const gate = new AdmissionGate(3, () => kit.countBlockedAdmissions(), 300);
    const racing = new InteractiveService(
      withAdmissionGate(kit.prisma, POINT, gate),
      kit.narrator,
      configWithCap(50),
    );
    kit.narrator.barrier = new Barrier(2);

    // One caller holds the admission lock at the gate; the other is blocked on
    // it and reaches the gate only after the first has rolled back.
    const results = await Promise.allSettled([
      racing.createSession(userId, startCommand(SCENARIO_ID, 'never-opens')),
      racing.createSession(userId, startCommand(SCENARIO_ID, 'never-opens')),
    ]);

    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(await kit.prisma.interactiveSession.count({ where: { userId } })).toBe(0);
    const [open] = await kit.prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database()
        AND application_name = current_setting('application_name')
        AND pid <> pg_backend_pid() AND state LIKE 'idle in transaction%'`;
    expect(open!.n).toBe(0);
  });
});

describe('Harness deadlines (controlled timers, no database)', () => {
  const BOUND_MS = 20;

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects every gate participant within the bound when the observer never settles', async () => {
    const observe = vi.fn(() => new Promise<number>(() => undefined));
    const gate = new AdmissionGate(3, observe, BOUND_MS);
    const first = track(gate.pass());
    const second = track(gate.pass());

    await vi.advanceTimersByTimeAsync(BOUND_MS + 5);

    expect(first.state).toBe('rejected');
    expect(second.state).toBe('rejected');
    expect((first.reason as Error).message).toMatch(/never opened: 2 arrived/);
    expect(second.reason).toBe(first.reason);

    // A caller arriving after the failure gets the same decision and starts nothing.
    const late = track(gate.pass());
    await vi.advanceTimersByTimeAsync(0);
    expect(late.reason).toBe(first.reason);
    // Failure ends polling and leaves no timer behind.
    const calls = observe.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(observe.mock.calls.length).toBe(calls);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not open on an observation that returns after the deadline', async () => {
    // Sufficient (1 arrived + 2 blocked of 3), but only after 80ms against a 20ms bound.
    const observe = vi.fn(
      () => new Promise<number>((resolve) => setTimeout(() => resolve(2), 4 * BOUND_MS)),
    );
    const gate = new AdmissionGate(3, observe, BOUND_MS);
    const only = track(gate.pass());

    await vi.advanceTimersByTimeAsync(10 * BOUND_MS);

    expect(only.state).toBe('rejected');
    expect((only.reason as Error).message).toMatch(/never opened/);
    expect(observe).toHaveBeenCalledTimes(1);
  });

  it('keeps a gate failed when a sufficient observation resolves after expiration', async () => {
    const observation = deferred<number>();
    const observe = vi.fn(() => observation.promise);
    const gate = new AdmissionGate(3, observe, BOUND_MS);
    const first = track(gate.pass());
    await vi.advanceTimersByTimeAsync(BOUND_MS + 5);
    expect(first.state).toBe('rejected');

    observation.resolve(2);
    await vi.advanceTimersByTimeAsync(50);

    const later = track(gate.pass());
    await vi.advanceTimersByTimeAsync(0);
    expect(later.state).toBe('rejected');
    expect(later.reason).toBe(first.reason);
    expect(observe).toHaveBeenCalledTimes(1);
  });

  it('ignores an observer rejection that arrives after expiration', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const observation = deferred<number>();
      const gate = new AdmissionGate(3, () => observation.promise, BOUND_MS);
      const first = track(gate.pass());
      await vi.advanceTimersByTimeAsync(BOUND_MS + 5);
      expect(first.state).toBe('rejected');
      expect((first.reason as Error).message).toMatch(/never opened/);

      observation.reject(new Error('late observer failure'));
      vi.useRealTimers();
      // Unhandled rejections are reported on a later macrotask.
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(unhandled).toEqual([]);
      // The decision stays the deadline failure, not the late observer error.
      const later = track(gate.pass());
      await Promise.resolve();
      expect(later.reason).toBe(first.reason);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('gives every caller the one observer failure while another has an observation pending', async () => {
    const observations: ReturnType<typeof deferred<number>>[] = [];
    const observe = vi.fn(() => {
      const next = deferred<number>();
      observations.push(next);
      return next.promise;
    });
    const gate = new AdmissionGate(3, observe, 1_000);
    const first = track(gate.pass());
    const second = track(gate.pass());

    const failure = new Error('observer failed');
    observations[0]!.reject(failure);
    await vi.advanceTimersByTimeAsync(5);

    expect(first.state).toBe('rejected');
    expect(second.state).toBe('rejected');
    expect(first.reason).toBe(failure);
    expect(second.reason).toBe(failure);
    const later = track(gate.pass());
    await vi.advanceTimersByTimeAsync(0);
    expect(later.reason).toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a caller that arrives after its barrier expired instead of releasing it', async () => {
    const barrier = new Barrier(2, BOUND_MS);
    const first = track(barrier.wait());
    await vi.advanceTimersByTimeAsync(BOUND_MS + 5);
    expect(first.state).toBe('rejected');

    // The second party completes the count, but the barrier already failed.
    const second = track(barrier.wait());
    await vi.advanceTimersByTimeAsync(0);

    expect(second.state).toBe('rejected');
    expect(second.reason).toBe(first.reason);
  });

  it('gives pending and later barrier callers the one expiry failure', async () => {
    const barrier = new Barrier(3, BOUND_MS);
    const first = track(barrier.wait());
    const second = track(barrier.wait());

    await vi.advanceTimersByTimeAsync(BOUND_MS + 5);

    expect(first.state).toBe('rejected');
    expect(second.state).toBe('rejected');
    expect((first.reason as Error).message).toMatch(/Barrier saw 2 of 3 callers/);
    expect(second.reason).toBe(first.reason);

    // The third caller arrives too late: it must not release a barrier that failed.
    const third = track(barrier.wait());
    await vi.advanceTimersByTimeAsync(0);
    expect(third.state).toBe('rejected');
    expect(third.reason).toBe(first.reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the deadline and poll timers once a gate opens', async () => {
    // Not enough blockers on the first look, enough on the second.
    const observe = vi.fn().mockResolvedValueOnce(0).mockResolvedValue(1);
    const gate = new AdmissionGate(2, observe, 1_000);
    const only = track(gate.pass());

    await vi.advanceTimersByTimeAsync(100);

    expect(only.state).toBe('fulfilled');
    expect(observe).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    // A caller after the opening passes at once and starts nothing.
    const late = track(gate.pass());
    await vi.advanceTimersByTimeAsync(0);
    expect(late.state).toBe('fulfilled');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the deadline timer once a barrier completes', async () => {
    const barrier = new Barrier(2, 1_000);
    const first = track(barrier.wait());
    expect(vi.getTimerCount()).toBe(1);
    const second = track(barrier.wait());

    await vi.advanceTimersByTimeAsync(0);

    expect(first.state).toBe('fulfilled');
    expect(second.state).toBe('fulfilled');
    expect(vi.getTimerCount()).toBe(0);
  });
});
