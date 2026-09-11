import type { GenerationResumeBook } from './generation-resume.service';

/** Candidates are independent of all reader/publication fields. */
export function checkpointBook<T extends GenerationResumeBook>(book: T): T {
  const checkpoint = book.generationCheckpoint;
  if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) return book;
  const value = checkpoint as Record<string, unknown>;
  if (value.version !== 1 || !value.content || typeof value.content !== 'object') return book;
  return {
    ...book,
    // Missing candidate fields mean unfinished work, never a fallback to reader content.
    characterCard: null,
    characterProfile: null,
    storyPlan: null,
    bookPreview: null,
    imageGenerationResult: null,
    bookLayout: null,
    characterSheetAssetKey: null,
    ...value.content,
    id: book.id,
    lastGenerationInputHash: value.inputHash,
    lastGenerationCompatibilityFingerprint: value.compatibilityFingerprint,
    lastGenerationRunId: value.runId,
    lastGenerationFencingVersion: value.fencingVersion,
  } as T;
}
