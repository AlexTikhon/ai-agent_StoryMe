import { randomUUID } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import type { Env } from '../../../src/config/env.schema';
import { fold, startSession, type DomainEvent } from '../../../src/interactive/domain/engine';
import { buildCanonicalNarration } from '../../../src/interactive/domain/narration';
import { hashState, parseState } from '../../../src/interactive/domain/state';
import { InteractiveService } from '../../../src/interactive/interactive.service';
import { MockNarratorProvider } from '../../../src/interactive/narrator/mock-narrator.provider';
import {
  prepareNarration,
  type NarrationRequest,
  type NarratorProvider,
} from '../../../src/interactive/narrator/narrator';
import { buildPublicView, type PublicSessionView } from '../../../src/interactive/public-view';
import { getScenario, type ScenarioRegistry } from '../../../src/interactive/scenarios';
import { PrismaService } from '../../../src/database/prisma.service';

export const SCENARIO_ID = 'warsaw-last-delivery';

/** A fresh creation command; pass `key` to reuse an identity. */
export function startCommand(scenarioId = SCENARIO_ID, key = `start-${randomUUID()}`) {
  return { scenarioId, idempotencyKey: key };
}

/** Stands in for ConfigService with only the session cap the service reads. */
export function configWithCap(maxSessions: number): ConfigService<Env, true> {
  return {
    get: (key: string) => (key === 'INTERACTIVE_MAX_SESSIONS_PER_USER' ? maxSessions : undefined),
  } as unknown as ConfigService<Env, true>;
}

/** The only database the integration suite may touch (mirrors test/integration/setup.ts). */
const DISPOSABLE_DATABASE_URL = 'postgresql://storyme:storyme_e2e@127.0.0.1:5440/storyme_e2e';

/**
 * Connections the kit's Prisma client may hold. A gated race needs one per
 * participant (each sits in its own transaction, all but one blocked on the
 * owner's admission lock) plus one for the lock observer, which queries through
 * the same client. Prisma's default is `physical cores * 2 + 1`, which is 5 on a
 * small CI runner: below `parties + 1` the observer queues behind the blocked
 * participants, they reach lock_timeout, and the gate can never open.
 */
export const KIT_CONNECTION_LIMIT = 16;
const OBSERVER_CONNECTIONS = 1;

/**
 * Bounds every harness wait. Shorter than the 10s transaction timeout and the
 * 30s test timeout, so a broken precondition fails with a diagnosable error
 * instead of hanging the test and leaking an open transaction into cleanup.
 */
export const HARNESS_WAIT_TIMEOUT_MS = 8_000;

function kitDatabaseUrl(connectionLimit: number, applicationName: string): string {
  const base = process.env['DATABASE_URL'];
  if (base !== DISPOSABLE_DATABASE_URL) {
    throw new Error('InteractiveTestKit refused a non-disposable DATABASE_URL.');
  }
  const url = new URL(base);
  url.searchParams.set('connection_limit', String(connectionLimit));
  url.searchParams.set('application_name', applicationName);
  return url.toString();
}

/**
 * The one terminal outcome of a gate or barrier, shared by every participant.
 * The deadline starts with the first participant and covers everything the
 * primitive waits for. The first of "opened" and "failed" wins; the other, and
 * anything arriving after it, is ignored, so every pending and later caller
 * observes the same decision. Settling clears the deadline timer.
 */
class TerminalDecision {
  readonly outcome: Promise<void>;
  private resolveOutcome!: () => void;
  private rejectOutcome!: (error: Error) => void;
  private state: 'pending' | 'opened' | 'failed' = 'pending';
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private started = false;

  constructor(private readonly onSettled: () => void = () => undefined) {
    this.outcome = new Promise<void>((resolve, reject) => {
      this.resolveOutcome = resolve;
      this.rejectOutcome = reject;
    });
    // Participants await `outcome`; this only keeps an unclaimed failure from
    // surfacing as an unhandled rejection.
    this.outcome.catch(() => undefined);
  }

  get decided(): boolean {
    return this.state !== 'pending';
  }

