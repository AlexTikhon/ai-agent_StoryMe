import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { GenerationRunStatus, type Prisma } from '@prisma/client';
import { PrismaService } from '../../src/database/prisma.service';
import {
  GenerationExecutionService,
  StaleGenerationRunError,
} from '../../src/agent/generation-execution.service';
import { GenerationRunCoordinator } from '../../src/agent/generation-run-coordinator.service';
import { CreditsService, generationChargeIdempotencyKey } from '../../src/credits/credits.service';
import { buildInputSnapshot, hashInputSnapshot } from '../../src/agent/generation-input-snapshot';
import { createTestAgentService } from '../../src/common/test-utils/create-test-agent-service';
import { MockCharacterProfileProvider } from '../../src/agent/character-profile-provider';
import {
  MockImageGenerationProvider,
  type ImageGenerationInput,
  type ImageGenerationProvider,
} from '../../src/images/image-generation-provider';
import type { ImageAssetStorage } from '../../src/images/image-asset-storage';
import type { PdfStorage } from '../../src/pdf/pdf-storage';
import {
  failThenSucceed,
  ScriptedImageProvider,
  ScriptedStoryProvider,
} from '../support/scripted-providers';
import {
  cancellableSleep,
  ProviderCancellationError,
  type ProviderExecutionOptions,
} from '../../src/common/provider-execution';
import type { GenerationExecutionContext } from '../../src/agent/generation-execution-context';

vi.mock('../../src/pdf/pdf-renderer', () => ({
  renderStorybookPdf: vi.fn(async () => Buffer.from('%PDF-1.4 deterministic-test')),
}));

class MemoryImageStorage {
  readonly artifacts = new Map<string, Buffer>();

  async saveImageAsset(key: string, buffer: Buffer, contentType: string) {
    this.artifacts.set(key, buffer);
    return { key, path: key, contentType };
  }

  async getImageAsset(key: string) {
    return this.artifacts.get(key);
  }

  async copyImageAsset(sourceKey: string, destinationKey: string) {
    const buffer = this.artifacts.get(sourceKey);
    if (!buffer) return undefined;
    this.artifacts.set(destinationKey, buffer);
    return { key: destinationKey, path: destinationKey, contentType: 'image/png' as const };
  }
}

class MemoryPdfStorage {
  readonly driver = 'local' as const;
  readonly artifacts = new Map<string, Buffer>();
  writes = 0;

  private claimKey(bookId: string, namespace: { runId: string; fencingVersion: number }) {
    return `${bookId}/${namespace.runId}/${namespace.fencingVersion}`;
  }

  async saveClaimPreviewPdf(
    bookId: string,
    namespace: { runId: string; fencingVersion: number },
    buffer: Buffer,
  ) {
    this.writes++;
    const key = this.claimKey(bookId, namespace);
    this.artifacts.set(key, buffer);
    return { url: `/test-pdfs/${key}` };
  }

  async claimPreviewPdfExists(
    bookId: string,
    namespace: { runId: string; fencingVersion: number },
  ) {
    return this.artifacts.has(this.claimKey(bookId, namespace));
  }

