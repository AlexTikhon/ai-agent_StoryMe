/**
 * Agent step identifiers — mirror the AgentStep enum in schema.prisma.
 * Values must stay in sync with the pipeline state machine.
 */
export enum AgentStep {
  CharBuild = 'char_build',
  StoryPlan = 'story_plan',
  PagePlan = 'page_plan',
  StoryDraft = 'story_draft',
  ChapterGen = 'chapter_gen',
  IllustPlan = 'illust_plan',
  PreviewReady = 'preview_ready',
  CharConsistency = 'char_consistency',
  ImageGen = 'image_gen',
  QaReview = 'qa_review',
  Layout = 'layout',
  PdfRender = 'pdf_render',
}

/**
 * Book lifecycle statuses — mirror the BookStatus enum in schema.prisma.
 *
 * `Partial` remains reserved for a future generation-workflow feature
 * (partial-completion recovery) — no API code path sets a book to it yet.
 * `Cancelled` is reachable since Phase G1: `POST /books/:id/cancel`
 * transitions an active (queued/running) generation to it. Both are treated
 * as terminal wherever this codebase checks for a terminal Book status (see
 * isTerminalBookStatus in apps/web's use-book-detail.ts and
 * EDITABLE_BOOK_STATUSES in apps/api's books.service.ts).
 */
export enum BookStatus {
  Created = 'created',
  CharBuild = 'char_build',
  StoryPlan = 'story_plan',
  PagePlan = 'page_plan',
  StoryDraft = 'story_draft',
  ChapterGen = 'chapter_gen',
  IllustPlan = 'illust_plan',
  PreviewReady = 'preview_ready',
  ImageGen = 'image_gen',
  QaReview = 'qa_review',
  Layout = 'layout',
  PdfRender = 'pdf_render',
  Complete = 'complete',
  Failed = 'failed',
  Partial = 'partial',
  Cancelled = 'cancelled',
}

/** Visual illustration style choices presented in the wizard. */
export enum IllustrationStyle {
  Watercolor = 'watercolor',
  Comic = 'comic',
  Cartoon3d = 'cartoon_3d',
  PencilSketch = 'pencil_sketch',
}

/** Story genre choices presented in the wizard. */
export enum BookGenre {
  Adventure = 'adventure',
  Fantasy = 'fantasy',
  Friendship = 'friendship',
  Mystery = 'mystery',
  Nature = 'nature',
  Space = 'space',
  Ocean = 'ocean',
}

/** Pronouns for the child protagonist. */
export enum Pronouns {
  HeHim = 'he/him',
  SheHer = 'she/her',
  TheyThem = 'they/them',
}

/** Allowed book page lengths. */
export type BookLength = 8 | 16 | 24 | 32;

/** BullMQ job payload shared by all agent processors. */
export interface AgentJob {
  bookId: string;
  userId: string;
  traceId: string;
  /** Step-specific input data. */
  payload?: Record<string, unknown>;
}

/** Context object injected into every agent's run() call. */
export interface AgentContext {
  bookId: string;
  userId: string;
  traceId: string;
}

/** Agent log entry written to the agent_logs table. */
export interface AgentLogEntry {
  bookId: string;
  agent: string;
  step: AgentStep;
  provider?: string;
  model?: string;
  durationMs?: number;
  tokensInput?: number;
  tokensOutput?: number;
  costUsd?: number;
  attempt: number;
  status: 'success' | 'error' | 'retry';
  error?: string;
  traceId?: string;
}

/** Provider identifiers surfaced for generation diagnostics — never a secret, never a raw response. */
export type GenerationProviderName = 'mock' | 'openai' | 'unknown';

export type GenerationProviderOperation =
  'character_profile' | 'character_sheet' | 'story' | 'illustration';

/**
 * Safe metadata for one logical provider invocation. Prompt text and provider
 * responses are deliberately excluded; promptHash fingerprints the versioned
 * normalized input without making that input part of diagnostics.
 */
export interface GenerationProviderCallMetadata {
  callIndex: number;
  operation: GenerationProviderOperation;
  assetLabel?: string;
  provider: GenerationProviderName;
  model?: string;
  promptVersion: string;
  promptHash: string;
  attempt: number;
  durationMs: number;
  status: 'success' | 'error';
  estimatedCostUsd?: number;
}

/** Per-run paid-provider budget and the calls actually made by the latest run. */
export interface GenerationProviderUsage {
  maxPaidCalls: number;
  plannedPaidCalls: number;
  actualPaidCalls: number;
  /** Present only when every paid call had an operator-configured estimate. */
  estimatedCostUsd?: number;
  calls: GenerationProviderCallMetadata[];
}

/**
 * Safe, non-secret summary of one book generation run. Deliberately excludes
 * prompts, generated image bytes/base64, and raw provider responses — see
 * apps/api/docs/local-generation-pipeline.md ("Generation diagnostics").
 */
export interface GenerationMetadata {
  storyProvider: GenerationProviderName;
  imageProvider: GenerationProviderName;
  storyModel?: string;
  imageModel?: string;
  requestedPages?: number;
  generatedPages?: number;
  generatedImageCount?: number;
  failedImageCount?: number;
  providerUsage?: GenerationProviderUsage;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  durationMs?: number;
  failedStep?: AgentStep;
  errorMessage?: string;
}

/** One AgentLog row as surfaced to the generation-diagnostics endpoint. */
export interface AgentLogSummary {
  step: AgentStep;
  status: 'success' | 'error' | 'retry';
  provider?: string | null;
  model?: string | null;
  durationMs?: number | null;
  attempt: number;
  error?: string | null;
  traceId?: string | null;
  createdAt: string;
}

