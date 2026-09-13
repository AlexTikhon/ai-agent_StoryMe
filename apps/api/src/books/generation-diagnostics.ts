import type { AgentLog, Book, GenerationRun, Prisma } from '@prisma/client';
import type {
  AgentLogSummary,
  AgentStep,
  CharacterPersonalizationDiagnostics,
  GenerationDiagnosticsDto,
  GenerationJobSummary,
  GenerationMetadata,
  GenerationProviderName,
  GenerationProviderCallMetadata,
  GenerationProviderUsage,
  ImageGenerationFailureDetail,
  PdfStorageDiagnostics,
  QueueDiagnostics,
  ResumeDiagnostics,
} from '@book/types';
import { countAuthorizedDispatches } from '../agent/generation-execution-policy';
import { PRESERVE_APPEARANCE_INSTRUCTION } from '../agent/story-generation-provider';
import type { QualityReport } from '@book/types';

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
  characterReferenceLoadError?: string;
} {
  const result = imageGenerationResult as {
    characterReferenceAvailable?: unknown;
    characterReferenceUsedForImages?: unknown;
    imageGenerationMode?: unknown;
    characterReferenceLoadError?: unknown;
  } | null;
  const mode = result?.imageGenerationMode;
  return {
    characterReferenceAvailable: result?.characterReferenceAvailable === true,
    characterReferenceUsedForImages: result?.characterReferenceUsedForImages === true,
    imageGenerationMode:
      mode === 'character-reference-edit' || mode === 'mixed' ? mode : 'text-to-image',
    ...(typeof result?.characterReferenceLoadError === 'string' && {
      characterReferenceLoadError: result.characterReferenceLoadError,
    }),
  };
}

/**
 * Reads the per-asset image-generation failure diagnostics AgentService
 * folds onto Book.imageGenerationResult.imageFailures (see
 * ImageGenerationFailureDetail, agent.service.ts) — empty for books
 * generated before this feature existed, or whose most recent run had no
 * failures.
 */
function buildImageFailureDiagnostics(
  imageGenerationResult: Book['imageGenerationResult'],
): ImageGenerationFailureDetail[] {
  const failures = (imageGenerationResult as { imageFailures?: unknown } | null)?.imageFailures;
  return Array.isArray(failures) ? (failures as ImageGenerationFailureDetail[]) : [];
}

function buildProviderUsage(
  imageGenerationResult: Book['imageGenerationResult'],
): GenerationProviderUsage | null {
  const usage = (imageGenerationResult as { providerUsage?: unknown } | null)?.providerUsage;
  return usage ? (usage as GenerationProviderUsage) : null;
}

const PROVIDER_OPERATIONS = new Set([
  'character_profile',
  'character_sheet',
  'story',
  'story_repair',
  'illustration',
]);
const PROVIDER_FAILURES = new Set([
  'cancelled',
  'timeout',
  'rate_limit',
  'network',
  'authentication',
  'invalid_response',
  'refusal',
  'truncated',
  'schema_error',
  'provider_error',
  'unknown',
]);
const GENERATION_FAILURES = new Set([
  'provider_transient_failure',
  'refusal',
  'invalid_output',
  'storage_failure',
]);

