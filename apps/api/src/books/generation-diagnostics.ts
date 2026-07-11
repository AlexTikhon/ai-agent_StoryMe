import type { AgentLog, Book, GenerationJob } from '@prisma/client';
import type {
  AgentLogSummary,
  AgentStep,
  CharacterPersonalizationDiagnostics,
  GenerationDiagnosticsDto,
  GenerationJobSummary,
  GenerationMetadata,
  GenerationProviderName,
  PdfStorageDiagnostics,
  QueueDiagnostics,
  ResumeDiagnostics,
} from '@book/types';
import { PRESERVE_APPEARANCE_INSTRUCTION } from '../agent/story-generation-provider';

function toProviderName(raw: string | null | undefined): GenerationProviderName {
  return raw === 'mock' || raw === 'openai' ? raw : 'unknown';
}

function generatedPageCount(bookPreview: Book['bookPreview']): number | undefined {
  const pages = (bookPreview as { pages?: unknown[] } | null)?.pages;
  return Array.isArray(pages) ? pages.length : undefined;
}

function imageCounts(imageGenerationResult: Book['imageGenerationResult']): {
  generatedImageCount?: number;
  failedImageCount?: number;
} {
  const result = imageGenerationResult as {
    generatedImageCount?: unknown;
    failedImageCount?: unknown;
  } | null;
  return {
    ...(typeof result?.generatedImageCount === 'number' && {
      generatedImageCount: result.generatedImageCount,
    }),
    ...(typeof result?.failedImageCount === 'number' && {
      failedImageCount: result.failedImageCount,
    }),
  };
}

type ImageGenerationModeValue = 'text-to-image' | 'character-reference-edit' | 'mixed';

/**
 * Reads the visual-reference-usage fields AgentService.startBookGeneration
 * writes onto Book.imageGenerationResult (see agent.service.ts). Defaults to
 * the safe "nothing happened yet" shape for books generated before this
 * phase existed, matching how pagePromptsIncludeConsistencyData already
 * defaults to false below.
 */
function characterReferenceUsage(imageGenerationResult: Book['imageGenerationResult']): {
  characterReferenceAvailable: boolean;
  characterReferenceUsedForImages: boolean;
  imageGenerationMode: ImageGenerationModeValue;
} {
  const result = imageGenerationResult as {
    characterReferenceAvailable?: unknown;
    characterReferenceUsedForImages?: unknown;
    imageGenerationMode?: unknown;
  } | null;
  const mode = result?.imageGenerationMode;
  return {
    characterReferenceAvailable: result?.characterReferenceAvailable === true,
    characterReferenceUsedForImages: result?.characterReferenceUsedForImages === true,
    imageGenerationMode:
      mode === 'character-reference-edit' || mode === 'mixed' ? mode : 'text-to-image',
  };
}

/**
 * Builds the safe, non-secret GenerationMetadata view for a book from
 * already-persisted columns (Book.generationTimeMs/aiModelVersions/
 * failedStep/errorMessage/bookPreview) plus its AgentLog rows — no new
 * storage, no schema change. `startedAt` is derived (updatedAt - durationMs)
 * since generation has no dedicated start-timestamp column.
 */
export function buildGenerationMetadata(book: Book, logs: AgentLog[]): GenerationMetadata {
  const storyLog = logs.find((log) => log.step === 'story_plan');
  const imageLog = logs.find((log) => log.step === 'image_gen');
  const aiModelVersions = book.aiModelVersions as { story?: string; image?: string } | null;
  const durationMs = book.generationTimeMs ?? undefined;
  const isTerminal = book.status === 'complete' || book.status === 'failed';
  const terminalAt = isTerminal ? book.updatedAt.toISOString() : undefined;
  const startedAt =
    durationMs !== undefined && terminalAt
      ? new Date(book.updatedAt.getTime() - durationMs).toISOString()
      : undefined;
  const storyModel = aiModelVersions?.story ?? storyLog?.model ?? undefined;
  const imageModel = aiModelVersions?.image ?? imageLog?.model ?? undefined;
  const generatedPages = generatedPageCount(book.bookPreview);
  const { generatedImageCount, failedImageCount } = imageCounts(book.imageGenerationResult);

  return {
    storyProvider: toProviderName(storyLog?.provider),
    imageProvider: toProviderName(imageLog?.provider),
    ...(storyModel && { storyModel }),
    ...(imageModel && { imageModel }),
    ...(book.pageCount != null && { requestedPages: book.pageCount }),
    ...(generatedPages !== undefined && { generatedPages }),
    ...(generatedImageCount !== undefined && { generatedImageCount }),
    ...(failedImageCount !== undefined && { failedImageCount }),
    ...(startedAt && { startedAt }),
    ...(book.status === 'complete' && terminalAt && { completedAt: terminalAt }),
    ...(book.status === 'failed' && terminalAt && { failedAt: terminalAt }),
    ...(durationMs !== undefined && { durationMs }),
    ...(book.failedStep && { failedStep: book.failedStep as unknown as AgentStep }),
    ...(book.errorMessage && { errorMessage: book.errorMessage }),
  };
}

