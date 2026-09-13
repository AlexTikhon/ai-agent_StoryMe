import { describe, expect, it, vi } from 'vitest';
import { PageImageRevisionExecutionGateway } from './page-image-revision-execution.gateway';

interface RevisionUpdateArgs {
  where: Record<string, unknown>;
  data: Record<string, unknown>;
}

interface StoredOperation extends Record<string, unknown> {
  dispatches: Array<Record<string, unknown>>;
}

function harness(authorizedDispatches = 2) {
  const state: Record<string, unknown> = {
    id: 'revision-1',
    status: 'running',
    fencingVersion: 4,
    deliveryToken: 'bullmq-delivery-9',
    providerDispatches: 0,
    authorizedDispatches,
    providerOperations: null,
  };
  const pageImageRevision = {
    updateMany: vi.fn(async ({ where, data }: RevisionUpdateArgs) => {
      if (
        where.id !== state.id ||
        where.status !== state.status ||
        where.fencingVersion !== state.fencingVersion
      )
        return { count: 0 };
      for (const [key, value] of Object.entries(data)) {
        if (value && typeof value === 'object' && 'increment' in value) {
          state[key] = Number(state[key] ?? 0) + Number(value.increment);
        } else {
          state[key] = value;
        }
      }
      return { count: 1 };
    }),
    findUniqueOrThrow: vi.fn(async () => state),
    update: vi.fn(async ({ data }: Pick<RevisionUpdateArgs, 'data'>) => {
      for (const [key, value] of Object.entries(data)) {
        if (value && typeof value === 'object' && 'increment' in value) {
          state[key] = Number(state[key] ?? 0) + Number(value.increment);
        } else {
          state[key] = value;
        }
      }
      return state;
    }),
  };
  const prisma = {
    pageImageRevision,
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) =>
      callback({ pageImageRevision }),
    ),
  };
  const binding = new PageImageRevisionExecutionGateway(prisma as never).bind({
    revisionId: 'revision-1',
    fencingVersion: 4,
    candidateImageKey: 'books/book-1/runs/revision-1/claims/4/page-1',
    leaseMs: 60_000,
  });
  return { state, binding };
}

const call = {
  callIndex: 1,
  operation: 'illustration' as const,
  assetLabel: 'page_1',
  provider: 'openai' as const,
  model: 'gpt-image-test',
  promptVersion: 'page-image-v3',
  promptHash: 'a'.repeat(64),
  operationId: 'ignored-by-page-scope',
  attempt: 1,
};

describe('PageImageRevisionExecutionGateway', () => {
  it('persists delivery identity, per-dispatch duration, provider id, usage and typed failure', async () => {
    const { state, binding } = harness();
    const index = await binding.reserveOperation(call);
    await binding.reserveHttpAttempt(index);
    await binding.finishOperation(index, 'known_failure', {
      completedAt: new Date(Date.now() + 5).toISOString(),
      providerRequestId: 'req_page_123',
      inputTokens: 7,
      outputTokens: 3,
      failureKind: 'refusal',
      failureReason: 'refusal',
    });

    const operation = (state.providerOperations as StoredOperation[])[0]!;
    expect(operation).toMatchObject({
      operationId: 'page-image-revision:revision-1',
      deliveryFencingVersion: 4,
      state: 'known_failure',
      providerRequestId: 'req_page_123',
      inputTokens: 7,
      outputTokens: 3,
      failureReason: 'refusal',
    });
    expect(operation.dispatches).toEqual([
      expect.objectContaining({
        dispatchId: expect.any(String),
        deliveryToken: 'bullmq-delivery-9',
        deliveryFencingVersion: 4,
        state: 'known_failure',
        durationMs: expect.any(Number),
        providerRequestId: 'req_page_123',
        failureReason: 'refusal',
      }),
    ]);
  });

  it('never authorizes more dispatches than the durable revision envelope', async () => {
    const { state, binding } = harness(1);
    const index = await binding.reserveOperation(call);
    await binding.reserveHttpAttempt(index);
    await expect(binding.reserveHttpAttempt(index)).rejects.toMatchObject({
      reason: 'budget_rejection',
    });
    expect(state.providerDispatches).toBe(1);
  });

  it('stores a candidate checkpoint only behind the active revision fence', async () => {
    const { state, binding } = harness();
    await binding.checkpoint(
      {},
      {
        page_1: {
          key: 'books/book-1/runs/revision-1/claims/4/page-1',
          sha256: 'b'.repeat(64),
          format: 'png',
          width: 1024,
          height: 1024,
          sizeBytes: 42,
        },
      },
    );
    expect(state).toMatchObject({
      providerOutcome: 'artifact_stored',
      checkpointState: 'artifact_stored',
      candidateImageManifest: expect.objectContaining({ sha256: 'b'.repeat(64) }),
    });
  });
});
