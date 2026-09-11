import { Injectable } from '@nestjs/common';
import { AgentStep, GenerationRunStatus, Prisma, type Book } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import type { GenerationExecutionContext } from './generation-execution-context';
import type { ExecutionAuthorization, ExecutionPolicy } from './generation-execution-policy';
import { assertAuthorizedOperations } from './generation-execution-policy';
import type { GenerationProviderCallMetadata } from '@book/types';
import { throwIfAborted } from '../common/provider-execution';

/**
 * Thrown by applyFencedBookWrite when the calling attempt no longer owns its
 * GenerationRun — a newer claim (a different worker's legitimate BullMQ
 * redelivery) or recovery already superseded it. Callers must treat this as
 * "abandon quietly," never as a reason to rethrow/retry: retrying would only
 * race the attempt that actually owns the run now.
 */
export class StaleGenerationRunError extends Error {
  constructor(runId: string, step: AgentStep) {
    super(`GenerationRun ${runId} is no longer owned by this attempt (step ${step}) — abandoning.`);
    this.name = 'StaleGenerationRunError';
  }
}

/**
 * The single choke point every pipeline mutation to a Book must go through
 * while a GenerationRun is executing (see AgentService). Replaces the old
 * pattern of unguarded `prisma.book.update({ where: { id } })` calls, which
 * had no way to detect that a newer attempt had already reclaimed the run.
 */
@Injectable()
export class GenerationExecutionService {
  constructor(private readonly prisma: PrismaService) {}

  async authorize(
    ctx: GenerationExecutionContext,
    authorization: ExecutionAuthorization,
  ): Promise<void> {
    // Add a conservative worker authorization to legacy queued runs exactly once.
    const result = await this.prisma.generationRun.updateMany({
      where: {
        id: ctx.runId,
        status: 'running',
        fencingVersion: ctx.fencingVersion,
        executionAuthorization: { equals: Prisma.DbNull },
      },
      data: {
        executionAuthorization: JSON.parse(JSON.stringify(authorization)) as Prisma.InputJsonValue,
      },
    });
    if (!result.count) await this.assertOwnership(ctx);
  }

  async assertOwnership(ctx: GenerationExecutionContext): Promise<void> {
    throwIfAborted(ctx.signal);
    const owned = await this.prisma.generationRun.updateMany({
      where: { id: ctx.runId, status: 'running', fencingVersion: ctx.fencingVersion },
      data: { updatedAt: new Date() },
    });
    if (!owned.count) throw new StaleGenerationRunError(ctx.runId, AgentStep.image_gen);
  }

