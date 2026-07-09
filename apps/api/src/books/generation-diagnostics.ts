import type { AgentLog, Book, GenerationJob } from '@prisma/client';
import type {
  AgentLogSummary,
  AgentStep,
  GenerationDiagnosticsDto,
  GenerationJobSummary,
  GenerationMetadata,
  GenerationProviderName,
  PdfStorageDiagnostics,
  QueueDiagnostics,
} from '@book/types';

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
        !!latestJob &&
        ACTIVE_JOB_STATUSES.has(latestJob.status) &&
        resolvedQueue.workerCount === 0,
    },
  };
}
