import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AgentLogStatus,
  AgentStep,
  GenerationRunStatus,
  type Prisma,
  type Book,
  type GenerationRun,
} from '@prisma/client';
import { PrismaService } from '../../src/database/prisma.service';
import { GenerationRunService } from '../../src/agent/generation-run.service';
import {
  GenerationExecutionService,
  StaleGenerationRunError,
} from '../../src/agent/generation-execution.service';
import { GenerationRunRecoveryService } from '../../src/agent/generation-run-recovery.service';
import { GenerationRunCoordinator } from '../../src/agent/generation-run-coordinator.service';
import { CreditsService } from '../../src/credits/credits.service';
import type { GenerationOutcome } from '../../src/agent/generation-outcome';
import { GenerationInputSnapshotBackfillService } from '../../src/agent/generation-input-snapshot-backfill.service';
import { LocalImageAssetStorage } from '../../src/images/image-asset-storage';
import {
  buildInputSnapshot,
  hashInputSnapshot,
  parseGenerationInputSnapshot,
} from '../../src/agent/generation-input-snapshot';

/**
 * Durable integration coverage against a real Postgres (see
 * vitest.integration.config.ts) — not mocks. Proves the invariants that
 * depend on Postgres's actual row-locking/READ-COMMITTED re-check semantics,
 * which a mocked PrismaClient cannot verify: fenced claims/writes correctly
 * serialize concurrent attempts, atomic transactions leave no partial state,
 * and JSONB round-tripping preserves an input snapshot exactly.
 *
 * Every row created here is deleted in afterEach/afterAll — safe to run
 * against a shared local dev database.
 */