function isJsonObject(value: Prisma.JsonValue): value is Prisma.JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Aggregate the authoritative ledger across every delivery of one run. */
function buildDurableProviderUsage(run?: GenerationRun | null): GenerationProviderUsage | null {
  if (!run || !Array.isArray(run.providerOperations)) return null;
  const operations = run.providerOperations.filter(isJsonObject);
  const calls: GenerationProviderCallMetadata[] = [];
  for (const [index, operation] of operations.entries()) {
    if (
      !PROVIDER_OPERATIONS.has(String(operation.operation)) ||
      !['mock', 'openai', 'unknown'].includes(String(operation.provider)) ||
      typeof operation.promptVersion !== 'string' ||
      typeof operation.promptHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(operation.promptHash)
    ) {
      continue;
    }
    const state = String(operation.state ?? 'unknown');
    const failureKind = PROVIDER_FAILURES.has(String(operation.failureKind))
      ? (operation.failureKind as GenerationProviderCallMetadata['failureKind'])
      : state === 'unknown' || state === 'dispatch_intent'
        ? 'unknown'
        : undefined;
    const failureReason = GENERATION_FAILURES.has(String(operation.failureReason))
      ? (operation.failureReason as GenerationProviderCallMetadata['failureReason'])
      : undefined;
    calls.push({
      callIndex: Number.isInteger(operation.callIndex) ? Number(operation.callIndex) : index + 1,
      operation: operation.operation as GenerationProviderCallMetadata['operation'],
      provider: operation.provider as GenerationProviderName,
      promptVersion: operation.promptVersion,
      promptHash: operation.promptHash,
      attempt: Number.isInteger(operation.attempt) ? Number(operation.attempt) : 1,
      durationMs:
        typeof operation.durationMs === 'number' && operation.durationMs >= 0
          ? operation.durationMs
          : 0,
      status:
        state === 'response_received' || state === 'artifact_stored'
          ? 'success'
          : failureKind === 'cancelled'
            ? 'cancelled'
            : 'error',
      ...(typeof operation.operationId === 'string' && {
        operationId: operation.operationId,
      }),
      ...(Number.isInteger(operation.deliveryFencingVersion) && {
        deliveryFencingVersion: Number(operation.deliveryFencingVersion),
      }),
      ...(typeof operation.assetLabel === 'string' && { assetLabel: operation.assetLabel }),
      ...(typeof operation.model === 'string' && { model: operation.model }),
      ...(typeof operation.providerRequestId === 'string' && {
        providerRequestId: operation.providerRequestId,
      }),
      ...(typeof operation.inputTokens === 'number' && { inputTokens: operation.inputTokens }),
      ...(typeof operation.outputTokens === 'number' && { outputTokens: operation.outputTokens }),
      ...(typeof operation.httpAttempts === 'number' && {
        httpAttempts: operation.httpAttempts,
      }),
      ...(typeof operation.estimatedCostUsd === 'number' && {
        estimatedCostUsd: operation.estimatedCostUsd,
      }),
      ...(failureKind && { failureKind }),
      ...(failureReason && { failureReason }),
    });
  }
  const paid = operations.filter((operation) => operation.provider === 'openai');
  const actualDispatches = paid.reduce(
    (sum, operation) => sum + countAuthorizedDispatches(operation),
    0,
  );
  const logicalPaid = new Set(
    paid
      .filter((operation) => countAuthorizedDispatches(operation) > 0)
      .map((operation, index) => String(operation.operationId ?? `legacy:${index}`)),
  ).size;
  const unknownOutcomes = paid.reduce((sum, operation) => {
    const dispatches = Array.isArray(operation.dispatches)
      ? operation.dispatches.filter(
          (dispatch) =>
            dispatch &&
            typeof dispatch === 'object' &&
            ['unknown', 'unknown_remote_outcome', 'dispatch_intent'].includes(
              String((dispatch as Record<string, unknown>).state),
            ),
        ).length
      : ['unknown', 'dispatch_intent'].includes(String(operation.state))
        ? countAuthorizedDispatches(operation)
        : 0;
    return sum + dispatches;
  }, 0);
  const authorization = run.executionAuthorization as {
    policy?: { maxPaidCalls?: unknown };
    estimate?: { maximumProviderCalls?: unknown };
  } | null;
  const estimatedValues = paid.map((operation) => operation.estimatedCostUsd);
  const allEstimated = estimatedValues.every(
    (value) => typeof value === 'number' && Number.isFinite(value),
  );
  return {
    maxPaidCalls: Number(authorization?.policy?.maxPaidCalls ?? Math.max(1, actualDispatches)),
    plannedPaidCalls: Number(authorization?.estimate?.maximumProviderCalls ?? logicalPaid),
    actualPaidCalls: logicalPaid,
    actualDispatches,
    unknownOutcomes,
    knownInputTokens: paid.reduce(
      (sum, operation) => sum + (Number(operation.inputTokens) || 0),
      0,
    ),
    knownOutputTokens: paid.reduce(
      (sum, operation) => sum + (Number(operation.outputTokens) || 0),
      0,
    ),
    ...(allEstimated && {
      estimatedCostUsd: estimatedValues.reduce<number>(
        (sum, value) => sum + (typeof value === 'number' ? value : 0),
        0,
      ),
      estimatedExposureUsd: paid.reduce(
        (sum, operation) =>
          sum +
          Number(operation.estimatedCostUsd) * Math.max(1, countAuthorizedDispatches(operation)),
        0,
      ),
    }),
    calls,
  };
}

/**
 * Builds the safe, non-secret GenerationMetadata view for a book from
 * already-persisted columns (Book.generationTimeMs/aiModelVersions/
 * failedStep/errorMessage/bookPreview) plus its AgentLog rows — no new
 * storage, no schema change. `startedAt` is derived (updatedAt - durationMs)
 * since generation has no dedicated start-timestamp column.
 */
