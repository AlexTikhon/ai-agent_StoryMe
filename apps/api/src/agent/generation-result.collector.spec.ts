import { describe, expect, it } from 'vitest';
import type {
  GeneratedImageEntry,
  GenerationProviderUsage,
  ImageGenerationResult,
} from '@book/types';
import { AgentLogStatus, AgentStep, BookStatus } from '@prisma/client';
import { GenerationResultCollector } from './generation-result.collector';

const collector = new GenerationResultCollector();
const providerUsage: GenerationProviderUsage = {
  maxPaidCalls: 17,
  plannedPaidCalls: 0,
  actualPaidCalls: 0,
  estimatedCostUsd: 0,
  calls: [],
};

function image(id: string, kind: GeneratedImageEntry['kind'], pageNumber?: number) {
  return {
    id,
    kind,
    ...(pageNumber !== undefined && { pageNumber }),
    prompt: id,
    provider: 'local_mock' as const,
    status: 'complete' as const,
    imageUrl: `/mock/${id}`,
    altText: id,
    width: 1024,
    height: 1024,
    seed: id,
  };
}

function imageResult(images = [image('cover', 'cover')]): ImageGenerationResult {
  return {
    provider: 'local_mock',
    status: 'complete',
    images,
    createdAt: '2026-07-24T00:00:00.000Z',
  };
}

