import { Injectable } from '@nestjs/common';
import { AgentStep, GenerationRunStatus, Prisma, type Book } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import type { GenerationExecutionContext } from './generation-execution-context';
import type { ExecutionAuthorization, ExecutionPolicy } from './generation-execution-policy';
import {
  assertAuthorizedOperations,
  countAuthorizedDispatches,
} from './generation-execution-policy';
import type { GenerationProviderCallMetadata } from '@book/types';
import { GenerationControlError, throwIfAborted } from '../common/provider-execution';
import { effectiveGenerationCheckpoint } from './generation-checkpoint';
import { randomUUID } from 'node:crypto';

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
      const effectivePrior = effectiveGenerationCheckpoint(prior);
      const compatiblePrior =
        effectivePrior?.inputHash === ctx.inputHash &&
        effectivePrior.compatibilityFingerprint === fingerprint
          ? effectivePrior
          : null;
      const sourceCheckpoint: Record<string, unknown> | undefined = same
        ? prior?.sourceCheckpoint &&
          typeof prior.sourceCheckpoint === 'object' &&
          !Array.isArray(prior.sourceCheckpoint)
          ? (prior.sourceCheckpoint as Record<string, unknown>)
          : undefined
        : compatiblePrior
          ? {
              version: 1,
              inputHash: compatiblePrior.inputHash,
              compatibilityFingerprint: compatiblePrior.compatibilityFingerprint,
              runId: compatiblePrior.runId,
              fencingVersion: compatiblePrior.fencingVersion,
              content: compatiblePrior.content,
              artifacts: compatiblePrior.artifacts,
            }
          : undefined;
      await tx.book.update({
        where: { id: ctx.bookId },
        data: {
          lastGenerationRunId: ctx.runId,
          lastGenerationFencingVersion: ctx.fencingVersion,
          lastGenerationInputHash: ctx.inputHash,
          lastGenerationCompatibilityFingerprint: fingerprint,
          generationCheckpoint: JSON.parse(
            JSON.stringify({
              version: 2,
              inputHash: ctx.inputHash,
              compatibilityFingerprint: fingerprint,
              runId: ctx.runId,
              fencingVersion: ctx.fencingVersion,
              content: { ...(same ? (prior?.content as object) : {}), ...content },
              artifacts: { ...(same ? (prior?.artifacts as object) : {}), ...artifacts },
              ...(sourceCheckpoint && { sourceCheckpoint }),
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
      const reclaimableIndex = operations.findIndex(
        (op) =>
          op.operation === call.operation &&
          op.assetLabel === call.assetLabel &&
          op.state === 'reserved_unsent',
      );
      if (reclaimableIndex >= 0) {
        operations[reclaimableIndex] = {
          ...operations[reclaimableIndex],
          ...call,
          fencingVersion: ctx.fencingVersion,
          deliveryFencingVersion: ctx.fencingVersion,
          state: 'reserved_unsent',
        };
        await tx.generationRun.update({
          where: { id: ctx.runId },
          data: { providerOperations: operations as Prisma.InputJsonValue },
        });
        return reclaimableIndex;
      }
      if (previous.length >= (call.operation === 'story_repair' ? 1 : 2))
        throw new GenerationControlError('budget_rejection', 'PROVIDER_OPERATION_RETRY_LIMIT');
      const paid = operations.filter((op) => op.provider === 'openai');
      const authorization = run.executionAuthorization as unknown as ExecutionAuthorization | null;
      assertAuthorizedOperations(authorization, [...operations, { ...call }]);
      if (call.provider === 'openai') {
        const limit = Math.min(
          policy.maxPaidCalls,
          policy.limits.maxProviderCalls,
          authorization?.envelope?.maxDispatches ??
            authorization?.estimate.maximumProviderCalls ??
            policy.limits.maxProviderCalls,
        );
        const reservedExposure = paid.reduce(
          (sum, op) =>
            sum + countAuthorizedDispatches(op) + (op.state === 'reserved_unsent' ? 1 : 0),
          0,
        );
        if (reservedExposure >= limit)
          throw new GenerationControlError('budget_rejection', 'GENERATION_HARD_BUDGET_EXCEEDED');
        const costLimit =
          authorization?.envelope?.maxEstimatedExposureUsd ??
          authorization?.estimate.estimatedCostUsd?.maximum ??
          policy.limits.maxEstimatedCostUsd;
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
          throw new GenerationControlError('budget_rejection', 'GENERATION_HARD_BUDGET_EXCEEDED');
      }
      // A prior in-flight dispatch has an unknown remote outcome, never a free retry.
      for (const op of operations)
        if (
          (op.state === 'reserved' || op.state === 'dispatch_intent') &&
          op.fencingVersion !== ctx.fencingVersion
        )
          op.state = 'unknown';
      const index = operations.length;
      operations.push({
        ...call,
        fencingVersion: ctx.fencingVersion,
        deliveryFencingVersion: ctx.fencingVersion,
        attempt: previous.length + 1,
        state: 'reserved_unsent',
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
    state: 'response_received' | 'artifact_stored' | 'unknown' | 'known_failure',
    details: Record<string, unknown> = {},
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const owned = await tx.generationRun.updateMany({
        where: { id: ctx.runId, status: 'running', fencingVersion: ctx.fencingVersion },
        data: { updatedAt: new Date() },
      });
      if (!owned.count) throw new StaleGenerationRunError(ctx.runId, AgentStep.image_gen);
      const run = await tx.generationRun.findUniqueOrThrow({ where: { id: ctx.runId } });
      const operations = run.providerOperations as unknown as Array<Record<string, unknown>>;
      const operation = operations[index] ?? {};
      const dispatches = Array.isArray(operation.dispatches)
        ? (operation.dispatches as Array<Record<string, unknown>>)
        : [];
      const lastDispatch = dispatches.length - 1;
      if (lastDispatch >= 0) {
        const completedAt =
          typeof details.completedAt === 'string' ? details.completedAt : new Date().toISOString();
        const startedAt =
          typeof dispatches[lastDispatch]!.startedAt === 'string'
            ? Date.parse(dispatches[lastDispatch]!.startedAt as string)
            : NaN;
        const completedMs = Date.parse(completedAt);
        dispatches[lastDispatch] = {
          ...dispatches[lastDispatch],
          ...details,
          state,
          completedAt,
          durationMs:
            Number.isFinite(startedAt) && Number.isFinite(completedMs)
              ? Math.max(0, completedMs - startedAt)
              : Number(details.durationMs ?? 0),
        };
      }
      operations[index] = { ...operation, ...details, dispatches, state };
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
      if (!operation || !['reserved_unsent', 'dispatch_intent'].includes(String(operation.state)))
        throw new GenerationControlError('budget_rejection', 'PROVIDER_OPERATION_NOT_DISPATCHABLE');
      operation.httpAttempts = Number(operation.httpAttempts ?? 0) + 1;
      operation.state = 'dispatch_intent';
      const dispatches = Array.isArray(operation.dispatches)
        ? (operation.dispatches as Array<Record<string, unknown>>)
        : [];
      const previousDispatch = dispatches.at(-1);
      if (previousDispatch?.state === 'dispatch_intent') {
        // A subsequent authorized attempt proves the provider adapter saw a
        // retryable outcome, but a timeout/network failure may still have
        // reached the provider. Keep that prior exposure conservative.
        previousDispatch.state = 'unknown_remote_outcome';
        const completedAt = new Date().toISOString();
        previousDispatch.completedAt = completedAt;
        const startedAt =
          typeof previousDispatch.startedAt === 'string'
            ? Date.parse(previousDispatch.startedAt)
            : NaN;
        previousDispatch.durationMs = Number.isFinite(startedAt)
          ? Math.max(0, Date.parse(completedAt) - startedAt)
          : 0;
      }
      dispatches.push({
        dispatchId: randomUUID(),
        operationId: operation.operationId,
        deliveryToken: run.deliveryToken,
        deliveryFencingVersion: ctx.fencingVersion,
        state: 'dispatch_intent',
        startedAt: new Date().toISOString(),
      });
      operation.dispatches = dispatches;
      assertAuthorizedOperations(authorization, operations);
      const paid = operations.filter((op) => op.provider === 'openai');
      const attempts = paid.reduce((sum, op) => sum + countAuthorizedDispatches(op), 0);
      const limit = Math.min(
        policy.maxPaidCalls,
        authorization?.envelope?.maxDispatches ??
          authorization?.estimate.maximumProviderCalls ??
          policy.limits.maxProviderCalls,
        policy.limits.maxProviderCalls,
      );
      const ceiling =
        authorization?.envelope?.maxEstimatedExposureUsd ??
        authorization?.estimate.estimatedCostUsd?.maximum ??
        policy.limits.maxEstimatedCostUsd;
      const cost = paid.reduce(
        (sum, op) =>
          sum + Number(op.estimatedCostUsd ?? 0) * Math.max(1, Number(op.httpAttempts ?? 0)),
        0,
      );
      if (attempts > limit || (ceiling !== undefined && cost > ceiling + 1e-9))
        throw new GenerationControlError('budget_rejection', 'GENERATION_HARD_BUDGET_EXCEEDED');
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
