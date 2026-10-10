import { describe, it, expect, vi } from 'vitest';
import type { GenerationDiagnosticsDto } from '@book/types';
import {
  DEFAULT_SMOKE_TIMEOUT_MS,
  checkPreconditions,
  formatDiagnosticsSummary,
  loadSmokePhoto,
  parseSmokeLanguage,
  resolveSmokeBookConfig,
  resolveSmokeTimeoutMs,
  type SmokeValidationExtras,
} from './smoke-real-generation-helpers';

describe('checkPreconditions', () => {
  it('requires OPENAI_API_KEY', () => {
    const message = checkPreconditions({} as NodeJS.ProcessEnv);
    expect(message).toMatch(/OPENAI_API_KEY/);
  });

  it('requires both providers to be "openai"', () => {
    const message = checkPreconditions({
      OPENAI_API_KEY: 'sk-test',
    } as unknown as NodeJS.ProcessEnv);
    expect(message).toMatch(/STORY_GENERATION_PROVIDER/);
    expect(message).toMatch(/IMAGE_GENERATION_PROVIDER/);
  });

  it('requires the image provider to be "openai" even if the story provider is', () => {
    const message = checkPreconditions({
      OPENAI_API_KEY: 'sk-test',
      STORY_GENERATION_PROVIDER: 'openai',
    } as unknown as NodeJS.ProcessEnv);
    expect(message).not.toBeNull();
  });

  it('returns null when every precondition is satisfied', () => {
    const message = checkPreconditions({
      OPENAI_API_KEY: 'sk-test',
      STORY_GENERATION_PROVIDER: 'openai',
      IMAGE_GENERATION_PROVIDER: 'openai',
    } as unknown as NodeJS.ProcessEnv);
    expect(message).toBeNull();
  });

  it('never includes the API key value in the returned message', () => {
    const message = checkPreconditions({
      OPENAI_API_KEY: 'sk-super-secret',
    } as unknown as NodeJS.ProcessEnv);
    expect(message).not.toContain('sk-super-secret');
  });
});

describe('formatDiagnosticsSummary', () => {
  function makeDiagnostics(
    overrides: Partial<GenerationDiagnosticsDto> = {},
  ): GenerationDiagnosticsDto {
    return {
      bookId: 'b-1',
      status: 'complete' as GenerationDiagnosticsDto['status'],
      generationMetadata: {
        storyProvider: 'openai',
        imageProvider: 'openai',
        storyModel: 'gpt-4o-mini',
        imageModel: 'gpt-image-1',
        generatedPages: 6,
        generatedImageCount: 8,
        failedImageCount: 0,
        durationMs: 12_345,
      },
      recentLogs: [],
      previewPdfUrl: '/files/books/b-1/storybook.pdf',
      pdfStorage: { driver: 'local', keyPresent: true, previewAvailable: true },
      queue: {
        queueName: 'book-generation',
        workerCount: 1,
        counts: { waiting: 0, active: 0, completed: 1, failed: 0, delayed: 0 },
        stalledNoWorker: false,
      },
      characterPersonalization: {
        hasReferencePhoto: true,
        characterProfileCreated: true,
        characterSheetGenerated: true,
        pagePromptsIncludeConsistencyData: true,
        characterReferenceAvailable: true,
        characterReferenceUsedForImages: true,
        imageGenerationMode: 'character-reference-edit',
      },
      resume: null,
      imageFailures: [],
      providerUsage: null,
      ...overrides,
    };
  }

  function makeExtras(overrides: Partial<SmokeValidationExtras> = {}): SmokeValidationExtras {
    return {
      expectedImageCount: 8,
      fallbackImageCount: 0,
      characterSheetAssetId: 'b-1/character-sheet',
      characterProfileProvider: 'openai',
      pdfExists: true,
      pdfSizeBytes: 123_456,
      ...overrides,
    };
  }

  it('includes book id, status, providers, models, page count, duration, and PDF url', () => {
    const summary = formatDiagnosticsSummary(makeDiagnostics());

    expect(summary).toContain('b-1');
    expect(summary).toContain('complete');
    expect(summary).toContain('openai');
    expect(summary).toContain('gpt-4o-mini');
    expect(summary).toContain('gpt-image-1');
    expect(summary).toContain('6');
    expect(summary).toContain('12345ms');
    expect(summary).toContain('/files/books/b-1/storybook.pdf');
    expect(summary).toContain('Reference available: yes');
    expect(summary).toContain('Reference used:     yes');
    expect(summary).toContain('character-reference-edit');
  });

  it('includes generated/failed image counts and the diagnostics URL', () => {
    const summary = formatDiagnosticsSummary(makeDiagnostics());

    expect(summary).toContain('Generated images:   8');
    expect(summary).toContain('Fallback images:    0');
    expect(summary).toContain('/api/books/b-1/generation-diagnostics');
  });

  it('includes failedStep and errorMessage when the run failed', () => {
    const summary = formatDiagnosticsSummary(
      makeDiagnostics({
        status: 'failed' as GenerationDiagnosticsDto['status'],
        failedStep: 'image_gen' as GenerationDiagnosticsDto['failedStep'],
        errorMessage: 'OpenAI image request failed with status 401',
      }),
    );

    expect(summary).toContain('image_gen');
    expect(summary).toContain('OpenAI image request failed with status 401');
  });

  it('never includes an API key, raw prompt, or base64 image payload', () => {
    const summary = formatDiagnosticsSummary(
      makeDiagnostics({
        errorMessage: 'request failed with status 401',
      }),
    );

    expect(summary).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(summary.toLowerCase()).not.toContain('b64_json');
    expect(summary.toLowerCase()).not.toContain('base64');
  });

  it('falls back to "n/a" fields when extras are omitted', () => {
    const summary = formatDiagnosticsSummary(makeDiagnostics());

    expect(summary).toContain('Char. profile prov.: n/a');
    expect(summary).toContain('Expected images:    n/a');
    expect(summary).toContain('PDF exists:         n/a');
    expect(summary).toContain('PDF size > 0:       n/a');
    expect(summary).toContain('Char. sheet asset:  n/a');
  });

  it('includes expected/fallback image counts, character-sheet asset id, profile provider, and PDF exists/size when extras are given', () => {
    const summary = formatDiagnosticsSummary(makeDiagnostics(), makeExtras());

    expect(summary).toContain('Char. profile prov.: openai');
    expect(summary).toContain('Expected images:    8');
    expect(summary).toContain('Fallback images:    0');
    expect(summary).toContain('Char. sheet asset:  b-1/character-sheet');
    expect(summary).toContain('PDF exists:         yes');
    expect(summary).toContain('PDF size > 0:       yes (123456 bytes)');
  });

  it('reports PDF size 0 as "no" rather than a falsy omission', () => {
    const summary = formatDiagnosticsSummary(
      makeDiagnostics(),
      makeExtras({ pdfExists: true, pdfSizeBytes: 0 }),
    );

    expect(summary).toContain('PDF size > 0:       no (0 bytes)');
  });

  it('never includes an asset id that looks like a raw filesystem path', () => {
    const summary = formatDiagnosticsSummary(makeDiagnostics(), makeExtras());

    expect(summary).not.toMatch(/[A-Za-z]:\\/);
    expect(summary).not.toContain('tmp\\images');
    expect(summary).not.toContain('tmp/images');
  });
});