  async previewPdfExists() {
    return false;
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class BlockingImageProvider implements ImageGenerationProvider {
  readonly providerName = 'mock' as const;
  readonly modelName = 'blocking-local-image';
  readonly promptVersion = 'blocking-image-v1';
  readonly delegate = new MockImageGenerationProvider();
  started = 0;
  completed = 0;

  generateCharacterSheet(...args: Parameters<ImageGenerationProvider['generateCharacterSheet']>) {
    return this.delegate.generateCharacterSheet(...args);
  }

  async generateImage(input: ImageGenerationInput, options?: ProviderExecutionOptions) {
    this.started++;
    await cancellableSleep(10_000, options?.signal);
    const result = await this.delegate.generateImage(input, options);
    this.completed++;
    return result;
  }
}

describe('generation provider fault injection (real PostgreSQL)', () => {
  const prisma = new PrismaService();
  const credits = new CreditsService(prisma);
  const coordinator = new GenerationRunCoordinator(prisma, credits);
  const execution = new GenerationExecutionService(prisma);
  const userIds: string[] = [];
  const runIds: string[] = [];

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  afterEach(async () => {
    if (runIds.length > 0) {
      await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: runIds } } });
      runIds.length = 0;
    }
    if (userIds.length > 0) {
      await prisma.creditTransaction.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      userIds.length = 0;
    }
  });

  async function createClaim(
    options: {
      previousPublishedRunId?: string;
      userCredits?: number;
    } = {},
  ) {
    const user = await prisma.user.create({
      data: {
        email: `provider-fault-${randomUUID()}@example.test`,
        credits: options.userCredits ?? 1,
      },
    });
    userIds.push(user.id);
    const book = await prisma.book.create({
      data: {
        userId: user.id,
        status: 'char_build',
        childName: 'Mia',
        childAge: 5,
        language: 'en',
        theme: 'friendship',
        pageCount: 6,
        ...(options.previousPublishedRunId && {
          previewPdfUrl: '/previous-good.pdf',
          publishedRunId: options.previousPublishedRunId,
          publishedRunFencingVersion: 7,
        }),
      },
    });
    const snapshot = buildInputSnapshot(book);
    const inputHash = hashInputSnapshot(snapshot);
    const run = await prisma.generationRun.create({
      data: {
        bookId: book.id,
        userId: user.id,
        kind: 'initial',
        status: GenerationRunStatus.running,
        inputSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        inputHash,
        leaseOwner: 'fault-worker-a',
        leaseExpiresAt: new Date(Date.now() + 60_000),
        deliveryToken: 'fault-delivery-a',
        fencingVersion: 1,
      },
    });
    runIds.push(run.id);
    await prisma.$transaction([
      prisma.book.update({ where: { id: book.id }, data: { activeRunId: run.id } }),
      prisma.outboxEvent.create({
        data: {
          aggregateType: 'generation_run',
          aggregateId: run.id,
          eventType: 'generation.requested',
          payload: { bookId: book.id, runId: run.id },
          status: 'dispatched',
          dispatchedAt: new Date(),
        },
      }),
      prisma.creditTransaction.create({
        data: {
          userId: user.id,
          bookId: book.id,
          amount: -1,
          balanceAfter: options.userCredits ?? 1,
          reason: 'book_creation',
          idempotencyKey: generationChargeIdempotencyKey(run.id),
        },
      }),
    ]);
    return {
      user,
      book,
      run,
      ctx: {
        runId: run.id,
        bookId: book.id,
        fencingVersion: 1,
        inputHash,
        inputSnapshot: snapshot,
      },
    };
  }

  function createHarness(
    storyProvider: ScriptedStoryProvider,
    options: {
      imageProvider?: ImageGenerationProvider;
      execution?: GenerationExecutionService;
      images?: MemoryImageStorage;
      pdfs?: MemoryPdfStorage;
    } = {},
  ) {
    const images = options.images ?? new MemoryImageStorage();
    const pdfs = options.pdfs ?? new MemoryPdfStorage();
    const agent = createTestAgentService(
      prisma,
      pdfs as unknown as PdfStorage,
      images as unknown as ImageAssetStorage,
      storyProvider,
      options.imageProvider ?? new MockImageGenerationProvider(),
      new MockCharacterProfileProvider(),
      options.execution ?? execution,
    );
    return { agent, images, pdfs };
  }

  it.each(['rate_limit', 'network_error'] as const)(
    'recovers from one %s attempt with one authoritative publication and charge',
    async (failure) => {
      const claim = await createClaim();
      const story = new ScriptedStoryProvider(failThenSucceed(failure));
      const { agent, images, pdfs } = createHarness(story);

      const outcome = await agent.startBookGeneration(claim.ctx);
      expect(await coordinator.completeRun(claim.ctx, outcome)).toBe('applied');
      expect(await coordinator.completeRun(claim.ctx, outcome)).toBe('stale_fence');

      const [book, run, ledger, logs] = await Promise.all([
        prisma.book.findUniqueOrThrow({ where: { id: claim.book.id } }),
        prisma.generationRun.findUniqueOrThrow({ where: { id: claim.run.id } }),
        prisma.creditTransaction.findMany({ where: { userId: claim.user.id } }),
        prisma.agentLog.findMany({ where: { bookId: claim.book.id } }),
      ]);
      const persistedResult = book.imageGenerationResult as {
        providerUsage?: { calls?: Array<Record<string, unknown>> };
      };
      const storyTelemetry = persistedResult.providerUsage?.calls?.find(
        (call) => call['operation'] === 'story',
      );

      expect(story.stats).toMatchObject({ logicalCalls: 1, httpAttempts: 2, retries: 1 });
      expect(storyTelemetry).toMatchObject({
        attempt: 1,
        httpAttempts: 2,
        retries: 1,
        status: 'success',
      });
      expect(book).toMatchObject({
        status: 'complete',
        activeRunId: null,
        publishedRunId: claim.run.id,
        publishedRunFencingVersion: 1,
      });
      expect(run.status).toBe('completed');
      expect(pdfs.writes).toBe(1);
      expect(images.artifacts.size).toBe(9);
      expect(
        [...images.artifacts.keys()].every((key) =>
          key.includes(`/runs/${claim.run.id}/claims/1/`),
        ),
      ).toBe(true);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]?.idempotencyKey).toBe(generationChargeIdempotencyKey(claim.run.id));
      expect(logs).toHaveLength(10);
    },
  );

  it('persists a classified permanent failure without leaking provider data or replacing a good publication', async () => {
    const previousPublishedRunId = randomUUID();
    const claim = await createClaim({ previousPublishedRunId });
    const privatePayload =
      'prompt=Mia private story image=base64-secret Authorization=Bearer sk-test-secret';
    const story = new ScriptedStoryProvider([
      { result: 'invalid_response', privateMessage: privatePayload },
    ]);
    const { agent, images, pdfs } = createHarness(story);

    const outcome = await agent.startBookGeneration(claim.ctx);
    expect(await coordinator.completeRun(claim.ctx, outcome)).toBe('applied');
    expect(await coordinator.completeRun(claim.ctx, outcome)).toBe('stale_fence');

    const [book, run, ledger, logs, user] = await Promise.all([
      prisma.book.findUniqueOrThrow({ where: { id: claim.book.id } }),
      prisma.generationRun.findUniqueOrThrow({ where: { id: claim.run.id } }),
      prisma.creditTransaction.findMany({ where: { userId: claim.user.id } }),
      prisma.agentLog.findMany({ where: { bookId: claim.book.id } }),
      prisma.user.findUniqueOrThrow({ where: { id: claim.user.id } }),
    ]);
    const persisted = JSON.stringify({ book, run, logs });

    expect(run).toMatchObject({
      status: 'failed',
      errorCode: 'PROVIDER_INVALID_RESPONSE',
      errorMessage: 'Provider returned an invalid response.',
    });
    expect(book).toMatchObject({
      status: 'failed',
      activeRunId: null,
      publishedRunId: previousPublishedRunId,
      publishedRunFencingVersion: 7,
      previewPdfUrl: '/previous-good.pdf',
    });
    expect(persisted).not.toContain('base64-secret');
    expect(persisted).not.toContain('sk-test-secret');
    expect(persisted).not.toContain('Mia private story');
    expect(pdfs.writes).toBe(0);
    expect(images.artifacts.size).toBe(1);
    expect(ledger.map((entry) => entry.amount).sort()).toEqual([-1, 1]);
    expect(user.credits).toBe(2);
  });

  it('cancels delayed story work through AbortSignal and never publishes stale output', async () => {
    const claim = await createClaim();
    const controller = new AbortController();
    const story = new ScriptedStoryProvider([
      { result: 'delay', delayMs: 10_000 },
      { result: 'success' },
    ]);
    const { agent, images, pdfs } = createHarness(story);
    const pending = agent.startBookGeneration({ ...claim.ctx, signal: controller.signal });

    while (story.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    const cancelled = await coordinator.cancelGeneration({
      bookId: claim.book.id,
      userId: claim.user.id,
    });
    controller.abort('generation cancelled');

    await expect(pending).rejects.toBeInstanceOf(ProviderCancellationError);
    expect(cancelled.kind).toBe('applied');
    const [book, run, logs] = await Promise.all([
      prisma.book.findUniqueOrThrow({ where: { id: claim.book.id } }),
      prisma.generationRun.findUniqueOrThrow({ where: { id: claim.run.id } }),
      prisma.agentLog.findMany({ where: { bookId: claim.book.id } }),
    ]);
    expect(book).toMatchObject({ status: 'cancelled', activeRunId: null, publishedRunId: null });
    expect(run.status).toBe('cancelled');
    expect(story.stats.httpAttempts).toBe(0);
    expect(pdfs.writes).toBe(0);
    expect(images.artifacts.size).toBe(1);
    expect(logs).toHaveLength(0);
  });

  it('cancels all concurrent image calls as exceptional control flow, not failedCount aggregation', async () => {
    const claim = await createClaim();
    const controller = new AbortController();
    const story = new ScriptedStoryProvider([{ result: 'success' }]);
    const imageProvider = new BlockingImageProvider();
    const { agent, images, pdfs } = createHarness(story, { imageProvider });
    const pending = agent.startBookGeneration({ ...claim.ctx, signal: controller.signal });

    while (imageProvider.started < 8) await new Promise((resolve) => setTimeout(resolve, 5));
    const cancelled = await coordinator.cancelGeneration({
      bookId: claim.book.id,
      userId: claim.user.id,
    });
    controller.abort('generation cancelled during images');

    await expect(pending).rejects.toBeInstanceOf(ProviderCancellationError);
    expect(cancelled.kind).toBe('applied');
    expect(imageProvider).toMatchObject({ started: 8, completed: 0 });
    expect(images.artifacts.size).toBe(1);
    expect(pdfs.writes).toBe(0);
    const [book, logs] = await Promise.all([
      prisma.book.findUniqueOrThrow({ where: { id: claim.book.id } }),
      prisma.agentLog.findMany({ where: { bookId: claim.book.id } }),
    ]);
    expect(book).toMatchObject({ status: 'cancelled', activeRunId: null, publishedRunId: null });
    expect(logs).toHaveLength(0);
  });

  it('lets cancellation win after layout persistence but before PDF publication', async () => {
    const claim = await createClaim();
    const controller = new AbortController();
    const story = new ScriptedStoryProvider([{ result: 'success' }]);
    const layoutPersisted = deferred();
    const releasePublication = deferred();
    const gatedExecution = Object.create(execution) as GenerationExecutionService;
    gatedExecution.markStep = async (ctx, step) => {
      await execution.markStep(ctx, step);
      if (step === 'pdf_render') {
        layoutPersisted.resolve();
        await releasePublication.promise;
      }
    };
    const { agent, images, pdfs } = createHarness(story, { execution: gatedExecution });
    const pending = agent.startBookGeneration({ ...claim.ctx, signal: controller.signal });

    await layoutPersisted.promise;
    const cancelled = await coordinator.cancelGeneration({
      bookId: claim.book.id,
      userId: claim.user.id,
    });
    controller.abort('generation cancelled at publication boundary');
    releasePublication.resolve();

    await expect(pending).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof StaleGenerationRunError || error instanceof ProviderCancellationError,
    );
    expect(cancelled.kind).toBe('applied');
    const [book, run] = await Promise.all([
      prisma.book.findUniqueOrThrow({ where: { id: claim.book.id } }),
      prisma.generationRun.findUniqueOrThrow({ where: { id: claim.run.id } }),
    ]);
    expect(book).toMatchObject({ status: 'cancelled', activeRunId: null, publishedRunId: null });
    expect(run.status).toBe('cancelled');
    expect(images.artifacts.size).toBe(9);
    expect(pdfs.writes).toBe(0);
  });

  it('reuses valid story/images and regenerates only a subsequently missing artifact', async () => {
    const first = await createClaim({ userCredits: 3 });
    const firstStory = new ScriptedStoryProvider([{ result: 'success' }]);
    const initial = createHarness(firstStory, {
      imageProvider: new ScriptedImageProvider(
        Array.from({ length: 9 }, () => ({ result: 'success' as const })),
      ),
    });
    const firstOutcome = await initial.agent.startBookGeneration(first.ctx);
    expect(await coordinator.completeRun(first.ctx, firstOutcome)).toBe('applied');

    async function createRetry(previousRunId: string) {
      const run = await prisma.generationRun.create({
        data: {
          bookId: first.book.id,
          userId: first.user.id,
          kind: 'retry',
          retryOfRunId: previousRunId,
          status: 'running',
          inputSnapshot: first.ctx.inputSnapshot as unknown as Prisma.InputJsonValue,
          inputHash: first.ctx.inputHash,
          leaseOwner: 'resume-worker',
          leaseExpiresAt: new Date(Date.now() + 60_000),
          deliveryToken: `resume-${randomUUID()}`,
          fencingVersion: 1,
        },
      });
      runIds.push(run.id);
      const updatedUser = await prisma.user.update({
        where: { id: first.user.id },
        data: { credits: { decrement: 1 } },
      });
      await prisma.$transaction([
        prisma.book.update({
          where: { id: first.book.id },
          data: { status: 'char_build', activeRunId: run.id },
        }),
        prisma.creditTransaction.create({
          data: {
            userId: first.user.id,
            bookId: first.book.id,
            amount: -1,
            balanceAfter: updatedUser.credits,
            reason: 'book_creation',
            idempotencyKey: generationChargeIdempotencyKey(run.id),
          },
        }),
      ]);
      return {
        run,
        ctx: {
          ...first.ctx,
          runId: run.id,
          fencingVersion: 1,
        },
      };
    }

    const fullyReusable = await createRetry(first.run.id);
    const noStoryCalls = new ScriptedStoryProvider([]);
    const noImageCalls = new ScriptedImageProvider([]);
    const secondHarness = createHarness(noStoryCalls, {
      imageProvider: noImageCalls,
      images: initial.images,
      pdfs: initial.pdfs,
    });
    const secondOutcome = await secondHarness.agent.startBookGeneration(fullyReusable.ctx);
    expect(await coordinator.completeRun(fullyReusable.ctx, secondOutcome)).toBe('applied');
    expect(noStoryCalls.stats.logicalCalls).toBe(0);
    expect(noImageCalls.stats.logicalCalls).toBe(0);

    const priorBackCover = [...initial.images.artifacts.keys()].find(
      (key) => key.includes(`/runs/${fullyReusable.run.id}/`) && key.endsWith('/back-cover'),
    );
    expect(priorBackCover).toBeDefined();
    initial.images.artifacts.delete(priorBackCover!);

    const partiallyReusable = await createRetry(fullyReusable.run.id);
    const stillNoStoryCalls = new ScriptedStoryProvider([]);
    const oneImageCall = new ScriptedImageProvider([{ result: 'success' }]);
    const thirdHarness = createHarness(stillNoStoryCalls, {
      imageProvider: oneImageCall,
      images: initial.images,
      pdfs: initial.pdfs,
    });
    const thirdOutcome = await thirdHarness.agent.startBookGeneration(partiallyReusable.ctx);
    expect(await coordinator.completeRun(partiallyReusable.ctx, thirdOutcome)).toBe('applied');

    expect(stillNoStoryCalls.stats.logicalCalls).toBe(0);
    expect(oneImageCall.stats).toMatchObject({ logicalCalls: 1, httpAttempts: 1 });
    expect(oneImageCall.calls).toEqual([
      expect.objectContaining({
        operation: 'image',
        input: expect.objectContaining({ entry: expect.objectContaining({ kind: 'back_cover' }) }),
      }),
    ]);
    const currentKeys = [...initial.images.artifacts.keys()].filter((key) =>
      key.includes(`/runs/${partiallyReusable.run.id}/claims/1/`),
    );
    expect(currentKeys).toHaveLength(9);
    const published = await prisma.book.findUniqueOrThrow({ where: { id: first.book.id } });
    expect(published).toMatchObject({
      status: 'complete',
      publishedRunId: partiallyReusable.run.id,
      publishedRunFencingVersion: 1,
    });
  });
});