/**
 * Generation job lifecycle types — mirror the GenerationJobType/
 * GenerationJobStatus enums in schema.prisma (Phase 3I). A GenerationJob
 * tracks one generation attempt (generate or retry); Book.status remains the
 * source of truth for user-facing status. See "Generation jobs (Phase 3I)"
 * in apps/api/docs/local-generation-pipeline.md.
 */
export type GenerationJobType = 'generate' | 'retry';

export type GenerationJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * Safe, non-secret compatibility summary of the latest authoritative
 * GenerationRun for a book, surfaced via GenerationDiagnosticsDto.latestJob.
 * The legacy field/type names remain stable while GenerationJob is retired.
 */
export interface GenerationJobSummary {
  id: string;
  type: GenerationJobType;
  status: GenerationJobStatus;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  failedStep?: AgentStep;
  errorMessage?: string;
}

/**
 * Safe, non-secret view of the book-generation BullMQ queue's health,
 * surfaced via GenerationDiagnosticsDto.queue — lets a stuck book (job
 * queued/running with no worker consuming it) be diagnosed without shell
 * access to Redis. See "Worker process separation" in
 * apps/api/docs/local-generation-pipeline.md.
 */
export interface QueueDiagnostics {
  queueName: string;
  /** Number of BullMQ Worker processes currently connected to this queue (any process). */
  workerCount: number;
  counts: {
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  };
  /** True when this book's latest authoritative run is queued/running but workerCount is 0. */
  stalledNoWorker: boolean;
}

/**
 * Safe, non-secret view of idempotent-resume behavior for one generation run
 * (see "Idempotent resume" in apps/api/docs/local-generation-pipeline.md).
 * Persisted onto Book.imageGenerationResult.resume (no schema migration —
 * mirrors how generatedImageCount/failedImageCount were added in Phase 3E)
 * and surfaced via GenerationDiagnosticsDto.resume. Asset labels are stable
 * strings: 'character_sheet', 'cover', 'page_<n>', 'back_cover', 'pdf'.
 */
export interface ResumeDiagnostics {
  /** True when this run reused any prior persisted generation state instead of starting from scratch. */
  resumeMode: boolean;
  /** Every asset this book needs to reach 'complete'. */
  requiredAssets: string[];
  /** Assets that already had valid, non-empty bytes/data before this run started. */
  validExistingAssets: string[];
  /** Required assets that had no prior record/bytes at all before this run. */
  missingAssetsBeforeRetry: string[];
  /** Required assets that had a prior record but failed validation (e.g. zero-byte file) before this run. */
  invalidAssetsBeforeRetry: string[];
  /** Count of image assets reused as-is (no new provider call) this run. */
  reusedImageCount: number;
  /** Count of image assets actually generated via the image provider this run. */
  regeneratedImageCount: number;
  skippedStoryGeneration: boolean;
  skippedCharacterProfileGeneration: boolean;
  skippedCharacterSheetGeneration: boolean;
  /** True when at least one existing image asset was reused instead of regenerated this run. */
  skippedExistingImageGeneration: boolean;
  /** Required assets still missing/invalid after this run completed. */
  missingAssetsAfterRetry: string[];
  pdfRenderAttempted: boolean;
  pdfRenderSucceeded: boolean;
  finalBookStatus: BookStatus;
}

/**
 * Safe, non-secret per-image failure diagnostic captured whenever an
 * ImageGenerationProvider.generateImage call fails during a generation run
 * (see "Diagnose and Fix Failed Resumed Back-Cover Generation"). Persisted
 * onto Book.imageGenerationResult.imageFailures (no schema migration — same
 * pattern as ResumeDiagnostics) and surfaced via
 * GenerationDiagnosticsDto.imageFailures. Never includes the API key, image
 * bytes/base64, prompt text, or a raw provider response body.
 */
export interface ImageGenerationFailureDetail {
  /** Stable asset label: 'cover' | 'page_<n>' | 'back_cover'. */
  assetLabel: string;
  provider: GenerationProviderName;
  model?: string;
  /** HTTP status code from the provider response, if the failure was an HTTP-level error. */
  httpStatus?: number;
  /** OpenAI error `type` field (e.g. 'invalid_request_error'), if the provider returned one. */
  errorType?: string;
  /** OpenAI error `code` field (e.g. 'content_policy_violation'), if the provider returned one. */
  errorCode?: string;
  /** Safe, truncated error message — never the raw response body, image bytes, or base64. */
  message: string;
  /** Number of HTTP attempts made for this image, including fetchWithRetry's own network/5xx retries. */
  attempts: number;
  /** Number of HTTP 429 retries the shared OpenAIImageRateLimiter performed for this image. */
  limiterRetries: number;
  /** Total milliseconds this image's request spent waiting on the rate limiter (spacing + 429 backoff). */
  limiterWaitMs: number;
  /** Whether a character-sheet reference was supplied to this request. */
  characterReferenceSupplied: boolean;
  /** Which endpoint shape this request used. */
  requestMode: 'text-to-image' | 'character-reference-edit';
  /** Configured per-attempt HTTP timeout (ms) for the failed request. Only present when errorCode is 'request_timeout'. */
  timeoutMs?: number;
  /** Wall-clock ms spent actually attempting the HTTP request(s), excluding rate-limiter queue wait. Only present when errorCode is 'request_timeout'. */
  elapsedMs?: number;
  /** Why no further timeout retry was attempted. Only present when errorCode is 'request_timeout'. */
  retryDecision?: string;
}

/** WebSocket progress event shapes emitted during generation. */
export type WsProgressEvent =
  | { type: 'book:progress'; step: AgentStep; percentComplete: number }
  | { type: 'book:page_ready'; pageNumber: number; imageUrl: string }
  | { type: 'book:complete'; bookId: string; pdfUrl: string }
  | { type: 'book:error'; step: AgentStep; message: string };
