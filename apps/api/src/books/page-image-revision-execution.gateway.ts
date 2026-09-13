import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { GenerationProviderCallMetadata } from '@book/types';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { GenerationControlError, throwIfAborted } from '../common/provider-execution';
import type {
  DurableProviderExecutionGateway,
  DurableProviderOperationState,
} from '../agent/generation-provider-telemetry';

export interface PageImageRevisionGatewayContext {
  revisionId: string;
  fencingVersion: number;
  candidateImageKey: string;
  signal?: AbortSignal | undefined;
  leaseMs: number;
}

function jsonOperations(value: Prisma.JsonValue | null): Array<Record<string, unknown>> {
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

/**
 * Page-revision implementation of the same provider execution gateway used by
 * whole-book telemetry. Every remote attempt is fenced and durably identified
 * before dispatch; terminal attempt data is merged into the same ledger.
 */
@Injectable()
export class PageImageRevisionExecutionGateway {
  constructor(private readonly prisma: PrismaService) {}

  bind(ctx: PageImageRevisionGatewayContext): DurableProviderExecutionGateway {
    return {
      assertOwnership: () => this.assertOwnership(ctx),
      reserveOperation: (call) => this.reserveOperation(ctx, call),
      reserveHttpAttempt: (index) => this.reserveHttpAttempt(ctx, index),
      finishOperation: (index, state, details) => this.finishOperation(ctx, index, state, details),
      checkpoint: (_content, artifacts = {}) => this.checkpoint(ctx, artifacts),
    };
  }

  private async assertOwnership(ctx: PageImageRevisionGatewayContext): Promise<void> {
    throwIfAborted(ctx.signal);
    const owned = await this.prisma.pageImageRevision.updateMany({
      where: {
        id: ctx.revisionId,
        status: 'running',
        fencingVersion: ctx.fencingVersion,
      },
      data: { leaseExpiresAt: new Date(Date.now() + ctx.leaseMs) },
    });
    if (!owned.count)
      throw new GenerationControlError(
        'confirmed_supersession',
        'PAGE_IMAGE_REVISION_FENCE_REJECTED',
      );
  }

  private async reserveOperation(
    ctx: PageImageRevisionGatewayContext,
    call: Omit<GenerationProviderCallMetadata, 'status' | 'durationMs'>,
  ): Promise<number> {
    throwIfAborted(ctx.signal);
    return this.prisma.$transaction(async (tx) => {
      const owned = await tx.pageImageRevision.updateMany({
        where: { id: ctx.revisionId, status: 'running', fencingVersion: ctx.fencingVersion },
        data: {
          candidateImageKey: ctx.candidateImageKey,
          leaseExpiresAt: new Date(Date.now() + ctx.leaseMs),
        },
      });
      if (!owned.count)
        throw new GenerationControlError(
          'confirmed_supersession',
          'PAGE_IMAGE_REVISION_FENCE_REJECTED',
        );
      const revision = await tx.pageImageRevision.findUniqueOrThrow({
        where: { id: ctx.revisionId },
      });
      const operations = jsonOperations(revision.providerOperations);
      const existing = operations.findIndex(
        (operation) =>
          operation.operation === call.operation &&
          operation.assetLabel === call.assetLabel &&
          operation.state === 'reserved_unsent',
      );
      if (existing >= 0) {
        operations[existing] = {
          ...operations[existing],
          ...call,
          operationId: `page-image-revision:${ctx.revisionId}`,
          deliveryFencingVersion: ctx.fencingVersion,
        };
        await tx.pageImageRevision.update({
          where: { id: ctx.revisionId },
          data: { providerOperations: operations as Prisma.InputJsonValue },
        });
        return existing;
      }
      if (operations.length > 0)
        throw new GenerationControlError(
          'budget_rejection',
          'PAGE_IMAGE_REVISION_LOGICAL_OPERATION_LIMIT',
        );
      operations.push({
        ...call,
        operationId: `page-image-revision:${ctx.revisionId}`,
        deliveryFencingVersion: ctx.fencingVersion,
        state: 'reserved_unsent',
      });
      await tx.pageImageRevision.update({
        where: { id: ctx.revisionId },
        data: { providerOperations: operations as Prisma.InputJsonValue },
      });
      return 0;
    });
  }

  private async reserveHttpAttempt(
    ctx: PageImageRevisionGatewayContext,
    index: number,
  ): Promise<void> {
    throwIfAborted(ctx.signal);
    await this.prisma.$transaction(async (tx) => {
      const owned = await tx.pageImageRevision.updateMany({
        where: {
          id: ctx.revisionId,
          status: 'running',
          fencingVersion: ctx.fencingVersion,
        },
        data: {
          candidateImageKey: ctx.candidateImageKey,
          leaseExpiresAt: new Date(Date.now() + ctx.leaseMs),
        },
      });
      if (!owned.count)
        throw new GenerationControlError(
          'confirmed_supersession',
          'PAGE_IMAGE_REVISION_FENCE_REJECTED',
        );
      const revision = await tx.pageImageRevision.findUniqueOrThrow({
        where: { id: ctx.revisionId },
      });
      if (revision.providerDispatches >= revision.authorizedDispatches)
        throw new GenerationControlError(
          'budget_rejection',
          'PAGE_IMAGE_DISPATCH_BUDGET_OR_FENCE_REJECTED',
        );
      await tx.pageImageRevision.update({
        where: { id: ctx.revisionId },
        data: {
          providerDispatches: { increment: 1 },
          providerOutcome: 'dispatch_intent',
        },
      });
      const operations = jsonOperations(revision.providerOperations);
      const operation = operations[index];
      if (!operation || !['reserved_unsent', 'dispatch_intent'].includes(String(operation.state)))
        throw new GenerationControlError(
          'budget_rejection',
          'PAGE_IMAGE_OPERATION_NOT_DISPATCHABLE',
        );
      const dispatches = Array.isArray(operation.dispatches)
        ? (operation.dispatches as Array<Record<string, unknown>>)
        : [];
      const previous = dispatches.at(-1);
      if (previous?.state === 'dispatch_intent') {
        const completedAt = new Date().toISOString();
        previous.state = 'unknown_remote_outcome';
        previous.completedAt = completedAt;
        const startedAt =
          typeof previous.startedAt === 'string' ? Date.parse(previous.startedAt) : NaN;
        previous.durationMs = Number.isFinite(startedAt)
          ? Math.max(0, Date.parse(completedAt) - startedAt)
          : 0;
      }
      dispatches.push({
        dispatchId: randomUUID(),
        deliveryToken: revision.deliveryToken,
        deliveryFencingVersion: ctx.fencingVersion,
        state: 'dispatch_intent',
        startedAt: new Date().toISOString(),
      });
      operations[index] = {
        ...operation,
        httpAttempts: Number(operation.httpAttempts ?? 0) + 1,
        state: 'dispatch_intent',
        dispatches,
      };
      await tx.pageImageRevision.update({
        where: { id: ctx.revisionId },
        data: { providerOperations: operations as Prisma.InputJsonValue },
      });
    });
  }

  private async finishOperation(
    ctx: PageImageRevisionGatewayContext,
    index: number,
    state: DurableProviderOperationState,
    details: Record<string, unknown> = {},
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const owned = await tx.pageImageRevision.updateMany({
        where: { id: ctx.revisionId, status: 'running', fencingVersion: ctx.fencingVersion },
        data: { leaseExpiresAt: new Date(Date.now() + ctx.leaseMs) },
      });
      if (!owned.count)
        throw new GenerationControlError(
          'confirmed_supersession',
          'PAGE_IMAGE_REVISION_FENCE_REJECTED',
        );
      const revision = await tx.pageImageRevision.findUniqueOrThrow({
        where: { id: ctx.revisionId },
      });
      const operations = jsonOperations(revision.providerOperations);
      const operation = operations[index];
      if (!operation) throw new Error('PAGE_IMAGE_PROVIDER_OPERATION_MISSING');
      const dispatches = Array.isArray(operation.dispatches)
        ? (operation.dispatches as Array<Record<string, unknown>>)
        : [];
      const last = dispatches.at(-1);
      if (last) {
        const completedAt =
          typeof details.completedAt === 'string' ? details.completedAt : new Date().toISOString();
        const started = typeof last.startedAt === 'string' ? Date.parse(last.startedAt) : NaN;
        const completed = Date.parse(completedAt);
        Object.assign(last, details, {
          state,
          completedAt,
          durationMs:
            Number.isFinite(started) && Number.isFinite(completed)
              ? Math.max(0, completed - started)
              : Number(details.durationMs ?? 0),
        });
      }
      operations[index] = { ...operation, ...details, state, dispatches };
      await tx.pageImageRevision.update({
        where: { id: ctx.revisionId },
        data: {
          providerOperations: operations as Prisma.InputJsonValue,
          providerOutcome: state,
          ...(state === 'artifact_stored' && { checkpointState: 'artifact_stored' }),
        },
      });
    });
  }

  private async checkpoint(
    ctx: PageImageRevisionGatewayContext,
    artifacts: Record<string, unknown>,
  ): Promise<void> {
    const artifact = Object.values(artifacts)[0] as Record<string, unknown> | undefined;
    if (!artifact) {
      await this.assertOwnership(ctx);
      return;
    }
    const stored = await this.prisma.pageImageRevision.updateMany({
      where: { id: ctx.revisionId, status: 'running', fencingVersion: ctx.fencingVersion },
      data: {
        providerOutcome: 'artifact_stored',
        checkpointState: 'artifact_stored',
        candidateImageKey: ctx.candidateImageKey,
        candidateImageManifest: artifact as Prisma.InputJsonValue,
        leaseExpiresAt: new Date(Date.now() + ctx.leaseMs),
      },
    });
    if (!stored.count)
      throw new GenerationControlError(
        'confirmed_supersession',
        'PAGE_IMAGE_REVISION_FENCE_REJECTED',
      );
  }
}