describe('resolveSmokeBookConfig', () => {
  it('falls back to safe defaults when no SMOKE_* env vars are set, including pageCount=4 (MIN_BOOK_PAGE_COUNT)', () => {
    const config = resolveSmokeBookConfig({} as NodeJS.ProcessEnv);

    expect(config).toEqual({
      childName: 'Smoke',
      childAge: 5,
      language: 'en',
      theme: 'friendship',
      pageCount: 4,
    });
  });

  it('reads childName/age/language/theme/pageCount/photo path from env vars', () => {
    const config = resolveSmokeBookConfig({
      SMOKE_CHILD_NAME: 'Mia',
      SMOKE_CHILD_AGE: '3',
      SMOKE_LANGUAGE: 'ru',
      SMOKE_THEME: 'a trip to the sea',
      SMOKE_PAGE_COUNT: '8',
      SMOKE_CHILD_PHOTO_PATH: '/tmp/mia.jpg',
    } as unknown as NodeJS.ProcessEnv);

    expect(config).toEqual({
      childName: 'Mia',
      childAge: 3,
      language: 'ru',
      theme: 'a trip to the sea',
      pageCount: 8,
      childPhotoPath: '/tmp/mia.jpg',
    });
  });

  it('ignores a malformed SMOKE_CHILD_AGE/SMOKE_PAGE_COUNT and falls back to defaults', () => {
    const config = resolveSmokeBookConfig({
      SMOKE_CHILD_AGE: 'not-a-number',
      SMOKE_PAGE_COUNT: '-3',
    } as unknown as NodeJS.ProcessEnv);

    expect(config.childAge).toBe(5);
    expect(config.pageCount).toBe(4);
  });
});

describe('resolveSmokeTimeoutMs', () => {
  it('defaults when unset, malformed or non-positive', () => {
    expect(resolveSmokeTimeoutMs({} as NodeJS.ProcessEnv)).toBe(DEFAULT_SMOKE_TIMEOUT_MS);
    for (const bad of ['abc', '0', '-5']) {
      expect(resolveSmokeTimeoutMs({ SMOKE_TIMEOUT_MS: bad } as unknown as NodeJS.ProcessEnv)).toBe(
        DEFAULT_SMOKE_TIMEOUT_MS,
      );
    }
  });

  it('reads a positive SMOKE_TIMEOUT_MS', () => {
    expect(
      resolveSmokeTimeoutMs({ SMOKE_TIMEOUT_MS: '90000' } as unknown as NodeJS.ProcessEnv),
    ).toBe(90_000);
  });
});

describe('loadSmokePhoto', () => {
  it('maps the extension to a content type and returns the file bytes', () => {
    const readFile = vi.fn(() => Buffer.from('bytes'));
    expect(loadSmokePhoto('/tmp/mia.JPG', readFile)).toEqual({
      buffer: Buffer.from('bytes'),
      contentType: 'image/jpeg',
    });
    expect(loadSmokePhoto('/tmp/mia.webp', readFile).contentType).toBe('image/webp');
  });

  it('rejects an unsupported extension before reading the file', () => {
    const readFile = vi.fn(() => Buffer.from('bytes'));
    expect(() => loadSmokePhoto('/tmp/mia.gif', readFile)).toThrow(
      'SMOKE_CHILD_PHOTO_PATH must point to',
    );
    expect(readFile).not.toHaveBeenCalled();
  });
});

describe('parseSmokeLanguage', () => {
  it('accepts supported languages and rejects others', () => {
    expect(parseSmokeLanguage('ru')).toBe('ru');
    expect(() => parseSmokeLanguage('xx')).toThrow(/SMOKE_LANGUAGE/);
  });
});
