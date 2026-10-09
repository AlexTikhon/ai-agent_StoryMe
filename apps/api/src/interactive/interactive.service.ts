import { randomUUID } from 'node:crypto';
import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import type { InteractiveSession, Prisma } from '@prisma/client';
import { canonicalHash } from './domain/canonical';
import {
  DomainError,
  applyChoice,
  startSession,
  validateTransition,
  type DomainEvent,
} from './domain/engine';
import { validateNarration, type NarrationOutput } from './domain/narration';
import type { ScenarioDefinition } from './domain/scenario-schema';
import { hashState, parseState, type InteractiveState } from './domain/state';
import {
  idempotencyKeyReused,
  isLockOrTransactionTimeout,
  revisionConflict,
  scenarioVersionUnavailable,
  sessionBusy,
  sessionNotFound,
  sessionStateInvalid,
  toHttpError,
  unknownScenario,
} from './interactive.errors';
import {
  NARRATOR_PROVIDER,
  NarrationRejectedError,
  prepareNarration,
  type NarratorProvider,
} from './narrator/narrator';
import { PrismaService } from '../database/prisma.service';
import { buildPublicView, publicSessionViewSchema, type PublicSessionView } from './public-view';
import type { SubmitChoiceBody } from './requests';
import { getLatestScenario, getScenario } from './scenarios';

/** Bounds how long a choice may wait for the session row lock or run in total. */
export const LOCK_TIMEOUT_MS = 2_000;
export const STATEMENT_TIMEOUT_MS = 5_000;
const TRANSACTION_OPTIONS = { maxWait: 5_000, timeout: 10_000 } as const;
/** Narration is prepared outside the lock; a racing write can invalidate it. */
const MAX_COMMIT_ATTEMPTS = 3;

/** Narration prepared from a non-locking read, bound to the exact state it describes. */
interface PreparedChoice {
  baseStateHash: string;
  narration: NarrationOutput | null;
  narrationError: NarrationRejectedError | null;
}

/** Thrown inside the transaction when prepared narration no longer matches the locked state. */
class StalePreparationError extends Error {}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

@Injectable()
export class InteractiveService {
  private readonly logger = new Logger(InteractiveService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(NARRATOR_PROVIDER) private readonly narrator: NarratorProvider,
  ) {}

  async createSession(userId: string, scenarioId: string): Promise<PublicSessionView> {
    const scenario = getLatestScenario(scenarioId);
    if (!scenario) throw unknownScenario();

    const genesis = startSession(scenario);
    // Narration is prepared before, and never inside, the write transaction.
    const narration = await this.narrate(scenario, genesis.state);
    const sessionId = randomUUID();
    const view = buildPublicView({ sessionId, scenario, state: genesis.state, narration });

    await this.prisma.$transaction(async (tx) => {
      await tx.interactiveSession.create({
        data: {
          id: sessionId,
          userId,
          scenarioId: scenario.id,
          scenarioVersion: scenario.version,
          revision: genesis.state.revision,
          state: json(genesis.state),
        },
      });
      await tx.sessionEvent.create({
        data: {
          sessionId,
          seq: genesis.event.seq,
          type: genesis.event.type,
          schemaVersion: genesis.event.version,
          payload: json(genesis.event.payload),
          stateHash: genesis.event.stateHash,
          response: json(view),
        },
      });
    }, TRANSACTION_OPTIONS);
    return view;
  }

  async getSession(userId: string, sessionId: string): Promise<PublicSessionView> {
    const session = await this.loadOwned(userId, sessionId);
    const event = await this.prisma.sessionEvent.findUnique({
      where: { sessionId_seq: { sessionId, seq: session.revision } },
    });
    if (!event) {
      this.logger.error(`Session ${sessionId} has no event for revision ${session.revision}`);
      throw sessionStateInvalid();
    }
    return this.parseStoredView(event.response);
  }