  async checkpoint(
    ctx: GenerationExecutionContext,
    fingerprint: string,
    content: Record<string, unknown>,
    artifacts: Record<string, unknown> = {},
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const owned = await tx.generationRun.updateMany({
        where: { id: ctx.runId, status: 'running', fencingVersion: ctx.fencingVersion },
        data: { updatedAt: new Date() },
      });
      if (!owned.count) throw new StaleGenerationRunError(ctx.runId, AgentStep.image_gen);
      const book = await tx.book.findUniqueOrThrow({ where: { id: ctx.bookId } });
      const prior = book.generationCheckpoint as Record<string, unknown> | null;
      const same = prior?.runId === ctx.runId && prior?.fencingVersion === ctx.fencingVersion;
      await tx.book.update({
        where: { id: ctx.bookId },
        data: {
          lastGenerationRunId: ctx.runId,
          lastGenerationFencingVersion: ctx.fencingVersion,
          lastGenerationInputHash: ctx.inputHash,
          lastGenerationCompatibilityFingerprint: fingerprint,
          generationCheckpoint: JSON.parse(
            JSON.stringify({
              version: 1,
              inputHash: ctx.inputHash,
              compatibilityFingerprint: fingerprint,
              runId: ctx.runId,
              fencingVersion: ctx.fencingVersion,
              content: { ...(same ? (prior?.content as object) : {}), ...content },
              artifacts: { ...(same ? (prior?.artifacts as object) : {}), ...artifacts },
            }),
          ) as Prisma.InputJsonValue,
        },
      });
    });
  }

  /** Locks the durable run before reserving; redeliveries share the same ledger. */
  async reserveOperation(
    ctx: GenerationExecutionContext,
    policy: ExecutionPolicy,
    call: Omit<GenerationProviderCallMetadata, 'status' | 'durationMs'>,
  ): Promise<number> {
    throwIfAborted(ctx.signal);
    return this.prisma.$transaction(async (tx) => {
      const owned = await tx.generationRun.updateMany({
        where: { id: ctx.runId, status: 'running', fencingVersion: ctx.fencingVersion },
        data: { updatedAt: new Date() },
      });
      if (!owned.count) throw new StaleGenerationRunError(ctx.runId, AgentStep.image_gen);
      const run = await tx.generationRun.findUniqueOrThrow({ where: { id: ctx.runId } });
      const operations = (Array.isArray(run.providerOperations)
        ? run.providerOperations
        : []) as unknown as Array<Record<string, unknown>>;
      const previous = operations.filter(
        (op) => op.operation === call.operation && op.assetLabel === call.assetLabel,
      );
      if (previous.length >= (call.operation === 'story_repair' ? 1 : 2))
        throw new Error('PROVIDER_OPERATION_RETRY_LIMIT');
      const paid = operations.filter((op) => op.provider === 'openai');
      const authorization = run.executionAuthorization as unknown as ExecutionAuthorization | null;
      assertAuthorizedOperations(authorization, [...operations, { ...call }]);
      if (call.provider === 'openai') {
        const limit = Math.min(
          policy.maxPaidCalls,
          policy.limits.maxProviderCalls,
          authorization?.estimate.maximumProviderCalls ?? policy.limits.maxProviderCalls,
        );
        if (paid.reduce((sum, op) => sum + Math.max(1, Number(op.httpAttempts ?? 0)), 0) >= limit)
          throw new Error('GENERATION_HARD_BUDGET_EXCEEDED');
        const costLimit =
          authorization?.estimate.estimatedCostUsd?.maximum ?? policy.limits.maxEstimatedCostUsd;
        if (
          costLimit !== undefined &&
          (call.estimatedCostUsd === undefined ||
            paid.some((op) => op.estimatedCostUsd === undefined) ||
            paid.reduce(
              (sum, op) =>
                sum + Number(op.estimatedCostUsd ?? 0) * Math.max(1, Number(op.httpAttempts ?? 0)),
              0,
            ) +
              call.estimatedCostUsd >
              costLimit + 1e-9)
        )
          throw new Error('GENERATION_HARD_BUDGET_EXCEEDED');
      }
      // A prior in-flight dispatch has an unknown remote outcome, never a free retry.
      for (const op of operations)
        if (op.state === 'reserved' && op.fencingVersion !== ctx.fencingVersion)
          op.state = 'unknown';
      const index = operations.length;
      operations.push({
        ...call,
        fencingVersion: ctx.fencingVersion,
        attempt: previous.length + 1,
        state: 'reserved',
      });
      await tx.generationRun.update({
        where: { id: ctx.runId },
        data: {
          providerOperations: JSON.parse(JSON.stringify(operations)) as Prisma.InputJsonValue,
        },
      });
      return index;
    });
  }

  async finishOperation(
    ctx: GenerationExecutionContext,
    index: number,
    state: 'provider_succeeded' | 'unknown' | 'failed',
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const owned = await tx.generationRun.updateMany({
        where: { id: ctx.runId, status: 'running', fencingVersion: ctx.fencingVersion },
        data: { updatedAt: new Date() },
      });
      if (!owned.count) throw new StaleGenerationRunError(ctx.runId, AgentStep.image_gen);
      const run = await tx.generationRun.findUniqueOrThrow({ where: { id: ctx.runId } });
      const operations = run.providerOperations as unknown as Array<Record<string, unknown>>;
      operations[index] = { ...operations[index], state };
      await tx.generationRun.update({
        where: { id: ctx.runId },
        data: { providerOperations: operations as Prisma.InputJsonValue },
      });
    });
  }

  async reserveHttpAttempt(
    ctx: GenerationExecutionContext,
    policy: ExecutionPolicy,
    index: number,
  ): Promise<void> {
    throwIfAborted(ctx.signal);
    await this.prisma.$transaction(async (tx) => {
      const owned = await tx.generationRun.updateMany({
        where: { id: ctx.runId, status: 'running', fencingVersion: ctx.fencingVersion },
        data: { updatedAt: new Date() },
      });
      if (!owned.count) throw new StaleGenerationRunError(ctx.runId, AgentStep.image_gen);
      const run = await tx.generationRun.findUniqueOrThrow({ where: { id: ctx.runId } });
      const operations = run.providerOperations as unknown as Array<Record<string, unknown>>;
      const operation = operations[index]!;
      const authorization = run.executionAuthorization as unknown as ExecutionAuthorization | null;
      operation.httpAttempts = Number(operation.httpAttempts ?? 0) + 1;
      assertAuthorizedOperations(authorization, operations);
      const paid = operations.filter((op) => op.provider === 'openai');
      const attempts = paid.reduce((sum, op) => sum + Math.max(1, Number(op.httpAttempts ?? 0)), 0);
      const limit = Math.min(
        policy.maxPaidCalls,
        authorization?.estimate.maximumProviderCalls ?? policy.limits.maxProviderCalls,
        policy.limits.maxProviderCalls,
      );
      const ceiling =
        authorization?.estimate.estimatedCostUsd?.maximum ?? policy.limits.maxEstimatedCostUsd;
      const cost = paid.reduce(
        (sum, op) =>
          sum + Number(op.estimatedCostUsd ?? 0) * Math.max(1, Number(op.httpAttempts ?? 0)),
        0,
      );
      if (attempts > limit || (ceiling !== undefined && cost > ceiling + 1e-9))
        throw new Error('GENERATION_HARD_BUDGET_EXCEEDED');
      await tx.generationRun.update({
        where: { id: ctx.runId },
        data: { providerOperations: operations as Prisma.InputJsonValue },
      });
    });
  }

  /**
   * Publishes the user-visible durable stage without touching the Book row.
   * The same run/fence predicate used by Book writes prevents a stale worker
   * from reporting progress after another attempt has reclaimed the run.
   */
  async markStep(ctx: GenerationExecutionContext, step: AgentStep): Promise<void> {
    throwIfAborted(ctx.signal);
    const fenceCheck = await this.prisma.generationRun.updateMany({
      where: {
        id: ctx.runId,
        status: GenerationRunStatus.running,
        fencingVersion: ctx.fencingVersion,
      },
      data: { currentStep: step },
    });
    if (fenceCheck.count === 0) {
      throw new StaleGenerationRunError(ctx.runId, step);
    }
  }

  /**
   * Atomically (1) proves `ctx.fencingVersion` still matches the run's
   * current fencingVersion and it is still `running` — the same row-level
   * lock + WHERE-clause re-check Postgres performs for every UPDATE under
   * READ COMMITTED is what makes this correctly serialize against a
   * concurrent claim/heartbeat/complete/fail/recovery write to the *same*
   * GenerationRun row, not just an optimistic best-effort check — then (2),
   * only if that held, writes `bookData` to the Book row. Both statements run
   * in one transaction, so a stale attempt can never sneak a Book write in
   * between the fence check and the write.
   */
  async applyFencedBookWrite(
    ctx: GenerationExecutionContext,
    bookData: Prisma.BookUpdateInput,
    step: AgentStep,
  ): Promise<Book> {
    return this.prisma.$transaction(async (tx) => {
      const fenceCheck = await tx.generationRun.updateMany({
        where: {
          id: ctx.runId,
          status: GenerationRunStatus.running,
          fencingVersion: ctx.fencingVersion,
        },
        data: { currentStep: step },
      });
      if (fenceCheck.count === 0) {
        throw new StaleGenerationRunError(ctx.runId, step);
      }
      // Fencing already proven above within this same transaction — a plain
      // unique-key update is safe here (see this method's doc comment for
      // why no other attempt could have written Book in between).
      return tx.book.update({ where: { id: ctx.bookId }, data: bookData });
    });
  }
}
