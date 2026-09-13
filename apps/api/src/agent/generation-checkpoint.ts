import type { GenerationResumeBook } from './generation-resume.service';

export interface GenerationCheckpointValue {
  version: number;
  inputHash?: unknown;
  compatibilityFingerprint?: unknown;
  runId?: unknown;
  fencingVersion?: unknown;
  content: Record<string, unknown>;
  artifacts: Record<string, Record<string, unknown>>;
  sourceCheckpoint?: unknown;
  legacy?: boolean;
}

function checkpointValue(value: unknown): GenerationCheckpointValue | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if ((record.version !== 1 && record.version !== 2) || !record.content) return null;
  if (typeof record.content !== 'object' || Array.isArray(record.content)) return null;
  return {
    version: Number(record.version),
    inputHash: record.inputHash,
    compatibilityFingerprint: record.compatibilityFingerprint,
    runId: record.runId,
    fencingVersion: record.fencingVersion,
    content: record.content as Record<string, unknown>,
    artifacts:
      record.artifacts && typeof record.artifacts === 'object' && !Array.isArray(record.artifacts)
        ? (record.artifacts as Record<string, Record<string, unknown>>)
        : {},
    sourceCheckpoint: record.sourceCheckpoint,
    ...(record.legacy === true && { legacy: true }),
  };
}

/**
 * Returns the effective candidate while retaining the current checkpoint's
 * owner. Version 2 keeps one immutable, compatibility-matched source snapshot
 * so a second takeover can finish adopting artifacts a first takeover had
 * not copied yet.
 */
export function effectiveGenerationCheckpoint(value: unknown): GenerationCheckpointValue | null {
  const current = checkpointValue(value);
  if (!current) return null;
  const source = checkpointValue(current.sourceCheckpoint);
  const compatibleSource =
    source &&
    source.inputHash === current.inputHash &&
    source.compatibilityFingerprint === current.compatibilityFingerprint
      ? source
      : null;
  return {
    ...current,
    content: { ...(compatibleSource?.content ?? {}), ...current.content },
    artifacts: { ...(compatibleSource?.artifacts ?? {}), ...current.artifacts },
  };
}

/** Candidates are independent of all reader/publication fields. */
export function checkpointBook<T extends GenerationResumeBook>(book: T): T {
  const value = effectiveGenerationCheckpoint(book.generationCheckpoint);
  if (!value) return book;
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