  async submitChoice(
    userId: string,
    sessionId: string,
    command: SubmitChoiceBody,
  ): Promise<PublicSessionView> {
    const requestHash = canonicalHash({
      choiceId: command.choiceId,
      expectedRevision: command.expectedRevision,
    });

    for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt += 1) {
      // Ownership is verified before anything about this session is disclosed.
      const session = await this.loadOwned(userId, sessionId);
      const scenario = this.pinnedScenario(session);
      const prepared = await this.prepare(session, scenario, command);
      try {
        return await this.commit({ userId, sessionId, scenario, command, requestHash, prepared });
      } catch (error) {
        if (error instanceof StalePreparationError) continue;
        throw this.translate(error);
      }
    }
    throw sessionBusy();
  }

  // ── Preparation (outside any transaction) ─────────────────────────────────

  private async prepare(
    session: InteractiveSession,
    scenario: ScenarioDefinition,
    command: SubmitChoiceBody,
  ): Promise<PreparedChoice | null> {
    // When the session is not at the expected revision the commit either replays a
    // saved idempotent response or reports a conflict; no narration is needed.
    if (session.revision !== command.expectedRevision) return null;
    const state = parseState(session.state);
    const baseStateHash = hashState(state);
    // Invalid choices are re-detected (and reported) under the lock, after the
    // idempotency and revision checks.
    if (!validateTransition(state, command.choiceId, scenario).ok) {
      return { baseStateHash, narration: null, narrationError: null };
    }
    const applied = applyChoice(state, command.choiceId, scenario);
    try {
      const narration = await prepareNarration(this.narrator, scenario, applied.state);
      return { baseStateHash, narration, narrationError: null };
    } catch (error) {
      if (error instanceof NarrationRejectedError) {
        return { baseStateHash, narration: null, narrationError: error };
      }
      throw error;
    }
  }

  // ── Commit (single transaction, session row locked) ───────────────────────

  private commit(input: {
    userId: string;
    sessionId: string;
    scenario: ScenarioDefinition;
    command: SubmitChoiceBody;
    requestHash: string;
    prepared: PreparedChoice | null;
  }): Promise<PublicSessionView> {
    const { userId, sessionId, scenario, command, requestHash, prepared } = input;
    return this.prisma.$transaction(async (tx) => {
      // Scoped to this transaction only (SET LOCAL): bounds lock waiting and runtime.
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);

      // Serializes every command for this session; also re-verifies ownership.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM interactive_sessions
        WHERE id = ${sessionId}::uuid AND user_id = ${userId}::uuid
        FOR UPDATE`;
      if (locked.length === 0) throw sessionNotFound();

      // 1-3. Idempotency resolves before the revision check so an exact retry
      // still returns the original result after later choices advanced the session.
      const existing = await tx.sessionEvent.findUnique({
        where: { sessionId_idempotencyKey: { sessionId, idempotencyKey: command.idempotencyKey } },
      });
      if (existing) {
        if (existing.requestHash === requestHash) return this.parseStoredView(existing.response);
        throw idempotencyKeyReused();
      }

      // 4-5. Optimistic concurrency.
      const session = await tx.interactiveSession.findUniqueOrThrow({ where: { id: sessionId } });
      if (session.revision !== command.expectedRevision) throw revisionConflict();

      // 6. Validate the choice, then the narration binding, against the locked state.
      const state = parseState(session.state);
      const check = validateTransition(state, command.choiceId, scenario);
      if (!check.ok) throw new DomainError(check.code);
      if (!prepared || prepared.baseStateHash !== hashState(state)) {
        throw new StalePreparationError();
      }
      if (prepared.narrationError) throw prepared.narrationError;

      const applied = applyChoice(state, command.choiceId, scenario);
      // Revalidate the prepared narration against the state this commit will persist.
      const bound = validateNarration(prepared.narration, scenario, applied.state);
      if (!bound.ok) throw new NarrationRejectedError(bound.code);
      const view = buildPublicView({
        sessionId,
        scenario,
        state: applied.state,
        narration: bound.narration,
      });

      // 7. Exactly one event, and the session advances atomically with it.
      await this.insertEvent(
        tx,
        sessionId,
        applied.event,
        command.idempotencyKey,
        requestHash,
        view,
      );
      const advanced = await tx.interactiveSession.updateMany({
        where: { id: sessionId, revision: command.expectedRevision },
        data: { revision: applied.state.revision, state: json(applied.state) },
      });
      if (advanced.count !== 1) throw revisionConflict();
      return view;
    }, TRANSACTION_OPTIONS);
  }

  private insertEvent(
    tx: Prisma.TransactionClient,
    sessionId: string,
    event: DomainEvent,
    idempotencyKey: string,
    requestHash: string,
    view: PublicSessionView,
  ) {
    return tx.sessionEvent.create({
      data: {
        sessionId,
        seq: event.seq,
        type: event.type,
        schemaVersion: event.version,
        payload: json(event.payload),
        stateHash: event.stateHash,
        idempotencyKey,
        requestHash,
        response: json(view),
      },
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async narrate(
    scenario: ScenarioDefinition,
    state: InteractiveState,
  ): Promise<NarrationOutput> {
    try {
      return await prepareNarration(this.narrator, scenario, state);
    } catch (error) {
      throw this.translate(error);
    }
  }

  private async loadOwned(userId: string, sessionId: string): Promise<InteractiveSession> {
    const session = await this.prisma.interactiveSession.findFirst({
      where: { id: sessionId, userId },
    });
    if (!session) throw sessionNotFound();
    return session;
  }

  private pinnedScenario(session: InteractiveSession): ScenarioDefinition {
    const scenario = getScenario(session.scenarioId, session.scenarioVersion);
    if (!scenario) {
      this.logger.error(
        `Session ${session.id} pinned to unavailable ${session.scenarioId}@${session.scenarioVersion}`,
      );
      throw scenarioVersionUnavailable();
    }
    return scenario;
  }

  private parseStoredView(raw: unknown): PublicSessionView {
    return publicSessionViewSchema.parse(raw);
  }

  /** Public error for anything thrown while handling a command; never leaks raw errors. */
  private translate(error: unknown): unknown {
    if (error instanceof HttpException) return error;
    const mapped = toHttpError(error);
    if (mapped) return mapped;
    if (isLockOrTransactionTimeout(error)) return sessionBusy();
    return error;
  }
}
