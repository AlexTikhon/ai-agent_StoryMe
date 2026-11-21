import type { AgentLog, Book, GenerationRun, Prisma } from '@prisma/client';
import type {
  AgentLogSummary,
  AgentStep,
  CharacterPersonalizationDiagnostics,
  GenerationDiagnosticsDto,
  GenerationJobSummary,
  GenerationProviderName,
  GenerationProviderCallMetadata,
  GenerationProviderUsage,
  GenerationQualitySummary,
  GenerationRunKindName,
  GenerationRunTimestamps,
  ImageGenerationFailureDetail,
  LatestGenerationAttemptDiagnostics,
  PdfStorageDiagnostics,
  PublishedEditionDiagnostics,
  PublishedSourceGenerationRun,
  QualityReport,
  QueueDiagnostics,
  ResumeDiagnostics,
  RunProviderUsageProjection,
} from '@book/types';
import { countAuthorizedDispatches } from '../agent/generation-execution-policy';
import { PRESERVE_APPEARANCE_INSTRUCTION } from '../agent/story-generation-provider';
import { publishedEdition } from './books.mapper';

/*
 * Source rules for GET /books/:id/generation-diagnostics (see
 * GenerationDiagnosticsDto):
 * - publishedEdition reads only the published Book columns and the run that
 *   Book.publishedRunId names. Those columns change only when a full-book run
 *   completes or a page revision publishes.
 * - latestAttempt reads only the newest GenerationRun row and its ledger.
 * - Neither falls back to the other, and no timestamp is derived from
 *   Book.updatedAt.
 */