/**
 * Builds the safe, non-secret personalized-character diagnostics view (item
 * 9 of the personalization feature): whether a reference photo exists,
 * whether a CharacterProfile was created, whether a character-sheet
 * reference image was generated, and — verified by construction rather than
 * just inferred from characterProfile's presence — whether every planned
 * page's illustration prompt actually includes the character-consistency
 * instructions built in story-generation-provider.ts.
 */
export function buildCharacterPersonalizationDiagnostics(
  book: Book,
): CharacterPersonalizationDiagnostics {
  const pages = (book.bookPreview as { pages?: unknown[] } | null)?.pages;
  const pagePromptsIncludeConsistencyData =
    Array.isArray(pages) &&
    pages.length > 0 &&
    pages.every((page) => {
      const prompt = (page as { illustrationPrompt?: unknown } | null)?.illustrationPrompt;
      return typeof prompt === 'string' && prompt.includes(PRESERVE_APPEARANCE_INSTRUCTION);
    });

  return {
    hasReferencePhoto: book.childPhotoAssetKey != null,
    characterProfileCreated: book.characterProfile != null,
    characterSheetGenerated: book.characterSheetAssetKey != null,
    pagePromptsIncludeConsistencyData,
    ...characterReferenceUsage(book.imageGenerationResult),
  };
}

/**
 * Reads the idempotent-resume diagnostics AgentService.startBookGeneration
 * folds onto Book.imageGenerationResult.resume (see ResumeDiagnostics,
 * agent.service.ts) — null for books generated before this feature existed,
 * or whose most recent run never reached the point of computing it.
 */
function buildResumeDiagnostics(
  imageGenerationResult: Book['imageGenerationResult'],
): ResumeDiagnostics | null {
  const resume = (imageGenerationResult as { resume?: unknown } | null)?.resume;
  return resume ? (resume as ResumeDiagnostics) : null;
}

function toAgentLogSummary(log: AgentLog): AgentLogSummary {
  return {
    step: log.step as AgentLogSummary['step'],
    status: log.status as AgentLogSummary['status'],
    provider: log.provider,
    model: log.model,
    durationMs: log.durationMs,
    attempt: log.attempt,
    error: log.error,
    traceId: log.traceId,
    createdAt: log.createdAt.toISOString(),
  };
}

/** Maps a GenerationJob row (Phase 3I) to its safe diagnostics summary — never exposes runnerId. */
function toGenerationJobSummary(job: GenerationJob): GenerationJobSummary {
  return {
    id: job.id,
    type: job.type as unknown as GenerationJobSummary['type'],
    status: job.status as unknown as GenerationJobSummary['status'],
    attempt: job.attempt,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    ...(job.startedAt && { startedAt: job.startedAt.toISOString() }),
    ...(job.completedAt && { completedAt: job.completedAt.toISOString() }),
    ...(job.failedAt && { failedAt: job.failedAt.toISOString() }),
    ...(job.failedStep && { failedStep: job.failedStep as unknown as AgentStep }),
    ...(job.errorMessage && { errorMessage: job.errorMessage }),
  };
}

/**
 * Composes the full GET /books/:id/generation-diagnostics response from a
 * Book row, its AgentLog rows, and (Phase 3I) its latest GenerationJob row.
 * `latestJob` is optional/nullable since a book may predate job tracking or
 * never have started generation. `pdfStorage` is optional purely so this
 * pure function stays easy to unit test without a real PdfStorage — the real
 * caller (BooksService.getGenerationDiagnostics) always computes and passes
 * it (see pdf-storage.ts's `previewPdfExists`).
 */
const ACTIVE_JOB_STATUSES = new Set(['queued', 'running']);

export function buildGenerationDiagnostics(
  book: Book,
  logs: AgentLog[],
  latestJob?: GenerationJob | null,
  pdfStorage?: PdfStorageDiagnostics,
  queue?: Omit<QueueDiagnostics, 'stalledNoWorker'>,
): GenerationDiagnosticsDto {
  const resolvedQueue = queue ?? {
    queueName: 'book-generation',
    workerCount: 0,
    counts: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
  };
  return {
    bookId: book.id,
    status: book.status as unknown as GenerationDiagnosticsDto['status'],
    failedStep: book.failedStep as unknown as AgentStep | null,
    errorMessage: book.errorMessage,
    generationMetadata: buildGenerationMetadata(book, logs),
    recentLogs: logs.map(toAgentLogSummary),
    previewPdfUrl: book.previewPdfUrl,
    latestJob: latestJob ? toGenerationJobSummary(latestJob) : null,
    pdfStorage: pdfStorage ?? {
      driver: 'local',
      keyPresent: book.previewPdfUrl != null,
      previewAvailable: false,
    },
    queue: {
      ...resolvedQueue,
      stalledNoWorker:
        !!latestJob && ACTIVE_JOB_STATUSES.has(latestJob.status) && resolvedQueue.workerCount === 0,
    },
    characterPersonalization: buildCharacterPersonalizationDiagnostics(book),
    resume: buildResumeDiagnostics(book.imageGenerationResult),
  };
}
