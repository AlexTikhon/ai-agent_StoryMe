import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { fold, type DomainEvent } from '../../../src/interactive/domain/engine';
import { buildCanonicalNarration } from '../../../src/interactive/domain/narration';
import { hashState, parseState } from '../../../src/interactive/domain/state';
import { InteractiveService } from '../../../src/interactive/interactive.service';
import { MockNarratorProvider } from '../../../src/interactive/narrator/mock-narrator.provider';
import type {
  NarrationRequest,
  NarratorProvider,
} from '../../../src/interactive/narrator/narrator';
import type { PublicSessionView } from '../../../src/interactive/public-view';
import { getScenario } from '../../../src/interactive/scenarios';
import { PrismaService } from '../../../src/database/prisma.service';

export const SCENARIO_ID = 'warsaw-last-delivery';

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
  readonly service = new InteractiveService(this.prisma, this.narrator);
  private readonly userIds: string[] = [];

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

/**
 * Wraps a PrismaService so the named transactional model method rejects.
 * Everything else, including the real transaction and rollback, is untouched;
 * this is how tests prove a failed write leaves no partial state.
 */
export function withTransactionFault(
  prisma: PrismaService,
  fault: { model: 'interactiveSession' | 'sessionEvent'; method: string },
): PrismaService {
  const bound = (target: object, prop: string | symbol): unknown => {
    const value = Reflect.get(target, prop, target) as unknown;
    return typeof value === 'function' ? (value as AnyFn).bind(target) : value;
  };
  const faultyTx = (tx: Prisma.TransactionClient): Prisma.TransactionClient =>
    new Proxy(tx, {
      get(target, prop) {
        if (prop !== fault.model) return bound(target, prop);
        return new Proxy(Reflect.get(target, prop, target) as object, {
          get(delegate, method) {
            if (method === fault.method) {
              return () => Promise.reject(new Error('injected write failure'));
            }
            return bound(delegate, method);
          },
        });
      },
    });
  return new Proxy(prisma, {
    get(target, prop) {
      if (prop === '$transaction') {
        return (fn: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: object) =>
          target.$transaction((tx) => fn(faultyTx(tx)), options as never);
      }
      return bound(target, prop);
    },
  });
}