  /** Arms the shared deadline once, for the first participant. */
  startDeadline(ms: number, expired: () => Error): void {
    if (this.started || this.decided) return;
    this.started = true;
    this.deadline = setTimeout(() => this.fail(expired()), ms);
  }

  open(): void {
    this.settle('opened', () => this.resolveOutcome());
  }

  fail(error: Error): void {
    this.settle('failed', () => this.rejectOutcome(error));
  }

  private settle(state: 'opened' | 'failed', act: () => void): void {
    if (this.decided) return;
    this.state = state;
    clearTimeout(this.deadline);
    this.deadline = undefined;
    act();
    this.onSettled();
  }
}

/**
 * Waits for every racing caller to settle, then reports the first failure. A
 * failed assertion therefore never leaves operations running into cleanup.
 */
export async function settleAll<T>(calls: Promise<T>[]): Promise<T[]> {
  const settled = await Promise.allSettled(calls);
  const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed) throw failed.reason;
  return settled.map((r) => (r as PromiseFulfilledResult<T>).value);
}

/**
 * Opens `parties` callers together: each `wait()` resolves only once all have
 * arrived. One deadline, started by the first caller, bounds the whole barrier.
 * If it expires first the barrier has failed for good: pending callers and any
 * caller arriving afterwards reject with the same error, and a late arrival
 * cannot release it.
 */
export class Barrier {
  private arrived = 0;
  private readonly decision = new TerminalDecision();

  constructor(
    private readonly parties: number,
    private readonly timeoutMs = HARNESS_WAIT_TIMEOUT_MS,
  ) {}

  wait(): Promise<void> {
    if (this.decision.decided) return this.decision.outcome;
    this.arrived += 1;
    this.decision.startDeadline(
      this.timeoutMs,
      () =>
        new Error(
          `Harness wait expired after ${this.timeoutMs}ms: ` +
            `Barrier saw ${this.arrived} of ${this.parties} callers`,
        ),
    );
    if (this.arrived >= this.parties) this.decision.open();
    return this.decision.outcome;
  }
}

/**
 * Test narrator. By default it behaves like the mock; tests can make it
 * return invalid output, and can hold every `narrate` call at a barrier so
 * several requests are provably "prepared" before any of them commits.
 */
export class ScriptedNarrator implements NarratorProvider {
  readonly providerName = 'scripted-test';
  calls = 0;
  barrier: Barrier | null = null;
  mode: 'valid' | 'invalid-text' = 'valid';
  private readonly delegate = new MockNarratorProvider();

  async narrate(request: NarrationRequest): Promise<unknown> {
    this.calls += 1;
    if (this.barrier) await this.barrier.wait();
    const good = buildCanonicalNarration(request.scenario, request.state);
    return this.mode === 'invalid-text'
      ? { ...good, text: `${good.text} Ines confessed on the spot.` }
      : this.delegate.narrate(request);
  }
}

export class InteractiveTestKit {
  readonly prisma: PrismaService;
  readonly narrator = new ScriptedNarrator();
  readonly service: InteractiveService;
  /** Tags this kit's connections so lock observation never sees other clients' backends. */
  private readonly applicationName = `storyme-it-${randomUUID().slice(0, 8)}`;
  private readonly userIds: string[] = [];

  constructor(
    readonly maxSessions = 50,
    readonly connectionLimit = KIT_CONNECTION_LIMIT,
  ) {
    this.prisma = new PrismaService({
      datasourceUrl: kitDatabaseUrl(connectionLimit, this.applicationName),
    });
    this.service = new InteractiveService(this.prisma, this.narrator, configWithCap(maxSessions));
  }

  /** Creates a session with a fresh (or supplied) creation key. */
  start(userId: string, key?: string): Promise<PublicSessionView> {
    return this.service.createSession(userId, startCommand(SCENARIO_ID, key));
  }

  connect(): Promise<void> {
    return this.prisma.$connect();
  }

  async createUser(): Promise<string> {
    const user = await this.prisma.user.create({
      data: { email: `interactive-${randomUUID()}@example.test` },
    });
    this.userIds.push(user.id);
    return user.id;
  }

