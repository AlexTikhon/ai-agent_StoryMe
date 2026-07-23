import { describe, it, expect } from 'vitest';
import type { AgentLog, Book, GenerationJob } from '@prisma/client';
import {
  buildCharacterPersonalizationDiagnostics,
  buildGenerationDiagnostics,
  buildGenerationMetadata,
} from './generation-diagnostics';
import { PRESERVE_APPEARANCE_INSTRUCTION } from '../agent/story-generation-provider';

function makeGenerationJob(overrides: Partial<GenerationJob> = {}): GenerationJob {
  return {
    id: 'job-1',
    bookId: 'b-1',
    userId: 'u-1',
    type: 'generate' as GenerationJob['type'],
    status: 'queued' as GenerationJob['status'],
    attempt: 1,
    maxAttempts: null,
    failedStep: null,
    errorMessage: null,
    runnerId: 'runner-secret-id',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    startedAt: null,
    completedAt: null,
    failedAt: null,
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function makeBook(overrides: Partial<Book> = {}): Book {
  return {
    id: 'b-1',
    userId: 'u-1',
    childProfileId: null,
    status: 'complete' as Book['status'],
    request: null,
    title: 'The Adventures of Mia',
    dedicationText: null,
    pageCount: null,
    childName: 'Mia',
    childAge: 5,
    language: 'en' as Book['language'],
    theme: 'friendship',
    educationalMessage: null,
    characterCard: null,
    storyPlan: null,
    bookPreview: {
      pages: [{ pageNumber: 1 }, { pageNumber: 2 }],
    } as unknown as Book['bookPreview'],
    imageGenerationResult: null,
    bookLayout: null,
    childPhotoAssetKey: null,
    childPhotoContentType: null,
    characterProfile: null,
    characterSheetAssetKey: null,
    chapters: null,
    imagePrompts: null,
    qualityReport: null,
    pageLayouts: null,
    coverUrl: null,
    pdfR2Key: null,
    pdfUrl: null,
    printPdfR2Key: null,
    printPdfUrl: null,
    previewPdfR2Key: null,
    previewPdfUrl: '/files/books/b-1/storybook.pdf',
    socialCardUrl: null,
    isPaid: false,
    paidAt: null,
    stripePaymentIntentId: null,
    isPublic: false,
    generationTimeMs: 4200,
    totalCostUsd: null,
    aiModelVersions: { story: 'mock', image: 'mock' } as unknown as Book['aiModelVersions'],
    generatedDegraded: false,
    errorMessage: null,
    retryCount: 0,
    failedStep: null,
    deletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:10.000Z'),
    ...overrides,
  };
}

function makeAgentLog(overrides: Partial<AgentLog> = {}): AgentLog {
  return {
    id: 'log-1',
    bookId: 'b-1',
    agent: 'LocalPipelineAgent',
    step: 'story_plan' as AgentLog['step'],
    provider: 'mock',
    model: null,
    durationMs: 10,
    tokensInput: null,
    tokensOutput: null,
    costUsd: null,
    attempt: 1,
    status: 'success' as AgentLog['status'],
    error: null,
    traceId: 'trace-1',
    createdAt: new Date('2026-01-01T00:00:05.000Z'),
    ...overrides,
  };
}

describe('buildGenerationMetadata', () => {
  it('reads storyProvider/imageProvider from the matching AgentLog rows', () => {
    const logs = [
      makeAgentLog({ step: 'story_plan' as AgentLog['step'], provider: 'mock' }),
      makeAgentLog({
        step: 'image_gen' as AgentLog['step'],
        provider: 'openai',
        model: 'gpt-image-1',
      }),
    ];

    const metadata = buildGenerationMetadata(makeBook({ aiModelVersions: null }), logs);

    expect(metadata.storyProvider).toBe('mock');
    expect(metadata.imageProvider).toBe('openai');
    expect(metadata.imageModel).toBe('gpt-image-1');
  });

  it('falls back to "unknown" when no matching AgentLog row exists', () => {
    const metadata = buildGenerationMetadata(makeBook({ aiModelVersions: null }), []);

    expect(metadata.storyProvider).toBe('unknown');
    expect(metadata.imageProvider).toBe('unknown');
  });

  it('prefers Book.aiModelVersions over the AgentLog model column for storyModel/imageModel', () => {
    const logs = [makeAgentLog({ step: 'story_plan' as AgentLog['step'], model: 'log-model' })];

    const metadata = buildGenerationMetadata(
      makeBook({
        aiModelVersions: {
          story: 'gpt-4o-mini',
          image: 'gpt-image-1',
        } as unknown as Book['aiModelVersions'],
      }),
      logs,
    );

    expect(metadata.storyModel).toBe('gpt-4o-mini');
  });

  it('derives generatedPages from bookPreview.pages.length', () => {
    const metadata = buildGenerationMetadata(makeBook(), []);

    expect(metadata.generatedPages).toBe(2);
  });

  it('derives generatedImageCount/failedImageCount from imageGenerationResult when present', () => {
    const metadata = buildGenerationMetadata(
      makeBook({
        imageGenerationResult: {
          generatedImageCount: 2,
          failedImageCount: 1,
        } as unknown as Book['imageGenerationResult'],
      }),
      [],
    );

    expect(metadata.generatedImageCount).toBe(2);
    expect(metadata.failedImageCount).toBe(1);
  });

  it('omits generatedImageCount/failedImageCount when imageGenerationResult has no counts (older books)', () => {
    const metadata = buildGenerationMetadata(makeBook({ imageGenerationResult: null }), []);

    expect(metadata.generatedImageCount).toBeUndefined();
    expect(metadata.failedImageCount).toBeUndefined();
  });

  it('derives durationMs from Book.generationTimeMs and startedAt from updatedAt - durationMs', () => {
    const book = makeBook();

    const metadata = buildGenerationMetadata(book, []);

    expect(metadata.durationMs).toBe(4200);
    expect(metadata.completedAt).toBe('2026-01-01T00:00:10.000Z');
    expect(metadata.startedAt).toBe(new Date(book.updatedAt.getTime() - 4200).toISOString());
  });

  it('sets failedAt (not completedAt) and includes failedStep/errorMessage when the book failed', () => {
    const metadata = buildGenerationMetadata(
      makeBook({
        status: 'failed' as Book['status'],
        failedStep: 'image_gen' as Book['failedStep'],
        errorMessage: 'OpenAI image request failed',
      }),
      [],
    );

    expect(metadata.failedAt).toBeDefined();
    expect(metadata.completedAt).toBeUndefined();
    expect(metadata.failedStep).toBe('image_gen');
    expect(metadata.errorMessage).toBe('OpenAI image request failed');
  });

  it('omits startedAt/completedAt/failedAt when the book is still in progress', () => {
    const metadata = buildGenerationMetadata(
      makeBook({ status: 'layout' as Book['status'], generationTimeMs: null }),
      [],
    );

    expect(metadata.startedAt).toBeUndefined();
    expect(metadata.completedAt).toBeUndefined();
    expect(metadata.failedAt).toBeUndefined();
    expect(metadata.durationMs).toBeUndefined();
  });

  it('never includes secrets, prompts, image bytes, or raw provider responses', () => {
    const metadata = buildGenerationMetadata(makeBook(), []);

    const serialized = JSON.stringify(metadata);
    expect(serialized).not.toMatch(/sk-/);
    expect(serialized.toLowerCase()).not.toContain('apikey');
    expect(serialized.toLowerCase()).not.toContain('base64');
    expect(serialized.toLowerCase()).not.toContain('prompt');
  });
});

describe('buildGenerationDiagnostics', () => {
  it('composes bookId, status, and generationMetadata from the book row', () => {
    const diagnostics = buildGenerationDiagnostics(makeBook(), []);

    expect(diagnostics.bookId).toBe('b-1');
    expect(diagnostics.status).toBe('complete');
    expect(diagnostics.previewPdfUrl).toBe('/files/books/b-1/storybook.pdf');
    expect(diagnostics.generationMetadata).toBeDefined();
  });

  it('maps AgentLog rows into recentLogs preserving step/status/provider/model/error', () => {
    const logs = [
      makeAgentLog({
        step: 'image_gen' as AgentLog['step'],
        status: 'error' as AgentLog['status'],
        error: 'boom',
      }),
    ];

    const diagnostics = buildGenerationDiagnostics(makeBook(), logs);

    expect(diagnostics.recentLogs).toHaveLength(1);
    expect(diagnostics.recentLogs[0]).toMatchObject({
      step: 'image_gen',
      status: 'error',
      error: 'boom',
    });
  });

  it('never leaks OPENAI_API_KEY, prompts, image base64, or raw provider responses through recentLogs', () => {
    const logs = [makeAgentLog({ error: 'OpenAI request failed: 401 Unauthorized' })];

    const diagnostics = buildGenerationDiagnostics(makeBook(), logs);

    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(serialized.toLowerCase()).not.toContain('b64_json');
    expect(serialized.toLowerCase()).not.toContain('choices');
  });

  it('returns latestJob: null when no GenerationJob is passed', () => {
    const diagnostics = buildGenerationDiagnostics(makeBook(), []);

    expect(diagnostics.latestJob).toBeNull();
  });

  it('maps a GenerationJob into a safe latestJob summary, excluding runnerId', () => {
    const job = makeGenerationJob({
      id: 'job-9',
      type: 'retry' as GenerationJob['type'],
      status: 'failed' as GenerationJob['status'],
      attempt: 2,
      failedStep: 'image_gen' as GenerationJob['failedStep'],
      errorMessage: 'OpenAI image request failed',
      startedAt: new Date('2026-01-01T00:00:01.000Z'),
      failedAt: new Date('2026-01-01T00:00:05.000Z'),
    });

    const diagnostics = buildGenerationDiagnostics(makeBook(), [], job);

    expect(diagnostics.latestJob).toEqual({
      id: 'job-9',
      type: 'retry',
      status: 'failed',
      attempt: 2,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      startedAt: '2026-01-01T00:00:01.000Z',
      failedAt: '2026-01-01T00:00:05.000Z',
      failedStep: 'image_gen',
      errorMessage: 'OpenAI image request failed',
    });
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain('runner-secret-id');
  });

  it('defaults pdfStorage to a safe local/not-available shape when no pdfStorage state is passed', () => {
    const diagnostics = buildGenerationDiagnostics(makeBook({ previewPdfUrl: null }), []);

    expect(diagnostics.pdfStorage).toEqual({
      driver: 'local',
      keyPresent: false,
      previewAvailable: false,
    });
  });

  it('passes through an explicitly provided pdfStorage state as-is', () => {
    const diagnostics = buildGenerationDiagnostics(makeBook(), [], null, {
      driver: 's3',
      keyPresent: true,
      previewAvailable: false,
    });

    expect(diagnostics.pdfStorage).toEqual({
      driver: 's3',
      keyPresent: true,
      previewAvailable: false,
    });
  });

  it('defaults queue to a safe zeroed shape when no queue state is passed', () => {
    const diagnostics = buildGenerationDiagnostics(makeBook(), []);

    expect(diagnostics.queue).toEqual({
      queueName: 'book-generation',
      workerCount: 0,
      counts: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
      stalledNoWorker: false,
    });
  });

  it('passes through an explicitly provided queue state', () => {
    const diagnostics = buildGenerationDiagnostics(makeBook(), [], null, undefined, {
      queueName: 'book-generation',
      workerCount: 3,
      counts: { waiting: 1, active: 1, completed: 20, failed: 2, delayed: 0 },
    });

    expect(diagnostics.queue).toMatchObject({
      queueName: 'book-generation',
      workerCount: 3,
      counts: { waiting: 1, active: 1, completed: 20, failed: 2, delayed: 0 },
    });
  });

  it('sets queue.stalledNoWorker=true when the latest job is queued/running and no worker is connected — the "stuck forever" signature', () => {
    const queuedJob = makeGenerationJob({ status: 'queued' as GenerationJob['status'] });

    const diagnostics = buildGenerationDiagnostics(
      makeBook({ status: 'char_build' as Book['status'] }),
      [],
      queuedJob,
      undefined,
      {
        queueName: 'book-generation',
        workerCount: 0,
        counts: { waiting: 1, active: 0, completed: 0, failed: 0, delayed: 0 },
      },
    );

    expect(diagnostics.queue.stalledNoWorker).toBe(true);
  });

  it('sets queue.stalledNoWorker=false when a worker is connected, even with a queued job', () => {
    const queuedJob = makeGenerationJob({ status: 'queued' as GenerationJob['status'] });

    const diagnostics = buildGenerationDiagnostics(
      makeBook({ status: 'char_build' as Book['status'] }),
      [],
      queuedJob,
      undefined,
      {
        queueName: 'book-generation',
        workerCount: 1,
        counts: { waiting: 1, active: 0, completed: 0, failed: 0, delayed: 0 },
      },
    );

    expect(diagnostics.queue.stalledNoWorker).toBe(false);
  });

  it('sets queue.stalledNoWorker=false when the latest job is already terminal (completed/failed), even with no worker connected', () => {
    const completedJob = makeGenerationJob({ status: 'completed' as GenerationJob['status'] });

    const diagnostics = buildGenerationDiagnostics(makeBook(), [], completedJob, undefined, {
      queueName: 'book-generation',
      workerCount: 0,
      counts: { waiting: 0, active: 0, completed: 1, failed: 0, delayed: 0 },
    });

    expect(diagnostics.queue.stalledNoWorker).toBe(false);
  });

  it('includes characterPersonalization diagnostics from the book row', () => {
    const diagnostics = buildGenerationDiagnostics(makeBook(), []);
    expect(diagnostics.characterPersonalization).toBeDefined();
  });

  it('defaults imageFailures to an empty array when imageGenerationResult has none', () => {
    const diagnostics = buildGenerationDiagnostics(makeBook({ imageGenerationResult: null }), []);
    expect(diagnostics.imageFailures).toEqual([]);
    expect(diagnostics.providerUsage).toBeNull();
  });

  it('surfaces safe provider usage in diagnostics and generation metadata', () => {
    const providerUsage = {
      maxPaidCalls: 17,
      plannedPaidCalls: 2,
      actualPaidCalls: 1,
      estimatedCostUsd: 0.02,
      calls: [
        {
          callIndex: 1,
          operation: 'story',
          provider: 'openai',
          model: 'story-model',
          promptVersion: 'story-v2',
          promptHash: 'a'.repeat(64),
          attempt: 1,
          durationMs: 20,
          status: 'success',
          estimatedCostUsd: 0.02,
        },
      ],
    };
    const diagnostics = buildGenerationDiagnostics(
      makeBook({
        imageGenerationResult: {
          providerUsage,
        } as unknown as Book['imageGenerationResult'],
      }),
      [],
    );

    expect(diagnostics.providerUsage).toEqual(providerUsage);
    expect(diagnostics.generationMetadata.providerUsage).toEqual(providerUsage);
  });

  it('surfaces imageFailures from imageGenerationResult', () => {
    const failure = {
      assetLabel: 'back_cover',
      provider: 'openai',
      model: 'gpt-image-1',
      httpStatus: 429,
      message: 'OpenAI image request failed with status 429',
      attempts: 3,
      limiterRetries: 2,
      limiterWaitMs: 24000,
      characterReferenceSupplied: true,
      requestMode: 'character-reference-edit',
    };
    const diagnostics = buildGenerationDiagnostics(
      makeBook({
        imageGenerationResult: {
          imageFailures: [failure],
        } as unknown as Book['imageGenerationResult'],
      }),
      [],
    );
    expect(diagnostics.imageFailures).toEqual([failure]);
  });
});

describe('buildCharacterPersonalizationDiagnostics', () => {
  it('is all-false when nothing personalization-related has happened yet', () => {
    const result = buildCharacterPersonalizationDiagnostics(makeBook({ bookPreview: null }));

    expect(result).toEqual({
      hasReferencePhoto: false,
      characterProfileCreated: false,
      characterSheetGenerated: false,
      pagePromptsIncludeConsistencyData: false,
      characterReferenceAvailable: false,
      characterReferenceUsedForImages: false,
      imageGenerationMode: 'text-to-image',
    });
  });

  it('surfaces characterReferenceLoadError when a character-sheet asset was recorded as existing but could not be loaded', () => {
    const result = buildCharacterPersonalizationDiagnostics(
      makeBook({
        bookPreview: null,
        imageGenerationResult: {
          characterReferenceLoadError:
            'Character sheet asset "b-1/character-sheet" is recorded as existing but its bytes could not be loaded from image storage; continuing with text-only image generation for this run.',
        } as unknown as Book['imageGenerationResult'],
      }),
    );

    expect(result.characterReferenceLoadError).toContain('could not be loaded');
  });

  it('omits characterReferenceLoadError when no such failure occurred', () => {
    const result = buildCharacterPersonalizationDiagnostics(makeBook({ bookPreview: null }));

    expect(result.characterReferenceLoadError).toBeUndefined();
  });

  it('reflects hasReferencePhoto/characterProfileCreated/characterSheetGenerated from their respective columns', () => {
    const result = buildCharacterPersonalizationDiagnostics(
      makeBook({
        bookPreview: null,
        childPhotoAssetKey: 'b-1/child-photo',
        characterProfile: { consistencyPrompt: 'Mia, ...' } as unknown as Book['characterProfile'],
        characterSheetAssetKey: 'b-1/character-sheet',
      }),
    );

    expect(result.hasReferencePhoto).toBe(true);
    expect(result.characterProfileCreated).toBe(true);
    expect(result.characterSheetGenerated).toBe(true);
  });

  it('sets pagePromptsIncludeConsistencyData=true only when every page prompt includes the marker phrase', () => {
    const allIncluded = buildCharacterPersonalizationDiagnostics(
      makeBook({
        bookPreview: {
          pages: [
            { pageNumber: 1, illustrationPrompt: `Scene one. ${PRESERVE_APPEARANCE_INSTRUCTION}` },
            { pageNumber: 2, illustrationPrompt: `Scene two. ${PRESERVE_APPEARANCE_INSTRUCTION}` },
          ],
        } as unknown as Book['bookPreview'],
      }),
    );
    expect(allIncluded.pagePromptsIncludeConsistencyData).toBe(true);

    const partiallyIncluded = buildCharacterPersonalizationDiagnostics(
      makeBook({
        bookPreview: {
          pages: [
            { pageNumber: 1, illustrationPrompt: `Scene one. ${PRESERVE_APPEARANCE_INSTRUCTION}` },
            { pageNumber: 2, illustrationPrompt: 'Scene two, no consistency instructions.' },
          ],
        } as unknown as Book['bookPreview'],
      }),
    );
    expect(partiallyIncluded.pagePromptsIncludeConsistencyData).toBe(false);
  });

  it('is false when bookPreview has no pages yet', () => {
    const result = buildCharacterPersonalizationDiagnostics(
      makeBook({ bookPreview: { pages: [] } as unknown as Book['bookPreview'] }),
    );
    expect(result.pagePromptsIncludeConsistencyData).toBe(false);
  });

  it('defaults characterReferenceAvailable/characterReferenceUsedForImages to false and imageGenerationMode to text-to-image when imageGenerationResult is null', () => {
    const result = buildCharacterPersonalizationDiagnostics(
      makeBook({ bookPreview: null, imageGenerationResult: null }),
    );

    expect(result.characterReferenceAvailable).toBe(false);
    expect(result.characterReferenceUsedForImages).toBe(false);
    expect(result.imageGenerationMode).toBe('text-to-image');
  });

  it('reflects characterReferenceAvailable/characterReferenceUsedForImages/imageGenerationMode from imageGenerationResult', () => {
    const result = buildCharacterPersonalizationDiagnostics(
      makeBook({
        bookPreview: null,
        imageGenerationResult: {
          characterReferenceAvailable: true,
          characterReferenceUsedForImages: true,
          imageGenerationMode: 'character-reference-edit',
        } as unknown as Book['imageGenerationResult'],
      }),
    );

    expect(result.characterReferenceAvailable).toBe(true);
    expect(result.characterReferenceUsedForImages).toBe(true);
    expect(result.imageGenerationMode).toBe('character-reference-edit');
  });

  it('distinguishes characterSheetGenerated (created) from characterReferenceAvailable (bytes loaded) from characterReferenceUsedForImages (actually used)', () => {
    const result = buildCharacterPersonalizationDiagnostics(
      makeBook({
        bookPreview: null,
        characterSheetAssetKey: 'b-1/character-sheet',
        imageGenerationResult: {
          characterReferenceAvailable: false,
          characterReferenceUsedForImages: false,
        } as unknown as Book['imageGenerationResult'],
      }),
    );

    expect(result.characterSheetGenerated).toBe(true);
    expect(result.characterReferenceAvailable).toBe(false);
    expect(result.characterReferenceUsedForImages).toBe(false);
  });

  it('never reports imageGenerationMode as anything other than the three known values, even for a malformed stored value', () => {
    const result = buildCharacterPersonalizationDiagnostics(
      makeBook({
        bookPreview: null,
        imageGenerationResult: {
          imageGenerationMode: 'not-a-real-mode',
        } as unknown as Book['imageGenerationResult'],
      }),
    );

    expect(result.imageGenerationMode).toBe('text-to-image');
  });
});
