import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { LocalImageAssetStorage } from '../../src/images/image-asset-storage';
import { LocalPdfStorage } from '../../src/pdf/pdf-storage';
import { GenerationResumeService } from '../../src/agent/generation-resume.service';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Book, Prisma } from '@prisma/client';
import { PrismaService } from '../../src/database/prisma.service';
import { GenerationExecutionService } from '../../src/agent/generation-execution.service';
import { GenerationRunService } from '../../src/agent/generation-run.service';
import { GenerationRunCoordinator } from '../../src/agent/generation-run-coordinator.service';
import { CreditsService } from '../../src/credits/credits.service';
import { buildInputSnapshot, hashInputSnapshot } from '../../src/agent/generation-input-snapshot';
import { createTestAgentService } from '../../src/common/test-utils/create-test-agent-service';
import { MockStoryGenerationProvider } from '../../src/agent/story-generation-provider';
import { MockCharacterProfileProvider } from '../../src/agent/character-profile-provider';
import { MockImageGenerationProvider } from '../../src/images/image-generation-provider';
import type { ImageAssetStorage } from '../../src/images/image-asset-storage';
import type { PdfStorage } from '../../src/pdf/pdf-storage';
import { claimImageAssetKey } from '../../src/images/image-asset-storage';
import { claimNamespace } from '../../src/agent/generation-artifact-namespace';
import { executionPolicy } from '../../src/agent/generation-execution-policy';

