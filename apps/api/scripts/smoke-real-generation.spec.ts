import { describe, it, expect } from 'vitest';
import type { GenerationDiagnosticsDto } from '@book/types';
import {
  checkPreconditions,
  formatDiagnosticsSummary,
  resolveSmokeBookConfig,
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
  function makeDiagnostics(overrides: Partial<GenerationDiagnosticsDto> = {}): GenerationDiagnosticsDto {
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
  });

  it('includes generated/failed image counts and the diagnostics URL', () => {
    const summary = formatDiagnosticsSummary(makeDiagnostics());

    expect(summary).toContain('Generated images:   8');
    expect(summary).toContain('Failed images:      0');
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
});

describe('resolveSmokeBookConfig', () => {
  it('falls back to safe defaults when no SMOKE_* env vars are set', () => {
    const config = resolveSmokeBookConfig({} as NodeJS.ProcessEnv);

    expect(config).toEqual({
      childName: 'Smoke',
      childAge: 5,
      language: 'en',
      theme: 'friendship',
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
    expect(config.pageCount).toBeUndefined();
  });
});
