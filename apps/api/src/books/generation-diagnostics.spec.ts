import { describe, it, expect, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { AgentLog, Book, GenerationRun } from '@prisma/client';
import { CharacterReferenceStage } from '../agent/character-reference.stage';
import { claimArtifactBasePath } from '../agent/generation-artifact-namespace';
import { claimCharacterSheetAssetKey, type ImageAssetStorage } from '../images/image-asset-storage';
import {
  CHARACTER_REFERENCE_LOAD_ERROR,
  buildCharacterPersonalizationDiagnostics,
  buildGenerationDiagnostics,
  buildRunProviderUsage,
  runWallClockDurationMs,
  type GenerationDiagnosticsSnapshot,
} from './generation-diagnostics';
import { PRESERVE_APPEARANCE_INSTRUCTION } from '../agent/story-generation-provider';

const RUN_A = '00000000-0000-4000-8000-00000000000a';
const RUN_B = '00000000-0000-4000-8000-00000000000b';
const RUN_C = '00000000-0000-4000-8000-00000000000c';

function makeGenerationRun(overrides: Partial<GenerationRun> = {}): GenerationRun {
  return {
    id: 'run-1',
    bookId: 'b-1',
    userId: 'u-1',
    kind: 'initial' as GenerationRun['kind'],
    status: 'queued' as GenerationRun['status'],
    inputSnapshot: { childName: 'Snapshot Child', theme: 'snapshot-theme' },
    inputHash: 'input-hash-secret',
    retryOfRunId: null,
    currentStep: null,
    attempt: 1,
    leaseOwner: 'worker-secret-id',
    leaseExpiresAt: null,
    queueExpiresAt: null,
    processingDeadlineAt: null,
    deliveryToken: 'delivery-secret-token',
    fencingVersion: 1,
    errorCode: null,
    errorMessage: null,
    executionAuthorization: null,
    providerOperations: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    startedAt: null,
    completedAt: null,
    failedAt: null,
    cancelledAt: null,
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
    childPhotoSha256: null,
    childPhotoSizeBytes: null,
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
    activeRunId: null,
    publishedRunId: null,
    publishedRunFencingVersion: null,
    publishedPdfRunId: null,
    publishedPdfFencingVersion: null,
    activePageImageRevisionId: null,
    lastGenerationInputHash: null,
    lastGenerationCompatibilityFingerprint: null,
    lastGenerationRunId: null,
    lastGenerationFencingVersion: null,
    publishedArtifactManifest: null,
    generationCheckpoint: null,
    deletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-03-09T12:34:56.000Z'),
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

/** One durable ledger operation for a mock provider. */
function ledgerOperation(
  runId: string,
  assetLabel: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    callIndex: 1,
    operationId: `${runId}:illustration:${assetLabel}`,
    operation: 'illustration',
    assetLabel,
    provider: 'mock',
    promptVersion: 'page-v1',
    promptHash: 'c'.repeat(64),
    attempt: 1,
    state: 'artifact_stored',
    durationMs: 5,
    ...overrides,
  };
}

/** Published A: completed run whose pointer the Book carries. */
/** Values a diagnostics response must never contain. */
const PRIVATE_DIAGNOSTICS_VALUES = [
  'Snapshot Child',
  'snapshot-theme',
  'input-hash-secret',
  'worker-secret-id',
  'delivery-secret-token',
  'secret prompt text',
  'Mia',
  'child-photo-v1',
  'character-sheet',
  // Storage-derived PDF path of the published claim namespace.
  '/files/books/',
  'storyme-preview',
  'b64_json',
];

/** Claim columns exactly as GenerationRun creation leaves them. */
const PRE_CLAIM = {
  startedAt: null,
  leaseOwner: null,
  deliveryToken: null,
  processingDeadlineAt: null,
  currentStep: null,
} satisfies Partial<GenerationRun>;

function completedRunA(): GenerationRun {
  return makeGenerationRun({
    id: RUN_A,
    status: 'completed' as GenerationRun['status'],
    currentStep: 'pdf_render' as GenerationRun['currentStep'],
    fencingVersion: 1,
    startedAt: new Date('2026-01-01T00:00:01.000Z'),
    completedAt: new Date('2026-01-01T00:00:31.000Z'),
    providerOperations: [ledgerOperation(RUN_A, 'cover'), ledgerOperation(RUN_A, 'page_1')],
  } as Partial<GenerationRun>);
}

function bookPublishedFrom(runId: string, overrides: Partial<Book> = {}): Book {
  return makeBook({
    publishedRunId: runId,
    publishedRunFencingVersion: 1,
    previewPdfUrl: `/files/books/b-1/runs/${runId}/claims/1/storyme-preview-b-1.pdf`,
    imageGenerationResult: {
      generatedImageCount: 4,
      failedImageCount: 0,
      imageFailures: [],
      resume: { resumeMode: false, finalBookStatus: 'complete' },
      // The publishing run's embedded snapshot: never a substitute for a
      // newer run's missing ledger.
      providerUsage: {
        maxPaidCalls: 0,
        plannedPaidCalls: 0,
        actualPaidCalls: 0,
        calls: [{ callIndex: 99, operation: 'story', provider: 'mock', assetLabel: 'snapshot' }],
      },
    } as unknown as Book['imageGenerationResult'],
    ...overrides,
  });
}

function diagnose(snapshot: Partial<GenerationDiagnosticsSnapshot> & { book: Book }) {
  return buildGenerationDiagnostics({
    latestRun: null,
    publishedSourceRun: null,
    logs: [],
    ...snapshot,
  });
}

describe('buildGenerationDiagnostics — publication and latest-attempt provenance', () => {
  it('keeps published A with A provenance while failed B reports its own identity, failure, timestamps and usage', () => {
    const runA = completedRunA();
    const runB = makeGenerationRun({
      id: RUN_B,
      kind: 'regenerate' as GenerationRun['kind'],
      status: 'failed' as GenerationRun['status'],
      attempt: 1,
      currentStep: 'pdf_render' as GenerationRun['currentStep'],
      errorCode: 'GENERATION_INVALID_OUTPUT',
      errorMessage: 'missing generated illustration(s) for page 2.',
      createdAt: new Date('2026-02-01T00:00:00.000Z'),
      startedAt: new Date('2026-02-01T00:00:02.000Z'),
      failedAt: new Date('2026-02-01T00:00:12.500Z'),
      providerOperations: [
        ledgerOperation(RUN_B, 'page_2', { state: 'failed', failureKind: 'provider_error' }),
      ],
    } as Partial<GenerationRun>);
    const book = bookPublishedFrom(RUN_A, {
      status: 'failed' as Book['status'],
      errorMessage: 'missing generated illustration(s) for page 2.',
    });

    const result = diagnose({ book, latestRun: runB, publishedSourceRun: runA });

    expect(result.publishedEdition).toMatchObject({
      edition: `${RUN_A}:1`,
      revisedAfterGeneration: false,
      sourceGenerationRun: {
        availability: 'recorded',
        runId: RUN_A,
        fencingVersion: 1,
        status: 'completed',
        timestamps: {
          startedAt: '2026-01-01T00:00:01.000Z',
          completedAt: '2026-01-01T00:00:31.000Z',
          failedAt: null,
        },
        runWallClockDurationMs: 30_000,
      },
      generationRecord: { generatedImageCount: 4, failedImageCount: 0, imageFailures: [] },
    });
    const baseUsage = result.publishedEdition!.baseGenerationUsage;
    expect(baseUsage.availability).toBe('recorded');
    if (baseUsage.availability === 'recorded') {
      expect(baseUsage.usage.calls.map((call) => call.operationId)).toEqual([
        `${RUN_A}:illustration:cover`,
        `${RUN_A}:illustration:page_1`,
      ]);
    }

    expect(result.latestAttempt).toMatchObject({
      runId: RUN_B,
      kind: 'regenerate',
      status: 'failed',
      isPublishedSource: false,
      timestamps: {
        createdAt: '2026-02-01T00:00:00.000Z',
        startedAt: '2026-02-01T00:00:02.000Z',
        completedAt: null,
        failedAt: '2026-02-01T00:00:12.500Z',
        cancelledAt: null,
      },
      runWallClockDurationMs: 10_500,
      error: {
        code: 'GENERATION_INVALID_OUTPUT',
        message: 'missing generated illustration(s) for page 2.',
        failedStep: 'pdf_render',
      },
    });
    const attemptUsage = result.latestAttempt!.providerUsage;
    expect(attemptUsage.availability).toBe('recorded');
    if (attemptUsage.availability === 'recorded') {
      expect(attemptUsage.usage.calls).toEqual([
        expect.objectContaining({
          operationId: `${RUN_B}:illustration:page_2`,
          status: 'error',
          failureKind: 'provider_error',
        }),
      ]);
    }
    expect(result.latestJob).toMatchObject({ id: RUN_B, status: 'failed' });
  });

  it.each([
    ['queued', { ...PRE_CLAIM, fencingVersion: 0 }, 'never_claimed'],
    [
      'cancelled',
      { ...PRE_CLAIM, fencingVersion: 1, cancelledAt: new Date('2026-02-01T00:00:03.000Z') },
      'never_claimed',
    ],
    [
      'cancelled',
      {
        startedAt: new Date('2026-02-01T00:00:01.000Z'),
        cancelledAt: new Date('2026-02-01T00:00:03.000Z'),
      },
      'ledger_absent',
    ],
    [
      'completed',
      { ...PRE_CLAIM, fencingVersion: 1, completedAt: new Date('2026-02-01T00:00:09.000Z') },
      'ledger_absent',
    ],
  ] as const)(
    'never falls back to the published usage for a %s B without a ledger (%#)',
    (status, fields, reason) => {
      const runB = makeGenerationRun({
        id: RUN_B,
        status: status as GenerationRun['status'],
        createdAt: new Date('2026-02-01T00:00:00.000Z'),
        ...fields,
      });

      const result = diagnose({
        book: bookPublishedFrom(RUN_A),
        latestRun: runB,
        publishedSourceRun: completedRunA(),
      });

      expect(result.latestAttempt!.providerUsage).toEqual({ availability: 'unavailable', reason });
      expect(JSON.stringify(result.latestAttempt)).not.toContain('snapshot');
      expect(JSON.stringify(result.latestAttempt)).not.toContain(RUN_A);
      expect(result.publishedEdition!.sourceGenerationRun).toMatchObject({ runId: RUN_A });
    },
  );

  it('reports a confirmed empty ledger as recorded zero usage, distinct from unavailable', () => {
    const run = makeGenerationRun({
      id: RUN_B,
      status: 'failed' as GenerationRun['status'],
      startedAt: new Date('2026-02-01T00:00:01.000Z'),
      failedAt: new Date('2026-02-01T00:00:02.000Z'),
      providerOperations: [],
    } as Partial<GenerationRun>);

    const usage = buildRunProviderUsage(run);

    expect(usage).toMatchObject({
      availability: 'recorded',
      usage: { actualPaidCalls: 0, actualDispatches: 0, calls: [] },
    });
  });

  it('advances publication provenance to successful C', () => {
    const runC = makeGenerationRun({
      id: RUN_C,
      kind: 'retry' as GenerationRun['kind'],
      retryOfRunId: RUN_B,
      status: 'completed' as GenerationRun['status'],
      fencingVersion: 2,
      startedAt: new Date('2026-03-01T00:00:01.000Z'),
      completedAt: new Date('2026-03-01T00:00:21.000Z'),
      providerOperations: [ledgerOperation(RUN_C, 'page_2')],
    } as Partial<GenerationRun>);
    const book = bookPublishedFrom(RUN_C, { publishedRunFencingVersion: 2 });

    const result = diagnose({ book, latestRun: runC, publishedSourceRun: runC });

    expect(result.publishedEdition).toMatchObject({
      edition: `${RUN_C}:2`,
      sourceGenerationRun: { availability: 'recorded', runId: RUN_C, kind: 'retry' },
    });
    expect(result.latestAttempt).toMatchObject({
      runId: RUN_C,
      retryOfRunId: RUN_B,
      isPublishedSource: true,
      runWallClockDurationMs: 20_000,
    });
    expect(result.publishedEdition!.baseGenerationUsage).toEqual(
      result.latestAttempt!.providerUsage,
    );
  });

  it.each([
    ['text correction', '11111111-1111-4111-8111-111111111111'],
    ['page image revision', '22222222-2222-4222-8222-222222222222'],
  ])(
    'changes the edition after a %s without inventing a run or rewriting history',
    (_label, revisionId) => {
      const runA = completedRunA();
      const before = diagnose({
        book: bookPublishedFrom(RUN_A),
        latestRun: runA,
        publishedSourceRun: runA,
      });
      const revised = bookPublishedFrom(RUN_A, {
        publishedPdfRunId: revisionId,
        publishedPdfFencingVersion: 1,
        previewPdfUrl: `/files/books/b-1/runs/${revisionId}/claims/1/storyme-preview-b-1.pdf`,
        updatedAt: new Date('2026-04-01T00:00:00.000Z'),
      });

      const after = diagnose({ book: revised, latestRun: runA, publishedSourceRun: runA });

      expect(after.publishedEdition!.edition).toBe(`${revisionId}:1`);
      expect(after.publishedEdition!.edition).not.toBe(before.publishedEdition!.edition);
      expect(after.publishedEdition!.revisedAfterGeneration).toBe(true);
      expect(after.publishedEdition!.sourceGenerationRun).toEqual(
        before.publishedEdition!.sourceGenerationRun,
      );
      expect(after.publishedEdition!.baseGenerationUsage).toEqual(
        before.publishedEdition!.baseGenerationUsage,
      );
      expect(after.latestAttempt).toEqual(before.latestAttempt);
      expect(JSON.stringify(after)).not.toContain('2026-04-01T00:00:00.000Z');
    },
  );

  it('keeps legacy and missing provenance unavailable without fabricated timestamps, costs or providers', () => {
    const legacy = makeBook({
      status: 'complete' as Book['status'],
      generationTimeMs: 4200,
      aiModelVersions: null,
      imageGenerationResult: {
        providerUsage: { maxPaidCalls: 1, plannedPaidCalls: 1, actualPaidCalls: 1, calls: [] },
      } as unknown as Book['imageGenerationResult'],
    });

    const result = diagnose({
      book: legacy,
      logs: [
        makeAgentLog({ step: 'story_plan' as AgentLog['step'], provider: 'openai' }),
        makeAgentLog({ step: 'image_gen' as AgentLog['step'], provider: 'openai', model: 'm' }),
      ],
    });

    expect(result.publishedEdition).toMatchObject({
      edition: 'legacy',
      sourceGenerationRun: { availability: 'unavailable', reason: 'legacy_publication' },
      baseGenerationUsage: { availability: 'unavailable', reason: 'source_run_unavailable' },
    });
    expect(result.publishedEdition!.generationRecord).not.toHaveProperty('storyModel');
    expect(result.publishedEdition!.generationRecord).not.toHaveProperty('imageModel');
    expect(result.latestAttempt).toBeNull();
    const projections = JSON.stringify({
      publishedEdition: result.publishedEdition,
      latestAttempt: result.latestAttempt,
    });
    expect(projections).not.toContain('openai');
    expect(projections).not.toContain('2026-03-09');
    // Book.generationTimeMs is never turned into a duration or timestamp.
    expect(projections).not.toContain('4200');
    // Book-level history is still shown, labelled as such by the contract.
    expect(result.recentLogs).toHaveLength(2);
  });

  it('reports a dangling or foreign publication pointer as a missing record, never another run', () => {
    const foreign = makeGenerationRun({ id: RUN_A, userId: 'u-other' });
    const wrongId = makeGenerationRun({
      id: RUN_B,
      status: 'completed' as GenerationRun['status'],
    });
    for (const candidate of [null, foreign, wrongId]) {
      const result = diagnose({ book: bookPublishedFrom(RUN_A), publishedSourceRun: candidate });
      expect(result.publishedEdition).toMatchObject({
        sourceGenerationRun: {
          availability: 'unavailable',
          reason: 'run_record_missing',
          runId: RUN_A,
        },
        baseGenerationUsage: { availability: 'unavailable', reason: 'source_run_unavailable' },
      });
    }
  });

  it('returns no published edition and no attempt for an untouched draft', () => {
    const result = diagnose({
      book: makeBook({ status: 'created' as Book['status'], previewPdfUrl: null }),
    });

    expect(result.publishedEdition).toBeNull();
    expect(result.latestAttempt).toBeNull();
    expect(result.latestJob).toBeNull();
  });

  it('never exposes input snapshots, child details, prompts, storage keys, lease identities or raw responses', () => {
    const runB = makeGenerationRun({
      id: RUN_B,
      status: 'running' as GenerationRun['status'],
      startedAt: new Date('2026-02-01T00:00:01.000Z'),
    });
    const book = bookPublishedFrom(RUN_A, {
      characterProfile: {
        childName: 'Mia',
        consistencyPrompt: 'secret prompt text',
        hasReferencePhoto: true,
      } as unknown as Book['characterProfile'],
      childPhotoAssetKey: 'b-1/child-photo-v1',
      characterSheetAssetKey: 'b-1/character-sheet',
    });

    const serialized = JSON.stringify(
      diagnose({ book, latestRun: runB, publishedSourceRun: completedRunA() }),
    );

    for (const forbidden of PRIVATE_DIAGNOSTICS_VALUES) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('projects a missing character reference as a static failure without the storage key or internal path', async () => {
    const namespace = { kind: 'claim' as const, runId: RUN_A, fencingVersion: 1 };
    const sheetKey = claimCharacterSheetAssetKey('b-1', namespace);
    const internalPath = claimArtifactBasePath('b-1', namespace);
    const storage = { getImageAsset: vi.fn(async () => undefined) };
    const stage = new CharacterReferenceStage(
      storage as unknown as ImageAssetStorage,
      {} as never,
      { providerName: 'mock' } as never,
    );
    const errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const { reference, loadError } = await stage.loadReference('b-1', sheetKey);

    // The real stage error names the storage key and is still logged internally.
    expect(reference).toBeUndefined();
    expect(storage.getImageAsset).toHaveBeenCalledWith(sheetKey);
    expect(loadError).toContain(sheetKey);
    expect(errorLog).toHaveBeenCalledWith(loadError);
    errorLog.mockRestore();

    const runB = makeGenerationRun({
      id: RUN_B,
      status: 'running' as GenerationRun['status'],
      startedAt: new Date('2026-02-01T00:00:01.000Z'),
    });
    const book = bookPublishedFrom(RUN_A, {
      characterProfile: {
        childName: 'Mia',
        consistencyPrompt: 'secret prompt text',
        hasReferencePhoto: true,
      } as unknown as Book['characterProfile'],
      childPhotoAssetKey: 'b-1/child-photo-v1',
      characterSheetAssetKey: sheetKey,
      imageGenerationResult: {
        generatedImageCount: 4,
        failedImageCount: 0,
        characterReferenceAvailable: false,
        characterReferenceUsedForImages: false,
        imageGenerationMode: 'text-to-image',
        characterReferenceLoadError: loadError,
      } as unknown as Book['imageGenerationResult'],
    });

    const dto = diagnose({ book, latestRun: runB, publishedSourceRun: completedRunA() });
    const serialized = JSON.stringify(dto);

    expect(dto.publishedEdition!.characterPersonalization).toMatchObject({
      characterSheetGenerated: true,
      characterReferenceAvailable: false,
      characterReferenceUsedForImages: false,
      characterReferenceLoadError: CHARACTER_REFERENCE_LOAD_ERROR,
    });
    for (const forbidden of [
      ...PRIVATE_DIAGNOSTICS_VALUES,
      sheetKey,
      internalPath,
      loadError!,
      'Character sheet asset',
      'image storage',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe('buildRunProviderUsage — missing execution history', () => {
  const COMPLETED_AT = new Date('2026-02-01T00:00:09.000Z');

  /** Completed before startedAt was persisted: claimed, but no timestamp or ledger. */
  function completedLegacyRun(overrides: Partial<GenerationRun> = {}): GenerationRun {
    return makeGenerationRun({
      id: RUN_B,
      status: 'completed' as GenerationRun['status'],
      fencingVersion: 1,
      ...PRE_CLAIM,
      completedAt: COMPLETED_AT,
      providerOperations: null,
      ...overrides,
    });
  }

  it('reports a completed legacy run without startedAt or ledger as ledger_absent, never never_claimed', () => {
    const legacy = completedLegacyRun();

    expect(buildRunProviderUsage(legacy)).toEqual({
      availability: 'unavailable',
      reason: 'ledger_absent',
    });

    const result = diagnose({
      book: bookPublishedFrom(RUN_A),
      latestRun: legacy,
      publishedSourceRun: completedRunA(),
    });
    expect(result.latestAttempt!.timestamps).toMatchObject({
      startedAt: null,
      completedAt: COMPLETED_AT.toISOString(),
    });
    expect(result.latestAttempt!.runWallClockDurationMs).toBeNull();
    expect(result.latestAttempt!.providerUsage).toEqual({
      availability: 'unavailable',
      reason: 'ledger_absent',
    });
    // Neither A's ledger nor the published imageGenerationResult snapshot.
    expect(JSON.stringify(result.latestAttempt)).not.toContain(RUN_A);
    expect(JSON.stringify(result.latestAttempt)).not.toContain('snapshot');
  });

  it('reports a completed legacy published source run as ledger_absent without substituting the book usage', () => {
    const book = bookPublishedFrom(RUN_B);
    const result = diagnose({ book, publishedSourceRun: completedLegacyRun() });

    expect(result.publishedEdition!.sourceGenerationRun).toMatchObject({
      availability: 'recorded',
      runId: RUN_B,
      timestamps: { startedAt: null, completedAt: COMPLETED_AT.toISOString() },
      runWallClockDurationMs: null,
    });
    expect(result.publishedEdition!.baseGenerationUsage).toEqual({
      availability: 'unavailable',
      reason: 'ledger_absent',
    });
    expect(JSON.stringify(result.publishedEdition!.baseGenerationUsage)).not.toContain('snapshot');
  });

  it.each([
    ['running without startedAt', { status: 'running' }],
    ['cancelled after claim + cancel fence bumps', { status: 'cancelled', fencingVersion: 2 }],
    ['cancelled with a recorded lease owner', { status: 'cancelled', leaseOwner: 'worker-1' }],
    ['cancelled with a delivery token', { status: 'cancelled', deliveryToken: 'token-1' }],
    ['failed after a claim fence bump', { status: 'failed', fencingVersion: 1 }],
    [
      'failed with a processing deadline',
      { status: 'failed', processingDeadlineAt: new Date('2026-02-01T00:45:00.000Z') },
    ],
    ['failed with a pipeline step', { status: 'failed', currentStep: 'char_build' }],
    ['queued with an impossible claim marker', { status: 'queued', leaseOwner: 'worker-1' }],
  ] as const)(
    'keeps a run with prior-claim evidence but no startedAt unknown (%s)',
    (_label, fields) => {
      const run = makeGenerationRun({
        id: RUN_B,
        ...PRE_CLAIM,
        fencingVersion: 0,
        providerOperations: null,
        ...(fields as Partial<GenerationRun>),
      });

      expect(run.startedAt).toBeNull();
      expect(buildRunProviderUsage(run)).toEqual({
        availability: 'unavailable',
        reason: 'ledger_absent',
      });
    },
  );

  it.each([
    ['queued, not yet claimed', { status: 'queued', fencingVersion: 0 }],
    [
      'cancelled while queued',
      { status: 'cancelled', fencingVersion: 1, cancelledAt: COMPLETED_AT },
    ],
    [
      'failed by recovery while queued',
      { status: 'failed', fencingVersion: 0, failedAt: COMPLETED_AT },
    ],
  ] as const)(
    'reports never_claimed only when lifecycle invariants prove it (%s)',
    (_l, fields) => {
      const run = makeGenerationRun({
        id: RUN_B,
        ...PRE_CLAIM,
        providerOperations: null,
        ...(fields as Partial<GenerationRun>),
      });

      expect(buildRunProviderUsage(run)).toEqual({
        availability: 'unavailable',
        reason: 'never_claimed',
      });
    },
  );

  it.each([
    ['completed legacy run', completedLegacyRun({ providerOperations: [] })],
    [
      'pre-claim cancelled run',
      makeGenerationRun({
        id: RUN_B,
        status: 'cancelled' as GenerationRun['status'],
        ...PRE_CLAIM,
        fencingVersion: 1,
        providerOperations: [],
      }),
    ],
  ] as const)('reports an explicitly empty ledger as recorded, not unavailable (%s)', (_l, run) => {
    const projection = buildRunProviderUsage(run);

    expect(projection.availability).toBe('recorded');
    if (projection.availability === 'recorded') {
      expect(projection.usage.calls).toEqual([]);
      expect(projection.usage.actualPaidCalls).toBe(0);
    }
  });
});

describe('runWallClockDurationMs', () => {
  it('uses only the persisted terminal timestamp for the run status', () => {
    const startedAt = new Date('2026-01-01T00:00:00.000Z');
    expect(
      runWallClockDurationMs(
        makeGenerationRun({
          status: 'cancelled' as GenerationRun['status'],
          startedAt,
          cancelledAt: new Date('2026-01-01T00:00:04.000Z'),
        }),
      ),
    ).toBe(4000);
    expect(
      runWallClockDurationMs(
        makeGenerationRun({ status: 'running' as GenerationRun['status'], startedAt }),
      ),
    ).toBeNull();
    expect(
      runWallClockDurationMs(
        makeGenerationRun({
          status: 'completed' as GenerationRun['status'],
          completedAt: new Date('2026-01-01T00:00:04.000Z'),
        }),
      ),
    ).toBeNull();
  });
});

describe('buildGenerationDiagnostics — book-level and read-time fields', () => {
  it('maps AgentLog rows into book-level recentLogs preserving step/status/provider/model/error', () => {
    const result = diagnose({
      book: makeBook(),
      logs: [
        makeAgentLog({
          step: 'image_gen' as AgentLog['step'],
          status: 'error' as AgentLog['status'],
          error: 'boom',
        }),
      ],
    });

    expect(result.recentLogs).toHaveLength(1);
    expect(result.recentLogs[0]).toMatchObject({
      step: 'image_gen',
      status: 'error',
      error: 'boom',
    });
  });

  it('exposes optional actual token counts from AgentLog rows', () => {
    const result = diagnose({
      book: makeBook(),
      logs: [
        makeAgentLog({ tokensInput: 123, tokensOutput: 45 }),
        makeAgentLog({ id: 'log-2', tokensInput: null, tokensOutput: null }),
      ],
    });

    expect(result.recentLogs[0]).toMatchObject({ tokensInput: 123, tokensOutput: 45 });
    expect(result.recentLogs[1]).not.toHaveProperty('tokensInput');
    expect(result.recentLogs[1]).not.toHaveProperty('tokensOutput');
  });

  it('projects the legacy latestJob alias from the latest run only, without lease data', () => {
    const run = makeGenerationRun({
      id: 'run-9',
      kind: 'retry' as GenerationRun['kind'],
      status: 'failed' as GenerationRun['status'],
      attempt: 2,
      currentStep: 'image_gen' as GenerationRun['currentStep'],
      errorMessage: 'OpenAI image request failed',
      startedAt: new Date('2026-01-01T00:00:01.000Z'),
      failedAt: new Date('2026-01-01T00:00:05.000Z'),
    });

    const result = diagnose({ book: makeBook(), latestRun: run });

    expect(result.latestJob).toEqual({
      id: 'run-9',
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
    expect(result.latestAttempt).toMatchObject({
      runId: 'run-9',
      deliveryAttempt: 2,
      error: { code: null, message: 'OpenAI image request failed', failedStep: 'image_gen' },
    });
  });

  it('defaults pdfStorage to a safe local/not-available shape when no observation is passed', () => {
    const result = diagnose({ book: makeBook({ previewPdfUrl: null }) });

    expect(result.pdfStorage).toEqual({
      driver: 'local',
      keyPresent: false,
      previewAvailable: false,
    });
  });

  it('passes through explicit pdfStorage and queue observations', () => {
    const result = buildGenerationDiagnostics(
      { book: makeBook(), latestRun: null, publishedSourceRun: null, logs: [] },
      {
        pdfStorage: { driver: 's3', keyPresent: true, previewAvailable: false },
        queue: {
          queueName: 'book-generation',
          workerCount: 3,
          counts: { waiting: 1, active: 1, completed: 20, failed: 2, delayed: 0 },
        },
      },
    );

    expect(result.pdfStorage).toEqual({ driver: 's3', keyPresent: true, previewAvailable: false });
    expect(result.queue).toMatchObject({ workerCount: 3, stalledNoWorker: false });
  });

  it('defaults queue to a safe zeroed shape when no queue observation is passed', () => {
    expect(diagnose({ book: makeBook() }).queue).toEqual({
      queueName: 'book-generation',
      workerCount: 0,
      counts: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
      stalledNoWorker: false,
    });
  });

  it.each([
    ['queued', 0, true],
    ['running', 0, true],
    ['queued', 1, false],
    ['completed', 0, false],
    ['failed', 0, false],
  ] as const)(
    'sets stalledNoWorker from the latest attempt (%s, %d workers) -> %s',
    (status, workerCount, expected) => {
      const result = buildGenerationDiagnostics(
        {
          book: makeBook({ status: 'char_build' as Book['status'] }),
          latestRun: makeGenerationRun({ status: status as GenerationRun['status'] }),
          publishedSourceRun: null,
          logs: [],
        },
        {
          queue: {
            queueName: 'book-generation',
            workerCount,
            counts: { waiting: 1, active: 0, completed: 0, failed: 0, delayed: 0 },
          },
        },
      );

      expect(result.queue.stalledNoWorker).toBe(expected);
    },
  );

  it('aggregates the durable delivery-spanning ledger for one run', () => {
    const run = makeGenerationRun({
      status: 'running' as GenerationRun['status'],
      startedAt: new Date('2026-01-01T00:00:01.000Z'),
      executionAuthorization: {
        policy: { maxPaidCalls: 4 },
        estimate: { maximumProviderCalls: 2 },
      },
      providerOperations: [
        {
          callIndex: 1,
          operationId: 'run-1:story:singleton',
          operation: 'story',
          provider: 'openai',
          model: 'gpt-test',
          promptVersion: 'story-v1',
          promptHash: 'a'.repeat(64),
          attempt: 1,
          deliveryFencingVersion: 1,
          state: 'unknown',
          httpAttempts: 1,
          estimatedCostUsd: 0.02,
          dispatches: [{ state: 'unknown_remote_outcome' }],
        },
        {
          callIndex: 2,
          operationId: 'run-1:illustration:page_1',
          operation: 'illustration',
          assetLabel: 'page_1',
          provider: 'openai',
          model: 'image-test',
          promptVersion: 'page-v1',
          promptHash: 'b'.repeat(64),
          attempt: 1,
          deliveryFencingVersion: 2,
          state: 'artifact_stored',
          httpAttempts: 2,
          inputTokens: 10,
          outputTokens: 20,
          estimatedCostUsd: 0.04,
          providerRequestId: 'req_123',
          dispatches: [{ state: 'unknown_remote_outcome' }, { state: 'artifact_stored' }],
        },
      ],
    } as Partial<GenerationRun>);

    const usage = buildRunProviderUsage(run);

    expect(usage.availability).toBe('recorded');
    if (usage.availability !== 'recorded') return;
    expect(usage.usage).toMatchObject({
      maxPaidCalls: 4,
      plannedPaidCalls: 2,
      actualPaidCalls: 2,
      actualDispatches: 3,
      unknownOutcomes: 2,
      knownInputTokens: 10,
      knownOutputTokens: 20,
      estimatedCostUsd: 0.06,
      estimatedExposureUsd: 0.1,
    });
    expect(usage.usage.calls[1]).toMatchObject({
      operationId: 'run-1:illustration:page_1',
      providerRequestId: 'req_123',
      status: 'success',
    });
  });

  it('surfaces the published edition record: models, counts, quality, resume and image failures', () => {
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
    const result = diagnose({
      book: makeBook({
        aiModelVersions: {
          story: 'gpt-4o-mini',
          image: 'gpt-image-1',
        } as unknown as Book['aiModelVersions'],
        qualityReport: {
          overallPassed: true,
          issues: [{ code: 'MINOR' }],
          repair: { attempted: true, outcome: 'passed' },
        } as unknown as Book['qualityReport'],
        imageGenerationResult: {
          generatedImageCount: 2,
          failedImageCount: 1,
          imageFailures: [failure],
        } as unknown as Book['imageGenerationResult'],
      }),
    });

    expect(result.publishedEdition).toMatchObject({
      pageCount: 2,
      generationRecord: {
        storyModel: 'gpt-4o-mini',
        imageModel: 'gpt-image-1',
        generatedImageCount: 2,
        failedImageCount: 1,
        quality: {
          passed: true,
          issueCodes: ['MINOR'],
          repairAttempted: true,
          repairSuccessful: true,
        },
        resume: null,
        imageFailures: [failure],
      },
    });
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

    expect(result.characterReferenceLoadError).toBe(CHARACTER_REFERENCE_LOAD_ERROR);
    expect(result.characterReferenceLoadError).not.toContain('b-1/character-sheet');
  });

  it('omits characterReferenceLoadError when no such failure occurred', () => {
    const result = buildCharacterPersonalizationDiagnostics(makeBook({ bookPreview: null }));

    expect(result.characterReferenceLoadError).toBeUndefined();
  });

  it('reflects hasReferencePhoto/characterProfileCreated/characterSheetGenerated from the published columns', () => {
    const result = buildCharacterPersonalizationDiagnostics(
      makeBook({
        bookPreview: null,
        characterProfile: {
          consistencyPrompt: 'Mia, ...',
          hasReferencePhoto: true,
        } as unknown as Book['characterProfile'],
        characterSheetAssetKey: 'b-1/character-sheet',
      }),
    );

    expect(result.hasReferencePhoto).toBe(true);
    expect(result.characterProfileCreated).toBe(true);
    expect(result.characterSheetGenerated).toBe(true);
  });

  it('does not report a reference photo from the current draft input alone', () => {
    // A photo uploaded after publication is draft input, not part of the edition.
    const result = buildCharacterPersonalizationDiagnostics(
      makeBook({
        bookPreview: null,
        childPhotoAssetKey: 'b-1/child-photo-v2',
        characterProfile: { hasReferencePhoto: false } as unknown as Book['characterProfile'],
      }),
    );

    expect(result.hasReferencePhoto).toBe(false);
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