describe('Generation pipeline fencing (real Postgres)', () => {
  const prisma = new PrismaService();
  const userIds: string[] = [];

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  afterEach(async () => {
    // Deleting the user cascades to books -> generationRuns/outboxEvents.
    if (userIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      userIds.length = 0;
    }
  });

  async function createUserAndBook(overrides: Partial<Book> = {}): Promise<Book> {
    const user = await prisma.user.create({
      data: { email: `integration-${randomUUID()}@example.test` },
    });
    userIds.push(user.id);
    return prisma.book.create({
      data: {
        userId: user.id,
        status: 'char_build',
        childName: 'Mia',
        childAge: 5,
        language: 'en',
        theme: 'friendship',
        pageCount: 6,
        ...overrides,
      },
    });
  }

  async function createRun(
    book: Book,
    overrides: Partial<GenerationRun> = {},
  ): Promise<GenerationRun> {
    const snapshot = buildInputSnapshot(book);
    const run = await prisma.generationRun.create({
      data: {
        bookId: book.id,
        userId: book.userId,
        kind: 'initial',
        status: GenerationRunStatus.running,
        inputSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        inputHash: hashInputSnapshot(snapshot),
        leaseOwner: 'worker-a',
        deliveryToken: 'delivery-token-a',
        fencingVersion: 1,
        ...(overrides as Prisma.GenerationRunUncheckedCreateInput),
      },
    });
    await prisma.book.update({ where: { id: book.id }, data: { activeRunId: run.id } });
    return run;
  }

  describe('GenerationRunService.claim', () => {
    it('lets the same worker re-claim its own still-live lease (a BullMQ retry re-invoking the same process)', async () => {
      const book = await createUserAndBook();
      const run = await createRun(book);
      const service = new GenerationRunService(prisma);

      const claimed = await service.claim(run.id, 'token-2', 'worker-a', 60_000);

      expect(claimed).not.toBeNull();
      expect(claimed?.fencingVersion).toBe(run.fencingVersion + 1);
      expect(claimed?.deliveryToken).toBe('token-2');
    });

    it('a stalled-job redelivery to a different worker reclaims even though its BullMQ attempt count is unchanged and the old lease has not wall-clock-expired, then fences out the original (now-stale) delivery token', async () => {
      const book = await createUserAndBook();
      const run = await createRun(book, { leaseExpiresAt: new Date(Date.now() + 60_000) });
      const service = new GenerationRunService(prisma);

      // worker-b receives a BullMQ stalled-job redelivery of the exact same
      // job — attemptsMade is unchanged, only the lock token is new — before
      // worker-a's lease has wall-clock-expired.
      const reclaimed = await service.claim(run.id, 'token-b', 'worker-b', 60_000);
      expect(reclaimed).not.toBeNull();
      expect(reclaimed?.leaseOwner).toBe('worker-b');
      expect(reclaimed?.deliveryToken).toBe('token-b');

      // worker-a's later write, still carrying the pre-redelivery
      // fencingVersion/deliveryToken it originally observed, must now be
      // rejected — proven here via heartbeat (see also the
      // applyFencedBookWrite fencing test below).
      const staleHeartbeat = await service.heartbeat(
        run.id,
        'delivery-token-a',
        run.fencingVersion,
        60_000,
      );
      expect(staleHeartbeat).toBe(false);
    });

    it('is a no-op for an already-terminal run', async () => {
      const book = await createUserAndBook();
      const run = await createRun(book, { status: GenerationRunStatus.completed });
      const service = new GenerationRunService(prisma);

      const claimed = await service.claim(run.id, 'token-2', 'worker-a', 60_000);

      expect(claimed).toBeNull();
    });
  });

  describe('GenerationRunService.heartbeat', () => {
    it('extends the lease when deliveryToken and fencingVersion still match', async () => {
      const book = await createUserAndBook();
      const run = await createRun(book);
      const service = new GenerationRunService(prisma);

      const result = await service.heartbeat(
        run.id,
        'delivery-token-a',
        run.fencingVersion,
        60_000,
      );

      expect(result).toBe(true);
      const reloaded = await prisma.generationRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(reloaded.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    });

    it('rejects a heartbeat carrying a stale deliveryToken even if it happens to guess the current fencingVersion', async () => {
      const book = await createUserAndBook();
      const run = await createRun(book);
      const service = new GenerationRunService(prisma);

      const result = await service.heartbeat(
        run.id,
        'some-other-token',
        run.fencingVersion,
        60_000,
      );

      expect(result).toBe(false);
    });
  });

  describe('GenerationExecutionService.applyFencedBookWrite', () => {
    it('atomically writes Book and bumps GenerationRun.currentStep when the fencingVersion still matches', async () => {
      const book = await createUserAndBook();
      const run = await createRun(book, { fencingVersion: 5 });
      const execService = new GenerationExecutionService(prisma);
      const ctx = {
        runId: run.id,
        bookId: book.id,
        fencingVersion: 5,
        inputHash: run.inputHash,
        inputSnapshot: buildInputSnapshot(book),
      };

      const updated = await execService.applyFencedBookWrite(
        ctx,
        { title: 'New Title' },
        AgentStep.layout,
      );

      expect(updated.title).toBe('New Title');
      const reloadedRun = await prisma.generationRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(reloadedRun.currentStep).toBe(AgentStep.layout);
    });

    it('rejects a write from a stale fencingVersion and leaves Book provably untouched', async () => {
      const book = await createUserAndBook({ title: 'Original Title' });
      const run = await createRun(book, { fencingVersion: 5 });
      const execService = new GenerationExecutionService(prisma);
      const staleCtx = {
        runId: run.id,
        bookId: book.id,
        fencingVersion: 4, // a superseded attempt's observed version
        inputHash: run.inputHash,
        inputSnapshot: buildInputSnapshot(book),
      };

      await expect(
        execService.applyFencedBookWrite(staleCtx, { title: 'Stale Write' }, AgentStep.layout),
      ).rejects.toBeInstanceOf(StaleGenerationRunError);

      const reloadedBook = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
      expect(reloadedBook.title).toBe('Original Title');
    });

    it('a claim that bumps fencingVersion fences out a write built from the pre-claim context', async () => {
      const book = await createUserAndBook();
      const run = await createRun(book, {
        fencingVersion: 1,
        leaseOwner: 'worker-a',
        deliveryToken: 'delivery-token-a',
      });
      const runService = new GenerationRunService(prisma);
      const execService = new GenerationExecutionService(prisma);
      const staleCtx = {
        runId: run.id,
        bookId: book.id,
        fencingVersion: run.fencingVersion,
        inputHash: run.inputHash,
        inputSnapshot: buildInputSnapshot(book),
      };

      // A newer delivery reclaims the run, bumping fencingVersion.
      const reclaimed = await runService.claim(run.id, 'token-b', 'worker-b', 60_000);
      expect(reclaimed?.fencingVersion).toBe(2);

      // The stale worker's in-flight write, built from the context it observed at its own claim time, must now fail.
      await expect(
        execService.applyFencedBookWrite(
          staleCtx,
          { title: 'From stale worker' },
          AgentStep.layout,
        ),
      ).rejects.toBeInstanceOf(StaleGenerationRunError);
    });
  });

  describe('Atomic terminal transition (GenerationRunCoordinator.completeRun — the actual production method)', () => {
    const coordinator = new GenerationRunCoordinator(prisma, new CreditsService(prisma));

    function completedOutcome(overrides: Partial<GenerationOutcome> = {}): GenerationOutcome {
      return {
        status: 'complete' as GenerationOutcome['status'],
        completedStep: 'pdf_render' as GenerationOutcome['completedStep'],
        bookUpdate: { previewPdfUrl: '/files/books/b-1/storybook.pdf' },
        agentLogs: [],
        ...overrides,
      };
    }

    function failedOutcome(overrides: Partial<GenerationOutcome> = {}): GenerationOutcome {
      return {
        status: 'failed' as GenerationOutcome['status'],
        completedStep: 'pdf_render' as GenerationOutcome['completedStep'],
        errorCode: 'GENERATION_FAILED',
        errorMessage: 'boom',
        failedStep: 'pdf_render' as GenerationOutcome['failedStep'],
        bookUpdate: {},
        agentLogs: [],
        ...overrides,
      };
    }

    /** One representative AgentLog row for `bookId`, tagged with `traceId` so a test can identify exactly which attempt's row (if any) actually made it into the DB. */
    function agentLogRow(bookId: string, traceId: string): Prisma.AgentLogCreateManyInput {
      return {
        bookId,
        agent: 'LocalPipelineAgent',
        step: AgentStep.pdf_render,
        status: AgentLogStatus.success,
        attempt: 1,
        traceId,
      };
    }

    it('returns "stale_fence", leaves Book and GenerationRun completely untouched, and persists zero AgentLog rows when the fencing guard fails inside the transaction', async () => {
      const book = await createUserAndBook();
      const run = await createRun(book, { fencingVersion: 3 });

      const result = await coordinator.completeRun(
        {
          runId: run.id,
          bookId: book.id,
          fencingVersion: 999,
          inputHash: run.inputHash,
          inputSnapshot: buildInputSnapshot(book),
        },
        completedOutcome({ agentLogs: [agentLogRow(book.id, 'trace-stale-fence')] }),
      );

      expect(result).toBe('stale_fence');
      const reloadedBook = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
      expect(reloadedBook.activeRunId).toBe(run.id); // unchanged
      expect(reloadedBook.publishedRunId).toBeNull();
      expect(reloadedBook.publishedRunFencingVersion).toBeNull();
      expect(reloadedBook.status).not.toBe('complete');
      const reloadedRun = await prisma.generationRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(reloadedRun.status).toBe(GenerationRunStatus.running);
      const logs = await prisma.agentLog.findMany({ where: { bookId: book.id } });
      expect(logs).toHaveLength(0);
    });

    it("a claim reclaimed by a newer delivery (fencingVersion bumped) rejects the old claim's completeRun with zero AgentLog rows written, then the newer claim's own completion persists only its own AgentLog rows — proven against the real DB, not just the in-process return value", async () => {
      const book = await createUserAndBook();
      const run = await createRun(book, {
        fencingVersion: 1,
        leaseOwner: 'worker-a',
        deliveryToken: 'delivery-token-a',
      });
      const runService = new GenerationRunService(prisma);
      const staleCtx = {
        runId: run.id,
        bookId: book.id,
        fencingVersion: run.fencingVersion,
        inputHash: run.inputHash,
        inputSnapshot: buildInputSnapshot(book),
      };

      // A newer delivery reclaims the run — a stalled-job redelivery or
      // recovery reclaim — before worker-a's own in-flight pipeline attempt
      // has finished, bumping fencingVersion out from under it.
      const reclaimed = await runService.claim(run.id, 'token-b', 'worker-b', 60_000);
      expect(reclaimed?.fencingVersion).toBe(2);

      // worker-a's pipeline finishes and calls completeRun with the AgentLog
      // rows it built from the fencingVersion=1 context it originally
      // observed at claim time — its fencing check must fail before any of
      // those rows are ever inserted.
      const staleResult = await coordinator.completeRun(
        staleCtx,
        completedOutcome({ agentLogs: [agentLogRow(book.id, 'trace-stale-worker-a')] }),
      );
      expect(staleResult).toBe('stale_fence');
      const logsAfterStale = await prisma.agentLog.findMany({ where: { bookId: book.id } });
      expect(logsAfterStale).toHaveLength(0);

      // worker-b's own (current) claim then completes normally — its logs,
      // and only its logs, are the ones that persist.
      const currentCtx = {
        runId: run.id,
        bookId: book.id,
        fencingVersion: 2,
        inputHash: run.inputHash,
        inputSnapshot: buildInputSnapshot(book),
      };
      const currentResult = await coordinator.completeRun(
        currentCtx,
        completedOutcome({ agentLogs: [agentLogRow(book.id, 'trace-current-worker-b')] }),
      );
      expect(currentResult).toBe('applied');
      const logsAfterCurrent = await prisma.agentLog.findMany({ where: { bookId: book.id } });
      expect(logsAfterCurrent).toHaveLength(1);
      expect(logsAfterCurrent[0]?.traceId).toBe('trace-current-worker-b');
    });

    it('leaves an existing published pointer untouched when a later regeneration attempt fails on a stale fence', async () => {
      const priorRunId = randomUUID();
      const book = await createUserAndBook({
        status: 'complete',
        publishedRunId: priorRunId,
        publishedRunFencingVersion: 5,
      });
      const run = await createRun(book, { fencingVersion: 3 });

      const result = await coordinator.completeRun(
        {
          runId: run.id,
          bookId: book.id,
          fencingVersion: 999,
          inputHash: run.inputHash,
          inputSnapshot: buildInputSnapshot(book),
        },
        completedOutcome(),
      );

      expect(result).toBe('stale_fence');
      const reloadedBook = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
      expect(reloadedBook.publishedRunId).toBe(priorRunId);
      expect(reloadedBook.publishedRunFencingVersion).toBe(5);
    });

    it('returns "book_mirror_mismatch" and rolls back the ENTIRE transaction (GenerationRun AND the AgentLog insert included, provably still `running`/absent in the DB), leaving both published pointer fields untouched, when the run fence holds but Book.activeRunId has drifted', async () => {
      const book = await createUserAndBook();
      const run = await createRun(book, { fencingVersion: 3 });
      // Break the mirror invariant directly, simulating some other bug having
      // already cleared/repointed activeRunId while this run's own fencing
      // still legitimately holds.
      await prisma.book.update({ where: { id: book.id }, data: { activeRunId: null } });

      const result = await coordinator.completeRun(
        {
          runId: run.id,
          bookId: book.id,
          fencingVersion: 3,
          inputHash: run.inputHash,
          inputSnapshot: buildInputSnapshot(book),
        },
        completedOutcome({ agentLogs: [agentLogRow(book.id, 'trace-mirror-mismatch')] }),
      );

      expect(result).toBe('book_mirror_mismatch');
      // Proves a real rollback, not just "the Book write didn't happen" —
      // GenerationRun's own terminal transition, which happened earlier in
      // the same transaction, must have been undone too.
      const reloadedRun = await prisma.generationRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(reloadedRun.status).toBe(GenerationRunStatus.running);
      const reloadedBook = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
      expect(reloadedBook.status).not.toBe('complete');
      expect(reloadedBook.publishedRunId).toBeNull();
      expect(reloadedBook.publishedRunFencingVersion).toBeNull();
      // The AgentLog insert is the last statement in the transaction — never
      // reached at all here (the throw happens before it), but this also
      // proves the transaction genuinely rolled back rather than partially
      // committing, for the one write type that comes last.
      const logs = await prisma.agentLog.findMany({ where: { bookId: book.id } });
      expect(logs).toHaveLength(0);
    });

    it('atomically publishes Book.status=complete, GenerationRun.status=completed, activeRunId, publishedRunId, publishedRunFencingVersion, AND the outcome.agentLogs rows together on success', async () => {
      const book = await createUserAndBook();
      const run = await createRun(book, { fencingVersion: 3 });

      const result = await coordinator.completeRun(
        {
          runId: run.id,
          bookId: book.id,
          fencingVersion: 3,
          inputHash: run.inputHash,
          inputSnapshot: buildInputSnapshot(book),
        },
        completedOutcome({ agentLogs: [agentLogRow(book.id, 'trace-applied-success')] }),
      );

      expect(result).toBe('applied');
      const reloadedBook = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
      expect(reloadedBook.activeRunId).toBeNull();
      expect(reloadedBook.publishedRunId).toBe(run.id);
      expect(reloadedBook.publishedRunFencingVersion).toBe(3);
      expect(reloadedBook.status).toBe('complete');
      expect(reloadedBook.previewPdfUrl).toBe('/files/books/b-1/storybook.pdf');
      const logs = await prisma.agentLog.findMany({ where: { bookId: book.id } });
      expect(logs).toHaveLength(1);
      expect(logs[0]?.traceId).toBe('trace-applied-success');
      const reloadedRun = await prisma.generationRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(reloadedRun.status).toBe(GenerationRunStatus.completed);
    });

    it('atomically publishes Book.status=failed with errorMessage/failedStep alongside GenerationRun.status=failed', async () => {
      const book = await createUserAndBook();
      const run = await createRun(book, { fencingVersion: 1 });

      const result = await coordinator.completeRun(
        {
          runId: run.id,
          bookId: book.id,
          fencingVersion: 1,
          inputHash: run.inputHash,
          inputSnapshot: buildInputSnapshot(book),
        },
        failedOutcome({ errorMessage: 'PDF render crashed' }),
      );

      expect(result).toBe('applied');
      const reloadedBook = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
      expect(reloadedBook.status).toBe('failed');
      expect(reloadedBook.errorMessage).toBe('PDF render crashed');
      expect(reloadedBook.failedStep).toBe('pdf_render');
      expect(reloadedBook.activeRunId).toBeNull();
      expect(reloadedBook.publishedRunId).toBeNull(); // never set on failure
      expect(reloadedBook.publishedRunFencingVersion).toBeNull(); // never set on failure
      const reloadedRun = await prisma.generationRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(reloadedRun.status).toBe(GenerationRunStatus.failed);
      expect(reloadedRun.errorMessage).toBe('PDF render crashed');
    });

    it('failInvalidSnapshot atomically fails Book and GenerationRun with the stable GENERATION_INPUT_SNAPSHOT_INVALID code', async () => {
      const book = await createUserAndBook();
      const run = await createRun(book, { fencingVersion: 2 });

      const result = await coordinator.failInvalidSnapshot(
        { runId: run.id, bookId: book.id, fencingVersion: 2 },
        'safe public message',
      );

      expect(result).toBe('applied');
      const reloadedBook = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
      expect(reloadedBook.status).toBe('failed');
      expect(reloadedBook.errorMessage).toBe('safe public message');
      expect(reloadedBook.activeRunId).toBeNull();
      const reloadedRun = await prisma.generationRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(reloadedRun.status).toBe(GenerationRunStatus.failed);
      expect(reloadedRun.errorCode).toBe('GENERATION_INPUT_SNAPSHOT_INVALID');
    });

    it('failInvalidSnapshot is a no-op when the fencing guard finds the run already superseded', async () => {
      const book = await createUserAndBook();
      const run = await createRun(book, { fencingVersion: 2 });

      const result = await coordinator.failInvalidSnapshot(
        { runId: run.id, bookId: book.id, fencingVersion: 999 },
        'safe public message',
      );

      expect(result).toBe('stale_fence');
      const reloadedRun = await prisma.generationRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(reloadedRun.status).toBe(GenerationRunStatus.running);
    });

    it('failAbandoned atomically fails Book and GenerationRun (fenced on fromStatus="running") — the mechanism BooksService.markRunPermanentlyFailedAfterExhaustedRetries uses', async () => {
      const book = await createUserAndBook();
      const run = await createRun(book, { fencingVersion: 2 });

      const result = await coordinator.failAbandoned(
        {
          runId: run.id,
          bookId: book.id,
          fencingVersion: 2,
          fromStatus: GenerationRunStatus.running,
        },
        {
          errorCode: 'GENERATION_INFRASTRUCTURE_FAILURE',
          errorMessage: 'Generation failed after repeated errors.',
        },
      );

      expect(result).toBe('applied');
      const reloadedBook = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
      expect(reloadedBook.status).toBe('failed');
      expect(reloadedBook.activeRunId).toBeNull();
      const reloadedRun = await prisma.generationRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(reloadedRun.status).toBe(GenerationRunStatus.failed);
      expect(reloadedRun.errorCode).toBe('GENERATION_INFRASTRUCTURE_FAILURE');
    });

    it('failAbandoned fences on fromStatus="queued" for a never-claimed run — the mechanism GenerationRunRecoveryService uses for a run stuck before dispatch', async () => {
      const book = await createUserAndBook();
      const run = await prisma.generationRun.create({
        data: {
          bookId: book.id,
          userId: book.userId,
          kind: 'initial',
          status: GenerationRunStatus.queued,
          inputSnapshot: buildInputSnapshot(book) as unknown as Prisma.InputJsonValue,
          inputHash: hashInputSnapshot(buildInputSnapshot(book)),
          fencingVersion: 0,
        },
      });
      await prisma.book.update({ where: { id: book.id }, data: { activeRunId: run.id } });

      const result = await coordinator.failAbandoned(
        {
          runId: run.id,
          bookId: book.id,
          fencingVersion: 0,
          fromStatus: GenerationRunStatus.queued,
        },
        { errorCode: 'GENERATION_ABANDONED', errorMessage: 'Generation was interrupted.' },
      );

      expect(result).toBe('applied');
      const reloadedRun = await prisma.generationRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(reloadedRun.status).toBe(GenerationRunStatus.failed);
    });

    it("genuinely concurrent completeRun calls racing on the exact same fencingVersion (fired together via Promise.all — real overlapping transactions, not sequenced by the test) let exactly one win, via Postgres's own row-lock + WHERE re-check, not application-level ordering", async () => {
      const book = await createUserAndBook();
      const run = await createRun(book, { fencingVersion: 4 });
      const ctxA = {
        runId: run.id,
        bookId: book.id,
        fencingVersion: 4,
        inputHash: run.inputHash,
        inputSnapshot: buildInputSnapshot(book),
      };
      const ctxB = { ...ctxA };

      // Both calls observe the identical, currently-valid fencingVersion and
      // are dispatched together — genuinely concurrent from Node's
      // perspective, each on its own pooled connection — rather than
      // sequenced one after the other. Whichever transaction's UPDATE
      // commits first flips GenerationRun to `completed`; the other's WHERE
      // `status: running` then no longer matches, however narrowly it loses
      // the race, because Postgres re-evaluates the WHERE clause against the
      // row's actual current state at execution time, not a stale snapshot.
      const [resultA, resultB] = await Promise.all([
        coordinator.completeRun(
          ctxA,
          completedOutcome({ bookUpdate: { title: 'From attempt A' } }),
        ),
        coordinator.completeRun(
          ctxB,
          completedOutcome({ bookUpdate: { title: 'From attempt B' } }),
        ),
      ]);

      expect([resultA, resultB].filter((result) => result === 'applied')).toHaveLength(1);
      expect([resultA, resultB].filter((result) => result === 'stale_fence')).toHaveLength(1);

      const reloadedBook = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
      const reloadedRun = await prisma.generationRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(reloadedBook.status).toBe('complete');
      expect(['From attempt A', 'From attempt B']).toContain(reloadedBook.title);
      expect(reloadedRun.status).toBe(GenerationRunStatus.completed);
    });
  });

  describe('GenerationRunRecoveryService — RecoveryLease leadership across two instances (deterministic, barrier-driven — no Promise-timing races)', () => {
    /**
     * acquireLease/stillHoldsLease are private — accessed directly here (not
     * through the public recover() entry point) so each step below can be
     * awaited and asserted on in a fixed, deterministic order instead of
     * firing two real concurrent recover() calls and hoping their
     * interleaving comes out a particular way (see the Promise.all version
     * this replaced). This is what "barrier-driven" means in practice: every
     * transition — A acquires, the lease is force-expired, B acquires — is
     * an explicit, awaited step, not a race.
     */
    type LeaseInternals = {
      acquireLease(leaseMs: number): Promise<number | null>;
      stillHoldsLease(generation: number): Promise<boolean>;
    };

    let prismaA: PrismaService;
    let prismaB: PrismaService;

    beforeEach(async () => {
      prismaA = new PrismaService();
      prismaB = new PrismaService();
      await prismaA.$connect();
      await prismaB.$connect();
      // Every test in this describe block starts from a clean, available lease.
      await prisma.recoveryLease.update({
        where: { id: 'generation_run_recovery' },
        data: { leaseOwner: null, leaseExpiresAt: null },
      });
    });

    afterEach(async () => {
      await prismaA.$disconnect();
      await prismaB.$disconnect();
    });

    it('a second instance cannot acquire while the first still holds a live (non-expired) lease', async () => {
      const neverPendingQueue = { isJobStillPending: async () => false } as never;
      const serviceA = new GenerationRunRecoveryService(
        prismaA,
        neverPendingQueue,
        new GenerationRunCoordinator(prismaA, new CreditsService(prismaA)),
      ) as unknown as LeaseInternals;
      const serviceB = new GenerationRunRecoveryService(
        prismaB,
        neverPendingQueue,
        new GenerationRunCoordinator(prismaB, new CreditsService(prismaB)),
      ) as unknown as LeaseInternals;

      const generationA = await serviceA.acquireLease(60_000);
      expect(generationA).not.toBeNull();

      const generationB = await serviceB.acquireLease(60_000);

      expect(generationB).toBeNull();
    });

    it("a new instance acquires once the lease has expired, monotonically bumping the fencing generation — and the former leader's stale generation is no longer valid", async () => {
      const neverPendingQueue = { isJobStillPending: async () => false } as never;
      const serviceA = new GenerationRunRecoveryService(
        prismaA,
        neverPendingQueue,
        new GenerationRunCoordinator(prismaA, new CreditsService(prismaA)),
      ) as unknown as LeaseInternals;
      const serviceB = new GenerationRunRecoveryService(
        prismaB,
        neverPendingQueue,
        new GenerationRunCoordinator(prismaB, new CreditsService(prismaB)),
      ) as unknown as LeaseInternals;

      const generationA = await serviceA.acquireLease(60_000);
      expect(generationA).not.toBeNull();
      expect(await serviceA.stillHoldsLease(generationA!)).toBe(true);

      // Deterministically force the lease to look expired — using
      // PostgreSQL's own server time, matching how acquireLease itself
      // compares expiry — rather than waiting out a real TTL.
      await prisma.$executeRaw`
        UPDATE recovery_leases SET lease_expires_at = NOW() - interval '1 second'
        WHERE id = 'generation_run_recovery'
      `;

      const generationB = await serviceB.acquireLease(60_000);

      expect(generationB).toBe(generationA! + 1);
      // (d)/(e)-equivalent for recovery leadership: the former leader's
      // generation-fenced check now fails — it must never continue issuing
      // recovery writes, even though its own in-process wall-clock check
      // hasn't necessarily caught up yet.
      expect(await serviceA.stillHoldsLease(generationA!)).toBe(false);
      expect(await serviceB.stillHoldsLease(generationB!)).toBe(true);
    });
  });

  describe('GenerationInputSnapshot JSONB round-trip fidelity', () => {
    it('preserves the exact prior input (including a nested childPhoto identity) through real Postgres storage — the basis for retry-after-edit correctness', async () => {
      const book = await createUserAndBook({
        childPhotoAssetKey: 'b-1/child-photo-v1',
        childPhotoContentType: 'image/jpeg',
        childPhotoSha256: 'a'.repeat(64),
        childPhotoSizeBytes: 1024,
      });
      const snapshot = buildInputSnapshot(book);
      const run = await prisma.generationRun.create({
        data: {
          bookId: book.id,
          userId: book.userId,
          kind: 'initial',
          inputSnapshot: snapshot as unknown as Prisma.InputJsonValue,
          inputHash: hashInputSnapshot(snapshot),
        },
      });

      // Simulate an edit to the book's live fields after the run was created —
      // retryGeneration must still resolve to the frozen snapshot, not this.
      await prisma.book.update({
        where: { id: book.id },
        data: { theme: 'edited-after-snapshot' },
      });

      const reloadedRun = await prisma.generationRun.findUniqueOrThrow({ where: { id: run.id } });
      const parsed = parseGenerationInputSnapshot(reloadedRun.id, reloadedRun.inputSnapshot);

      expect(parsed).toEqual(snapshot);
      expect(parsed.theme).toBe('friendship'); // not the post-edit 'edited-after-snapshot'
      expect(parsed.childPhoto).toEqual({
        assetKey: 'b-1/child-photo-v1',
        sha256: 'a'.repeat(64),
        contentType: 'image/jpeg',
        sizeBytes: 1024,
      });
    });

    it('a child-photo re-upload produces a distinct snapshot/hash even with identical other fields', async () => {
      const bookV1 = await createUserAndBook({
        childPhotoAssetKey: 'b-1/child-photo-v1',
        childPhotoContentType: 'image/jpeg',
        childPhotoSha256: 'a'.repeat(64),
        childPhotoSizeBytes: 1024,
      });
      const snapshotV1 = buildInputSnapshot(bookV1);

      // Re-upload: a new versioned key/digest, everything else identical.
      const bookV2 = await prisma.book.update({
        where: { id: bookV1.id },
        data: {
          childPhotoAssetKey: 'b-1/child-photo-v2',
          childPhotoSha256: 'b'.repeat(64),
        },
      });
      const snapshotV2 = buildInputSnapshot(bookV2);

      expect(hashInputSnapshot(snapshotV1)).not.toBe(hashInputSnapshot(snapshotV2));
    });
  });

  describe('GenerationInputSnapshotBackfillService — legacy pre-Phase-A snapshot migration', () => {
    const backfill = new GenerationInputSnapshotBackfillService(
      prisma,
      new LocalImageAssetStorage(),
    );

    /** The exact pre-Phase-A GenerationRun.input_snapshot JSON shape — no snapshotVersion, a bare childPhotoAssetKey/childPhotoContentType rather than childPhoto's full versioned identity object (predates Book.childPhotoSha256/childPhotoSizeBytes existing at all). */
    function preExistingPhaseASnapshotFixture(overrides: Record<string, unknown> = {}) {
      return {
        childName: 'Mia',
        childAge: 5,
        language: 'en',
        theme: 'friendship',
        educationalMessage: null,
        pageCount: 6,
        childPhotoAssetKey: null,
        childPhotoContentType: null,
        ...overrides,
      };
    }

    it('migrates a legacy run with no photo in place and persists the migrated snapshot back to the row', async () => {
      const book = await createUserAndBook();
      const run = await prisma.generationRun.create({
        data: {
          bookId: book.id,
          userId: book.userId,
          kind: 'initial',
          status: GenerationRunStatus.queued,
          inputSnapshot: preExistingPhaseASnapshotFixture() as unknown as Prisma.InputJsonValue,
          inputHash: 'legacy-hash',
        },
      });

      const migrated = await backfill.normalize(run);

      expect(migrated.snapshot.snapshotVersion).toBe(2);
      expect(migrated.snapshot.childPhoto).toBeNull();
      expect(migrated.inputHash).toBe(hashInputSnapshot(migrated.snapshot));
      expect(migrated.inputHash).not.toBe('legacy-hash');
      const reloaded = await prisma.generationRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(reloaded.inputSnapshot).toEqual(migrated.snapshot);
      // The snapshot/hash invariant this migration must maintain — see
      // GenerationInputSnapshotBackfillService's own doc comment.
      expect(reloaded.inputHash).toBe(migrated.inputHash);
      // Deployment safety: the migration only ever touches inputSnapshot/
      // inputHash — status/fencing are provably untouched by it.
      expect(reloaded.status).toBe(GenerationRunStatus.queued);
    });

    it('migrates a legacy run with a photo: reads the real bytes from LocalImageAssetStorage, mints a fresh versioned copy, and never touches the original key', async () => {
      const storage = new LocalImageAssetStorage();
      const originalKey = `backfill-fixture-${randomUUID()}/child-photo-legacy`;
      const bytes = Buffer.from('real legacy photo bytes for backfill integration test');
      await storage.saveImageAsset(originalKey, bytes, 'image/jpeg');
      const localBackfill = new GenerationInputSnapshotBackfillService(prisma, storage);

      const book = await createUserAndBook();
      const run = await prisma.generationRun.create({
        data: {
          bookId: book.id,
          userId: book.userId,
          kind: 'initial',
          status: GenerationRunStatus.failed,
          failedAt: new Date(),
          inputSnapshot: preExistingPhaseASnapshotFixture({
            childPhotoAssetKey: originalKey,
            childPhotoContentType: 'image/jpeg',
          }) as unknown as Prisma.InputJsonValue,
          inputHash: 'legacy-hash',
        },
      });

      const migrated = await localBackfill.normalize(run);

      expect(migrated.snapshot.childPhoto).not.toBeNull();
      expect(migrated.snapshot.childPhoto!.assetKey).not.toBe(originalKey);
      expect(migrated.snapshot.childPhoto!.sizeBytes).toBe(bytes.length);
      expect(migrated.inputHash).toBe(hashInputSnapshot(migrated.snapshot));
      // The original key's bytes are untouched — the migration mints a copy, never mutates in place.
      const originalStillThere = await storage.getImageAsset(originalKey);
      expect(originalStillThere).toEqual(bytes);
      const migratedBytes = await storage.getImageAsset(migrated.snapshot.childPhoto!.assetKey);
      expect(migratedBytes).toEqual(bytes);
      // Deployment safety: a run already terminal (failed) is still migrated cleanly.
      const reloaded = await prisma.generationRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(reloaded.status).toBe(GenerationRunStatus.failed);
    });

    it('is a safe no-op re-migration: normalizing an already-current snapshot a second time makes no further DB write', async () => {
      const book = await createUserAndBook();
      const run = await prisma.generationRun.create({
        data: {
          bookId: book.id,
          userId: book.userId,
          kind: 'initial',
          status: GenerationRunStatus.completed,
          completedAt: new Date(),
          inputSnapshot: preExistingPhaseASnapshotFixture() as unknown as Prisma.InputJsonValue,
          inputHash: 'legacy-hash',
        },
      });

      const firstPass = await backfill.normalize(run);
      const reloadedAfterFirst = await prisma.generationRun.findUniqueOrThrow({
        where: { id: run.id },
      });
      const secondPass = await backfill.normalize(reloadedAfterFirst);

      expect(secondPass).toEqual(firstPass);
    });

    it('genuinely concurrent normalize() calls on the SAME legacy run (fired together via Promise.all, real overlapping transactions) converge on exactly one migration — no last-write-wins split between inputSnapshot and inputHash', async () => {
      const storage = new LocalImageAssetStorage();
      const originalKey = `backfill-race-fixture-${randomUUID()}/child-photo-legacy`;
      const bytes = Buffer.from('legacy photo bytes raced by two concurrent migrators');
      await storage.saveImageAsset(originalKey, bytes, 'image/jpeg');
      const backfillA = new GenerationInputSnapshotBackfillService(prisma, storage);
      const backfillB = new GenerationInputSnapshotBackfillService(prisma, storage);

      const book = await createUserAndBook();
      const run = await prisma.generationRun.create({
        data: {
          bookId: book.id,
          userId: book.userId,
          kind: 'initial',
          status: GenerationRunStatus.failed,
          failedAt: new Date(),
          inputSnapshot: preExistingPhaseASnapshotFixture({
            childPhotoAssetKey: originalKey,
            childPhotoContentType: 'image/jpeg',
          }) as unknown as Prisma.InputJsonValue,
          inputHash: 'legacy-hash',
        },
      });

      // Two independent service instances, each starting from the identical
      // pre-migration row, racing to migrate it — genuinely concurrent from
      // Node's perspective, not sequenced.
      const [resultA, resultB] = await Promise.all([
        backfillA.normalize(run),
        backfillB.normalize(run),
      ]);

      // Both callers converge on the same winning migration — one CAS write
      // won, the other detected the loss and re-read/returned the winner's
      // result, rather than each trusting its own locally-computed copy.
      expect(resultA).toEqual(resultB);
      expect(resultA.inputHash).toBe(hashInputSnapshot(resultA.snapshot));

      // The persisted row is self-consistent (never a torn mix of one
      // racer's snapshot with the other's hash).
      const reloaded = await prisma.generationRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(reloaded.inputSnapshot).toEqual(resultA.snapshot);
      expect(reloaded.inputHash).toBe(resultA.inputHash);

      // The legacy photo itself is never lost — whichever versioned copy the
      // final row references still resolves to the original bytes.
      const winningBytes = await storage.getImageAsset(resultA.snapshot.childPhoto!.assetKey);
      expect(winningBytes).toEqual(bytes);
    });
  });

  describe('Legacy migration after a run already produced resumable Book state (retry-after-layout-failure resume)', () => {
    const backfill = new GenerationInputSnapshotBackfillService(
      prisma,
      new LocalImageAssetStorage(),
    );

    /** The exact pre-Phase-A GenerationRun.input_snapshot JSON shape — see the sibling describe block above. */
    function legacySnapshotFixture(overrides: Record<string, unknown> = {}) {
      return {
        childName: 'Mia',
        childAge: 5,
        language: 'en',
        theme: 'friendship',
        educationalMessage: null,
        pageCount: 6,
        childPhotoAssetKey: null,
        childPhotoContentType: null,
        ...overrides,
      };
    }

    it('migrates Book.lastGenerationInputHash in lockstep with a terminal legacy run, so a same-input retry can still resume', async () => {
      // A legacy run reached the layout phase (Book got its resumable
      // fields, and Book.lastGenerationInputHash was stamped with this run's
      // then-legacy inputHash) before later failing at a later step.
      const legacyHash = 'legacy-hash-from-original-run';
      const book = await createUserAndBook({
        status: 'failed',
        lastGenerationInputHash: legacyHash,
        storyPlan: { pages: ['once upon a time'] },
        characterCard: { description: 'a brave child' },
        bookPreview: { coverText: 'Mia the brave' },
        imageGenerationResult: { images: [] },
      });
      const legacyRun = await prisma.generationRun.create({
        data: {
          bookId: book.id,
          userId: book.userId,
          kind: 'initial',
          status: GenerationRunStatus.failed,
          failedAt: new Date(),
          inputSnapshot: legacySnapshotFixture() as unknown as Prisma.InputJsonValue,
          inputHash: legacyHash,
        },
      });

      // retryGeneration's real first step: normalize() the terminal legacy
      // run before building the retry's own snapshot/hash.
      const normalized = await backfill.normalize(legacyRun);

      // What createRunAndSchedule always does for a retry run: recompute the
      // hash fresh from the (now-migrated) snapshot it was handed.
      const retryRunInputHash = hashInputSnapshot(normalized.snapshot);
      expect(retryRunInputHash).toBe(normalized.inputHash);

      const reloadedBook = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
      // The exact condition AgentService.isResumableBook checks — without
      // the Book-mirror migration this stays the stale legacy hash forever,
      // never equal to any future retry's freshly-computed hash.
      expect(reloadedBook.lastGenerationInputHash).toBe(retryRunInputHash);
      expect(reloadedBook.lastGenerationInputHash).not.toBe(legacyHash);
      // The resumable fields themselves are untouched by the migration.
      expect(reloadedBook.storyPlan).toEqual({ pages: ['once upon a time'] });
      expect(reloadedBook.characterCard).toEqual({ description: 'a brave child' });
      expect(reloadedBook.bookPreview).toEqual({ coverText: 'Mia the brave' });
      expect(reloadedBook.imageGenerationResult).toEqual({ images: [] });
    });

    it('leaves Book.lastGenerationInputHash untouched when it was stamped by a different run than the one being migrated', async () => {
      const someOtherRunsHash = 'hash-from-a-later-run-that-also-reached-layout';
      const book = await createUserAndBook({
        status: 'failed',
        lastGenerationInputHash: someOtherRunsHash,
      });
      const legacyRun = await prisma.generationRun.create({
        data: {
          bookId: book.id,
          userId: book.userId,
          kind: 'initial',
          status: GenerationRunStatus.failed,
          failedAt: new Date(),
          inputSnapshot: legacySnapshotFixture() as unknown as Prisma.InputJsonValue,
          inputHash: 'this-runs-own-legacy-hash',
        },
      });

      await backfill.normalize(legacyRun);

      const reloadedBook = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
      expect(reloadedBook.lastGenerationInputHash).toBe(someOtherRunsHash);
    });
  });
});
