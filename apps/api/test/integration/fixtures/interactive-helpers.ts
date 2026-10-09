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
import { getScenario } from '../../../src/interactive/scenarios';
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

/** Opens `parties` callers together: each `wait()` resolves only once all have arrived. */
export class Barrier {
  private arrived = 0;
  private release!: () => void;
  private readonly gate = new Promise<void>((resolve) => (this.release = resolve));

  constructor(private readonly parties: number) {}

  wait(): Promise<void> {
    this.arrived += 1;
    if (this.arrived >= this.parties) this.release();
    return this.gate;
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
  readonly prisma = new PrismaService();
  readonly narrator = new ScriptedNarrator();
  readonly service: InteractiveService;
  private readonly userIds: string[] = [];

  constructor(readonly maxSessions = 50) {
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

  /** Backends currently waiting for a user-row admission lock (see AdmissionGate). */
  async countBlockedAdmissions(): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
        AND query LIKE '%FROM users%FOR NO KEY UPDATE%'`;
    return rows[0]?.n ?? 0;
  }

  /** A service whose transactions all pause at `point` until `parties` callers are queued. */
  gatedService(
    point: { model: InterceptedModel; method: string },
    parties: number,
  ): InteractiveService {
    const gate = new AdmissionGate(parties, () => this.countBlockedAdmissions());
    return new InteractiveService(
      withAdmissionGate(this.prisma, point, gate),
      this.narrator,
      configWithCap(this.maxSessions),
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

/**
 * Holds N concurrent transactions together at one point of the admission path
 * (right after the named read) until every one of them is either here or
 * blocked on the owner's admission lock. Without a lock all N pass together and
 * race; with it they are serialized and the gate opens as soon as the rest are
 * provably queued. No fixed sleep decides the outcome: the loop ends on state.
 */
export class AdmissionGate {
  private arrived = 0;
  private open = false;

  constructor(
    private readonly parties: number,
    private readonly blockedOnAdmissionLock: () => Promise<number>,
  ) {}

  async pass(): Promise<void> {
    this.arrived += 1;
    while (!this.open) {
      if (this.arrived + (await this.blockedOnAdmissionLock()) >= this.parties) this.open = true;
      else await new Promise((resolve) => setTimeout(resolve, 10));
    }
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