  /** Removes only this test's own records (events cascade with their sessions). */
  async cleanup(): Promise<void> {
    if (this.userIds.length === 0) return;
    await this.prisma.interactiveSession.deleteMany({ where: { userId: { in: this.userIds } } });
    await this.prisma.user.deleteMany({ where: { id: { in: this.userIds } } });
    this.userIds.length = 0;
  }

  async disconnect(): Promise<void> {
    await this.prisma.$disconnect();
  }

  /**
   * Inserts a session directly, the way a pre-creation-identity row looks: null
   * creation key and hash. `createdAt` / `id` can be pinned to build ties.
   */
  async seedLegacySession(
    userId: string,
    options: { createdAt?: Date; id?: string } = {},
  ): Promise<string> {
    const scenario = getScenario(SCENARIO_ID, 1)!;
    const genesis = startSession(scenario);
    const narration = await prepareNarration(new MockNarratorProvider(), scenario, genesis.state);
    const id = options.id ?? randomUUID();
    const view = buildPublicView({ sessionId: id, scenario, state: genesis.state, narration });
    await this.prisma.interactiveSession.create({
      data: {
        id,
        userId,
        scenarioId: scenario.id,
        scenarioVersion: scenario.version,
        revision: 0,
        state: genesis.state as unknown as Prisma.InputJsonValue,
        ...(options.createdAt ? { createdAt: options.createdAt } : {}),
      },
    });
    await this.prisma.sessionEvent.create({
      data: {
        sessionId: id,
        seq: 0,
        type: genesis.event.type,
        schemaVersion: genesis.event.version,
        payload: genesis.event.payload as unknown as Prisma.InputJsonValue,
        stateHash: genesis.event.stateHash,
        response: view as unknown as Prisma.InputJsonValue,
      },
    });
    return id;
  }

