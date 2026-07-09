import type { GenerationDiagnosticsDto } from '@book/types';

/**
 * Formats a GenerationDiagnosticsDto (already safe/non-secret — see
 * generation-diagnostics.ts) into the smoke script's console summary. Pure
 * function so it's unit-testable without booting Nest or hitting the network.
 */
export function formatDiagnosticsSummary(diagnostics: GenerationDiagnosticsDto): string {
  const meta = diagnostics.generationMetadata;
  const lines = [
    `  Book id:          ${diagnostics.bookId}`,
    `  Status:           ${diagnostics.status}`,
    `  Story provider:   ${meta.storyProvider}${meta.storyModel ? ` (${meta.storyModel})` : ''}`,
    `  Image provider:   ${meta.imageProvider}${meta.imageModel ? ` (${meta.imageModel})` : ''}`,
    `  Generated pages:  ${meta.generatedPages ?? 'n/a'}`,
    `  Duration:         ${meta.durationMs !== undefined ? `${meta.durationMs}ms` : 'n/a'}`,
    `  PDF preview url:  ${diagnostics.previewPdfUrl ?? 'n/a'}`,
  ];
  if (diagnostics.failedStep) {
    lines.push(`  Failed step:      ${diagnostics.failedStep}`);
  }
  if (diagnostics.errorMessage) {
    lines.push(`  Error:            ${diagnostics.errorMessage}`);
  }
  return lines.join('\n');
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
