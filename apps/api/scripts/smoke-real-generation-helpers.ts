import type { GenerationDiagnosticsDto } from '@book/types';

/**
 * Formats a GenerationDiagnosticsDto (already safe/non-secret — see
 * generation-diagnostics.ts) into the smoke script's console summary. Pure
 * function so it's unit-testable without booting Nest or hitting the network.
 * Only ever prints fields already proven safe by GenerationDiagnosticsDto/
 * GenerationMetadata — never an API key or a raw prompt.
 */
export function formatDiagnosticsSummary(diagnostics: GenerationDiagnosticsDto): string {
  const meta = diagnostics.generationMetadata;
  const lines = [
    `  Book id:            ${diagnostics.bookId}`,
    `  Status:             ${diagnostics.status}`,
    `  Story provider:     ${meta.storyProvider}${meta.storyModel ? ` (${meta.storyModel})` : ''}`,
    `  Image provider:     ${meta.imageProvider}${meta.imageModel ? ` (${meta.imageModel})` : ''}`,
    `  Generated pages:    ${meta.generatedPages ?? 'n/a'}`,
    `  Generated images:   ${meta.generatedImageCount ?? 'n/a'}`,
    `  Failed images:      ${meta.failedImageCount ?? 'n/a'}`,
    `  Duration:           ${meta.durationMs !== undefined ? `${meta.durationMs}ms` : 'n/a'}`,
    `  PDF preview url:    ${diagnostics.previewPdfUrl ?? 'n/a'}`,
    `  Character sheet:    ${diagnostics.characterPersonalization.characterSheetGenerated ? 'generated' : 'not generated'}`,
    `  Reference available:${diagnostics.characterPersonalization.characterReferenceAvailable ? ' yes' : ' no'}`,
    `  Reference used:     ${diagnostics.characterPersonalization.characterReferenceUsedForImages ? 'yes' : 'no'}`,
    `  Image gen mode:     ${diagnostics.characterPersonalization.imageGenerationMode}`,
    `  Diagnostics URL:    /api/books/${diagnostics.bookId}/generation-diagnostics`,
  ];
  if (diagnostics.failedStep) {
    lines.push(`  Failed step:        ${diagnostics.failedStep}`);
  }
  if (diagnostics.errorMessage) {
    lines.push(`  Error:              ${diagnostics.errorMessage}`);
  }
  return lines.join('\n');
}

/** Resolved, ready-to-use local QA book configuration — every field has a safe default. */
export interface SmokeBookConfig {
  childName: string;
  childAge: number;
  language: string;
  theme: string;
  pageCount?: number;
  /** Optional local filesystem path to a jpg/png/webp reference photo of the child. */
  childPhotoPath?: string;
}

const DEFAULT_SMOKE_CHILD_NAME = 'Smoke';
const DEFAULT_SMOKE_CHILD_AGE = 5;
const DEFAULT_SMOKE_LANGUAGE = 'en';
const DEFAULT_SMOKE_THEME = 'friendship';

/**
 * Reads the optional SMOKE_CHILD_NAME / SMOKE_CHILD_AGE / SMOKE_LANGUAGE /
 * SMOKE_THEME / SMOKE_PAGE_COUNT / SMOKE_CHILD_PHOTO_PATH env vars, falling
 * back to safe defaults for any that are unset or malformed. Pure function —
 * no filesystem or network access — so it's unit-testable directly.
 */
export function resolveSmokeBookConfig(env: NodeJS.ProcessEnv): SmokeBookConfig {
  const childName = env['SMOKE_CHILD_NAME']?.trim() || DEFAULT_SMOKE_CHILD_NAME;
  const parsedAge = env['SMOKE_CHILD_AGE'] ? Number(env['SMOKE_CHILD_AGE']) : NaN;
  const childAge =
    Number.isFinite(parsedAge) && parsedAge > 0 ? Math.floor(parsedAge) : DEFAULT_SMOKE_CHILD_AGE;
  const language = env['SMOKE_LANGUAGE']?.trim() || DEFAULT_SMOKE_LANGUAGE;
  const theme = env['SMOKE_THEME']?.trim() || DEFAULT_SMOKE_THEME;
  const parsedPageCount = env['SMOKE_PAGE_COUNT'] ? Number(env['SMOKE_PAGE_COUNT']) : NaN;
  const pageCount =
    Number.isFinite(parsedPageCount) && parsedPageCount > 0
      ? Math.floor(parsedPageCount)
      : undefined;
  const childPhotoPath = env['SMOKE_CHILD_PHOTO_PATH']?.trim() || undefined;

  return {
    childName,
    childAge,
    language,
    theme,
    ...(pageCount !== undefined && { pageCount }),
    ...(childPhotoPath !== undefined && { childPhotoPath }),
  };
}

/** Returns a clear message (never null) when preconditions aren't met, so main() can fail fast before booting Nest. */
export function checkPreconditions(env: NodeJS.ProcessEnv): string | null {
  if (!env['OPENAI_API_KEY']) {
    return 'OPENAI_API_KEY is required to run the real generation smoke test.';
  }

  const storyProvider = env['STORY_GENERATION_PROVIDER']?.trim().toLowerCase();
  const imageProvider = env['IMAGE_GENERATION_PROVIDER']?.trim().toLowerCase();
  if (storyProvider !== 'openai' || imageProvider !== 'openai') {
    return [
      'STORY_GENERATION_PROVIDER and IMAGE_GENERATION_PROVIDER must both be "openai" to run this smoke test.',
      `  STORY_GENERATION_PROVIDER=${storyProvider ?? '(unset)'}`,
      `  IMAGE_GENERATION_PROVIDER=${imageProvider ?? '(unset)'}`,
      'Set both to "openai" and re-run. This script never runs against mock providers — that path is already covered by the normal test suite.',
    ].join('\n');
  }

  return null;
}