export function buildGenerationMetadata(
  book: Book,
  logs: AgentLog[],
  providerUsageOverride?: GenerationProviderUsage | null,
): GenerationMetadata {
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
  const providerUsage = providerUsageOverride ?? buildProviderUsage(book.imageGenerationResult);
  const quality = book.qualityReport as unknown as QualityReport | null;
  const promptVersions = providerUsage
    ? [...new Set(providerUsage.calls.map((call) => call.promptVersion))]
    : [];

  return {
    storyProvider: toProviderName(storyLog?.provider),
    imageProvider: toProviderName(imageLog?.provider),
    ...(storyModel && { storyModel }),
    ...(imageModel && { imageModel }),
    ...(book.pageCount != null && { requestedPages: book.pageCount }),
    ...(generatedPages !== undefined && { generatedPages }),
    ...(generatedImageCount !== undefined && { generatedImageCount }),
    ...(failedImageCount !== undefined && { failedImageCount }),
    ...(providerUsage && { providerUsage }),
    ...(quality && {
      quality: {
        passed: quality.overallPassed,
        ...(quality.dimensions && { dimensions: quality.dimensions }),
        issueCodes: quality.issues.map((issue) => issue.code),
        repairAttempted: quality.repair?.attempted === true,
        repairSuccessful: quality.repair?.outcome === 'passed',
      },
    }),
    ...(promptVersions.length > 0 && { promptVersions }),
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
    ...(log.tokensInput !== null && { tokensInput: log.tokensInput }),
    ...(log.tokensOutput !== null && { tokensOutput: log.tokensOutput }),
    ...(log.costUsd !== null && { costUsd: log.costUsd.toNumber() }),
    attempt: log.attempt,
    error: log.error,
    traceId: log.traceId,
    createdAt: log.createdAt.toISOString(),
  };
}

/**
 * Projects the authoritative GenerationRun into the legacy `latestJob` API
 * shape. The field name and summary type stay stable for clients while the
 * runtime dependency on the best-effort GenerationJob mirror is removed.
 */
function toGenerationJobSummary(run: GenerationRun): GenerationJobSummary {
  return {
    id: run.id,
    type: run.kind === 'retry' ? 'retry' : 'generate',
    status: run.status as unknown as GenerationJobSummary['status'],
    attempt: run.attempt,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    ...(run.startedAt && { startedAt: run.startedAt.toISOString() }),
    ...(run.completedAt && { completedAt: run.completedAt.toISOString() }),
    ...(run.failedAt && { failedAt: run.failedAt.toISOString() }),
    ...(run.status === 'failed' &&
      run.currentStep && { failedStep: run.currentStep as unknown as AgentStep }),
    ...(run.errorMessage && { errorMessage: run.errorMessage }),
  };
}

/**
 * Composes the full GET /books/:id/generation-diagnostics response from a
 * Book row, its AgentLog rows, and its latest authoritative GenerationRun.
 * `latestJob` remains an API-compatibility projection and is nullable since a
 * book may predate run tracking or never have started generation.
 * `pdfStorage` is optional purely so this pure function stays easy to unit
 * test without a real PdfStorage.
 */
const ACTIVE_RUN_STATUSES = new Set(['queued', 'running']);

export function buildGenerationDiagnostics(
  book: Book,
  logs: AgentLog[],
  latestRun?: GenerationRun | null,
  pdfStorage?: PdfStorageDiagnostics,
  queue?: Omit<QueueDiagnostics, 'stalledNoWorker'>,
): GenerationDiagnosticsDto {
  const providerUsage =
    buildDurableProviderUsage(latestRun) ?? buildProviderUsage(book.imageGenerationResult);
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
    generationMetadata: buildGenerationMetadata(book, logs, providerUsage),
    recentLogs: logs.map(toAgentLogSummary),
    previewPdfUrl: book.previewPdfUrl,
    latestJob: latestRun ? toGenerationJobSummary(latestRun) : null,
    pdfStorage: pdfStorage ?? {
      driver: 'local',
      keyPresent: book.previewPdfUrl != null,
      previewAvailable: false,
    },
    queue: {
      ...resolvedQueue,
      stalledNoWorker:
        !!latestRun && ACTIVE_RUN_STATUSES.has(latestRun.status) && resolvedQueue.workerCount === 0,
    },
    characterPersonalization: buildCharacterPersonalizationDiagnostics(book),
    resume: buildResumeDiagnostics(book.imageGenerationResult),
    imageFailures: buildImageFailureDiagnostics(book.imageGenerationResult),
    providerUsage,
  };
}