function publishedPageCount(bookPreview: Book['bookPreview']): number | undefined {
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
 * Static projection of a recorded character-reference load failure. The
 * stored message (CharacterReferenceStage.loadReference) names the
 * character-sheet storage key and stays in logs and the stored record; only
 * the fact that loading failed reaches the response.
 */
export const CHARACTER_REFERENCE_LOAD_ERROR =
  'The character reference could not be loaded; images were generated without it.';

/**
 * Reads the visual-reference-usage fields the publishing run wrote onto
 * Book.imageGenerationResult. Defaults to the safe "nothing happened" shape
 * for editions published before this phase existed.
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
      characterReferenceLoadError: CHARACTER_REFERENCE_LOAD_ERROR,
    }),
  };
}

/**
 * Per-asset image failures the publishing run folded onto
 * Book.imageGenerationResult.imageFailures — empty for older editions or when
 * nothing failed.
 */
function buildImageFailureDiagnostics(
  imageGenerationResult: Book['imageGenerationResult'],
): ImageGenerationFailureDetail[] {
  const failures = (imageGenerationResult as { imageFailures?: unknown } | null)?.imageFailures;
  return Array.isArray(failures) ? (failures as ImageGenerationFailureDetail[]) : [];
}

/**
 * Resume diagnostics the publishing run folded onto
 * Book.imageGenerationResult.resume — null when it was never computed.
 */
function buildResumeDiagnostics(
  imageGenerationResult: Book['imageGenerationResult'],
): ResumeDiagnostics | null {
  const resume = (imageGenerationResult as { resume?: unknown } | null)?.resume;
  return resume ? (resume as ResumeDiagnostics) : null;
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
 * Highest fencingVersion a run can hold in `status` without ever having been
 * claimed. Runs are created queued at 0; GenerationRunService.claim is the
 * only way out of queued into running, and nothing returns a run to queued.
 * Unclaimed runs leave queued only by cancellation (cancelGeneration or hard
 * deletion, one bump) or by recovery's failAbandoned (no bump). Running and
 * completed runs were necessarily claimed.
 */
const PRE_CLAIM_MAX_FENCING_VERSION: Partial<Record<GenerationRun['status'], number>> = {
  queued: 0,
  cancelled: 1,
  failed: 0,
};

/**
 * True only when persisted lifecycle invariants prove no worker claimed the
 * run. A missing startedAt alone proves nothing (legacy rows can lack it), so
 * every column claim writes — startedAt, leaseOwner, deliveryToken,
 * processingDeadlineAt, its fence bump — and the worker's currentStep must
 * all still be at their creation values.
 */
function provablyNeverClaimed(run: GenerationRun): boolean {
  const maxFence = PRE_CLAIM_MAX_FENCING_VERSION[run.status];
  return (
    maxFence !== undefined &&
    run.fencingVersion <= maxFence &&
    run.startedAt === null &&
    run.completedAt === null &&
    run.leaseOwner === null &&
    run.deliveryToken === null &&
    run.processingDeadlineAt === null &&
    run.currentStep === null
  );
}

/**
 * Provider usage of exactly one run, from its durable ledger only. A missing
 * ledger stays unavailable; it is never filled from Book.imageGenerationResult
 * or another run. An empty ledger array is a confirmed empty ledger. Without
 * a ledger, `never_claimed` requires proof from lifecycle invariants;
 * anything else, including a claimed run with missing timestamps, is
 * `ledger_absent` (unknown).
 */
export function buildRunProviderUsage(run: GenerationRun): RunProviderUsageProjection {
  const usage = buildDurableProviderUsage(run);
  if (usage) return { availability: 'recorded', usage };
  return {
    availability: 'unavailable',
    reason: provablyNeverClaimed(run) ? 'never_claimed' : 'ledger_absent',
  };
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function runTimestamps(run: GenerationRun): GenerationRunTimestamps {
  return {
    createdAt: run.createdAt.toISOString(),
    startedAt: iso(run.startedAt),
    completedAt: iso(run.completedAt),
    failedAt: iso(run.failedAt),
    cancelledAt: iso(run.cancelledAt),
  };
}

/**
 * Run wall-clock duration from persisted timestamps only: the terminal
 * timestamp matching the run's status minus its first claim (startedAt).
 */
export function runWallClockDurationMs(run: GenerationRun): number | null {
  const terminal =
    run.status === 'completed'
      ? run.completedAt
      : run.status === 'failed'
        ? run.failedAt
        : run.status === 'cancelled'
          ? run.cancelledAt
          : null;
  if (!terminal || !run.startedAt) return null;
  const duration = terminal.getTime() - run.startedAt.getTime();
  return duration >= 0 ? duration : null;
}

export function buildLatestGenerationAttempt(
  run: GenerationRun,
  book: Pick<Book, 'publishedRunId'>,
): LatestGenerationAttemptDiagnostics {
  const hasError = run.errorCode !== null || run.errorMessage !== null;
  return {
    runId: run.id,
    kind: run.kind as GenerationRunKindName,
    status: run.status as LatestGenerationAttemptDiagnostics['status'],
    retryOfRunId: run.retryOfRunId,
    deliveryAttempt: run.attempt,
    currentStep: run.currentStep as AgentStep | null,
    timestamps: runTimestamps(run),
    runWallClockDurationMs: runWallClockDurationMs(run),
    error: hasError
      ? {
          code: run.errorCode,
          message: run.errorMessage,
          failedStep:
            run.status === 'failed' && run.currentStep ? (run.currentStep as AgentStep) : null,
        }
      : null,
    isPublishedSource: book.publishedRunId === run.id,
    providerUsage: buildRunProviderUsage(run),
  };
}

/**
 * Explicit pointer validation: a candidate source run counts only if it is
 * the exact run Book.publishedRunId names and belongs to the same book and
 * owner. Anything else is reported as a missing record, never attributed.
 */
function isPublishedSourceRun(
  book: Pick<Book, 'id' | 'userId' | 'publishedRunId'>,
  run: GenerationRun | null | undefined,
): run is GenerationRun {
  return (
    !!run &&
    !!book.publishedRunId &&
    run.id === book.publishedRunId &&
    run.bookId === book.id &&
    run.userId === book.userId
  );
}

function buildPublishedSourceRun(
  book: Book,
  sourceRun: GenerationRun | null | undefined,
): PublishedSourceGenerationRun {
  if (!book.publishedRunId) {
    return { availability: 'unavailable', reason: 'legacy_publication', runId: null };
  }
  if (!isPublishedSourceRun(book, sourceRun)) {
    return {
      availability: 'unavailable',
      reason: 'run_record_missing',
      runId: book.publishedRunId,
    };
  }
  return {
    availability: 'recorded',
    runId: sourceRun.id,
    fencingVersion: book.publishedRunFencingVersion,
    kind: sourceRun.kind as GenerationRunKindName,
    status: sourceRun.status as GenerationJobSummary['status'],
    timestamps: runTimestamps(sourceRun),
    runWallClockDurationMs: runWallClockDurationMs(sourceRun),
  };
}

function buildQualitySummary(book: Book): GenerationQualitySummary | undefined {
  const quality = book.qualityReport as unknown as QualityReport | null;
  if (!quality) return undefined;
  return {
    passed: quality.overallPassed,
    ...(quality.dimensions && { dimensions: quality.dimensions }),
    issueCodes: quality.issues.map((issue) => issue.code),
    repairAttempted: quality.repair?.attempted === true,
    repairSuccessful: quality.repair?.outcome === 'passed',
  };
}

/**
 * Safe personalized-character view of the published edition. Every flag reads
 * a published column (CharacterProfile, character-sheet key, bookPreview,
 * imageGenerationResult) — never the current draft photo input — and the
 * page-prompt check is verified by construction against the marker phrase.
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
  const profile = book.characterProfile as { hasReferencePhoto?: unknown } | null;

  return {
    hasReferencePhoto: profile?.hasReferencePhoto === true,
    characterProfileCreated: book.characterProfile != null,
    characterSheetGenerated: book.characterSheetAssetKey != null,
    pagePromptsIncludeConsistencyData,
    ...characterReferenceUsage(book.imageGenerationResult),
  };
}

/**
 * The published edition, or null when nothing is published. `sourceRun` is
 * the run Book.publishedRunId names, read in the same snapshot as `book`.
 */
export function buildPublishedEdition(
  book: Book,
  sourceRun: GenerationRun | null | undefined,
): PublishedEditionDiagnostics | null {
  const edition = publishedEdition(book);
  if (!edition || !book.previewPdfUrl) return null;
  const source = buildPublishedSourceRun(book, sourceRun);
  const models = book.aiModelVersions as { story?: unknown; image?: unknown } | null;
  const pageCount = publishedPageCount(book.bookPreview);
  const quality = buildQualitySummary(book);

  return {
    edition,
    sourceGenerationRun: source,
    revisedAfterGeneration: book.publishedPdfRunId !== null,
    ...(pageCount !== undefined && { pageCount }),
    generationRecord: {
      ...(typeof models?.story === 'string' && { storyModel: models.story }),
      ...(typeof models?.image === 'string' && { imageModel: models.image }),
      ...imageCounts(book.imageGenerationResult),
      ...(quality && { quality }),
      resume: buildResumeDiagnostics(book.imageGenerationResult),
      imageFailures: buildImageFailureDiagnostics(book.imageGenerationResult),
    },
    characterPersonalization: buildCharacterPersonalizationDiagnostics(book),
    baseGenerationUsage:
      source.availability === 'recorded' && isPublishedSourceRun(book, sourceRun)
        ? buildRunProviderUsage(sourceRun)
        : { availability: 'unavailable', reason: 'source_run_unavailable' },
  };
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
 * Legacy `latestJob` shape. Its only source is the same GenerationRun row as
 * `latestAttempt`; it carries no Book fields.
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

/** Database rows read in one consistent snapshot (see BookDiagnosticsService). */
export interface GenerationDiagnosticsSnapshot {
  book: Book;
  /** Newest GenerationRun for this book and owner, or null. */
  latestRun: GenerationRun | null;
  /** The run Book.publishedRunId names, scoped to this book and owner, or null. */
  publishedSourceRun: GenerationRun | null;
  /** Bounded, newest-first, book-level AgentLog window. */
  logs: AgentLog[];
}

/** Read-time observations taken outside the database snapshot. */
export interface GenerationDiagnosticsObservations {
  pdfStorage?: PdfStorageDiagnostics;
  queue?: Omit<QueueDiagnostics, 'stalledNoWorker'>;
}

const ACTIVE_RUN_STATUSES = new Set(['queued', 'running']);

/**
 * Composes GET /books/:id/generation-diagnostics. Observations are optional
 * so this pure function stays easy to unit test without storage or a queue.
 */
export function buildGenerationDiagnostics(
  snapshot: GenerationDiagnosticsSnapshot,
  observations: GenerationDiagnosticsObservations = {},
): GenerationDiagnosticsDto {
  const { book, latestRun, publishedSourceRun, logs } = snapshot;
  const queue = observations.queue ?? {
    queueName: 'book-generation',
    workerCount: 0,
    counts: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
  };
  return {
    bookId: book.id,
    status: book.status as unknown as GenerationDiagnosticsDto['status'],
    publishedEdition: buildPublishedEdition(book, publishedSourceRun),
    latestAttempt: latestRun ? buildLatestGenerationAttempt(latestRun, book) : null,
    latestJob: latestRun ? toGenerationJobSummary(latestRun) : null,
    recentLogs: logs.map(toAgentLogSummary),
    pdfStorage: observations.pdfStorage ?? {
      driver: 'local',
      keyPresent: book.previewPdfUrl != null,
      previewAvailable: false,
    },
    queue: {
      ...queue,
      stalledNoWorker:
        !!latestRun && ACTIVE_RUN_STATUSES.has(latestRun.status) && queue.workerCount === 0,
    },
  };
}