describe('GenerationResultCollector', () => {
  it('collects an early story failure with character progress and truthful logs', () => {
    const outcome = collector.collectStoryFailureOutcome({
      bookId: 'book-1',
      traceId: 'trace-1',
      generationTimeMs: 45,
      aiModelVersions: { story: 'story-model', image: 'image-model' },
      characterProfileUpdateData: { characterSheetAssetKey: 'sheet-key' },
      charBuildResult: {
        characterProfile: {} as never,
        providerName: 'mock',
        modelName: null,
        durationMs: 10,
      },
      storyProviderName: 'openai',
      storyModelName: 'story-model',
      errorMessage: 'story provider failed',
    });

    expect(outcome).toMatchObject({
      status: BookStatus.failed,
      completedStep: AgentStep.story_plan,
      errorCode: 'GENERATION_FAILED',
      errorMessage: 'story provider failed',
      failedStep: AgentStep.story_plan,
      bookUpdate: {
        generationTimeMs: 45,
        characterSheetAssetKey: 'sheet-key',
      },
    });
    expect(outcome.agentLogs).toEqual([
      expect.objectContaining({
        step: AgentStep.char_build,
        status: AgentLogStatus.success,
      }),
      expect.objectContaining({
        step: AgentStep.story_plan,
        status: AgentLogStatus.error,
        error: 'story provider failed',
        durationMs: 45,
      }),
    ]);
  });

  it('collects a privacy-safe quality failure before image generation', () => {
    const qualityReport = {
      version: 1 as const,
      overallPassed: false,
      issues: [
        {
          code: 'metadata_theme_mismatch' as const,
          category: 'alignment' as const,
          severity: 'error' as const,
          repairable: true,
          message: 'Generated theme metadata does not match the requested theme.',
        },
      ],
      flaggedPages: [],
    };

    const outcome = collector.collectQualityFailureOutcome({
      bookId: 'book-1',
      traceId: 'trace-1',
      generationTimeMs: 50,
      aiModelVersions: { story: 'story-model', image: 'image-model' },
      characterProfileUpdateData: { characterSheetAssetKey: 'sheet-key' },
      charBuildResult: {
        characterProfile: {} as never,
        providerName: 'mock',
        modelName: null,
        durationMs: 10,
      },
      storyProviderName: 'openai',
      storyModelName: 'story-model',
      storyDurationMs: 30,
      qualityDurationMs: 2,
      qualityReport,
    });

    expect(outcome).toMatchObject({
      status: BookStatus.failed,
      completedStep: AgentStep.qa_review,
      failedStep: AgentStep.qa_review,
      errorCode: 'QUALITY_REVIEW_FAILED',
      bookUpdate: { qualityReport },
    });
    expect(outcome.errorMessage).toBe(
      'Generated story did not pass deterministic quality review (1 finding(s)).',
    );
    expect(outcome.agentLogs).toHaveLength(3);
    expect(outcome.agentLogs.at(-1)).toMatchObject({
      step: AgentStep.qa_review,
      status: AgentLogStatus.error,
      durationMs: 2,
      error: 'Generated story did not pass deterministic quality review (1 finding(s)).',
    });
    expect(JSON.stringify(outcome)).not.toContain('Mia');
  });

  it('folds image counters and provider telemetry while preserving prior reuse signals', () => {
    const result = collector.collectImageResult({
      result: {
        ...imageResult(),
        characterReferenceAvailable: true,
        characterReferenceUsedForImages: true,
        imageGenerationMode: 'character-reference-edit',
        characterReferenceLoadError: 'stale error',
      },
      imageProviderName: 'openai',
      reusableImageCount: 1,
      attemptedImageCount: 0,
      generation: {
        generatedCount: 0,
        failedCount: 0,
        usedCharacterReference: false,
        failures: [],
      },
      characterReferenceAvailable: false,
      characterReferenceSupplied: false,
      providerUsage,
    });

    expect(result).toMatchObject({
      imageByteProvider: 'openai',
      generatedImageCount: 1,
      failedImageCount: 0,
      characterReferenceAvailable: true,
      characterReferenceUsedForImages: true,
      imageGenerationMode: 'character-reference-edit',
      imageFailures: [],
      providerUsage,
    });
    expect(result.characterReferenceLoadError).toBeUndefined();
  });

  it('reports reference-edit mode when every attempted referenced image failed', () => {
    const result = collector.collectImageResult({
      result: imageResult(),
      imageProviderName: 'openai',
      reusableImageCount: 0,
      attemptedImageCount: 1,
      generation: {
        generatedCount: 0,
        failedCount: 1,
        lastError: 'provider rejected image',
        usedCharacterReference: false,
        failures: [],
      },
      characterReferenceAvailable: true,
      characterReferenceSupplied: true,
      characterReferenceLoadError: 'read warning',
      providerUsage,
    });

    expect(result.imageGenerationMode).toBe('character-reference-edit');
    expect(result.lastImageError).toBe('provider rejected image');
    expect(result.characterReferenceLoadError).toBe('read warning');
  });

  it('assembles stable resume asset diagnostics', () => {
    const cover = image('cover', 'cover');
    const page = image('page-1', 'page', 1);

    expect(
      collector.collectResumeDiagnostics({
        resumable: true,
        images: [cover, page],
        priorSheetStatus: 'valid',
        pdfStatusBefore: 'invalid',
        reusableImages: [cover],
        missingImagesBefore: [page],
        invalidImagesBefore: [],
        generatedImageCount: 1,
        skippedStoryGeneration: true,
        skippedCharacterProfileGeneration: true,
        skippedCharacterSheetGeneration: true,
        missingAssetsAfterRetry: ['pdf'],
        pdfRenderSucceeded: false,
        finalBookStatus: BookStatus.failed,
      }),
    ).toEqual({
      resumeMode: true,
      requiredAssets: ['character_sheet', 'cover', 'page_1', 'pdf'],
      validExistingAssets: ['character_sheet', 'cover'],
      missingAssetsBeforeRetry: ['page_1'],
      invalidAssetsBeforeRetry: ['pdf'],
      reusedImageCount: 1,
      regeneratedImageCount: 1,
      skippedStoryGeneration: true,
      skippedCharacterProfileGeneration: true,
      skippedCharacterSheetGeneration: true,
      skippedExistingImageGeneration: true,
      missingAssetsAfterRetry: ['pdf'],
      pdfRenderAttempted: true,
      pdfRenderSucceeded: false,
      finalBookStatus: BookStatus.failed,
    });
  });

  it('collects a successful outcome and its complete agent-log batch', () => {
    const outcome = collector.collectOutcome({
      bookId: 'book-1',
      traceId: 'trace-1',
      generationTimeMs: 120,
      aiModelVersions: { story: 'story-model', image: 'image-model' },
      imageGenerationResult: imageResult(),
      previewPdfUrl: '/preview.pdf',
      finalStatus: BookStatus.complete,
      charBuildResult: {
        characterProfile: {} as never,
        providerName: 'mock',
        modelName: null,
        durationMs: 10,
      },
      storyProviderName: 'mock',
      storyModelName: null,
      imageProviderName: 'mock',
      imageModelName: null,
      storyDurationMs: 20,
      qualityDurationMs: 5,
      imageDurationMs: 30,
      layoutDurationMs: 40,
      pdfDurationMs: 50,
      failedImageCount: 0,
      attemptedImageCount: 1,
      layoutStep: AgentStep.layout,
      pdfStep: AgentStep.pdf_render,
    });

    expect(outcome.status).toBe(BookStatus.complete);
    expect(outcome.bookUpdate).toMatchObject({
      generationTimeMs: 120,
      previewPdfUrl: '/preview.pdf',
    });
    expect(outcome.agentLogs).toHaveLength(10);
    expect(outcome.agentLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          step: AgentStep.qa_review,
          status: AgentLogStatus.success,
        }),
      ]),
    );
    expect(outcome.agentLogs.at(-1)).toMatchObject({
      step: AgentStep.pdf_render,
      status: AgentLogStatus.success,
    });
  });

  it('collects truthful image and PDF errors in a failed outcome', () => {
    const outcome = collector.collectOutcome({
      bookId: 'book-1',
      traceId: 'trace-1',
      generationTimeMs: 120,
      aiModelVersions: { story: 'story-model', image: 'image-model' },
      imageGenerationResult: imageResult(),
      previewPdfUrl: null,
      finalStatus: BookStatus.failed,
      pdfRenderError: 'missing page image',
      charBuildResult: {
        characterProfile: {} as never,
        providerName: 'mock',
        modelName: null,
        durationMs: 10,
      },
      storyProviderName: 'mock',
      storyModelName: null,
      imageProviderName: 'openai',
      imageModelName: 'gpt-image',
      storyDurationMs: 20,
      qualityDurationMs: 5,
      imageDurationMs: 30,
      layoutDurationMs: 40,
      pdfDurationMs: 50,
      failedImageCount: 1,
      attemptedImageCount: 2,
      layoutStep: AgentStep.layout,
      pdfStep: AgentStep.pdf_render,
    });

    expect(outcome).toMatchObject({
      status: BookStatus.failed,
      errorCode: 'GENERATION_FAILED',
      errorMessage: 'missing page image',
      failedStep: AgentStep.pdf_render,
    });
    expect(outcome.agentLogs.find(({ step }) => step === AgentStep.image_gen)).toMatchObject({
      status: AgentLogStatus.error,
      error: expect.stringContaining('1 of 2 attempted image(s) failed'),
    });
    expect(outcome.agentLogs.at(-1)).toMatchObject({
      status: AgentLogStatus.error,
      error: 'missing page image',
    });
  });
});
