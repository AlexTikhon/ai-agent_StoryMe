import { randomUUID } from 'node:crypto';
import { HttpException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  InteractivePresentationDto,
  InteractiveScenarioCatalogueDto,
  InteractiveSessionListDto,
  InteractiveSessionSummaryDto,
} from '@book/types';
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
  sessionLimitReached,
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
import type { Env } from '../config/env.schema';
import { PrismaService } from '../database/prisma.service';
import { buildPublicView, publicSessionViewSchema, type PublicSessionView } from './public-view';
import {
  createSessionRequestHash,
  encodeListCursor,
  type CreateSessionBody,
  type ListSessionsQuery,
  type SubmitChoiceBody,
} from './requests';
import { projectPresentation } from './presentation/presentation';
import { sessionMetadataSchema, type SessionMetadata } from './session-metadata';
import { publishedScenarioRegistry, type ScenarioRegistry } from './scenarios';

/** Injection token for the published scenario registry; defaults to the real one. */
export const SCENARIO_REGISTRY = Symbol('SCENARIO_REGISTRY');

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
    @Inject(ConfigService) private readonly config: ConfigService<Env, true>,
    @Optional()
    @Inject(SCENARIO_REGISTRY)
    private readonly registry: ScenarioRegistry = publishedScenarioRegistry,
  ) {}

  /** The published scenarios, one allowlisted entry each (latest version). */
  listScenarios(): InteractiveScenarioCatalogueDto {
    return { scenarios: this.registry.catalogue() };
  }

  /**
   * Creates a session, or replays the one a previous identical request created.
   *
   * Order matters: (1) an existing creation identity is resolved before the
   * registry is consulted or any narration is prepared, so a retry never
   * narrates again and never depends on which versions are published now;
   * (2) the exact requested version is resolved (never upgraded), or the latest
   * when none was named; (3) narration is prepared outside any transaction;
   * (4) the identity is re-checked inside the write transaction, under the
   * owner's admission lock, before the session cap is evaluated, so an accepted
   * retry still succeeds at the cap.
   */
  async createSession(userId: string, command: CreateSessionBody): Promise<PublicSessionView> {
    const requestHash = createSessionRequestHash(command);

    const existing = await this.findCreation(this.prisma, userId, command.idempotencyKey);
    if (existing) return this.replayCreation(this.prisma, existing, requestHash);

    const scenario =
      command.scenarioVersion === undefined
        ? this.registry.getLatest(command.scenarioId)
        : this.registry.get(command.scenarioId, command.scenarioVersion);
    if (!scenario) throw unknownScenario();

    const genesis = startSession(scenario);
    const narration = await this.narrate(scenario, genesis.state);
    const sessionId = randomUUID();
    const view = buildPublicView({ sessionId, scenario, state: genesis.state, narration });

    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);

        // Serializes session admission for this owner. FOR NO KEY UPDATE conflicts
        // with other admissions (and other writers of the user row) but not with
        // foreign-key checks, so unrelated inserts that merely reference the user
        // (books, events, ...) are not blocked. Held only for this short
        // transaction; narration was prepared before it began.
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM users WHERE id = ${userId}::uuid FOR NO KEY UPDATE`;
        if (locked.length === 0) throw sessionNotFound();

        // Identity first, then the cap: an accepted retry must work at the cap.
        const raced = await this.findCreation(tx, userId, command.idempotencyKey);
        if (raced) return this.replayCreation(tx, raced, requestHash);

        // Counted under the lock and inserted in the same transaction: there is no
        // window between the count and the insert for a concurrent creation.
        const retained = await tx.interactiveSession.count({ where: { userId } });
        if (retained >= this.maxSessionsPerUser()) throw sessionLimitReached();

        await tx.interactiveSession.create({
          data: {
            id: sessionId,
            userId,
            scenarioId: scenario.id,
            scenarioVersion: scenario.version,
            revision: genesis.state.revision,
            state: json(genesis.state),
            creationIdempotencyKey: command.idempotencyKey,
            creationRequestHash: requestHash,
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
        return view;
      }, TRANSACTION_OPTIONS);
    } catch (error) {
      throw this.translate(error);
    }
  }

  /**
   * One page of the caller's sessions, newest first. Every query is filtered by
   * the owner; summaries are built only from the stored public view of each
   * session's current revision (never from state, payloads or hashes).
   */
  async listSessions(userId: string, query: ListSessionsQuery): Promise<InteractiveSessionListDto> {
    const { limit, cursor } = query;
    const rows = await this.prisma.interactiveSession.findMany({
      where: {
        userId,
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        scenarioId: true,
        scenarioVersion: true,
        revision: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor =
      rows.length > limit && last
        ? encodeListCursor({ createdAt: last.createdAt, id: last.id })
        : null;
    if (page.length === 0) return { sessions: [], nextCursor };

    const events = await this.prisma.sessionEvent.findMany({
      where: { OR: page.map((row) => ({ sessionId: row.id, seq: row.revision })) },
      select: { sessionId: true, response: true },
    });
    const responses = new Map(events.map((event) => [event.sessionId, event.response]));

    const sessions: InteractiveSessionSummaryDto[] = [];
    for (const row of page) {
      const parsed = publicSessionViewSchema.safeParse(responses.get(row.id));
      if (!parsed.success) {
        this.logger.error(`Session ${row.id} has no valid event for revision ${row.revision}`);
        continue;
      }
      const view = parsed.data;
      sessions.push({
        sessionId: row.id,
        scenarioId: row.scenarioId,
        scenarioVersion: row.scenarioVersion,
        scenarioTitle: this.registry.title(row.scenarioId, row.scenarioVersion),
        sceneTitle: view.scene.title,
        status: view.status,
        endingTitle: view.ending?.title ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      });
    }
    return { sessions, nextCursor };
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

  /**
   * Artwork for the session's current scene. Resolves the owned session through
   * getSession (so ownership and the stored public view are the only inputs),
   * then selects from that view. Strictly read-only: no events, state, narration
   * or provider calls.
   */
  async getPresentation(
    userId: string,
    sessionId: string,
    expectedRevision: number,
  ): Promise<InteractivePresentationDto> {
    const view = await this.getSession(userId, sessionId);
    if (view.revision !== expectedRevision) throw revisionConflict();
    return projectPresentation(view);
  }

  /**
   * Display title of the session's exact pinned (id, version). Ownership is
   * resolved first; the title comes from the injected registry for that pinned
   * identity, never from the latest version. Strictly read-only and independent
   * of events, narration, providers and artwork.
   */
  async getSessionMetadata(userId: string, sessionId: string): Promise<SessionMetadata> {
    const session = await this.loadOwned(userId, sessionId);
    return sessionMetadataSchema.parse({
      sessionId: session.id,
      scenarioId: session.scenarioId,
      scenarioVersion: session.scenarioVersion,
      title: this.registry.title(session.scenarioId, session.scenarioVersion),
    });
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

  private maxSessionsPerUser(): number {
    return this.config.get('INTERACTIVE_MAX_SESSIONS_PER_USER', { infer: true });
  }

  private findCreation(db: Prisma.TransactionClient, userId: string, key: string) {
    return db.interactiveSession.findUnique({
      where: { userId_creationIdempotencyKey: { userId, creationIdempotencyKey: key } },
      select: { id: true, creationRequestHash: true },
    });
  }

  /** Same fingerprint: the stored genesis response, even if the session has since advanced. */
  private async replayCreation(
    db: Prisma.TransactionClient,
    existing: { id: string; creationRequestHash: string | null },
    requestHash: string,
  ): Promise<PublicSessionView> {
    if (existing.creationRequestHash !== requestHash) throw idempotencyKeyReused();
    const genesis = await db.sessionEvent.findUnique({
      where: { sessionId_seq: { sessionId: existing.id, seq: 0 } },
    });
    if (!genesis) {
      this.logger.error(`Session ${existing.id} has no genesis event`);
      throw sessionStateInvalid();
    }
    return this.parseStoredView(genesis.response);
  }

  private async loadOwned(userId: string, sessionId: string): Promise<InteractiveSession> {
    const session = await this.prisma.interactiveSession.findFirst({
      where: { id: sessionId, userId },
    });
    if (!session) throw sessionNotFound();
    return session;
  }

  private pinnedScenario(session: InteractiveSession): ScenarioDefinition {
    const scenario = this.registry.get(session.scenarioId, session.scenarioVersion);
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
