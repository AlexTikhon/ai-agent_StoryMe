import type { AgentLog, Book } from '@prisma/client';
import type {
  AgentLogSummary,
  AgentStep,
  GenerationDiagnosticsDto,
  GenerationMetadata,
  GenerationProviderName,
} from '@book/types';

function toProviderName(raw: string | null | undefined): GenerationProviderName {
  return raw === 'mock' || raw === 'openai' ? raw : 'unknown';
}

function generatedPageCount(bookPreview: Book['bookPreview']): number | undefined {
  const pages = (bookPreview as { pages?: unknown[] } | null)?.pages;
  return Array.isArray(pages) ? pages.length : undefined;
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

  return {
    storyProvider: toProviderName(storyLog?.provider),
    imageProvider: toProviderName(imageLog?.provider),
    ...(storyModel && { storyModel }),
    ...(imageModel && { imageModel }),
    ...(book.pageCount != null && { requestedPages: book.pageCount }),
    ...(generatedPages !== undefined && { generatedPages }),
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

/** Composes the full GET /books/:id/generation-diagnostics response from a Book row and its AgentLog rows. */
export function buildGenerationDiagnostics(
  book: Book,
  logs: AgentLog[],
): GenerationDiagnosticsDto {
  return {
    bookId: book.id,
    status: book.status as unknown as GenerationDiagnosticsDto['status'],
    failedStep: book.failedStep as unknown as AgentStep | null,
    errorMessage: book.errorMessage,
    generationMetadata: buildGenerationMetadata(book, logs),
    recentLogs: logs.map(toAgentLogSummary),
    previewPdfUrl: book.previewPdfUrl,
  };
}