  /**
   * This kit's backends currently waiting for a user-row admission lock (see
   * AdmissionGate). Scoped to the kit's own connections, i.e. the participants.
   */
  async countBlockedAdmissions(): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND application_name = ${this.applicationName}
        AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'
        AND query LIKE '%FROM users%FOR NO KEY UPDATE%'`;
    return rows[0]?.n ?? 0;
  }

  /**
   * A service whose transactions all pause at `point` until `parties` callers are
   * queued. Every participant holds a connection while it waits, and the observer
   * needs one more, so the kit's pool must cover `parties + 1`.
   */
  gatedService(
    point: { model: InterceptedModel; method: string },
    parties: number,
    registry?: ScenarioRegistry,
  ): InteractiveService {
    const needed = parties + OBSERVER_CONNECTIONS;
    if (needed > this.connectionLimit) {
      throw new Error(
        `A ${parties}-party gate needs ${needed} connections (participants plus the lock ` +
          `observer) but this kit holds ${this.connectionLimit}.`,
      );
    }
    const gate = new AdmissionGate(parties, () => this.countBlockedAdmissions());
    return new InteractiveService(
      withAdmissionGate(this.prisma, point, gate),
      this.narrator,
      configWithCap(this.maxSessions),
      registry,
    );
  }

  /** Plays one choice at the session's current revision with a fresh key. */
  async choose(
    userId: string,
    view: PublicSessionView,
    choiceId: string,
    idempotencyKey = `key-${randomUUID()}`,
  ): Promise<PublicSessionView> {
    return this.service.submitChoice(userId, view.sessionId, {
      choiceId,
      expectedRevision: view.revision,
      idempotencyKey,
    });
  }

  async eventCount(sessionId: string): Promise<number> {
    return this.prisma.sessionEvent.count({ where: { sessionId } });
  }

  /** Replays the full persisted event log and requires it to equal the stored session. */
  async assertReplayMatchesStored(sessionId: string): Promise<void> {
    const session = await this.prisma.interactiveSession.findUniqueOrThrow({
      where: { id: sessionId },
    });
    const rows = await this.prisma.sessionEvent.findMany({
      where: { sessionId },
      orderBy: { seq: 'asc' },
    });
    const scenario = getScenario(session.scenarioId, session.scenarioVersion)!;
    const events: DomainEvent[] = rows.map((row) => ({
      seq: row.seq,
      revision: row.seq,
      type: row.type,
      version: row.schemaVersion,
      payload: row.payload,
      stateHash: row.stateHash,
    }));
    const replayed = fold(events, scenario);
    const stored = parseState(session.state);
    if (hashState(replayed) !== hashState(stored)) throw new Error('replay != stored state');
    if (hashState(stored) !== events[events.length - 1]!.stateHash) {
      throw new Error('stored state != final event hash');
    }
    if (session.revision !== events.length - 1 || stored.revision !== session.revision) {
      throw new Error('revision != latest event seq');
    }
  }
}

type AnyFn = (...args: unknown[]) => unknown;
type InterceptedModel = 'interactiveSession' | 'sessionEvent';

/**
 * Wraps a PrismaService so one transactional model method is intercepted:
 * `wrap` receives the real call and decides what happens around it. Everything
 * else, including the real transaction and rollback, is untouched.
 */
function interceptTransactionMethod(
  prisma: PrismaService,
  target: { model: InterceptedModel; method: string },
  wrap: (call: () => unknown) => unknown,
): PrismaService {
  const bound = (object: object, prop: string | symbol): unknown => {
    const value = Reflect.get(object, prop, object) as unknown;
    return typeof value === 'function' ? (value as AnyFn).bind(object) : value;
  };
  const interceptedTx = (tx: Prisma.TransactionClient): Prisma.TransactionClient =>
    new Proxy(tx, {
      get(object, prop) {
        if (prop !== target.model) return bound(object, prop);
        return new Proxy(Reflect.get(object, prop, object) as object, {
          get(delegate, method) {
            if (method !== target.method) return bound(delegate, method);
            const original = bound(delegate, method) as AnyFn;
            return (...args: unknown[]) => wrap(() => original(...args));
          },
        });
      },
    });
  return new Proxy(prisma, {
    get(object, prop) {
      if (prop === '$transaction') {
        return (fn: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: object) =>
          object.$transaction((tx) => fn(interceptedTx(tx)), options as never);
      }
      return bound(object, prop);
    },
  });
}

/** Makes the named transactional method reject; proves a failed write leaves no partial state. */
export function withTransactionFault(
  prisma: PrismaService,
  fault: { model: InterceptedModel; method: string },
): PrismaService {
  return interceptTransactionMethod(prisma, fault, () =>
    Promise.reject(new Error('injected write failure')),
  );
}

/** Pause between two lock observations while the gate is undecided. */
const GATE_POLL_INTERVAL_MS = 10;

/**
 * Holds N concurrent transactions together at one point of the admission path
 * (right after the named read) until every one of them is either here or
 * blocked on the owner's admission lock. Without a lock all N pass together and
 * race; with it they are serialized and the gate opens as soon as the rest are
 * provably queued. No fixed sleep decides the outcome: polling ends on state.
 *
 * One deadline, started by the first participant, bounds the whole gate,
 * including every wait on the lock observer. The first of "opened" and "failed"
 * is terminal: every pending and later participant observes that same decision,
 * so a failed gate rolls its transactions back and releases the lock instead of
 * spinning into cleanup, and a late arrival cannot reopen it. Observations are
 * made one at a time by a single shared loop (the pool reserves one connection
 * for the observer), and a result or rejection arriving after the decision is
 * discarded. Polling and timers stop with the decision.
 *
 * Expiry abandons the wait for an observation; it does not cancel it. The
 * observer's query is not interrupted by this class: it keeps its pooled
 * connection until it returns, and that return is ignored.
 */
export class AdmissionGate {
  private arrived = 0;
  private lastBlocked: number | null = null;
  private observing = false;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly decision = new TerminalDecision(() => {
    clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
  });

  constructor(
    private readonly parties: number,
    private readonly blockedOnAdmissionLock: () => Promise<number>,
    private readonly timeoutMs = HARNESS_WAIT_TIMEOUT_MS,
  ) {}

  pass(): Promise<void> {
    if (this.decision.decided) return this.decision.outcome;
    const first = this.arrived === 0;
    this.arrived += 1;
    if (first) {
      this.decision.startDeadline(this.timeoutMs, () => this.neverOpened());
      this.observe();
    }
    return this.decision.outcome;
  }

  private observe(): void {
    if (this.decision.decided || this.observing) return;
    this.observing = true;
    let observation: Promise<number>;
    try {
      observation = Promise.resolve(this.blockedOnAdmissionLock());
    } catch (error) {
      observation = Promise.reject(error);
    }
    // Both branches are handled here, so a rejection after the decision is
    // dropped instead of becoming an unhandled rejection.
    observation.then(
      (blocked) => {
        this.observing = false;
        this.observed(blocked);
      },
      (error: unknown) => {
        this.observing = false;
        this.decision.fail(error instanceof Error ? error : new Error(String(error)));
      },
    );
  }

  private observed(blocked: number): void {
    if (this.decision.decided) return;
    this.lastBlocked = blocked;
    if (this.arrived + blocked >= this.parties) {
      this.decision.open();
      return;
    }
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      this.observe();
    }, GATE_POLL_INTERVAL_MS);
  }

  private neverOpened(): Error {
    const blocked = this.lastBlocked === null ? 'unobserved' : String(this.lastBlocked);
    const abandoned = this.observing
      ? '; a lock observation was still in flight and is abandoned, not cancelled'
      : '';
    return new Error(
      `AdmissionGate never opened: ${this.arrived} arrived + ${blocked} blocked of ` +
        `${this.parties} parties after ${this.timeoutMs}ms${abandoned}`,
    );
  }
}

/** Runs the real method, then waits at the gate before returning its result. */
export function withAdmissionGate(
  prisma: PrismaService,
  point: { model: InterceptedModel; method: string },
  gate: AdmissionGate,
): PrismaService {
  return interceptTransactionMethod(prisma, point, async (call) => {
    const result = await (call() as Promise<unknown>);
    await gate.pass();
    return result;
  });
}

/**
 * Keeps one transactional model call's transaction (and every lock it holds)
 * open after the call returns, until `hold` settles. Deterministic stand-in for
 * "this request is mid-transaction while another one arrives".
 */
export function withTransactionHold(
  prisma: PrismaService,
  point: { model: InterceptedModel; method: string },
  hold: () => Promise<void>,
): PrismaService {
  return interceptTransactionMethod(prisma, point, async (call) => {
    const result = await (call() as Promise<unknown>);
    await hold();
    return result;
  });
}

/** Like withTransactionHold, for the transaction client's tagged `$executeRaw` writes. */
export function withRawWriteHold(prisma: PrismaService, hold: () => Promise<void>): PrismaService {
  const heldTx = (tx: Prisma.TransactionClient): Prisma.TransactionClient =>
    new Proxy(tx, {
      get(object, prop) {
        const value = Reflect.get(object, prop, object) as unknown;
        if (typeof value !== 'function') return value;
        const original = (value as AnyFn).bind(object);
        if (prop !== '$executeRaw') return original;
        return async (...args: unknown[]) => {
          const result = await (original(...args) as Promise<unknown>);
          await hold();
          return result;
        };
      },
    });
  return new Proxy(prisma, {
    get(object, prop) {
      const value = Reflect.get(object, prop, object) as unknown;
      if (prop === '$transaction') {
        return (fn: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: object) =>
          object.$transaction((tx) => fn(heldTx(tx)), options as never);
      }
      return typeof value === 'function' ? (value as AnyFn).bind(object) : value;
    },
  });
}

/** Holds a non-transactional read after it returns, so another request can act in between. */
export function withReadHold(
  prisma: PrismaService,
  point: { model: InterceptedModel; method: string },
  hold: () => Promise<void>,
): PrismaService {
  return new Proxy(prisma, {
    get(object, prop) {
      const value = Reflect.get(object, prop, object) as unknown;
      if (prop !== point.model) {
        return typeof value === 'function' ? (value as AnyFn).bind(object) : value;
      }
      return new Proxy(value as object, {
        get(delegate, method) {
          const original = (Reflect.get(delegate, method, delegate) as AnyFn).bind(delegate);
          if (method !== point.method) return original;
          return async (...args: unknown[]) => {
            const result = await (original(...args) as Promise<unknown>);
            await hold();
            return result;
          };
        },
      });
    },
  });
}