describe('complete editions and durable spending (real PostgreSQL, real PDF, synthetic rasters)', () => {
  const db = new PrismaService();
  const execution = new GenerationExecutionService(db);
  const coordinator = new GenerationRunCoordinator(db, new CreditsService(db));
  const users: string[] = [];
  beforeAll(() => db.$connect());
  afterAll(() => db.$disconnect());
  afterEach(async () => {
    await db.user.deleteMany({ where: { id: { in: users.splice(0) } } });
  });

  async function book() {
    const user = await db.user.create({ data: { email: `${randomUUID()}@edition.test` } });
    users.push(user.id);
    return db.book.create({
      data: {
        userId: user.id,
        childName: 'Mia',
        childAge: 6,
        language: 'en',
        theme: 'friendship',
        pageCount: 6,
      },
    });
  }
  async function claim(value: Book) {
    const inputSnapshot = buildInputSnapshot(value);
    const run = await db.generationRun.create({
      data: {
        bookId: value.id,
        userId: value.userId,
        kind: 'regenerate',
        inputSnapshot: inputSnapshot as unknown as Prisma.InputJsonValue,
        inputHash: hashInputSnapshot(inputSnapshot),
      },
    });
    await db.book.update({
      where: { id: value.id },
      data: { activeRunId: run.id, status: 'char_build' },
    });
    const delivery = await new GenerationRunService(db).claim(run.id, randomUUID(), 'test', 60_000);
    return {
      runId: run.id,
      bookId: value.id,
      fencingVersion: delivery!.fencingVersion,
      inputSnapshot,
      inputHash: run.inputHash,
    };
  }

  it('preserves old reader text, image bytes, PDF and page versions after a shorter regeneration cannot save its PDF', async () => {
    const initial = await book();
    const assets = new Map<string, Buffer>();
    const pdfs = new Map<string, Buffer>();
    let failPdf = false;
    const images = {
      getImageAsset: async (key: string) => assets.get(key),
      saveImageAsset: async (key: string, bytes: Buffer) => {
        assets.set(key, bytes);
        return { key };
      },
      copyImageAsset: async (source: string, key: string) => {
        const bytes = assets.get(source);
        if (!bytes) return undefined;
        assets.set(key, bytes);
        return { key };
      },
    } as unknown as ImageAssetStorage;
    const storage = {
      saveClaimPreviewPdf: async (_bookId: string, namespace: { runId: string }, bytes: Buffer) => {
        if (failPdf) throw new Error('synthetic storage failure');
        pdfs.set(namespace.runId, bytes);
        return { url: `/pdf/${namespace.runId}` };
      },
      claimPreviewPdfExists: async (_bookId: string, namespace: { runId: string }) =>
        pdfs.has(namespace.runId),
    } as unknown as PdfStorage;
    const agent = createTestAgentService(
      db,
      storage,
      images,
      new MockStoryGenerationProvider(),
      new MockImageGenerationProvider(),
      new MockCharacterProfileProvider(),
      execution,
    );
    const first = await claim(initial);
    const firstOutcome = await agent.startBookGeneration(first);
    expect(firstOutcome.status).toBe('complete');
    expect(await coordinator.completeRun(first, firstOutcome)).toBe('applied');
    const published = await db.book.findUniqueOrThrow({ where: { id: initial.id } });
    const oldImage = assets.get(
      claimImageAssetKey(initial.id, claimNamespace(first.runId, 1), 'page', 1),
    );
    const oldPdf = pdfs.get(first.runId)!;
    expect(oldPdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(oldPdf.toString('latin1')).toContain('/Subtype /Image');
    await db.bookPage.update({
      where: { bookId_pageNumber: { bookId: initial.id, pageNumber: 1 } },
      data: {
        bookId: initial.id,
        pageNumber: 1,
        version: 7,
        textContent: 'edition one correction',
      },
    });
    const edited = await db.book.update({
      where: { id: initial.id },
      data: { pageCount: 4, theme: 'space' },
    });
    const second = await claim(edited);
    failPdf = true;
    const failed = await agent.startBookGeneration(second);
    expect(failed.status).toBe('failed');
    await coordinator.completeRun(second, failed);
    const reader = await db.book.findUniqueOrThrow({ where: { id: initial.id } });
    for (const field of [
      'title',
      'bookPreview',
      'storyPlan',
      'characterProfile',
      'bookLayout',
      'imageGenerationResult',
      'publishedArtifactManifest',
      'previewPdfUrl',
      'publishedRunId',
    ] as const)
      expect(reader[field]).toEqual(published[field]);
    expect(
      assets.get(
        claimImageAssetKey(initial.id, claimNamespace(reader.publishedRunId!, 1), 'page', 1),
      ),
    ).toEqual(oldImage);
    expect(pdfs.get(reader.publishedRunId!)).toEqual(oldPdf);
    expect(
      (
        await db.bookPage.findUniqueOrThrow({
          where: { bookId_pageNumber: { bookId: initial.id, pageNumber: 1 } },
        })
      ).version,
    ).toBe(7);
    expect(
      (reader.generationCheckpoint as { content: { bookPreview: { pages: unknown[] } } }).content
        .bookPreview.pages,
    ).toHaveLength(4);
    // A successful retry swaps the entire edition and invalidates old page versions.
    failPdf = false;
    const third = await claim(reader);
    const success = await agent.startBookGeneration(third);
    expect(success.status).toBe('complete');
    expect(await coordinator.completeRun(third, success)).toBe('applied');
    const replacement = await db.book.findUniqueOrThrow({ where: { id: initial.id } });
    expect((replacement.bookPreview as { pages: unknown[] }).pages).toHaveLength(4);
    expect(replacement.publishedRunId).toBe(third.runId);
    expect(replacement.bookPreview).not.toEqual(published.bookPreview);
    expect(pdfs.get(third.runId)).not.toEqual(oldPdf);
    const pages = await db.bookPage.findMany({ where: { bookId: initial.id } });
    expect(pages).toHaveLength(4);
    expect(pages.every((page) => page.version === 8 && page.imageR2Key === null)).toBe(true);
  });

  it('retains unknown reservations across takeover and never resets the paid budget', async () => {
    const value = await book();
    const first = await claim(value);
    const policy = executionPolicy(
      {
        story: { providerName: 'openai' },
        image: { providerName: 'mock' },
        character: { providerName: 'mock' },
      },
      { MAX_PAID_PROVIDER_CALLS_PER_RUN: '1' },
    );
    const operation = {
      callIndex: 1,
      operation: 'story' as const,
      provider: 'openai' as const,
      promptVersion: 'v1',
      promptHash: 'digest',
      attempt: 1,
    };
    await execution.reserveOperation(first, policy, operation);
    const second = await new GenerationRunService(db).claim(
      first.runId,
      'second',
      'second',
      60_000,
    );
    await expect(
      execution.reserveOperation(
        { ...first, fencingVersion: second!.fencingVersion },
        policy,
        operation,
      ),
    ).rejects.toThrow('BUDGET');
    await expect(
      execution.checkpoint(first, policy.fingerprint, { title: 'stale' }),
    ).rejects.toThrow('no longer owned');
    const run = await db.generationRun.findUniqueOrThrow({ where: { id: first.runId } });
    expect(run.providerOperations).toHaveLength(1);
    expect(run.providerOperations).toEqual([expect.objectContaining({ state: 'unknown' })]);
  });

  it('resumes only three confirmed illustrations after a real worker process terminates', async () => {
    const value = await book();
    const first = await claim(value);
    const images = new LocalImageAssetStorage();
    const pdfs = new LocalPdfStorage();
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            '-r',
            'ts-node/register/transpile-only',
            '-r',
            'tsconfig-paths/register',
            'test/integration/fixtures/terminated-generation-worker.ts',
            first.runId,
          ],
          {
            env: { ...process.env, TS_NODE_PROJECT: 'tsconfig.scripts.json' },
            stdio: 'ignore',
          },
        );
        const timeout = setTimeout(() => {
          child.kill();
          reject(new Error('Termination fixture timed out'));
        }, 20_000);
        child.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.once('exit', (status) => {
          clearTimeout(timeout);
          resolve(status);
        });
      });
      expect(code).toBe(86);
      const stopped = await db.book.findUniqueOrThrow({ where: { id: value.id } });
      const providers = {
        story: new MockStoryGenerationProvider(),
        image: new MockImageGenerationProvider(),
        character: new MockCharacterProfileProvider(),
      };
      const policy = executionPolicy(providers);
      const work = await new GenerationResumeService(images).inspect(
        stopped,
        first.inputHash,
        policy.fingerprint,
        null,
      );
      expect(work.images.filter((image) => image.valid)).toHaveLength(3);
      expect(stopped.bookPreview).toBeNull();
      const delivery = await new GenerationRunService(db).claim(
        first.runId,
        'replacement',
        'replacement',
        60_000,
      );
      const previousIllustrations = (
        delivery!.providerOperations as Array<{ operation: string }>
      ).filter((op) => op.operation === 'illustration').length;
      const ctx = {
        ...first,
        fencingVersion: delivery!.fencingVersion,
        executionAuthorization: delivery!.executionAuthorization,
      };
      const outcome = await createTestAgentService(
        db,
        pdfs,
        images,
        providers.story,
        providers.image,
        providers.character,
        execution,
      ).startBookGeneration(ctx);
      expect(outcome.status).toBe('complete');
      expect(await coordinator.completeRun(ctx, outcome)).toBe('applied');
      const completed = await db.book.findUniqueOrThrow({ where: { id: value.id } });
      expect(Object.keys(completed.publishedArtifactManifest as object)).toHaveLength(9);
      const ledger = (await db.generationRun.findUniqueOrThrow({ where: { id: first.runId } }))
        .providerOperations as Array<{ operation: string }>;
      expect(ledger.filter((op) => op.operation === 'story')).toHaveLength(1);
      // Other operations may have been reserved before death; exactly five assets remain.
      expect(ledger.filter((op) => op.operation === 'illustration')).toHaveLength(
        previousIllustrations + 5,
      );
    } finally {
      await images.deleteBookArtifacts(value.id);
      await pdfs.deleteBookArtifacts(value.id);
    }
  });
});
