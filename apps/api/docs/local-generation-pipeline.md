# Local generation pipeline

Maps the full local book-generation lifecycle: create → generate → preview.
Everything described here runs locally and deterministically — no network
calls, no external AI providers, no cloud dependency.

## Lifecycle

1. **Create** — `POST /api/books` (`BooksController.create` →
   `BooksService.create`) inserts a `Book` row scoped to the current user.
   Status starts at `created` (Prisma column default).
2. **Update draft fields** — `PATCH /api/books/:id`
   (`BooksService.update`) is only allowed while `status === created`;
   otherwise it throws `ConflictException` (409).
3. **Trigger generation** — `POST /api/books/:id/generate`
   (`BooksService.startGeneration`):
   - Requires `childName`, `childAge`, `language`, `theme` to already be set
     on the book — missing any throws `BadRequestException` (400) listing
     every missing field.
   - Requires `status === created` — otherwise `ConflictException` (409)
     ("Generation already started or completed for this book").
   - Requires no active (`queued`/`running`) `GenerationJob` already exists
     for the book — otherwise `ConflictException` (409, "Generation is
     already in progress for this book").
   - Charges 1 credit the moment the run is durably scheduled, inside the
     same transaction as the `GenerationRun` create/`Book` transition/
     `OutboxEvent` write — an insufficient balance returns the stable `402
{ code: 'INSUFFICIENT_CREDITS' }` and rolls everything back. See
     `apps/api/docs/credits.md`, "Phase E2".
   - Transitions `status` to `char_build` (the first pipeline step) and
     returns immediately — it does **not** wait for generation to finish.
     See "Durable generation queue (Phase 3K)" below.
4. **Generation** — `AgentService.startBookGeneration` (see below) runs on a
   durable BullMQ/Redis-backed queue worker, and eventually updates the book
   to a terminal `complete` or `failed` status. The frontend's existing
   status/diagnostics poll (see "Status transitions" below) is how the caller
   observes that outcome — not the `generate` response.
5. **Preview** — `GET /api/books/:id/pdf/preview`
   (`BooksService.getPreviewPdfBuffer` → `PdfStorage.getPreviewPdf`) streams
   the rendered PDF back as `application/pdf`.

Generation is scheduled onto a real BullMQ/Redis-backed queue (Phase 3K —
`GenerationQueueService`/`GenerationQueueProcessor`) and runs on a worker in
the same process, after the HTTP response for `generate`/`retry-generation`
has already been sent. See "Durable generation queue (Phase 3K)" below for
the full design and its remaining limitations.

## What `AgentService.startBookGeneration` does, in order

- (a) `storyGenerationProvider.generateStory({ bookId, childName, childAge,
theme, language })` — delegates all character/story/page/image-metadata
  planning to the injected `StoryGenerationProvider` (see "Story generation
  provider boundary" below) and returns `{ characterCard, storyPlan,
bookPreview, imageGenerationResult }`. If this call throws, `AgentService`
  catches it, marks the book `failed` (`failedStep: 'story_plan'`,
  `errorMessage` from the caught error), writes a single `story_plan`
  `AgentLog` row with `status: 'error'`, and returns immediately — none of
  the steps below run.
- (b) `generateAndSaveImageAssets` (private helper) — for every
  `GeneratedImageEntry` in the provider's `imageGenerationResult` (up to the
  `MAX_GENERATED_IMAGES_PER_BOOK` cap for the real provider), calls the
  injected `ImageGenerationProvider.generateImage({ bookId, entry,
characterCard })` (see "Image generation provider boundary" below) to get
  real image bytes, then saves them through
  `ImageAssetStorage.saveImageAsset(imageAssetKey(bookId, kind, pageNumber),
buffer, contentType)`. **This helper never throws.** Both a `generateImage`
  failure (e.g. a real provider's API outage) and a `saveImageAsset` failure
  for one entry are caught per-entry, logged (`Image generation/save failed
for entry "<id>" ...`), and counted — that entry simply has no saved bytes.
  Unlike earlier phases, this no longer degrades quietly: `assertAllImagesResolved`
  (Phase 2 below) requires every planned illustration to have real bytes, so
  any entry left without saved bytes now fails the whole book at `pdf_render`
  with a clear error naming the page, instead of rendering a placeholder for
  it. The helper returns `{ generatedCount, failedCount, lastError }`,
  which `AgentService` writes onto `imageGenerationResult.generatedImageCount`/
  `failedImageCount`/`lastImageError` for diagnostics (see "Generation
  diagnostics" below), and folds `failedCount` into the final `image_gen`
  `AgentLog` row's `error` field (status stays `success`, since the failure is
  only realized later at `pdf_render`) rather than ever setting
  `failedStep: 'image_gen'`.
- (c) `buildBookLayout` (private function in `agent.service.ts`) — builds the
  print-ready `BookLayout` (2400×2400px canvas, `square_8x8` trim),
  referencing the same mock `imageUrl`s. Every story page uses the single
  stable `image_top_text_bottom` template (image on top, text below) — this
  step stays in `AgentService` rather than the story provider — it's
  print-layout logic over already-built story/image data, not story content
  itself.

Then, in three phases against the database:

- **Phase 1** — one `prisma.book.update`: status → `layout`, persists
  `characterCard`, `storyPlan`, `bookPreview`, `imageGenerationResult`,
  `bookLayout`.
- **Phase 2** — PDF render, wrapped in try/catch:
  1. `buildImageBufferResolver(imageAssetStorage, bookId, layout.entries)`
     pre-resolves every layout entry's saved bytes (if any) from
     `ImageAssetStorage` into a synchronous lookup closure.
  2. `assertAllImagesResolved(logger, bookId, bookLayout, resolveImageBuffer)`
     checks every layout entry that was planned to have an image actually
     has resolvable bytes, logging each page's outcome; if any are missing it
     throws one clear error naming every affected page (see
     `apps/api/docs/pdf-rendering.md`), which the surrounding try/catch turns
     into a `failed` book with `failedStep: 'pdf_render'`.
  3. `renderStorybookPdf(bookLayout, { resolveImageBuffer })` renders one PDF
     page per layout entry, embedding real bytes for every entry (the
     validation above guarantees they're all present on this path).
  4. `pdfStorage.savePreviewPdf(bookId, buffer)` persists the PDF (default
     `LocalPdfStorage`: `tmp/books/<bookId>/storybook.pdf`) and returns a
     `url`.
  - Any error in this phase (render or storage) is caught, logged, and
    recorded — the book is **not** marked complete.
- **Phase 3** — second `prisma.book.update`:
  - On success: status → `complete`, `previewPdfUrl` set to the URL from
    Phase 2.
  - On failure: status → `failed`, `errorMessage` set to the caught error's
    message, `failedStep` set to `pdf_render`. `previewPdfUrl` is left
    untouched (not set).
- Finally, nine `AgentLog` rows are written in one `createMany` call, all
  sharing a single `traceId`: `char_build`, `story_plan`, `page_plan`,
  `story_draft`, `illust_plan`, `preview_ready`, `image_gen`, `layout`,
  `pdf_render` — the last one's `status` is `success` or `error` depending on
  Phase 2's outcome, with the error message attached when it failed.

## Idempotent resume of a partially generated book

`BooksService.retryGeneration` (see "Retrying failed generation (Phase 3G)"
below) never clears
`Book.storyPlan`/`characterCard`/`bookPreview`/`imageGenerationResult`/
`characterProfile`/`characterSheetAssetKey` — only `status`/`failedStep`/
`errorMessage`/`retryCount`. So a retry against a book that previously made
it past Phase 1 of a run (e.g. one that failed at `pdf_render`) hands
`AgentService.startBookGeneration` a `Book` row that already carries a full
prior generation result. `isResumableBook` (`agent.service.ts`) detects this
(`storyPlan`/`characterCard`/`bookPreview`/`imageGenerationResult` all
non-null) and the pipeline reuses as much of it as is still valid instead of
regenerating from scratch:

- **Story** — skipped entirely when resumable: `characterCard`/`storyPlan`/
  `bookPreview`/`imageGenerationResult` are read straight off the book row,
  `StoryGenerationProvider.generateStory` is never called.
- **Character profile** — skipped when `Book.characterProfile` is present;
  `CharacterProfileProvider.buildProfile` is never called.
- **Character sheet** — skipped when the profile's `hasCharacterSheet` is
  true and `Book.characterSheetAssetKey`'s bytes are still readable and
  non-empty (`classifyCharacterSheetAsset`). If the profile is being reused
  but the sheet specifically is missing/invalid, only the sheet is
  regenerated (`regenerateCharacterSheet`) — the profile provider is still
  never re-called.
- **Illustrations** — `classifyImageAssets` checks every planned cover/page/
  back-cover entry's saved bytes via `ImageAssetStorage.getImageAsset`: no
  bytes at all → missing, a zero-length buffer → invalid, otherwise → valid
  and reusable as-is. Only missing/invalid entries are sent to
  `ImageGenerationProvider.generateImage` — for a six-page book with only
  `back_cover` missing, this is exactly one request.
  `MAX_GENERATED_IMAGES_PER_BOOK`/`REAL_GENERATION_MAX_PAGES` (see "Real
  provider hardening" below) still apply to that (usually much smaller) set
  of new requests. A fresh (non-resumable) book has nothing saved yet, so
  every entry naturally falls into "missing" — this is the same code path as
  ordinary first-time generation, not a separate one.
- **Layout and PDF** — always rebuilt/re-rendered on every run (cheap,
  deterministic, no external cost), whether resuming or not.

Concurrency (repeated Retry clicks, or two concurrent retries) is guarded the
same way `startGeneration`/`retryGeneration` already guard against duplicate
generation: `GenerationJobService.findActive` plus `claimStatusTransition`'s
conditional UPDATE (see "Retrying failed generation (Phase 3G)" below) —
idempotent resume adds no
new concurrency surface.

### Resume diagnostics

Every run — resumed or not — folds a `ResumeDiagnostics` object
(`@book/types`) onto `Book.imageGenerationResult.resume` (no schema
migration, the same pattern Phase 3E used for `generatedImageCount`/
`failedImageCount`), surfaced as `resume` on
`GET /:id/generation-diagnostics`'s response
(`GenerationDiagnosticsDto.resume`, `null` for books generated before this
existed):

```ts
interface ResumeDiagnostics {
  resumeMode: boolean;
  requiredAssets: string[]; // 'character_sheet' | 'cover' | 'page_<n>' | 'back_cover' | 'pdf'
  validExistingAssets: string[];
  missingAssetsBeforeRetry: string[];
  invalidAssetsBeforeRetry: string[];
  reusedImageCount: number;
  regeneratedImageCount: number;
  skippedStoryGeneration: boolean;
  skippedCharacterProfileGeneration: boolean;
  skippedCharacterSheetGeneration: boolean;
  skippedExistingImageGeneration: boolean; // true when at least one image was reused
  missingAssetsAfterRetry: string[];
  pdfRenderAttempted: boolean;
  pdfRenderSucceeded: boolean;
  finalBookStatus: BookStatus;
}
```

`missingAssetsAfterRetry` is only populated for `character_sheet` (its own
independent best-effort check) and, when `pdf_render` fails, a fresh
`classifyImageAssets` pass — a successful `pdf_render` implies every planned
illustration resolved (see `assertAllImagesResolved` above), so no extra
storage reads happen on the happy path.

## Story generation provider boundary

`apps/api/src/agent/story-generation-provider.ts` defines `StoryGenerationProvider`,
the internal boundary `AgentService` depends on for all character/story/page/
image-metadata planning, mirroring the `PdfStorage` / `ImageAssetStorage`
pattern:

```ts
interface StoryGenerationInput {
  bookId: string;
  childName: string;
  childAge: number;
  theme: string;
  language: string;
}

interface StoryGenerationResult {
  characterCard: CharacterCard;
  storyPlan: StoryPlan & {
    pages: Array<PagePlan & { storyText: string; illustration: IllustrationPlan }>;
  };
  bookPreview: BookPreview;
  imageGenerationResult: ImageGenerationResult;
}

interface StoryGenerationProvider {
  generateStory(input: StoryGenerationInput): Promise<StoryGenerationResult>;
}
```

- Registered via `STORY_GENERATION_PROVIDER_TOKEN` in `books.module.ts`,
  injected into `AgentService`'s constructor exactly like `PDF_STORAGE_TOKEN`
  and `IMAGE_ASSET_STORAGE_TOKEN`.
- `MockStoryGenerationProvider` is the only implementation today. It's a
  straight extraction of the hand-written template logic that used to live
  directly in `AgentService` (`buildCharacterCard`, `buildStoryPlan`,
  `buildPagePlan`, `buildStoryDraft`, `buildIllustrationPlan`,
  `buildBookPreview`, `buildImageGenerationResult` — now private functions in
  `story-generation-provider.ts`) — same inputs still produce byte-identical
  output; no behavior changed by the extraction.
- Image _metadata_ (prompts, mock `imageUrl` placeholder paths,
  `GeneratedImageEntry` records) is built by the provider as part of
  `imageGenerationResult`. Actual image _bytes_ are not — that stays behind
  `ImageAssetStorage` / `generateMockImagePng` (see "Images" in
  `apps/api/docs/pdf-rendering.md`), called separately by `AgentService`
  after the provider returns. This split is deliberate: a future real-LLM
  story provider and a future real-image provider are independent phases and
  shouldn't be coupled.
- `buildBookLayout` (print-layout geometry over already-built story/image
  data) intentionally stayed a private function in `agent.service.ts` rather
  than moving into the provider — it isn't story content, and moving it would
  have widened this phase's scope beyond the story-generation boundary.
- **Failure behavior**: if `generateStory` throws, `AgentService` catches it
  before Phase 1 runs, marks the book `failed` (`failedStep: 'story_plan'`,
  `errorMessage` from the caught error's message), writes one `story_plan`
  `AgentLog` row with `status: 'error'`, and returns — no image assets are
  saved, no layout is built, no PDF is rendered or stored.

### Real LLM provider (`OpenAIStoryGenerationProvider`)

`apps/api/src/agent/openai-story-generation-provider.ts` implements
`StoryGenerationProvider` with a real OpenAI chat-completions call, gated
entirely behind explicit env selection — the default and every test/CI run
still use `MockStoryGenerationProvider` with zero network calls.

- **Provider selection** — `apps/api/src/agent/story-generation-provider.factory.ts`
  exports `createStoryGenerationProvider(env = process.env)`, wired into
  `books.module.ts`'s `useFactory` for `STORY_GENERATION_PROVIDER_TOKEN`:
  - `STORY_GENERATION_PROVIDER` unset, empty, or `"mock"` → `MockStoryGenerationProvider`.
  - `STORY_GENERATION_PROVIDER=openai` → `OpenAIStoryGenerationProvider`,
    constructed with `OPENAI_API_KEY` (required — throws a clear
    `Error` at provider-construction time if missing) and optional
    `OPENAI_STORY_MODEL` (defaults to `gpt-4o-mini`).
  - Any other value throws a clear `Error` naming the invalid value.
- **Prompt** — `buildStoryGenerationPrompt(input, targetPageCount)` is a pure
  function (no network) returning `{ system, user }` messages. It embeds
  `childName`, `childAge`, `theme`, `language`, and the target page count
  (default 6, matching the mock's 6-page output), and instructs the model to
  return strict JSON only, write in age-appropriate simple language, avoid
  violent/scary/copyrighted content, and include one `illustrationPrompt` per
  page for a future image-generation model.
- **Call** — sends `POST {baseUrl}/chat/completions` (default
  `https://api.openai.com/v1`) with `response_format: { type: 'json_object' }`
  via an injectable `fetchImpl` (defaults to the Node global `fetch`) — no new
  HTTP/OpenAI SDK dependency was added; tests inject a mock `fetchImpl` so no
  real network call ever happens in the suite.
- **Validation** — the model's JSON content is parsed and validated with a
  `zod` schema (`zod` was already a dependency) requiring `title`,
  `theme`, `educationalMessage`, `openingHook`, `resolution`, a
  `characterCard` with `visualAnchor`/`narrativeDescription`, and 4–12
  `pages` each with non-empty `title`/`sceneDescription`/`storyText`
  (max 1000 chars)/`illustrationPrompt`/`learningGoal`. Any parse failure or
  schema mismatch throws `StoryGenerationProviderError` with a clear message
  — raw model output never reaches `AgentService`.
- **Mapping** — validated output is mapped into the exact
  `StoryGenerationResult` shape `MockStoryGenerationProvider` returns:
  chapters/pages/illustration plans are synthesized around the LLM's
  per-page content (2 pages per chapter, same illustration-prompt/negative-
  prompt/consistency-notes pattern as the mock), then the shared
  `buildBookPreview` and `buildImageGenerationResult` helpers (exported from
  `story-generation-provider.ts` for reuse here) build `bookPreview` and
  `imageGenerationResult` identically to the mock path — including
  `imageGenerationResult.provider: 'local_mock'`, since real image
  generation still doesn't exist (see "What's intentionally not real yet").
  **Known limitation**: `characterCard.appearance`/`personality` are still
  fixed placeholders, not LLM-generated — only `visualAnchor` and
  `narrativeDescription` come from the model. This keeps the prompt/schema
  focused on story content; a future phase could ask the model for full
  appearance/personality too.
- **Failure path** — any thrown `StoryGenerationProviderError` (or provider
  construction error) is caught by `AgentService` exactly like a mock
  provider failure: book marked `failed`, `failedStep: 'story_plan'`, one
  `story_plan` `AgentLog` row written, nothing downstream runs.

To try it locally: set `STORY_GENERATION_PROVIDER=openai` and `OPENAI_API_KEY`
in `apps/api/.env`, then run `pnpm --filter @book/api dev` and generate a book
as usual. **CI and the test suite never do this** — they always run with the
default mock provider.

## Image generation provider boundary

`apps/api/src/images/image-generation-provider.ts` defines
`ImageGenerationProvider`, the internal boundary `AgentService` depends on
for producing the actual image _bytes_ for one `GeneratedImageEntry`
(cover/page/back_cover), mirroring the `StoryGenerationProvider` pattern:

```ts
interface ImageGenerationInput {
  bookId: string;
  entry: GeneratedImageEntry;
  characterCard: CharacterCard;
}

interface ImageGenerationOutput {
  buffer: Buffer;
  contentType: ImageAssetContentType;
}

interface ImageGenerationProvider {
  generateImage(input: ImageGenerationInput): Promise<ImageGenerationOutput>;
}
```

- Registered via `IMAGE_GENERATION_PROVIDER` in `books.module.ts`,
  injected into `AgentService`'s constructor exactly like
  `STORY_GENERATION_PROVIDER_TOKEN`.
- `MockImageGenerationProvider` is a thin wrapper around
  `generateMockImagePng(entry.seed)` — byte-identical to the pre-Phase-3C
  behavior, just behind the new interface.
- **Real provider** (`OpenAIImageGenerationProvider`,
  `apps/api/src/images/openai-image-generation-provider.ts`) calls the
  OpenAI images API (`POST {baseUrl}/images/generations`, default
  `https://api.openai.com/v1`, default model `gpt-image-1`) via an
  injectable `fetchImpl` (defaults to the Node global `fetch`) — no new
  HTTP/OpenAI SDK dependency. It requests one base64-encoded PNG
  (`b64_json`) per entry and decodes it directly to a `Buffer`; any
  fetch failure, non-ok response, invalid JSON, or missing `b64_json` throws
  `ImageGenerationProviderError` with a clear message.
- **Prompt** — `buildImagePrompt(characterCard, entry)` is a pure function
  (no network) that composes a child-safe personalized-storybook-style
  prompt from the entry's own scene (`entry.prompt`) plus
  `characterCard.visualAnchor`/`narrativeDescription` (so the protagonist
  stays visually consistent across every illustration), ending with an
  explicit no-text/no-caption/no-watermark/no-logo instruction.
- **Provider selection** — `apps/api/src/images/image-generation-provider.factory.ts`
  exports `createImageGenerationProvider(env = process.env)`, wired into
  `books.module.ts`'s `useFactory` for `IMAGE_GENERATION_PROVIDER`:
  - `IMAGE_GENERATION_PROVIDER` unset, empty, or `"mock"` →
    `MockImageGenerationProvider`.
  - `IMAGE_GENERATION_PROVIDER=openai` → `OpenAIImageGenerationProvider`,
    constructed with `OPENAI_API_KEY` (required — throws a clear `Error` at
    provider-construction time if missing) and optional `OPENAI_IMAGE_MODEL`
    (defaults to `gpt-image-1`).
  - Any other value throws a clear `Error` naming the invalid value.
- **Failure behavior** — a `generateImage` failure for one entry (e.g. a
  transient real-API error) and a `saveImageAsset` failure for one entry are
  handled identically by `AgentService.generateAndSaveImageAssets`: caught,
  logged, and counted per-entry, never thrown from that helper. That entry
  has no saved bytes, so `assertAllImagesResolved` fails the whole book at
  the `pdf_render` step (see "Local mock/real image producer" above and
  `apps/api/docs/pdf-rendering.md`) instead of degrading to a placeholder —
  this holds even if _every_ entry fails (e.g. a full API outage). The counts
  are surfaced via `imageGenerationResult.generatedImageCount`/`failedImageCount`/
  `lastImageError` (see "Generation diagnostics" below) and folded into the
  final `image_gen` `AgentLog` row's `error` field when `failedCount > 0`
  (`status` stays `success` for that row — `failedStep` is set to
  `pdf_render`, not `image_gen`, since the failure is only realized once the
  renderer tries to use the missing bytes).

To try real image generation locally: set `IMAGE_GENERATION_PROVIDER=openai`
and `OPENAI_API_KEY` in `apps/api/.env`, then run `pnpm --filter @book/api dev`
and generate a book as usual. **CI and the test suite never do this** — they
always run with the default mock provider.

## Real provider hardening (Phase 3D)

Applies only to `OpenAIStoryGenerationProvider` and
`OpenAIImageGenerationProvider` — the mock providers (and every test/CI run,
which always use them) are unaffected.

### Timeout + retry

`apps/api/src/common/openai-request.ts` exports `fetchWithRetry`, a small
shared helper used by both real providers instead of calling `fetchImpl`
directly:

- Each attempt is wrapped in an `AbortController` with a per-attempt timeout
  (`OPENAI_REQUEST_TIMEOUT_MS`, default `60000`ms if unset/malformed).
- Up to `OPENAI_MAX_RETRIES` retries (default `2` if unset/malformed) with a
  small fixed backoff (`250ms * 2^attempt`, capped at `2000ms`) on:
  - network errors (fetch itself rejects),
  - timeouts (the abort fires),
  - HTTP `408`, `500`, `502`, `503`, `504` (and, for
    `OpenAIStoryGenerationProvider`/`OpenAICharacterProfileProvider`, `429`
    too — `OpenAIImageGenerationProvider` excludes `429` here since it's
    handled by the shared rate limiter below instead).
- **Never** retried: HTTP `400`/`401`/`403` (and any other non-retryable
  status), invalid/missing JSON, and zod schema-validation failures — these
  responses/errors are returned or thrown as-is on the first attempt.
- Every attempt that exhausts retries on a network error or timeout throws
  `OpenAIRequestError` (`reason: 'network' | 'timeout'`), which each provider
  catches and wraps in its own `StoryGenerationProviderError` /
  `ImageGenerationProviderError` — `AgentService`'s existing `failedStep`
  behavior (`story_plan` / `image_gen`) is unchanged, since it only ever sees
  those provider-specific error types either way.
- `readOpenAIRetryConfig(env)` (same file) parses `OPENAI_REQUEST_TIMEOUT_MS`
  / `OPENAI_MAX_RETRIES` from env, used by both provider factories.

### Image rate limiter — `OpenAIImageRateLimiter`

`gpt-image-1` organizations on the free/Tier-1-style quota can hit a very low
images-per-minute limit (observed: 5/min). Since `AgentService.generateAndSaveImageAssets`
fires every page's `generateImage` call concurrently via `Promise.all`
(cover, pages, and back cover all dispatch at once — see that method in
`apps/api/src/agent/agent.service.ts`), and the character sheet is one more
request before that, a six-page book can easily submit 7-8 requests in the
same minute. `apps/api/src/images/openai-image-rate-limiter.ts`
adds one `OpenAIImageRateLimiter` instance, shared by every call this process
makes through `OpenAIImageGenerationProvider` (character sheet, cover, every
page, back cover — constructed once in `image-generation-provider.factory.ts`
and injected into the provider, so it's effectively process-wide):

- **Serializes** every request: calls queue on a promise chain, so only one
  request (including its own retry waits) is in flight at a time — this is
  what actually fixes the `Promise.all` burst, independent of the interval
  below.
- Enforces **`OPENAI_IMAGE_MIN_INTERVAL_MS`** (default `15000`) between the
  start of successive requests.
- On HTTP `429`, retries up to **`OPENAI_IMAGE_MAX_RETRIES`** (default `5`)
  times: honors the `Retry-After` response header when present, otherwise
  waits an exponential backoff (`OPENAI_IMAGE_RETRY_BASE_MS` default `12000`,
  doubling per attempt, capped at `OPENAI_IMAGE_RETRY_MAX_MS` default
  `60000`) plus up to 20% jitter. This is a separate, longer-running retry
  axis from `OPENAI_MAX_RETRIES`/`fetchWithRetry` above, which still handles
  network errors/timeouts/5xx for image requests with its own short backoff.
- Network errors/timeouts are **not** retried again at this layer — those are
  already handled by `fetchWithRetry` inside the dispatched request; a
  thrown error propagates immediately, preserving the existing
  fallback-to-placeholder behavior for that entry.
- Testable without real waiting: `now`/`sleep`/`random` are all injectable
  (see `OpenAIImageRateLimiter`'s constructor options and its spec file).
- `getRateLimitDiagnostics()` on the provider (surfaced via the optional
  `ImageGenerationProvider.getRateLimitDiagnostics` interface member) returns
  a safe, cumulative-since-process-start snapshot — requests queued, total
  wait ms, 429 count, retries used, and how many retries honored
  `Retry-After` — folded into `AgentService`'s existing
  `Image generation for book ...` log line. `MockImageGenerationProvider`
  has no rate limiter and never waits.

### Logging

Both real providers log via Nest's `Logger` (`OpenAIStoryGenerationProvider`
/ `OpenAIImageGenerationProvider` contexts): provider type + model on
selection (logged once by the factory), one line per request attempt
(`attempt=X/Y`), one line on success, and one line on failure with a
high-level reason. Never logged: `OPENAI_API_KEY`, the full prompt, generated
image bytes/base64, or the full raw OpenAI response — failure logs only
include the HTTP status or the `OpenAIRequestError` reason/message, not
response bodies.

### Cost guardrail — `REAL_GENERATION_MAX_PAGES`

`OpenAIImageGenerationProvider.generateImage` rejects any `page`-kind entry
whose `pageNumber` exceeds `REAL_GENERATION_MAX_PAGES` (default `12` if
unset/malformed) with a clear `ImageGenerationProviderError`, before making
any network call. `cover`/`back_cover` entries are never capped. This only
applies to the real provider — `MockImageGenerationProvider` is unchanged.
`AgentService.generateAndSaveImageAssets` catches this per entry like any
other `generateImage` failure (see "Failure behavior" above) so the rest of
the batch can keep going; this guardrail's actual effect is just to skip the
network call for pages beyond the limit. **That page still has no saved
bytes, so `assertAllImagesResolved` (see below and
`apps/api/docs/pdf-rendering.md`) now fails the whole book at the
`pdf_render` step instead of letting it complete with a placeholder** — raise
`REAL_GENERATION_MAX_PAGES` if you need real illustrations past page 12.

### Per-book illustration budget — `MAX_GENERATED_IMAGES_PER_BOOK`

A second, tighter cost guardrail lives in `AgentService.generateAndSaveImageAssets`
itself (`apps/api/src/agent/agent.service.ts`), not the provider: when the
injected `ImageGenerationProvider.providerName === 'openai'`, only the first
`MAX_GENERATED_IMAGES_PER_BOOK` entries (default `3` if unset/malformed — see
`resolveMaxGeneratedImagesPerBook` in `apps/api/src/images/image-generation-provider.ts`)
of a book's `images` array (cover, then pages in order, then back cover) are
actually sent to the provider. The remaining entries are skipped entirely —
no network call, no cost, and also no saved bytes for those entries.
`MockImageGenerationProvider` is never capped (`providerName === 'mock'`),
since it's free — every test/CI run, which always uses the mock provider,
still gets one real (mock) image per entry, unaffected by this cap.

**Since `assertAllImagesResolved` requires every planned illustration to have
real bytes before rendering (see `apps/api/docs/pdf-rendering.md`), capping
below the book's total illustration count now makes the book fail at
`pdf_render` instead of completing with placeholders for the capped pages.**
Set `MAX_GENERATED_IMAGES_PER_BOOK` to at least the book's total image count
(cover + pages + back cover) for a full real-image local test run — e.g. `9`
for a 7-page book. This is still deliberately independent of
`REAL_GENERATION_MAX_PAGES` above: that guardrail rejects any single page
request beyond a page-number threshold; this one limits the _count_ of real
illustrations per book to control cost.

### Manual end-to-end smoke test

`apps/api/scripts/smoke-real-generation.ts`
(`pnpm --filter @book/api smoke:real-generation`) runs the full real pipeline
once, end-to-end, against the real OpenAI API:

- Fails fast with a clear message (no network calls, no Nest bootstrap) if
  `OPENAI_API_KEY` is missing or if `STORY_GENERATION_PROVIDER` /
  `IMAGE_GENERATION_PROVIDER` aren't both set to `openai` — the
  precondition check lives in `smoke-real-generation-helpers.ts` and is unit
  tested directly (`smoke-real-generation.spec.ts`) without ever importing
  the main script, so normal test runs never invoke `main()` or touch the
  network.
- Otherwise boots the real Nest application context (`AppModule`) — requires
  a running local Postgres + Redis, same as `pnpm --filter @book/api dev` —
  finds-or-creates a fixed smoke-test user, creates one test book via
  `PrismaService`, and calls `AgentService.startBookGeneration` directly.
  **Deliberately unchanged by Phase 3H**: this script still calls
  `AgentService.startBookGeneration` directly rather than going through
  `POST /:id/generate` + polling. It doesn't go through `BooksService` or
  `GenerationTaskRunner` at all, so the async/background change is invisible
  to it — the script blocks on the `await` exactly as before and asserts on
  the final `Book` row synchronously, which is the simplest, most
  deterministic way to smoke-test the real pipeline end-to-end. Exercising
  the actual async HTTP endpoints (with polling) is left to the mocked
  frontend/backend test suites, which already cover that path without a real
  network call.
- **Configurable inputs (QA phase)** — `resolveSmokeBookConfig(process.env)`
  (`smoke-real-generation-helpers.ts`, pure/unit-tested) reads optional env
  vars, each with a safe default so the script still runs with none of them
  set:
  - `SMOKE_CHILD_NAME` (default `Smoke`)
  - `SMOKE_CHILD_AGE` (default `5`)
  - `SMOKE_LANGUAGE` (default `en`; also try `ru`)
  - `SMOKE_THEME` (default `friendship`)
  - `SMOKE_PAGE_COUNT` (default: `MIN_BOOK_PAGE_COUNT` = 4 — the cheapest
    page count that can still reach a real `complete` book; the story
    provider clamps any lower value back up to 4 anyway)
  - `SMOKE_CHILD_PHOTO_PATH` — optional local filesystem path to a
    `.jpg`/`.jpeg`/`.png`/`.webp` reference photo. When set, the script
    uploads it to `ImageAssetStorage` under `childPhotoAssetKey(bookId)` and
    sets `Book.childPhotoAssetKey`/`childPhotoContentType` — the same state
    `BooksService.uploadChildPhoto` produces — **before** calling
    `startBookGeneration`, so the real `OpenAICharacterProfileProvider`
    actually analyzes it. Malformed extensions fail fast with a clear error
    before any upload happens.
- Verifies the book reaches `BookStatus.complete`, that every generated image
  entry's bytes were actually saved to `ImageAssetStorage`, and that the
  rendered PDF exists in `PdfStorage` — then prints a safe summary (see
  "Smoke test output" below).
- Exits non-zero with a clear error on any failed check. Not part of
  `pnpm --filter @book/api test` or CI — matches the existing
  `smoke:pdf-storage` script's pattern (see
  `apps/api/docs/pdf-storage-smoke-test.md`).

**Known limitations**: this smoke test creates real rows against whatever
database `DATABASE_URL` points at (nothing is cleaned up afterward — same as
manually creating a book through the API) and makes real, billed OpenAI API
calls (one story completion + one image generation per page/cover/back
cover). Run it deliberately, not routinely.

### How to generate a local personalized book with a child photo (QA)

1. In `apps/api/.env`, set:

   ```env
   OPENAI_API_KEY=sk-...
   STORY_GENERATION_PROVIDER=openai
   IMAGE_GENERATION_PROVIDER=openai
   CHARACTER_PROFILE_PROVIDER=openai
   ```

   **Do not set `MAX_GENERATED_IMAGES_PER_BOOK` below the book's total planned
   illustration count.** Since `assertAllImagesResolved` requires every
   planned illustration to have real bytes before a book can reach
   `complete` (see "Per-book illustration budget" above), a cap that's too
   low doesn't produce a cheaper partial book — it makes the whole run fail
   at `pdf_render` instead. **A book's total planned illustration count is
   `2 + pageCount` (cover + pages + back cover)**. `SMOKE_PAGE_COUNT`
   defaults to `MIN_BOOK_PAGE_COUNT` (4 pages, so 6 planned illustrations) —
   the cheapest page count that can still reach a real `complete` book, since
   `resolveTargetPageCount` clamps anything lower back up to 4 anyway. Leave
   `MAX_GENERATED_IMAGES_PER_BOOK` unset (or at its existing local `.env`
   value) as long as it's `>= 6`; raise it only if you also raise
   `SMOKE_PAGE_COUNT` for a longer full-book review.

2. Run (from `apps/api`, with a local Postgres + Redis up, e.g. via
   `pnpm --filter @book/api dev`'s existing stack):

   ```sh
   SMOKE_CHILD_NAME="Mia" SMOKE_CHILD_AGE=3 SMOKE_LANGUAGE=ru \
   SMOKE_THEME="a trip to the sea" \
   SMOKE_CHILD_PHOTO_PATH="/path/to/local/photo.jpg" \
   pnpm --filter @book/api smoke:real-generation
   ```

   Omit `SMOKE_CHILD_PHOTO_PATH` to test the no-photo (generic character
   profile) path instead. Set `SMOKE_PAGE_COUNT` explicitly to review a
   longer book once the 4-page smoke run looks right.

   The script always prints its full "Validation summary" (see "Smoke test
   output" below) right after generation finishes, whether the book reached
   `complete` or `failed` — a failed run is never just a bare stack trace. If
   the process throws before or after generation (setup, Nest bootstrap, or
   the post-completion verification asserts), the top-level error message
   names the failure stage (`preconditions` / `nest-bootstrap` / `setup` /
   `generation` / `diagnostics` / `verification`) so it's clear which phase
   broke. If `SMOKE_CHILD_PHOTO_PATH` is set without
   `CHARACTER_PROFILE_PROVIDER=openai`, the script prints an upfront warning
   that visual-reference consistency won't be exercised this run.

3. **Where output lands**: with the default `LocalPdfStorage`/local
   `ImageAssetStorage` drivers, the rendered PDF is at
   `apps/api/tmp/books/<bookId>/storybook.pdf` and generated illustration
   bytes are under `apps/api/tmp/images/` (exact layout is storage-driver
   internal — always go through `imageAssetKey`/`GET
/api/books/:id/pdf/preview` rather than hardcoding paths). The console
   summary prints the book id and PDF preview URL — see "Smoke test output"
   below.
4. **Safe diagnostics to check** — either read the script's printed summary,
   or call `GET /api/books/:bookId/generation-diagnostics` directly (see
   "Reading diagnostics for a book" below):
   - `generationMetadata.storyProvider`/`imageProvider` — confirm both say
     `openai`, not `mock`, for a real QA run.
   - `generationMetadata.generatedImageCount`/`failedImageCount` — confirm
     `failedImageCount` is `0` (any failure here means the book can't
     complete — see "Failure behavior" above).
   - `characterPersonalization.hasReferencePhoto` — should be `true` only
     when `SMOKE_CHILD_PHOTO_PATH` was set.
   - `characterPersonalization.characterProfileCreated` and
     `.characterSheetGenerated` — confirm both `true` for a fully-successful
     personalized run.
   - `characterPersonalization.pagePromptsIncludeConsistencyData` — confirm
     `true`; `false` means the character-consistency block didn't make it
     into every page's illustration prompt (a regression, not expected).
   - `characterPersonalization.characterReferenceAvailable` — confirm `true`
     when a character sheet was generated; `false` with `characterSheetGenerated:
true` means the sheet was created but its bytes couldn't be read back
     from storage (see "Visual-reference consistency" below).
   - `characterPersonalization.characterReferenceUsedForImages` and
     `.imageGenerationMode` — confirm `characterReferenceUsedForImages: true`
     and `imageGenerationMode: 'character-reference-edit'` for a
     fully-successful personalized run with `IMAGE_GENERATION_PROVIDER=openai`;
     `imageGenerationMode: 'text-to-image'` is expected whenever no character
     sheet exists (e.g. `IMAGE_GENERATION_PROVIDER=mock`, or the sheet
     failed/was unreadable).
   - `pdfStorage.previewAvailable` — confirm `true` before trying
     `GET /:id/pdf/preview`.
   - `recentLogs` (in the raw diagnostics response) — the `char_build` row's
     `status`/`provider`/`error` shows whether the character-profile call
     succeeded or silently fell back to the generic mock profile (see
     "Character consistency" below).
5. **Cleaning up local files** — this script does not delete what it creates.
   To reset: delete the smoke-test book's row(s) from `Book`/`AgentLog`/
   `GenerationJob` (`childName`/`title` filter on `'Real Generation Smoke
Test'`, or `userId` of the `smoke-real-generation@storyme.local` user), and
   delete `apps/api/tmp/books/<bookId>/` and any `apps/api/tmp/images/<bookId>*`
   files for those book ids.
6. **Cost warning**: every run with `IMAGE_GENERATION_PROVIDER=openai` and
   `STORY_GENERATION_PROVIDER=openai` makes real, billed OpenAI API calls —
   one chat-completion call for the story, one vision-capable chat-completion
   call for the character profile (only if a photo is uploaded, otherwise
   still one text-only call), one image-generation call for the character
   sheet, and one image-generation call per illustration actually sent to the
   provider (capped by `MAX_GENERATED_IMAGES_PER_BOOK`). Keep the cap low for
   routine QA; only raise it when you specifically need to review a fully
   illustrated book.

### Character consistency: text-level vs. visual-reference

There are two independent, additive layers of character consistency. The
text-level layer applies to every book; the visual-reference layer only
applies when a character sheet exists and its bytes can be read back.

- **Text-level consistency** (verified, always on, works with any image
  provider): every page/cover/back-cover illustration prompt embeds the same
  `CharacterProfile`-derived consistency block
  (`buildCharacterConsistencyBlock` in `story-generation-provider.ts` —
  face/hair/outfit/age/illustration style, plus explicit "do not change the
  character's appearance" and "no text in image" instructions), and
  `buildImagePrompt` (`openai-image-generation-provider.ts`, used whenever no
  character reference image is available) repeats an explicit "keep the
  protagonist visually identical across every illustration" instruction on
  top of that. `characterPersonalization.pagePromptsIncludeConsistencyData`
  in diagnostics confirms this held for every page of a given book. This is
  purely a matter of repeating the same _words_ on every prompt — the model
  never sees the character's actual pixels.
- **Visual-reference consistency** (real `IMAGE_GENERATION_PROVIDER=openai`
  only): `AgentService` generates one standalone character-sheet reference
  image via `ImageGenerationProvider.generateCharacterSheet` and saves it to
  `ImageAssetStorage` (`buildCharacterProfileAndSheet`). Once per book
  generation run — not once per page — `AgentService.loadCharacterReference`
  reads those bytes back from storage and holds them in memory as one shared
  `ImageReference`. Every subsequent cover/page/back-cover
  `ImageGenerationProvider.generateImage` call for that run receives the same
  `ImageReference` via `ImageGenerationInput.characterReference`.
  `OpenAIImageGenerationProvider` responds to a `characterReference` being
  present by calling OpenAI's `/images/edits` endpoint (multipart/form-data,
  the character-sheet PNG attached as the input image, `input_fidelity: high`
  for the default `gpt-image-1` model) instead of `/images/generations`, using
  the dedicated `buildReferenceImagePrompt` — which tells the model to copy
  the reference sheet's identity (age, face shape, hairstyle, hair color,
  eyes, outfit, proportions, illustration style) while taking the scene
  (environment, action, emotion, lighting, framing, composition, and pose/
  expression, which are expected to change per page) from that entry's own
  prompt. **Only the generated, stylized character sheet is ever sent to an
  image-generation/edit call — the original uploaded child photo is never
  sent anywhere except the one `CharacterProfileProvider.buildProfile` vision
  call** (see `CharacterProfileInput.photo`'s doc comment in
  `character-profile-provider.ts`).
- **Cost note**: an `/images/edits` request costs the same order of magnitude
  as an `/images/generations` request per image, but every page/cover/
  back-cover illustration in a personalized run now makes one edit call
  instead of one generation call — there's no extra multiplier beyond the
  existing per-image cost already covered by `MAX_GENERATED_IMAGES_PER_BOOK`.
- **Confirming which path actually ran**: read
  `characterPersonalization.characterReferenceAvailable` (bytes were loaded
  this run), `.characterReferenceUsedForImages` (at least one real
  `generateImage` call actually received and used the reference — set from
  `ImageGenerationOutput.usedReference`, not merely inferred from
  availability), and `.imageGenerationMode`
  (`'text-to-image' | 'character-reference-edit' | 'mixed'`) from
  `GET /:id/generation-diagnostics`. `characterSheetGenerated` only means a
  sheet was _created_ — it does not imply the bytes were later available or
  used; see "Fallback behavior" below for exactly when these diverge.
- **Fallback behavior** (verified in `agent.service.spec.ts` and
  `openai-image-generation-provider.spec.ts`): if the `CharacterProfileProvider`
  throws (e.g. a vision-API error), `AgentService` catches it, logs a
  warning, and falls back to `MockCharacterProfileProvider` — generation is
  never blocked by a profile failure, and the `char_build` `AgentLog` row is
  written with `status: 'error'` and `provider: 'mock'` so the fallback is
  visible in `recentLogs`. If the character-sheet _generation_ call fails
  (profile itself succeeded), generation also continues — the book has
  `characterProfile.hasCharacterSheet: false`, no `characterSheetAssetKey`,
  and `characterReferenceAvailable`/`characterReferenceUsedForImages` both
  `false` (`imageGenerationMode: 'text-to-image'`), with `char_build` staying
  `status: 'success'` since the profile step (not the best-effort sheet) is
  what that status reflects. If the sheet _was_ generated and saved but its
  bytes can't be read back later (e.g. a storage hiccup),
  `loadCharacterReference` logs a safe warning (never bytes/base64) and
  every page falls back to the ordinary text-to-image path for that run —
  `characterSheetGenerated: true` but `characterReferenceAvailable: false`.
  `MockImageGenerationProvider` accepts (and ignores) `characterReference` on
  its input, so mock-provider books are unaffected either way and always
  report `imageGenerationMode: 'text-to-image'`.

## Generation diagnostics (Phase 3E)

Safe, non-secret inspection data for debugging a book's generation run —
useful for both the mock pipeline and the real OpenAI-backed pipeline.
**No new tables or columns were added.** Everything is derived at read time
from data `AgentService.startBookGeneration` already writes:

- `Book.generationTimeMs` — total wall-clock ms for the run (set on every
  terminal outcome: story-plan failure, image-gen failure, and the final
  `complete`/`failed` update).
- `Book.aiModelVersions` (`{ story, image }`) — a safe label per provider
  (`modelName ?? providerName ?? 'unknown'`, e.g. `"mock"` or
  `"gpt-4o-mini"`), set on every terminal outcome regardless of which step
  failed.
- `Book.failedStep` / `Book.errorMessage` / `Book.previewPdfUrl` — already
  existed, reused as-is.
- `AgentLog` rows — every row `AgentService` writes now also carries
  `provider` (`'mock' | 'openai'`, from the injected provider's
  `providerName`), `model` (from `modelName`, only set for real providers),
  and `durationMs` where a step's timing is actually measured
  (`story_plan`, `image_gen`, `layout`, `pdf_render`; the other five
  sub-steps of story generation share the story provider's `provider`/
  `model` tag but not a separate duration, since they're all produced by one
  `generateStory` call). `AgentLogStatus` has no `"started"` value, so this
  phase does not add separate started/succeeded event pairs — each step
  still gets exactly one row per run, as before.

`apps/api/src/agent/story-generation-provider.ts` and
`apps/api/src/images/image-generation-provider.ts` declare optional
`providerName`/`modelName` on their respective provider interfaces.
`MockStoryGenerationProvider`/`MockImageGenerationProvider` set
`providerName = 'mock'` (no `modelName` — there's no underlying model).
`OpenAIStoryGenerationProvider`/`OpenAIImageGenerationProvider` set
`providerName = 'openai'` and expose `modelName` as a getter over their
existing `model` field. **Never exposed**: `OPENAI_API_KEY`, prompts,
generated image bytes/base64, or raw OpenAI response bodies — providers
never had these fields, and `AgentService` never had a place to put them.

### Composing the diagnostics view

`apps/api/src/books/generation-diagnostics.ts` exports
`buildGenerationDiagnostics(book, agentLogs)`, which composes:

```ts
interface GenerationDiagnosticsDto {
  bookId: string;
  status: BookStatus;
  failedStep?: AgentStep | null;
  errorMessage?: string | null;
  generationMetadata: GenerationMetadata; // storyProvider, imageProvider, storyModel,
  // imageModel, requestedPages, generatedPages,
  // generatedImageCount, failedImageCount,
  // startedAt, completedAt, failedAt, durationMs,
  // failedStep, errorMessage
  recentLogs: AgentLogSummary[]; // up to 20 most recent AgentLog rows, newest first
  previewPdfUrl?: string | null;
  pdfStorage: PdfStorageDiagnostics; // driver, keyPresent, previewAvailable — see below
}
```

- `storyProvider`/`imageProvider` come from the matching `story_plan`/
  `image_gen` `AgentLog` row's `provider` column (`'unknown'` if no such row
  exists yet, e.g. generation hasn't started).
- `storyModel`/`imageModel` prefer `Book.aiModelVersions`, falling back to
  the `AgentLog` row's `model` column.
- `generatedPages` comes from `Book.bookPreview.pages.length`.
  `requestedPages` comes from `Book.pageCount` (an existing, currently
  unpopulated Phase 1A column — the draft-creation form doesn't collect a
  page count today, so this is usually absent; see "Known limitations"
  below).
- `generatedImageCount`/`failedImageCount` come from
  `Book.imageGenerationResult.generatedImageCount`/`failedImageCount` (set by
  `AgentService.generateAndSaveImageAssets` — see "Image generation provider
  boundary" above); both are absent for books generated before this field
  existed. `failedImageCount > 0` now means the book is `failed` (at
  `pdf_render`), not `complete` — a page missing its illustration is never
  rendered with a placeholder; check `recentLogs`' `image_gen` row (or
  `Book.imageGenerationResult.lastImageError`) for the most recent failure's
  safe error message, and the `pdf_render` row's `error` for which page(s)
  were missing.
- `startedAt` is derived (`Book.updatedAt - Book.generationTimeMs`) since
  there's no dedicated start-timestamp column; `completedAt`/`failedAt` use
  `Book.updatedAt` when `status` is terminal.

#### PDF storage diagnostics (`pdfStorage`)

Added to close the gap where a book could show `status: 'complete'` with a
`previewPdfUrl` set, yet `GET /:id/pdf/preview` still 404s — see
"Troubleshooting: PDF ready but preview/download 404s" below for the
production incident that motivated this.

```ts
interface PdfStorageDiagnostics {
  driver: 'local' | 's3' | 'r2'; // the PdfStorage driver actually configured for this process
  keyPresent: boolean; // Book.previewPdfUrl is set — the pipeline believes a PDF was saved
  previewAvailable: boolean; // the storage backend was actually asked (PdfStorage.previewPdfExists)
  // and confirmed it can produce bytes right now
}
```

- `BooksService.getGenerationDiagnostics` computes this alongside the
  existing `AgentLog`/`GenerationJob` queries: `keyPresent` is a plain
  `Book.previewPdfUrl != null` check (no I/O); `previewAvailable` only calls
  `PdfStorage.previewPdfExists(bookId)` when `keyPresent` is true (skipping an
  unnecessary disk/network round-trip for every book that hasn't reached the
  PDF step yet).
- **Never exposed**: the local filesystem path or the cloud object key —
  only the driver name and two booleans. Safe to show directly in a support
  tool or admin view.
- **How to read it**: `keyPresent: true, previewAvailable: false` is the
  specific signature of the worker/API storage-mismatch bug — the pipeline
  saved a PDF somewhere, but _this_ process's configured `PdfStorage` can't
  find it. `keyPresent: false` just means generation hasn't reached the PDF
  step yet (or failed before it). `previewAvailable: true` means
  `GET /:id/pdf/preview` should succeed right now.

### Reading diagnostics for a book

- **Service method**: `BooksService.getGenerationDiagnostics(bookId, userId)`
  — looks up the book with the same ownership check as every other
  `BooksService` method (404s rather than leaking existence of another
  user's book), fetches its 20 most recent `AgentLog` rows, and calls
  `buildGenerationDiagnostics`.
- **Route**: `GET /api/books/:id/generation-diagnostics`
  (`BooksController.getGenerationDiagnostics`, same `DevAuthGuard` as every
  other books route).

To inspect a failed generation: call the endpoint (or
`BooksService.getGenerationDiagnostics` directly in a script/REPL) for the
book's id. `failedStep` and `errorMessage` say what broke;
`generationMetadata.storyProvider`/`imageProvider`/`storyModel`/`imageModel`
say which provider/model was configured for the run; `recentLogs` gives the
per-step timeline (status, provider, model, durationMs, error) to narrow
down which step actually failed and how long prior steps took.

### Smoke test output

`pnpm --filter @book/api smoke:real-generation` (see "Manual end-to-end
smoke test" above) builds and **always** prints a "Validation summary" right
after `AgentService.startBookGeneration` returns — whether the book reached
`complete` or `failed` — via `formatDiagnosticsSummary`
(`apps/api/scripts/smoke-real-generation-helpers.ts`): book id, status,
story/character-profile/image provider + model, requested vs. generated page
count, expected vs. generated vs. fallback image counts, duration, PDF
preview url, whether the PDF exists in storage and has non-zero size, the
character-sheet's safe storage-key identifier (never a filesystem path), the
character-reference-usage flags, **the `GET /:id/generation-diagnostics` URL
for the book**, and (only on failure) `failedStep` and `errorMessage`.

`formatDiagnosticsSummary` takes the shared `GenerationDiagnosticsDto` plus an
optional `SmokeValidationExtras` object (script-local, not part of
`@book/types` — see the helpers file) carrying the fields the shared DTO
doesn't have: `expectedImageCount`, `fallbackImageCount`,
`characterSheetAssetId`, `characterProfileProvider`, `pdfExists`,
`pdfSizeBytes`. It's a pure function — unit tested directly in
`smoke-real-generation.spec.ts` without booting Nest or making a network
call — and only ever prints fields already proven safe by
`GenerationDiagnosticsDto`/`GenerationMetadata`/`SmokeValidationExtras`. It
never prints `OPENAI_API_KEY`, a raw prompt, or generated image bytes/base64
— see "What's intentionally not stored (safety)" below.

If generation itself throws, or an error occurs outside
`startBookGeneration` (setup, Nest bootstrap, or the post-completion
verification asserts), the script's top-level error message names the
failure stage it was in (`preconditions` / `nest-bootstrap` / `setup` /
`generation` / `diagnostics` / `verification`) instead of a bare stack trace
— see "Manual end-to-end smoke test" above.

### What's intentionally not stored (safety)

Never logged, stored, or returned by diagnostics:

- `OPENAI_API_KEY` or any other secret.
- Full prompts (story or image).
- Generated image bytes or base64 (`b64_json`).
- Full raw OpenAI response bodies (chat completion or image generation).

### Known limitations

- `requestedPages` is usually absent — the Phase 1A draft-creation flow
  doesn't collect a target page count (`Book.pageCount` stays `null`), even
  though `OpenAIStoryGenerationProvider` internally targets 6 pages
  (`TARGET_PAGE_COUNT`). A future phase could thread that value onto `Book`
  at generation-start time.
- No "started" `AgentLog` events — `AgentLogStatus` only has
  `success`/`error`/`retry`, no `pending`/`started` value, so diagnostics
  can't show an in-progress step's live state, only completed/failed steps
  after the fact. Adding one would need a schema migration, which this
  phase deliberately avoided.
- Retry/attempt counts aren't threaded through to `AgentLog.attempt` — real
  providers already retry via `fetchWithRetry` (Phase 3D) and log each
  attempt via `Logger`, but the final attempt count isn't returned to
  `AgentService`, so every `AgentLog` row still records `attempt: 1`
  regardless of how many HTTP attempts it took.

### Frontend integration (Phase 3F)

The book detail page (`apps/web/src/app/dashboard/books/[id]/page.tsx`)
surfaces `GET /api/books/:id/generation-diagnostics` through a compact
"Generation diagnostics" panel (`GenerationDiagnosticsPanel`), shown for any
book past the `created` draft status:

- `apps/web/src/lib/api/books.ts` — `booksApi.getGenerationDiagnostics(id)`,
  typed against the same `GenerationDiagnosticsDto` exported from
  `@book/types` that the backend DTO already uses (no new frontend types —
  `GenerationDiagnosticsDto`/`GenerationMetadata`/`AgentLogSummary` are
  defined once, in `packages/types`, and shared by both sides).
- **Panel contents**: story/image provider + model, generated (of requested)
  page count, duration (formatted as `1m 5s` / `650ms` rather than raw
  milliseconds), and a "PDF: ready" row once `previewPdfUrl` is set. Only
  fields already proven safe by `GenerationDiagnosticsDto` are rendered — see
  "What's intentionally not stored" above; the panel has no path to prompts,
  image bytes, or raw provider responses because the DTO never carries them.
- **Failure display**: when `failedStep`/`errorMessage` are present, the
  panel adds a small danger-styled block with the failed step, the safe
  `errorMessage` string, and a static "Try again later, or check diagnostics
  for more detail" hint. No stack traces or raw provider payloads are ever
  rendered — again, because the DTO doesn't carry them.
- **Polling**: the existing book-status poll (every 2.5s, only while status
  is non-terminal — see "Status transitions" below) now also re-fetches
  diagnostics on each tick, so the panel's provider/page/duration fields
  update live during generation. Diagnostics are also fetched once
  immediately whenever a book's status leaves `created`, so the panel has
  data even before the first poll tick. Both stop the moment status becomes
  `complete`/`failed`/`cancelled`/`partial`, same as the book poll.
- **Failure isolation**: a failed diagnostics fetch only sets a local
  "Diagnostics unavailable" message inside the panel — it never blocks
  rendering the rest of the book detail page (story plan, preview, PDF
  section, etc.), which is unaffected by diagnostics being unavailable.

To inspect a failed generation from the UI: open the book's detail page:
the status badge and the `PdfSection`'s failure banner show it failed, and
the diagnostics panel underneath shows the failed step and safe error
message directly — no separate tool or API call needed.

## Retrying failed generation (Phase 3G)

A book that lands in `BookStatus.failed` (story-plan failure, image-gen
failure, or PDF-render failure — see "Failure states summary" below) isn't a
dead end: `POST /api/books/:id/retry-generation` re-runs the same pipeline in
place, reusing `AgentService.startBookGeneration` rather than duplicating any
generation logic.

- **How a failed generation is represented** — nothing new. `Book.status ===
'failed'`, `Book.failedStep` (which pipeline step failed), and
  `Book.errorMessage` (the caught error's message) are the same fields set by
  the original run (see "What `AgentService.startBookGeneration` does, in
  order" above). The `AgentLog` rows from the failed attempt are never
  deleted.
- **How to inspect diagnostics** — unchanged from Phase 3E: `GET
/api/books/:id/generation-diagnostics` (or the book detail page's
  diagnostics panel) shows `failedStep`, `errorMessage`, and `recentLogs` for
  the failed run. See "Generation diagnostics (Phase 3E)" above.
- **How to retry** — `BooksService.retryGeneration(userId, bookId)`:
  1. `findOwnedOrThrow` — 404 if the book doesn't exist, belongs to another
     user, or is soft-deleted (same ownership check as every other
     `BooksService` method).
  2. Requires `status === 'failed'` — otherwise `ConflictException` (409,
     "Only failed books can be retried"). Since intermediate pipeline steps
     never set `status` back to `failed` until a terminal outcome, this same
     check also rejects retrying a book that's already `complete` or
     currently mid-generation — there's no separate "is generating" flag to
     maintain.
  3. `prisma.book.update`: clears `failedStep`/`errorMessage` to `null` and
     increments `Book.retryCount`, before generation runs again — so if the
     retry fails too, the new failure's `failedStep`/`errorMessage` aren't
     mixed up with the old ones.
  4. Delegates to `AgentService.startBookGeneration(clearedBook)` — the exact
     same call `BooksService.startGeneration` makes. This appends a fresh set
     of `AgentLog` rows (new `traceId`) on top of the failed attempt's rows;
     nothing is deleted, so the full retry history stays visible via
     `recentLogs`/`GET /:id/generation-diagnostics`.
  5. Returns `GenerateBookResponse` (`{ book }`) — the same response shape
     `POST /:id/generate` returns, with the book's final `complete`/`failed`
     status.
- **Route**: `POST /api/books/:id/retry-generation`
  (`BooksController.retryGeneration`, same `DevAuthGuard` as every other
  books route, `@HttpCode(200)` like `generate`).
- **Frontend**: the book detail page shows a "Retry generation" button next
  to the diagnostics panel only when `status === BookStatus.Failed`. Clicking
  it calls `booksApi.retryGeneration(id)` (`POST
/books/:id/retry-generation`), disables the button until the response
  comes back, and on success replaces the page's `book` state with the
  response — which re-triggers the existing status/diagnostics poll effect
  exactly as a fresh `Generate Story` click does, since that effect is keyed
  off `book.status` rather than any retry-specific flag. On failure, the
  caught error's message is shown in a `role="alert"` banner (same pattern as
  the `Generate Story` and edit-form error banners) — never a raw
  stack trace or provider response.
- **Known limitations**:
  - Like `startGeneration`, this is a check-then-act read/update with no
    row-level lock or transaction — two concurrent retry requests for the
    same book both racing past the `status === 'failed'` check is a
    theoretical (pre-existing) race, narrowed but not eliminated by the
    `GenerationTaskRunner.isRunning` check added in Phase 3H (see "Background
    generation (Phase 3H)" below).
  - Since Phase 3H, the pipeline runs in the background (see "Background
    generation (Phase 3H)" below) — the retry endpoint's HTTP response
    returns as soon as the book is flipped back to `char_build`, not once the
    re-run finishes. The book detail page's existing poll loop is what
    eventually shows the retry's outcome.
  - Retrying does not reset or refund anything cost-related
    (`Book.totalCostUsd`, credits) — Phase 3G only clears the failure markers
    and re-runs generation.

## Background generation (Phase 3H)

> **Superseded by "Durable generation queue (Phase 3K)" below.** This section
> is kept for history — `GenerationTaskRunner` and the in-process scheduling
> it describes no longer exist in the code; `generationTaskRunner.run(...)`
> below is the same call site now made through `GenerationQueueService`. The
> request-lifecycle behavior (HTTP response returns as soon as the status
> transition is persisted, pipeline runs after) is unchanged — only _what_
> runs it changed.

`POST /api/books/:id/generate` and `POST /api/books/:id/retry-generation`
return as soon as the status transition is persisted — they no longer wait
for the whole pipeline (including PDF render) to finish. The pipeline itself
is unchanged; only _when_ the HTTP response is sent changed.

- **`apps/api/src/agent/generation-task-runner.ts`** — `GenerationTaskRunner`,
  an injectable, in-process scheduler:
  - `run(bookId, task)` schedules `task` (an `() => Promise<void>`) on the
    microtask queue via `Promise.resolve().then(...)` — no `setTimeout`, no
    external queue. Returns `false` without scheduling anything if `bookId`
    is already in its in-memory `running` `Set`, so the same book can't have
    two pipeline runs in flight at once within this process.
  - Any error the task throws is caught, logged (`Unhandled generation task
error for book <id>: <message>`), and swallowed — a background failure
    can never crash the process via an unhandled rejection.
  - `bookId` is removed from the running set in a `finally`, whether the task
    resolved or rejected, so the same book can be regenerated later.
  - `isRunning(bookId)` lets `BooksService` reject a second `generate`/
    `retry-generation` call for a book that's already scheduled, before even
    touching the database.
- **`BooksService.startGeneration`/`retryGeneration`** now do only the
  "start" half of what they used to do synchronously:
  1. Same validation/ownership/state checks as before, plus a
     `generationTaskRunner.isRunning(bookId)` check.
  2. One `prisma.book.update` that flips `status` to `char_build` (and, for
     retry, also clears `failedStep`/`errorMessage` and increments
     `retryCount` — unchanged from Phase 3G).
  3. `generationTaskRunner.run(bookId, () => this.runGenerationPipeline(book))`
     — schedules the pipeline and returns immediately; the returned
     `GenerateBookResponse` carries the `char_build` book, not a terminal one.
- **`BooksService.runGenerationPipeline`** (private) is the task body: it
  calls `AgentService.startBookGeneration(book)` — the exact same call
  `startGeneration`/`retryGeneration` used to make directly, so none of
  `AgentService`'s own failure handling (story-plan/image-gen/pdf-render →
  `failed`) changed. This method's own `try/catch` only guards against an
  error escaping _all_ of `AgentService`'s handling (a truly unexpected bug);
  if that happens, it marks the book `failed` with the caught error's message
  so the book never gets stuck in a non-terminal status forever, and logs
  (`Background generation pipeline threw unexpectedly for book <id>:
<message>`). Even the fallback `prisma.book.update` is wrapped in a
  `.catch()` — this method must never throw, since nothing awaits it.
- **Duplicate generation** — guarded at two levels: the DB `status` check
  (a book already past `created`/not `failed` is rejected with 409 before any
  scheduling happens) and `GenerationTaskRunner.isRunning` (an in-memory,
  same-process guard for the narrow window between two requests racing past
  that DB check). Neither is a distributed lock — this remains in-process
  only, same as every other limitation in this document.
- **Frontend** — no changes were needed. The book detail page's polling
  (`isGeneratingBookStatus`, the 2.5s interval effect) already treated every
  non-`created`, non-terminal status generically, and `char_build` already
  had a status message ("Building character profile…") from Phase 3F. The
  Generate/Retry buttons already only stayed in their loading state for the
  fetch call itself (`setGenerating(true)` around `await booksApi.generate(id)`),
  so they now simply return to normal state much sooner, before polling picks
  up the rest of the run.

## Generation jobs (Phase 3I)

Alongside `Book.status` (still the source of truth for user-facing status),
every `generate`/`retry-generation` call now also creates a `GenerationJob`
row — a typed, persisted record of that one generation _attempt_. This is
job-state hardening only: the runner is still `GenerationTaskRunner`
in-process scheduling (unchanged from Phase 3H), not a durable queue. The
model exists so generation attempts are individually inspectable today and so
a future durable queue (BullMQ/Redis) has a typed shape to migrate onto,
without redesigning the pipeline.

- **Schema** — `apps/api/prisma/schema.prisma`'s `GenerationJob` model
  (migration `20260702000000_phase3i_generation_jobs`):
  `id`, `bookId`, `userId`, `type` (`generate` | `retry`), `status`
  (`queued` | `running` | `completed` | `failed` | `cancelled` — `cancelled`
  is reserved, nothing sets it yet), `attempt`, `maxAttempts` (unused today,
  reserved for a future retry-cap policy), `failedStep`, `errorMessage`,
  `runnerId` (unused today, reserved for multi-instance ownership), and
  `createdAt`/`startedAt`/`completedAt`/`failedAt`/`updatedAt`.
- **Service** — `apps/api/src/agent/generation-job.service.ts`
  (`GenerationJobService`, registered in `books.module.ts`) is the only
  thing that touches the `generation_jobs` table: `findActive` (queued/running
  job for a book), `findLatest` (most recent job of any status), `createQueued`,
  `markRunning`, `markCompleted`, `markFailed`. `BooksService` never queries
  `prisma.generationJob` directly.
- **Lifecycle** — `BooksService.startGeneration`/`retryGeneration` create a
  `queued` job (`type: 'generate'`/`'retry'`, `attempt: 1` for a fresh
  generate, `attempt: clearedBook.retryCount + 1` for a retry — `retryCount`
  is already post-increment by the time the job is created, so this counts
  the original generate as attempt 1 and each retry after it) in the same
  call that flips `Book.status` to `char_build`, then schedule
  `runGenerationPipeline(book, job.id)` via `GenerationTaskRunner` exactly as
  before. Inside `runGenerationPipeline`: `markRunning` right away, then after
  `AgentService.startBookGeneration` resolves, `markCompleted` if the
  returned book's status isn't `failed`, or `markFailed` (with the book's
  `failedStep`/`errorMessage`) if it is. If the pipeline throws unexpectedly
  (the same defensive catch from Phase 3H), the job is also `markFailed` with
  the caught error's message, after the book itself is marked `failed`. Every
  `GenerationJobService` call in `runGenerationPipeline` is wrapped in a
  `.catch()` that only logs — a job-write failure can never change the book's
  own outcome or throw out of the background task, matching the existing
  "this method must never throw" invariant from Phase 3H.
- **Duplicate generation protection** — `startGeneration`/`retryGeneration`
  now reject with the same `ConflictException` ("Generation is already in
  progress for this book") when `generationJobService.findActive(bookId)`
  returns a `queued`/`running` job, in addition to the existing
  `GenerationTaskRunner.isRunning` check from Phase 3H and the `Book.status`
  check. A book that has a `completed` or `failed` job on record is not
  blocked — only an active (`queued`/`running`) job blocks a new attempt, so
  a normal retry after a failure is unaffected. None of these three checks is
  a distributed lock; see "Known limitations" below.
- **Diagnostics** — `GET /:id/generation-diagnostics` now also returns
  `latestJob` (`GenerationJobSummary | null`): `id`, `type`, `status`,
  `attempt`, `createdAt`, and whichever of `startedAt`/`completedAt`/
  `failedAt`/`failedStep`/`errorMessage` apply. `BooksService.getGenerationDiagnostics`
  fetches it via `generationJobService.findLatest` in parallel with the
  existing `AgentLog` query. `buildGenerationDiagnostics`
  (`apps/api/src/books/generation-diagnostics.ts`) maps the `GenerationJob`
  row to `GenerationJobSummary` and deliberately omits `runnerId` — never
  exposed, same safety bar as the rest of this DTO (see "What's intentionally
  not stored (safety)" above).
- **Known limitations**:
  - **No resume-on-restart.** A `GenerationJob` stuck in `running` because the
    API process crashed or redeployed mid-generation is not automatically
    retried — see "Startup recovery (Phase 3J)" below for what _does_ happen
    to it on the next boot (a fail-safe, not a resume).
  - ~~Still in-process, still no cross-instance coordination.~~ **Done in
    Phase 3K** — see "Durable generation queue (Phase 3K)" below.
    `maxAttempts` and `runnerId` remain schema-only/unused; BullMQ's own
    per-job `attempts`/backoff options are configured instead (see
    `queue.module.ts`), and `runnerId` was never needed since BullMQ tracks
    job ownership itself.

## Startup recovery (Phase 3J)

Phase 3I made a `GenerationJob` stuck in `queued`/`running` after an API
crash or redeploy _visible_ via diagnostics but didn't fix it — the book
stayed in a non-terminal "generating" status forever, since nothing else
would ever move it. Phase 3J closes that gap with a **fail-safe, not a
resume**: on every app boot, any job left active by a previous process is
marked `failed` with a safe, generic message, and the retry-generation flow
(Phase 3G) is how the user gets unstuck — generation itself is never
automatically re-run.

- **`apps/api/src/agent/generation-job.service.ts`** — new
  `findStaleActiveJobs(cutoff)`: queued/running jobs whose `updatedAt` is
  older than `cutoff`. `updatedAt` alone covers both staleness rules from the
  spec — for a job still `queued` it equals `createdAt` (nothing has updated
  it since creation), and for a `running` job it reflects `markRunning`'s
  write — so no separate "queued age" vs. "running age" query is needed.
- **`apps/api/src/agent/generation-job-recovery.service.ts`** —
  `GenerationJobRecoveryService`, registered in `books.module.ts` alongside
  `GenerationJobService`:
  - Implements Nest's `OnApplicationBootstrap`, so it runs once after the
    module graph (including `PrismaService`) is fully wired, not mid-startup.
  - `readGenerationJobStaleAfterMs(env)` reads
    `GENERATION_JOB_STALE_AFTER_MS` (default `1800000`ms / 30 minutes),
    falling back to the default for a missing or malformed value — same
    parsing pattern as `readOpenAIRetryConfig` in `openai-request.ts`.
  - `recover(staleAfterMs, now?)` computes `cutoff = now - staleAfterMs`,
    calls `findStaleActiveJobs(cutoff)`, and for each stale job:
    1. `generationJobService.markFailed(job.id, { errorMessage:
GENERATION_INTERRUPTED_MESSAGE })` — `"Generation was interrupted
before completion. Please retry."`. `failedStep` is left `null`
       rather than set to a specific `AgentStep`: recovery has no record of
       which pipeline step the process actually died on (`GenerationJob`
       doesn't track a "current step"), and `AgentStep` is a strict Prisma
       enum with no generic "unknown"/"recovery" value — guessing a specific
       step would be more misleading in diagnostics than leaving it unset.
    2. Looks up the job's `Book`; if its `status` isn't one of the terminal
       values (`complete`, `failed`, `partial`, `cancelled`), updates it to
       `status: 'failed'`, `failedStep: null`, `errorMessage:
GENERATION_INTERRUPTED_MESSAGE`. A book already `complete` or `failed`
       is left completely untouched — recovery never overwrites an existing
       outcome or a prior failure's own `errorMessage`/`failedStep`.
    - Each job is recovered independently (`try/catch` per job) — one job
      failing to update (e.g. a transient DB error) doesn't stop the rest
      from being recovered, and is counted in the returned summary instead.
    - Returns `{ staleJobsFound, jobsRecovered, errors }`.
  - `onApplicationBootstrap()` calls `recover()` and logs the summary as a
    single line (counts only — no job/book ids, no error details beyond a
    caught error's `message`). Wrapped in its own `try/catch`: if recovery
    itself throws (e.g. the database isn't reachable yet), the error is
    logged and swallowed — a recovery failure can never prevent the API from
    starting.
- **`AgentLog` history is untouched** — recovery never reads or writes the
  `agent_logs` table, so every prior attempt's log rows (including the
  interrupted one, whatever it managed to write before dying) remain exactly
  as they were.
- **Diagnostics** — no changes needed. `GET /:id/generation-diagnostics`
  already derives `latestJob` from `GenerationJobService.findLatest`, which
  reads the same (now-updated) `GenerationJob` row; a recovered job shows up
  as `latestJob.status: 'failed'` with `errorMessage:
"Generation was interrupted before completion. Please retry."` the next
  time diagnostics are fetched, with no extra plumbing.
- **Retry after recovery** — unaffected. A book recovery marks `failed` is,
  from `BooksService.retryGeneration`'s point of view, indistinguishable from
  any other failed book (same `status === 'failed'` check); the existing
  Phase 3G retry flow clears `failedStep`/`errorMessage` and re-runs
  generation exactly as it would after a real story/image/PDF failure.
- **Known limitations**:
  - **Not a resume.** Recovery never re-runs generation or restores
    in-flight state — a recovered book always needs an explicit user retry,
    even if the interrupted run was seconds away from finishing.
  - **No distributed lock.** Recovery runs independently in every API
    process on its own boot, reading/writing through the same
    single-Postgres-instance view as the rest of this document — running two
    API instances still has no shared coordination (same limitation noted
    under "Generation jobs (Phase 3I)" above). Two instances booting at
    once could both attempt to recover the same stale job; each write is a
    plain `update` (last write wins), not a `SELECT ... FOR UPDATE` or
    optimistic-lock pattern, so this is safe but not strictly exactly-once.
  - ~~No durable external queue.~~ **Done in Phase 3K** — see below. This
    recovery sweep still runs on every boot regardless, since it's the only
    thing that catches a job BullMQ itself can't recover (e.g. the whole
    process, including Redis connectivity, died in a way BullMQ's stalled-job
    detection doesn't cover before the next restart).
  - A job that goes stale _between_ recovery runs (i.e., the API stays up but
    the worker silently stops progressing without throwing or the process
    crashing) is not detected until the next process restart — recovery only
    runs on boot, not on an interval. BullMQ's own stalled-job detection (see
    below) narrows this further but doesn't eliminate it.

## Durable generation queue (Phase 3K) — superseded, see "Generation runs, fencing, and recovery" below

**This section describes the original Phase 3K design and is now historical.**
`GenerationJob` is no longer the dispatch/concurrency source of truth —
`GenerationRun` (introduced in the "production-safety hardening" commit and
hardened further in Phase A below) replaced it. `GenerationJob` rows are still
created as a best-effort, non-authoritative diagnostics mirror (see
`BooksService.createRunAndSchedule`), but nothing about ownership, retries, or
recovery reads them anymore. The mechanics below (BullMQ queue/producer/worker
shape, "why a durable queue at all") are still accurate in spirit; the
specifics of what dispatches jobs and what a retry means are not — read the
next section instead.

Closes the gap Phase 3I/3J both flagged as future work: `GenerationTaskRunner`
(Phase 3H), the in-process, in-memory scheduler, is gone. Every
`generate`/`retry-generation` call now enqueues its `GenerationJob` (Phase 3I)
onto a real BullMQ queue backed by the same Redis instance the rest of the API
already depends on (`RedisService`/`CacheModule`) — `@nestjs/bullmq`/`bullmq`
had been dependencies since early on but were unused until now. Nothing about
`Book.status`, the `GenerationJob` state model, the diagnostics/status
endpoints, or `AgentService`'s pipeline changed — only what schedules and runs
`BooksService.runGenerationPipeline` changed.

- **Queue** — `apps/api/src/queue/queues.config.ts` adds `QUEUES.BOOK_GENERATION`
  (`'book-generation'`) alongside the nine still-unused per-pipeline-step
  queue names reserved for a future finer-grained architecture. This queue
  carries one job per generation attempt — today's pipeline is still the
  single monolithic `AgentService.startBookGeneration` call, so a single
  whole-job queue matches the actual architecture instead of speculatively
  splitting it into steps.
- **`apps/api/src/queue/queue.module.ts`** is now `@Global()` (mirrors
  `CacheModule`) so any feature module can `@InjectQueue(...)` without
  importing it directly. Its existing `DEFAULT_JOB_OPTIONS` (3 attempts,
  exponential backoff starting at 2s) still applies to this queue, though it
  never actually triggers here — see the processor note below.
- **Producer — `apps/api/src/agent/generation-queue.service.ts`**
  (`GenerationQueueService`, registered in `books.module.ts`): `enqueue({
bookId, jobId })` adds one job (`queue.add('run-generation', data, { jobId
})`), using the `GenerationJob` row's own id as the BullMQ job id. Since
  that id is already unique per attempt (a fresh `GenerationJob` is created by
  `startGeneration`/`retryGeneration` every time), no separate
  de-duplication logic is needed at the queue layer — `GenerationJobService.findActive`
  (DB-backed, cross-instance) plus `BooksService`'s atomic status-claim UPDATE
  are still what prevent two concurrent attempts for the same book (see
  "Generation jobs (Phase 3I)" above), exactly as before.
- **Worker — `apps/api/src/agent/generation-queue.processor.ts`**
  (`GenerationQueueProcessor`, conditionally registered in `books.module.ts`):
  a `@Processor(QUEUES.BOOK_GENERATION)`/`WorkerHost` that calls
  `BooksService.runGenerationPipeline(bookId, jobId)` for each job. Originally
  ran embedded in the API process; since "Worker process separation" below it
  runs in a dedicated `apps/api/src/worker.ts` process instead, since the
  producer/consumer contract was always just `{ bookId, jobId }` over Redis.
- **`BooksService.runGenerationPipeline`** changed signature from
  `(book: Book, jobId: string)` to `(bookId: string, jobId: string)` and is
  now `public` (called by `GenerationQueueProcessor`, not just scheduled via a
  closure) — it reloads the book fresh via `prisma.book.findUniqueOrThrow`
  instead of trusting a caller-supplied object, since a durable queue job can
  run in a different process, or after a delay, from whenever it was
  enqueued. Its own body (mark running → call `AgentService.startBookGeneration`
  → mark completed/failed, catch-and-mark-failed on an unexpected throw) is
  unchanged from Phase 3H/3I and still never throws.
- **`BooksService.startGeneration`/`retryGeneration`** dropped the
  `GenerationTaskRunner.isRunning(bookId)` pre-check entirely — it was never
  the actual concurrency guard (the atomic status-claim UPDATE was, per the
  existing code comments), and BullMQ's per-attempt unique job id makes an
  equivalent in-memory check both impossible to implement meaningfully across
  processes and unnecessary. The rejected-schedule fallback (previously
  "`GenerationTaskRunner.run()` returned `false`") is now "the queue's
  `enqueue()` call itself threw" (e.g. Redis unreachable) — same shape
  (mark job + book `failed` with a safe message), but now throws
  `InternalServerErrorException` (500) instead of `ConflictException` (409),
  since a failed enqueue is an infrastructure fault, not a duplicate-request
  conflict.
- **Retries** — `BooksService.runGenerationPipeline` never throws, so
  BullMQ's own `attempts`/backoff job-retry (`DEFAULT_JOB_OPTIONS`) never
  actually triggers for this queue: from BullMQ's point of view every job
  "succeeds" the moment `process()` resolves, regardless of whether the book
  itself ended up `complete` or `failed`. Retrying a failed generation is
  still exclusively the user-driven `POST /:id/retry-generation` flow
  (Phase 3G) — BullMQ is durability infrastructure here, not a retry policy.
- **What this actually buys**:
  - **Durability across the API process restarting mid-schedule.** Before,
    if the process died between the atomic status-claim UPDATE and the
    (synchronous, in-memory) `GenerationTaskRunner.run()` call, the job was
    silently lost — nothing would ever run it, and only `GenerationJobRecoveryService`'s
    next-boot sweep (Phase 3J) would eventually notice and fail it out.
    Now the job is durably enqueued in Redis the moment `enqueue()` resolves,
    surviving an API restart; a fresh worker picks it up on the next boot.
  - **Cross-instance work distribution.** Running multiple API instances
    behind a load balancer now lets BullMQ distribute `book-generation` jobs
    across whichever instance's worker claims each one, instead of every
    instance's in-memory `running` `Set` only knowing about its own
    schedules. The _request-time_ duplicate-generation guard
    (`GenerationJobService.findActive` + the atomic status-claim UPDATE) was
    already cross-instance-safe via Postgres and is unchanged.
  - **BullMQ's own stalled-job detection** as a second (partial) safety net
    alongside `GenerationJobRecoveryService`: if a worker process dies mid-job,
    BullMQ can reassign the job to another worker after a timeout. This
    doesn't make `AgentService.startBookGeneration` resumable from where it
    left off — a "stalled" retry just re-runs `runGenerationPipeline` from the
    top against whatever the book's current DB row looks like — but it's a
    tighter recovery window than waiting for the next full app boot.
- **Known limitations**:
  - **Still not a true resume.** A re-run (whether from a BullMQ stalled
    retry or a fresh `retry-generation` call) always re-runs
    `AgentService.startBookGeneration` from the top; there is still no
    mid-pipeline checkpoint/resume.
  - **`maxAttempts`/`runnerId`** on `GenerationJob` remain schema-only and
    unused — BullMQ tracks its own job attempts/ownership internally, and
    nothing in this phase needed to surface that back onto the `GenerationJob`
    row.
  - ~~Worker still runs in-process with the API.~~ **Done — see "Worker
    process separation" below.**

## Generation runs, fencing, and recovery (Phase 2 / Phase A)

`GenerationRun` (`apps/api/prisma/schema.prisma`) is the sole source of truth
for "is a generation attempt in flight for this book, and who owns it" —
`GenerationJob` is kept only as a best-effort diagnostics mirror and must never
be read for ownership, retry, or recovery decisions.

### Creating a run — one transaction, outbox-dispatched

`BooksService.createRunAndSchedule` (used by `startGeneration`/
`retryGeneration`/`regenerateBook`) does three things in a single DB
transaction: creates the `GenerationRun` row, transitions `Book.status`/
`Book.activeRunId`, and writes an `OutboxEvent`. The actual BullMQ publish is
**not** done inside that transaction — `OutboxDispatcherService` sweeps
still-`pending` outbox rows on an interval (every process, API and worker
both) and publishes them, using the run's own id as the BullMQ `jobId`. This
is what makes "commit the run, then crash before publishing" impossible to
lose: the event is already durable in Postgres, and any live process's next
sweep re-publishes it (idempotently, since the jobId is stable).

A hand-added partial unique index
(`generation_runs_one_active_per_book`, `WHERE status IN ('queued','running')`)
enforces "at most one active run per book" at the database level — this, not
`Book.activeRunId`, is the actual source of truth for that invariant;
`Book.activeRunId` is an application-level mirror of it.

### Immutable input — `GenerationInputSnapshot`

`apps/api/src/agent/generation-input-snapshot.ts` defines a Zod schema
(`generationInputSnapshotSchema`) for `GenerationRun.inputSnapshot` — every
read of a run's snapshot goes through `parseGenerationInputSnapshot(runId,
value)`, which throws a stable-coded `InvalidGenerationInputSnapshotError`
(`GENERATION_INPUT_SNAPSHOT_INVALID`) rather than trusting an unchecked cast
of Prisma JSON. The uploaded child photo is identified immutably: `childPhoto`
carries `{ assetKey, sha256, contentType, sizeBytes }`, not just a mutable
key. `BooksService.uploadChildPhoto` mints a fresh, versioned
`ImageAssetStorage` key (`childPhotoAssetKey(bookId, randomUUID())`) on every
upload rather than overwriting a fixed one, so a later re-upload can never
mutate bytes an already-created run's snapshot still references.
`hashInputSnapshot` canonicalizes recursively (every nesting level's keys
sorted, not just the top level) before hashing, so the hash is stable
regardless of field insertion order at any depth.

Critically: **the pipeline consumes the snapshot, not the live Book row.**
`GenerationQueueProcessor.process` builds a `GenerationExecutionContext`
(`runId`, `bookId`, `fencingVersion`, `inputHash`, `inputSnapshot`, `signal`)
immediately after a successful claim and passes that — not a
freshly-reloaded, possibly since-edited `Book` — into
`AgentService.startBookGeneration(ctx)`, which resolves every
generation-relevant field (`childName`, `childAge`, `theme`, `language`,
`pageCount`, `educationalMessage`, the child photo) from `ctx.inputSnapshot`.
The Book row is still loaded, but only for prior-progress fields (story
plan/character card/etc., for idempotent resume) and identity — never for
the input parameters themselves. This is what makes "edit the book, then
retry" resume from the _pre-edit_ input the retried run actually captured,
not whatever the book looks like right now.

#### Snapshot versioning + legacy backfill (Phase A.1)

`generationInputSnapshotSchema` carries an optional `snapshotVersion` (current
= `CURRENT_SNAPSHOT_VERSION`, 2) — optional so a snapshot that already
structurally matches this shape but predates the field parses as current
without a migration; the two shapes are already structurally distinguishable
regardless of the tag. `legacyGenerationInputSnapshotSchemaV1` matches the
exact pre-Phase-A shape: no `snapshotVersion`, a bare
`childPhotoAssetKey`/`childPhotoContentType` instead of `childPhoto`'s full
versioned identity object (this predates `Book.childPhotoSha256`/
`childPhotoSizeBytes` existing at all).

`GenerationInputSnapshotBackfillService.normalize(run)` — used by
`GenerationQueueProcessor` (claiming) and `BooksService.retryGeneration`
(copying a prior run's snapshot forward) instead of the plain
`parseGenerationInputSnapshot` — tries the current schema first, and only on
failure attempts the legacy one. A legacy snapshot with no photo normalizes
with no I/O. A legacy snapshot _with_ a photo reads the existing asset bytes
once, computes sha256/size, and writes an **immutable versioned copy** under
a fresh key (mirroring `uploadChildPhoto`'s own versioning invariant — the
original bytes are never mutated or deleted). If the legacy photo's bytes are
missing from storage, this throws `InvalidGenerationInputSnapshotError` rather
than silently treating the run as if it never had a photo — a legacy photo is
never silently discarded just because the new digest columns are null. Safe to
call on a run in any status (queued/running/failed/completed): it only ever
reads+rewrites the `inputSnapshot`/`inputHash` columns, never touches
status/fencing.

`normalize` returns `{ snapshot, inputHash }`, never just the snapshot —
**every caller must use the returned `inputHash`, never a run's own
`.inputHash` field read separately.** A migration rewrites `inputSnapshot` to
the current shape and, in the same write, recomputes and persists `inputHash
= hashInputSnapshot(snapshot)` — the two always travel together. Earlier, only
`inputSnapshot` was rewritten and `inputHash` was left exactly as it was
pre-migration; since a retry always builds its _new_ run's hash fresh from its
own (already-current) copy of the snapshot (`BooksService.createRunAndSchedule`),
that stale value could never equal `Book.lastGenerationInputHash` (stamped
from the hash the migrated run actually executed under), so
`AgentService.isResumableBook` silently forced a full, unnecessary
regeneration on every retry of a migrated run instead of resuming — no data
was lost or corrupted, just wasted work. `GenerationQueueProcessor` builds its
`GenerationExecutionContext.inputHash` from `normalize`'s return value, not
`claimed.inputHash`, for the same reason.

**Concurrency.** Two callers can legitimately race to migrate the _same_ run
— e.g. two concurrent `retryGeneration` requests for the same book, both
reading the same prior (terminal) run before either has created a new one;
the per-book "one active run" index only rejects the loser at run-_creation_
time, after both may already be here. The migration write is a
compare-and-swap on the run's exact pre-migration `inputSnapshot` value (not a
blind `updateMany({ where: { id } })`): exactly one racer's write lands. The
other(s) detect zero rows matched, re-read the now-migrated row, and recurse,
converging on whichever migration won rather than each trusting its own
locally-computed copy (bounded at 5 attempts as a safety net against a
never-converging write storm, which should never happen in practice). Every
racer's own versioned photo-asset write to `ImageAssetStorage` still happens
independently (storage has no CAS primitive) — a losing racer's copy is left
unreferenced, the same accepted cleanup debt `uploadChildPhoto`'s own
re-upload versioning already carries — but the legacy photo itself is never
lost (every racer either wins or converges on someone else's equally valid
migration), and the run's own persisted `inputSnapshot`/`inputHash` pair is
always self-consistent, never a torn mix of two racers' writes.

#### Invalid snapshot handling — finalize, don't burn retries

A snapshot that fails both the current and legacy schema (truly malformed —
never expected in practice, but not assumed impossible) is a _permanent_
condition, not a transient one. `GenerationQueueProcessor.process` catches
`InvalidGenerationInputSnapshotError` right after claiming and calls
`GenerationRunCoordinator.failInvalidSnapshot` directly — finalizing
`GenerationRun`/`Book` as failed with the stable
`GENERATION_INPUT_SNAPSHOT_INVALID` code and a safe public message (never the
raw Zod issue list) — and returns without rethrowing, so BullMQ never retries
it. Earlier, this error propagated uncaught, so BullMQ retried a condition
retrying could never fix, burning all attempts before landing on a generic
`GENERATION_INFRASTRUCTURE_FAILURE` code that hid the real cause.
`BooksService.retryGeneration` similarly catches this from
`GenerationInputSnapshotBackfillService.normalize` and throws a predictable
`ConflictException` (the same stable code) instead of an unhandled 500 —
`regenerateBook` (which always builds a fresh snapshot from the book's
current fields) is the escape hatch when a prior run's snapshot is
corrupted.

#### Child photo byte integrity

`AgentService.loadAndVerifyChildPhoto` verifies a loaded child-photo asset's
byte length and sha256 against the identity frozen in the snapshot before
ever handing it to a vision provider — a mismatch (truncated bytes, a
different file at the same key, any other corruption or replacement) is
logged at `error` with the stable `CHILD_PHOTO_INTEGRITY_MISMATCH` code and
the bytes are never used; generation degrades to text-only, the same
graceful-degradation path a merely-missing asset already took (logged at
`warn`, not `error`, so the two cases stay distinguishable in diagnostics).

### Fencing — every pipeline write, not just claim/complete

`GenerationExecutionService.applyFencedBookWrite(ctx, bookData, step)`
(`apps/api/src/agent/generation-execution.service.ts`) is the only path
`AgentService` uses to write to `Book` while a run executes. It runs one
transaction: first a fenced `generationRun.updateMany` (`WHERE id, status =
running, fencingVersion = ctx.fencingVersion`) that also records `currentStep`
— if that matches zero rows, a newer claim or recovery has already superseded
this attempt, and the method throws `StaleGenerationRunError` instead of
writing `Book` at all. Only if that succeeds does it write `Book` (a plain
unique-key update — safe because Postgres's row lock on the `GenerationRun`
row, held for the duration of the transaction under READ COMMITTED, already
serializes this against every other writer of that same row: a concurrent
claim, heartbeat, `completeRun`, or recovery pass either waits for this
transaction to commit and then correctly fails its own WHERE-clause
re-check, or wins the race and makes this transaction's own check fail
instead — there is no window where two attempts both believe they hold the
fence). `BooksService.runGenerationPipeline` treats a `StaleGenerationRunError`
from `AgentService` as a quiet abandonment (log and return) — never a reason
to rethrow and trigger a BullMQ retry, since whichever attempt actually owns
the run now is responsible for finishing it.

### Correct BullMQ redelivery ownership — delivery-token fencing (Phase A.1)

`GenerationRunService.claim(runId, deliveryToken, workerId, leaseMs)`
(`apps/api/src/agent/generation-run.service.ts`) succeeds unconditionally
whenever the run is still queued/running — no OR-clause to satisfy. Earlier
this method fenced on `job.attemptsMade + 1` (a `leaseAttempt` column,
requiring a strictly-higher attempt to reclaim); that was a real bug, since
BullMQ's own **stalled-job recovery** can redeliver a job to a different
worker without ever incrementing `attemptsMade` (confirmed directly against
`moveStalledJobsToWait`'s Lua script — it only touches a separate stalled
counter, never `attemptsMade`). A same-attempt-number stalled redelivery
would fail that old OR-clause and `GenerationQueueProcessor` would silently
treat it as a no-op, permanently stranding the run.

The fix: `deliveryToken` (the `token` BullMQ's Worker passes to
`process(job, token)`, minted fresh on _every_ lock acquisition, including a
stalled redelivery) is the fencing identity now, not the attempt count. Every
call to `claim()` represents BullMQ itself asserting "a worker holds this
job's lock right now," so it always succeeds and unconditionally bumps
`fencingVersion` + overwrites `deliveryToken`/`leaseOwner` — there is nothing
to compare the previous delivery against at claim time. That previous
delivery's in-flight writes are instead fenced out downstream:
`GenerationRunService.heartbeat(runId, deliveryToken, fencingVersion, leaseMs)`
— a lease-extension call on an interval (`leaseMs / 3`) fenced on **both**
`deliveryToken` and `fencingVersion` — and every `applyFencedBookWrite`/
`completeRun`/`failInvalidSnapshot` call, fenced on `fencingVersion` alone
(sufficient on its own, since it's bumped on every claim; `deliveryToken` at
the heartbeat layer is defense-in-depth on top of that). A stale delivery
token can never heartbeat or write again once a newer claim has superseded
it. See `test/integration/generation-queue-stalled-redelivery.integration.spec.ts`
for this proven end-to-end against a real Redis/BullMQ Worker pair (one
worker's lock is force-stalled via `skipLockRenewal`, the other's real
BullMQ stalled-checker reclaims it with `attemptsMade` unchanged).

When a heartbeat call resolves `false` (this delivery has been superseded),
`GenerationQueueProcessor` aborts an `AbortController` whose `signal` rides
on `GenerationExecutionContext` — `AgentService.assertNotSuperseded` checks
it at the two natural checkpoints before further paid/expensive work (image
generation, PDF render) and throws `StaleGenerationRunError`, so a fenced-out
attempt stops promptly instead of only discovering it's superseded once its
next DB write is rejected. This is a same-process, best-effort optimization
layered on top of — never a replacement for — the DB-level fencing every
write already goes through independently.

### Atomic terminal transitions — `GenerationRunCoordinator` (Phase A.1)

`AgentService.startBookGeneration` never writes `Book.status = complete` or
`failed` itself — it returns a typed `GenerationOutcome` (status + safe
error fields + the rest of the Book update data, deliberately excluding
those three fields). `GenerationRunCoordinator` (`apps/api/src/agent/
generation-run-coordinator.service.ts`, extracted out of `BooksService`
specifically so this exact production code — not a hand-copied mirror of it
— is what integration tests exercise against real Postgres) is the _only_
place a `GenerationRun`'s terminal transition is ever paired with a `Book`
mirror write. Every public method shares one private helper
(`runFencedTerminalTransition`) that does exactly two things, in one
transaction: fences the `GenerationRun` write on `status` + `fencingVersion`,
and — only if that held — writes `Book` (`activeRunId` cleared, plus whatever
that method's own terminal fields are). Three callers reach it, each owning
its own _policy_ (when to fail a run, with what code/message) while the
mechanism itself lives only here:

- **`completeRun(ctx, outcome)`** — `AgentService`'s own computed outcome
  (success or an anticipated pipeline failure). Writes
  `Book.status`/`errorMessage`/`failedStep` + `activeRunId` (+
  `publishedRunId` on success) together with `GenerationRun`'s own
  `completed`/`failed` transition.
- **`failInvalidSnapshot(ctx, errorMessage)`** — a permanently malformed
  `input_snapshot`, caught before `AgentService` ever runs (see below).
- **`failAbandoned(ref, params)`** — a run finalized without `AgentService`
  ever having produced an outcome at all: BullMQ retry exhaustion
  (`BooksService.markRunPermanentlyFailedAfterExhaustedRetries`) or an
  abandoned-run recovery sweep (`GenerationRunRecoveryService.recoverOne`).
  `ref.fromStatus` is the `GenerationRun` status the caller actually observed
  (`running` for exhausted retries — a claimed run is always `running`;
  `running` _or_ `queued` for recovery, which also reclaims runs stuck before
  ever being claimed).

Earlier (pre-Phase-A), `AgentService` wrote `Book.status` directly (still
fenced, but as a _separate_ transaction from the one that flipped
`GenerationRun` to terminal and cleared `activeRunId`) — a crash between those
two transactions left `Book` already showing `complete`/`failed` while
`GenerationRun` was still `running` and `activeRunId` still pointed at it,
which among other things left `findActiveForBook` blocking a legitimate
retry/regenerate against a book that looked finished. This phase's later
hardening pass found — and closed — a second, subtler version of the same
problem: `markRunPermanentlyFailedAfterExhaustedRetries` and the recovery
sweep's abandoned-run path both still hand-rolled their _own_ copy of this
same fenced-transaction shape directly against `BooksService`'s/
`GenerationRunRecoveryService`'s own `PrismaService`, bypassing the
coordinator entirely — so the coordinator's own doc comment claiming to be
"the only place" was not, in fact, literally true. Both now go through
`failAbandoned` instead; every terminal `GenerationRun`+`Book` transition in
this codebase goes through `GenerationRunCoordinator`, full stop. Queue/
recovery _policy_ (BullMQ attempt bookkeeping, the recovery lease, BullMQ
pending-job checks) deliberately stayed in `BooksService`/
`GenerationRunRecoveryService` — only the transactional write mechanism moved,
so the coordinator stays a small, typed API rather than growing into a
god service that also owns orchestration.

A crash before any coordinator method's transaction commits leaves both
`Book` and `GenerationRun` non-terminal; a crash after leaves both terminal
and consistent — there is no in-between state either way.

**Result type, not a boolean.** Every coordinator method returns
`CoordinatorOutcome` (`'applied' | 'stale_fence' | 'book_mirror_mismatch'`),
not a plain boolean:

- `'applied'` — both writes committed; this attempt's outcome is now durable.
- `'stale_fence'` — the `GenerationRun` fencing WHERE clause matched zero
  rows: a newer claim/recovery already superseded this attempt. Expected
  under normal operation, not a bug — `Book` is provably untouched.
- `'book_mirror_mismatch'` — the `GenerationRun` fence held (this attempt
  still legitimately owns the run) but `Book.activeRunId` no longer pointed
  back at it. Under every invariant this system maintains, `activeRunId` is
  only ever cleared together with that same run's own terminal transition, so
  this should never happen; if it does, the _entire_ transaction (the
  `GenerationRun` write included) is rolled back rather than left half-applied,
  and it's logged at `error` severity (distinct from `stale_fence`'s routine
  `warn`).

A plain boolean could not distinguish the last two — both read as "nothing
happened" to a caller that only checks truthiness. Concretely, this is what
closed a real bug: `BooksService.runGenerationPipeline` used to call
`completeRun` and then unconditionally update the legacy `GenerationJob`
mirror regardless of what `completeRun` reported — a superseded worker would
still mark that diagnostics job `completed`/`failed`, potentially racing (and
clobbering) whatever the actually-owning attempt was concurrently writing to
the same job row. It now only touches the `GenerationJob` mirror when the
coordinator reports `'applied'`.

### Recovery leadership — a lease row, not a session advisory lock (Phase A.1: server time + fencing generation)

`GenerationRunRecoveryService` elects one leader per recovery pass via a
single-row `RecoveryLease` (seeded by migration, id `generation_run_recovery`)
and a plain conditional row update — **not**
`pg_try_advisory_lock`/`pg_advisory_unlock`. Session-scoped advisory locks
require acquire/work/release to run on the same physical Postgres connection,
a guarantee Prisma's pooled client does not make; getting that wrong either
leaks the lock (wedging every future pass on that instance) or gives no real
cross-instance guarantee at all. A plain row UPDATE has no such requirement.

Acquire/renew/expiry comparisons use PostgreSQL's own `NOW()` (via
`$queryRaw`), never application `Date` — clock skew between instances (or
between an instance and the DB) could otherwise let two instances disagree
about whether a lease has actually expired. `leaseGeneration` increments on
every successful acquire and is returned as a fencing token: instead of a
renewal heartbeat, the recovery loop re-verifies (`stillHoldsLease`) that it
still holds this exact generation before _every_ candidate it processes —
a bounded-batch guard that stops the pass early (leaving the rest for next
time) the instant leadership is lost, whether because the pass simply ran
long or because a new leader already took over. `releaseLease` is likewise
fenced on the acquired generation, so it can never release a lease a newer
leader has since acquired. `recoverOne`'s own run-fail + Book-clear goes
through `GenerationRunCoordinator.failAbandoned` (see "Atomic terminal
transitions" above) — fenced on the `GenerationRun`'s own status/
`fencingVersion`, independent of, and in addition to, the recovery lease
itself. See the "RecoveryLease leadership across two instances" describe
block in `test/integration/generation-fencing.integration.spec.ts` for
deterministic, barrier-driven (not `Promise.all`-timing-dependent) coverage
of both the mutual-exclusion and the fencing-generation invariants.

### Mutation races — CAS on Book, not read-then-write

`update()`, `remove()`, and `uploadChildPhoto()` in `BooksService` use a
conditional `updateMany` (`status` re-checked in the WHERE clause) rather than
an unconditional `update()` after a separate status read — generation
starting between the read and the write now makes the write match zero rows
(reported as the same conflict) instead of silently mutating a book whose
generation has already begun.

### Known limitations (explicit, not yet built)

**Scope honesty (Phase A.1):** every `GenerationRun`/`Book` _database write_
in the generation pipeline is now fenced — claim, heartbeat, every
`applyFencedBookWrite` call, `completeRun`, `failInvalidSnapshot`,
`markRunPermanentlyFailedAfterExhaustedRetries`, and recovery's own fail path
all condition on `fencingVersion` (and, for heartbeat, `deliveryToken` too),
so a stale attempt's DB write is provably rejected, not just usually
avoided. That is **not** the same claim as "a stale worker can do no harm at
all." Two gaps remain, deliberately out of scope for this pass:

- **Run-scoped artifact storage.** _Closed for images/character sheets by
  Phase B, Slice B3, and for PDFs by Slice B4 — see those sections below._
  Every new PDF is now written under `books/{bookId}/runs/{runId}/claims/
{fencingVersion}/...` (`pdfStorage.saveClaimPreviewPdf`), never the legacy
  shared key, and `GenerationRunCoordinator.completeRun` is the single fenced
  transaction that atomically promotes one claim's `(runId, fencingVersion)`
  to `Book.publishedRunId`/`publishedRunFencingVersion` on success. A stale
  (superseded) attempt's in-flight PDF-render/save call can still finish
  writing its own object after being superseded, but that write can never
  land at the namespace a newer or already-published attempt owns — it can
  only ever produce an unpublished orphan under its own claim. There is
  still no `GenerationArtifact` model or cleanup for those orphan objects
  (explicitly out of scope for B4 — see its own "Known limitations" below).
- **`AgentLog` ownership.** _Closed by Phase D — see its own section below._
  `AgentService` no longer writes `AgentLog` rows itself; it returns them on
  `GenerationOutcome.agentLogs`, and `GenerationRunCoordinator.completeRun`
  persists them inside the same fenced transaction as the terminal Book/
  GenerationRun write, so a stale/superseded claim writes zero AgentLog rows.

Do not describe this phase as having made the pipeline fully safe against a
stale/zombie worker in general — only its _database writes_ (which, as of
Phase D, includes AgentLog) are proven safe; claim artifact writes (images,
character sheets, PDFs) still rely on the same-process `assertNotSuperseded`
best-effort check (or nothing at all) rather than a DB-level guarantee — see
Phase D's own "Known limitations" below for the precise residual gap.

- **`ImageAssetStorage` read-side identity** still probes a fixed set of
  extensions rather than persisting the exact key/content-type pair (fixed
  for the child photo specifically, via versioned keys — not fixed for
  generated illustrations/character sheets). No delete/cleanup API exists yet.
- **Generation limits** (`assertGenerationAllowed`) are check-then-act, not an
  atomic reservation — a burst of concurrent requests can still transiently
  exceed the configured caps before the DB-level partial unique index catches
  the actual double-schedule.
- **Outbox** has no dead-letter status, `nextAttemptAt`/backoff, or SKIP
  LOCKED multi-dispatcher claim yet — a malformed/unsupported event is logged
  and left `pending` rather than moved to a terminal state.
- **`RedisModule` and `cache/RedisService`** are still two independent
  `ioredis` connections; lease/outbox/recovery tuning env vars are still read
  ad hoc via `process.env` rather than the validated `Env` schema.
- **`GenerationRun`** is missing the composite indexes
  (`status, leaseExpiresAt`), (`status, createdAt`), (`userId, status`),
  (`userId, createdAt`) that its query patterns above would benefit from.
- **End-to-end retry-after-edit test coverage.** Each boundary in
  `BooksService` → `GenerationRun` → `GenerationExecutionContext` →
  `AgentService` provider arguments is covered individually (unit tests at
  every layer, plus the real-Postgres fencing/snapshot integration suite),
  but there is no single test driving a retry-after-edit scenario through
  every layer in one run. Adding one is straightforward but was not done in
  this pass — flagged here rather than silently left uncovered.

## Phase G1 — user-initiated cancellation

Adds `POST /api/books/:id/cancel` — the first way a user can voluntarily stop
an in-progress generation before it finishes. **Backend only: this phase
implements the authoritative cancellation mechanism and API contract; the web
app's Cancel button is Phase G2, below.** Partial completion
(`BookStatus.Partial`) remains explicitly unimplemented; a cancelled run's
outcome is simply never published, not partially published.

### Business policy

- A cancellation accepted before completion terminates the run without
  publishing its outcome — no `Book` fields the pipeline would have written
  on success/failure (`previewPdfUrl`, `storyPlan`, etc.) are touched.
- Every accepted cancellation of a **billed** run refunds its original charge
  exactly once, regardless of which pipeline step the run was on when
  cancelled — there is no "too late to refund" step, unlike the stale
  `API_SPEC.md` guidance this phase corrects (see below).
- If successful completion wins the race first, cancellation is rejected
  (`409 BOOK_NOT_IN_PROGRESS`) and no cancellation refund occurs.
- A legacy/unbilled run (created before Phase E2 credit charging existed, or
  otherwise missing its charge `CreditTransaction`) may still be cancelled,
  but receives `creditsRefunded: 0` — the same eligibility rule
  `GenerationRunCoordinator`'s failure-refund path already uses (see "Refund
  atomicity" in `apps/api/docs/credits.md`).
- A second cancellation of the same book returns a stable
  `409 { code: 'BOOK_ALREADY_CANCELLED' }`.

**This intentionally replaces stale/contradictory guidance in the old
`API_SPEC.md`** — that document (predating any real implementation) claimed
credits refund only before `image_gen`, never during `pdf_render`, and always
refund exactly one credit. None of that is true here: eligibility is derived
from whether a charge `CreditTransaction` exists (see below), independent of
pipeline step, and the refunded amount is always the charge's own amount, not
a hardcoded `1` (even though `GENERATION_CREDIT_COST` is currently always
`1` in practice).

### `GenerationRunCoordinator.cancelGeneration` — the authoritative transaction

Unlike `completeRun`/`failInvalidSnapshot`/`failAbandoned` (Phase A.1 — all
fence a **pre-resolved** claim a background caller already trusts),
`cancelGeneration` is HTTP-request-driven and also owns resolving **and
verifying** that identity itself, inside one Prisma transaction
(`apps/api/src/agent/generation-run-coordinator.service.ts`):

1. Loads `Book` scoped to `(id, userId, deletedAt: null)` — a missing,
   not-owned, or soft-deleted book is indistinguishable, both `'not_found'`.
2. If `Book.activeRunId` is `null`, there is no active run to cancel:
   `'already_cancelled'` if `Book.status` already says so, otherwise
   `'not_in_progress'` (covers `created`, `complete`, `failed`, `partial`).
3. Otherwise loads that exact `GenerationRun` — scoped to
   `(id, bookId, userId)`, the same three-way ownership check the fenced
   write below re-verifies — and reads its current `status`/`fencingVersion`.
4. Conditionally transitions it to `cancelled`, fenced on run id, book id,
   user id, its exact observed status (`queued` or `running` only), and its
   exact observed `fencingVersion` — while also **incrementing**
   `fencingVersion` and setting `cancelledAt`. The `fencingVersion` bump
   means any already-running worker's next `GenerationRunService.heartbeat`
   call (fenced on `deliveryToken` + `fencingVersion`) loses ownership
   immediately and aborts via `AgentService.assertNotSuperseded` at its next
   checkpoint — the same mechanism a superseding claim already uses (see
   "Correct BullMQ redelivery ownership" above); cancellation needed no new
   worker-side code.
5. If that fenced write matched zero rows, something else won the race — a
   concurrent cancellation, or a concurrent completion — so the run is
   re-read once more to report the accurate outcome (`'already_cancelled'`
   if it's now `cancelled`, `'not_in_progress'` if a completion won).
6. Only if the run transition held: conditionally updates `Book`
   (`activeRunId` still pointing at this run) — `status: cancelled`,
   `activeRunId: null`, `errorMessage: null`, `failedStep: null` —
   deliberately **never** touching `previewPdfUrl`/`pdfUrl`/`bookPreview`/
   etc., so a previously published pointer from an earlier successful run
   survives a later regeneration's cancellation untouched. Zero rows matched
   here is a `'book_mirror_mismatch'` (see `CoordinatorOutcome`'s own doc
   comment) — the entire transaction rolls back, exactly like every other
   terminal transition in this class.
7. Suppresses a still-`pending` `OutboxEvent` for this run
   (`status: 'cancelled'`, a new terminal outbox status alongside the
   existing `'pending'`/`'dispatched'`) so a dispatcher sweep can never newly
   enqueue it. See "Outbox race safety" below.
8. Looks up the original charge (`generationChargeIdempotencyKey(runId)`)
   and, only if one exists, refunds its exact amount/user/book via
   `CreditsService.addInTransaction` with reason `refund_generation_cancelled`
   (a new `CreditReason` — deliberately never `refund_generation_failure`,
   the reason the automatic failure-refund path uses) and a distinct
   deterministic key, `generationCancellationRefundIdempotencyKey(runId)`
   (`generation:${runId}:cancel_refund`) — never colliding with the
   failure-refund key (`generation:${runId}:refund`), even though only one
   of the two paths can ever apply to a given run in practice (a run can only
   reach one terminal status).

Any failure at any step — including the refund insert hitting its own
idempotency-key conflict — throws out of the transaction callback and rolls
back every write made so far in that same call.

### Race semantics

Cancellation and completion compete purely through the same DB-level
fencing every other terminal transition already relies on — no new locking
primitive was added:

- **Cancellation wins:** the old worker's later `completeRun` call fences on
  the `fencingVersion` it observed at claim time, which cancellation has
  since bumped — its `GenerationRun` `updateMany` matches zero rows, so it
  returns `'stale_fence'` and writes no `Book` outcome, publication pointer,
  `AgentLog` row, or second ledger mutation. No cancellation-specific code
  was needed for this — it falls out of the existing fencing mechanism.
- **Completion wins:** cancellation's own `GenerationRun` fence (step 4
  above) finds the run already `completed`/`failed`, so it returns
  `'not_in_progress'` and never reaches the refund lookup.
- **Two concurrent cancellations:** Postgres's row lock on the
  `GenerationRun` row serializes the two `updateMany` calls — exactly one
  matches (`'applied'`), the other's WHERE clause re-evaluates against the
  winner's already-committed `cancelled` status and matches zero rows
  (`'already_cancelled'` after the re-read in step 5). Exactly one refund is
  ever inserted. Proven against real Postgres via two calls fired together
  with `Promise.all` (genuinely overlapping transactions, not sequenced by
  the test) in `test/integration/generation-cancellation.integration.spec.ts`.
- **`book_mirror_mismatch`** remains an invariant failure, never a successful
  cancellation — the whole transaction rolls back, same as every other
  coordinator method.

### Outbox race safety

`OutboxDispatcherService`'s sweep and a cancellation can race in either
order, and both interleavings stay safe:

- **Cancel-before-dispatch:** the event is already `'cancelled'` by the time
  the next sweep runs `OutboxService.findPending` (which only ever selects
  `status: 'pending'`), so it is never enqueued at all.
- **Dispatch-before-cancel:** a sweep that already read the event as
  `'pending'` and called `GenerationQueueService.enqueue` (creating the
  BullMQ job) before the cancellation transaction commits leaves the BullMQ
  job in existence — but that job's eventual `GenerationRunService.claim`
  call now matches zero rows (the run is no longer `queued`/`running`) and
  returns `null`, which `GenerationQueueProcessor.process` already treats as
  a normal no-op. Cancellation's own outbox suppression `updateMany` (scoped
  to `status: 'pending'`) simply matches zero rows in this interleaving and
  never falsely relabels an already-`dispatched` event.

Both interleavings are exercised directly against real Postgres in
`test/integration/generation-cancellation.integration.spec.ts`, "Outbox
race."

### Queue cleanup: best-effort, never the correctness mechanism

`GenerationQueueService.removeIfSafe(runId)` runs only **after** the DB
transaction above has already committed (`BooksService.cancelGeneration`) —
a `waiting`/`delayed`/`prioritized` BullMQ job (never yet picked up by a
worker) is removed outright; an `active` job (currently locked by a worker)
is deliberately left alone, since BullMQ has no safe way to yank a lock out
from under a worker mid-processing, and forcing it would either throw or
silently no-op. Any removal failure (including "job not found," the expected
case once a job has already completed or was already removed) is logged and
swallowed — it can never undo or fail the already-committed cancellation.
**The committed DB terminal status and fencing are the actual correctness
mechanism; Redis/BullMQ removal is pure tidying.** An in-flight external
provider request (an OpenAI story/image call `AgentService` already
started) may still finish and return bytes after cancellation — but that
result can never be published, since every write path back to `Book` is
fenced on the same `fencingVersion` cancellation already bumped.

### Legacy `GenerationJob` diagnostics mirror

`GenerationJobService.markCancelled(jobId)` is called by
`BooksService.cancelGeneration` only **after** the authoritative transaction
above has committed — `GenerationJob` is not authoritative for cancellation
any more than it is for any other terminal transition (see "Generation jobs
(Phase 3I)" above). A failure to update this legacy row is logged and
swallowed (the same `markJob` helper `runGenerationPipeline` already uses);
it can never roll back or fail an already-applied cancellation.

### API contract

`POST /api/books/:id/cancel` (`BooksController.cancel`) — normal
`AuthModeGuard` + `RequireVerifiedEmailGuard`, an empty body (nothing is read
from it — ownership comes exclusively from `@CurrentUser()`), UUID-validated
`:id`, and a dedicated Redis-backed per-user rate limit
(`CANCEL_RATE_LIMIT_WINDOW_MS`/`_MAX_ATTEMPTS`, looser than
`GENERATION_RATE_LIMIT_*` since cancelling is free and a legitimate client
may retry after losing a race). Response:

```ts
interface CancelGenerationResponse {
  book: BookDto;
  creditsRefunded: number;
}
```

Stable errors — never a run id, fencing version, balance, queue detail, or
raw database error:

| Status | Code                     | Condition                                                                                                       |
| ------ | ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| 404    | —                        | book missing / not owned / soft-deleted                                                                         |
| 409    | `BOOK_ALREADY_CANCELLED` | this book's generation was already cancelled                                                                    |
| 409    | `BOOK_NOT_IN_PROGRESS`   | no active (queued/running) run — `created`/`complete`/`failed`/`partial`, or a completion won a concurrent race |

### Follow-up behavior

- **Regeneration is allowed.** `BooksService.regenerateBook` now also
  accepts `status === cancelled` (alongside `failed`/`complete`) — the
  documented way to start a fresh attempt after a cancellation. That new run
  is charged independently via the usual `GENERATION_CREDIT_COST` debit,
  regardless of whether the cancelled run it replaces was refunded.
- **Retry is not.** `BooksService.retryGeneration` deliberately still only
  accepts `status === failed` — retry resumes a _failed_ run's exact input;
  a cancellation was voluntary, not a failure to resume, so a cancelled book
  gets the stable `409` "Only failed books can be retried" it already got
  for any other non-`failed` status.

### What this phase does not do

No SSE/WebSocket cancellation event, no subscription to watch cancellation
happen live, no provider-level request cancellation (an in-flight OpenAI
call is not aborted — see "Queue cleanup" above), and no partial-completion
support (`BookStatus.Partial` remains entirely unreachable).

## Phase G2 — frontend cancellation UX

Adds the web app's "Cancel generation" control to the book detail page
(`apps/web/src/app/dashboard/books/[id]/`), consuming the Phase G1
`POST /api/books/:id/cancel` contract. No backend changes.

### Visibility and confirmation

- The button renders only while `isGeneratingBookStatus(book.status)` is true
  (`use-book-detail.ts`) — never for `created`, `complete`, `failed`, or
  `cancelled`. This is the same helper the polling effect already uses, so
  the button and the polling loop always agree on what counts as "active."
- Clicking it opens a `window.confirm` dialog (the same primitive
  `retry-generation`/`regenerate` already use) whose copy explicitly covers
  all four things a user needs to know before confirming: the action is
  permanent; an already-started provider call may keep running in the
  background even though it's requested; that call's result will never be
  published; and any existing generation charge will be refunded. It
  deliberately never claims the provider request itself is aborted — see
  "Queue cleanup" in Phase G1 above for why that would be false.

### Pending state and duplicate protection

`BookDetailPage.handleCancel` (`page.tsx`) guards against double submission
with a `useRef` boolean (`cancellingRef`) checked and set **before** the
`await window.confirm`/fetch call — a plain `cancelling` state variable alone
cannot prevent a second synchronous click in the same tick, since React state
updates aren't visible until the next render. While the request is in
flight, the button is disabled, its accessible name switches to "Cancelling
generation" (via `aria-label`, not just its visible text), and the sibling
regenerate/retry button is disabled too (`cancelling` is threaded into
`BookDetailView`'s `disabled` props) — though in practice the two controls
are already mutually exclusive by status, since regenerate/retry only render
for `failed`/`complete`/`cancelled`, never for an active generation status.

### Outcome handling

`handleCancel` replaces `book` with the exact `BookDto` the endpoint returned
— it never guesses or optimistically adjusts status or credit balance.

- **`creditsRefunded > 0`:** shows "Generation cancelled. N credit(s)
  refunded." (`role="status"`) and dispatches `notifyCreditsUpdated()`
  (`apps/web/src/lib/credits-events.ts`, the same event
  `/billing/success` already fires) so any mounted balance indicator
  refetches immediately.
- **`creditsRefunded === 0`:** shows "Generation cancelled. No credit charge
  was found to refund." — no event dispatch, since nothing changed.
- **`BOOK_ALREADY_CANCELLED`:** refetches the book and shows a calm
  `role="status"` "Generation was already cancelled." message — not a
  generic failure alert, since the end state (cancelled) is exactly what the
  user wanted.
- **`BOOK_NOT_IN_PROGRESS`:** refetches the book (completion or failure may
  have won the race) and shows a `role="alert"` message derived from the
  _refreshed_ status (`describeNotInProgressStatus` in `page.tsx`) —
  "already finished successfully... nothing was refunded" for `complete`,
  "already failed..." for `failed`, etc. Never claims a cancellation or
  refund occurred.
- **Generic/transient failure (network error, 5xx):** the book state is left
  untouched (still showing the active generation status), a `role="alert"`
  error is shown, and the button re-enables so the user can simply click
  Cancel again.

### Race safety against polling

The existing 2.5s poll (`use-book-detail.ts`) and a cancel response can both
be in flight at once. The poll's `.then` handler was changed from an
unconditional `setBook(data)` to a functional update:

```ts
setBook((current) => (current?.status === BookStatus.Cancelled ? current : data));
```

React guarantees the `current` a functional updater sees is the latest
_applied_ state, regardless of microtask/macrotask ordering between the
poll's fetch and the cancel's fetch — so a poll response that started before
the cancel request but resolves after it can never revert an already-applied
`cancelled` status back to a stale in-progress one. Once `book.status`
becomes `cancelled`, the polling effect's own dependency
(`[id, book?.status]`) re-evaluates `isGeneratingBookStatus` to `false` and
the interval is torn down — no explicit "stop polling on cancel" call was
needed.

### Cancelled-state UX

- `BookDetailView`'s `canRegenerate` now also accepts `cancelled` (alongside
  `failed`/`complete`), matching `BooksService.regenerateBook`'s Phase G1
  rule; the button reads "Regenerate book" for `complete`/`cancelled`, same
  as it already did for `complete`. `retryGeneration` is untouched — it stays
  `failed`-only on both ends.
- The status badge (book detail header and dashboard `BookCard`) renders
  `cancelled` in a distinct amber treatment instead of the shared
  draft-gray/active-violet split, so a cancelled book doesn't read as either
  "still a draft" or "actively generating."
- `PdfSection` now also renders for `cancelled`: since cancellation never
  touches `previewPdfUrl`/`bookPreview` (see Phase G1's step 6 above), a
  cancelled-during-regeneration book that still has a PDF from an earlier
  successful run shows a "Previous PDF still available" panel with the same
  Open/Download actions as the `complete` panel (factored into a shared
  `PdfReadyActions` component). A cancelled book with no prior PDF shows a
  plain "Generation was cancelled before a PDF was produced" note instead.

## Phase B — claim-scoped artifact storage (Slices B1–B2)

Closes the "Run-scoped artifact storage" gap flagged above, one slice at a
time. **Slice B1** adds only the schema and a typed namespace abstraction —
it is additive and behavior-neutral: no production write or read path has
been switched to it yet, and every existing positional
(`imageAssetKey`/`characterSheetAssetKey`/`objectKey`) key builder and
caller is unchanged.

- **Artifact ownership is `(runId, fencingVersion)`, not `runId` alone.**
  `GenerationRunService.claim()` reclaims a stalled job's _same_
  `GenerationRun.id` and unconditionally bumps `fencingVersion` — so two
  different BullMQ deliveries of one run share a `runId` but never a
  `fencingVersion`. A storage key scoped only to `runId` cannot distinguish
  the delivery a redelivery superseded from the one that superseded it; this
  is why `GenerationArtifactNamespace` (`generation-artifact-namespace.ts`)
  and the new `claim*Key` builders always require both.
- **`Book` gained three nullable pointer columns**:
  `lastGenerationRunId`/`lastGenerationFencingVersion` (which claim's
  namespace backs the resumable JSON currently on the row) and
  `publishedRunFencingVersion` (which claim's namespace, alongside the
  existing `publishedRunId`, backs the currently published PDF/images). DB
  CHECK constraints enforce each pair is set together or not at all, and
  that a set fencing version is always positive (see the migration:
  `20260715160805_phase_b1_artifact_namespace_pointers`).
- **Every existing row remains legacy** (`lastGenerationRunId`/
  `lastGenerationFencingVersion` null, `publishedRunFencingVersion` null even
  where `publishedRunId` is already set) until a run generated _after_ the
  eventual pipeline cutover writes claim metadata for it. No migration
  backfill is possible or attempted — there is no historical per-write claim
  record to reconstruct.
- **No production storage path has changed.** `classifyImageAssets`,
  `buildImageBufferResolver`, `pdfStorage.savePreviewPdf`/`getPreviewPdf`,
  and every other real read/write in the pipeline still use the positional
  keys they always have.

**Slice B2** adds storage-_driver capabilities_ only — still additive and
behavior-neutral, and still zero production cutover. (An earlier version of
this doc described B2 as the `AgentService`/PDF pipeline cutover,
copy-forward, and publication wiring; that scope was split out to a later
slice once it became clear the driver primitives it depends on — a
same-bucket copy and claim-scoped PDF save/read/exists — hadn't been built
yet. This section describes what B2 actually shipped.)

- **`ImageAssetStorage.copyImageAsset(sourceKey, destinationKey)`** — a new
  method on the existing interface, implemented by both
  `LocalImageAssetStorage` and `CloudImageAssetStorage`. Exists for the
  future copy-forward retry algorithm (an edited-then-retried book should be
  able to reuse a prior claim's still-valid images instead of
  re-generating them) — not called by anything yet.
  - **Local**: locates the source via the same fixed-extension probe
    `getImageAsset` already uses, then copies with `fs.copyFile` (an
    OS-level copy) rather than reading the source into a `Buffer` and
    writing it back out.
  - **S3/R2**: locates the source with `HeadObjectCommand` (metadata only —
    confirms both existence and the object's real `ContentType`, without
    downloading the body), then copies with a single `CopyObjectCommand`
    (`CopySource` pointing at the located object). The object's bytes never
    transit the API process. A source with missing or mismatched
    content-type metadata fails loudly rather than guessing.
  - Both drivers treat a source that genuinely does not exist as `undefined`
    and let every other failure (validation, permission, network,
    unexpected metadata) propagate. Copying a key to itself is handled
    explicitly (a no-op that still returns the ref) rather than relying on
    what the filesystem or S3 happens to do with a self-copy.
- **`PdfStorage.saveClaimPreviewPdf` / `getClaimPreviewPdf` /
  `claimPreviewPdfExists`** — claim-only counterparts to the three legacy
  preview-PDF methods, implemented by both `LocalPdfStorage` and
  `CloudPdfStorage`, all built on B1's `claimPreviewPdfKey` as the single
  key-construction source (so the local path and the S3/R2 object key always
  represent the same logical namespace). They take a `ClaimArtifactNamespace`
  (the `{ kind: 'claim' }` half of `GenerationArtifactNamespace`, now
  exported from `generation-artifact-namespace.ts`) — never the legacy
  union — so passing a legacy pointer to a claim-only method is a type error
  at every real call site, and even a forced/`as never` cast is still
  rejected at runtime by `claimPreviewPdfKey`'s existing validation.
- **Every legacy method is untouched behaviorally.** `savePreviewPdf`,
  `getPreviewPdf`, `previewPdfExists`, `saveImageAsset`, and `getImageAsset`
  send the exact same S3 commands / touch the exact same filesystem paths as
  before; the claim methods and `copyImageAsset` share small private helpers
  with them purely to avoid duplicating the request-building code, not to
  change what the legacy methods do.
- **Still nothing production reads or writes claim-scoped storage.**
  `AgentService`, PDF rendering, `BooksService` endpoints, diagnostics, and
  `GenerationRunCoordinator` are all unchanged by this slice. Copy-forward
  itself — actually calling `copyImageAsset` from a retry path — is not
  active yet; that, along with the `AgentService`/PDF pipeline cutover and
  publication wiring, is deferred to a later slice.

**Slice B3** is the `AgentService` image/character-sheet cutover:
character sheets and generated illustrations are now claim-scoped and
self-contained via copy-forward. PDF storage is intentionally **not** cut
over yet — that remains B4.

- **Every write is namespaced.** `AgentService.startBookGeneration` resolves
  `currentNamespace = claimNamespace(ctx.runId, ctx.fencingVersion)` once, at
  the top, straight from `GenerationExecutionContext` — never from
  `Book.activeRunId`, a fresh `GenerationRun` read, BullMQ's delivery token,
  or any other derived source. Every new character-sheet or cover/page/
  back-cover image this run saves is written under `currentNamespace` via
  `claimCharacterSheetAssetKey`/`claimImageAssetKey` — `characterSheetAssetKey`/
  `imageAssetKey` (the legacy positional builders) are no longer called from
  any production write path.
- **Copy-forward-or-generate** (`generation-claim-artifacts.ts`,
  `resolveImageArtifact`/`resolveCharacterSheetArtifact`) is the shared
  algorithm behind every character sheet and generated image:
  1. A valid current-claim artifact is always reused directly — same-claim
     re-entry is idempotent, with no copy or provider call.
  2. Otherwise, if the Book is resumable (`isResumableBook` — the run's
     `inputHash` still matches `Book.lastGenerationInputHash`) and the
     resolved source namespace differs from the current claim, the exact
     source key is inspected and copied forward with B2's
     `copyImageAsset` (a server-side/`fs.copyFile` copy, never routed
     through this process's memory), then the destination is re-read to
     confirm it landed intact.
  3. Otherwise — no source applies, the run's input changed since the
     source JSON was produced, or the source is missing/empty/invalid/
     disappears mid-copy — the caller generates a fresh artifact straight
     into `currentNamespace`. A genuinely missing source is never confused
     with an operational failure: `copyImageAsset`/`getImageAsset` errors
     (permission, network, malformed metadata) propagate unchanged rather
     than being reclassified as "missing" or silently treated as a
     successful reuse.
- **The source namespace is resolved from typed Book pointers, never a
  stored key string.** `resolveLastGenerationNamespace(book)` (B1) reads
  `Book.lastGenerationRunId`/`lastGenerationFencingVersion`: both set means
  a prior claim of the current run (after a stalled redelivery) or the run
  being retried; both null means legacy positional storage; a malformed
  partial pair throws `InvalidGenerationArtifactPointerError` instead of
  silently falling back to legacy. `Book.characterSheetAssetKey`, retained
  for compatibility/diagnostics, is written with whatever key the current
  claim actually resolved to — it is never read back as an ownership
  source now that the typed namespace pointer exists.
- **The current claim becomes self-contained.** After copy-forward and any
  fresh generation, every image the PDF renderer needs lives under
  `currentNamespace` — `buildImageBufferResolver` now takes the current
  `ClaimArtifactNamespace` explicitly and reads exclusively from it, never
  from a source/prior claim, so the render step can never cross-reference a
  stale or foreign claim's bytes.
- **The Phase 1 fenced write is the one atomic pointer update.** The same
  `applyFencedBookWrite` call that persists `storyPlan`/`characterCard`/
  `bookPreview`/`imageGenerationResult`/`bookLayout`/`lastGenerationInputHash`
  now also writes `lastGenerationRunId: ctx.runId` and
  `lastGenerationFencingVersion: ctx.fencingVersion` in the same transaction
  — the pointer can never point at a claim whose resumable JSON didn't
  actually land, and a stale claim whose Phase 1 fence fails leaves both
  fields (and everything else in that write) untouched.
- **Legacy sources remain readable during rollout.** A book with both
  pointer fields null resolves to `{ kind: 'legacy' }`, whose keys
  (`imageAssetKey`/`characterSheetAssetKey`) are still readable as a
  copy-forward source — old rows keep working without a backfill.
- **PDF storage was the one remaining shared-key gap after B3.**
  `startBookGeneration` still called the legacy
  `pdfStorage.savePreviewPdf(bookId, buffer)` (a positional, non-claim-scoped
  key) after rendering — B2's `saveClaimPreviewPdf`/`getClaimPreviewPdf`/
  `claimPreviewPdfExists` were not wired in yet. Closing that gap, along with
  switching `GenerationRunCoordinator`'s published-artifact pointers, is B4.

**Slice B4** is the PDF cutover and the read-side publication boundary: every
new PDF is claim-scoped, and publication — the moment a claim's artifacts
become the ones actually served — is a single fenced coordinator transaction,
never a side effect of a successful storage write.

- **Every new PDF write is claim-scoped.**
  `AgentService.startBookGeneration` saves the rendered buffer via
  `pdfStorage.saveClaimPreviewPdf(book.id, currentNamespace, buffer)` —
  `currentNamespace`, the same `claimNamespace(ctx.runId, ctx.fencingVersion)`
  B3 already resolves for images/character sheets. The legacy
  `savePreviewPdf(bookId, buffer)` is no longer called from any generation
  path. A successful write here does **not** itself publish anything — it is
  just bytes sitting at `books/{bookId}/runs/{runId}/claims/{fencingVersion}/
storyme-preview-{bookId}.pdf`, readable only once something resolves that
  exact namespace as published.
- **Publication is the one fenced coordinator transaction, not a storage
  event.** `GenerationRunCoordinator.completeRun` is the only place
  `Book.publishedRunId`/`publishedRunFencingVersion` are ever set, and it sets
  both together, atomically, in the same fenced transaction as the
  `GenerationRun` terminal write and the rest of `Book`'s completion update —
  never independently, never from `AgentService` or `PdfStorage`. A `stale_
fence` or `book_mirror_mismatch` outcome leaves both pointer fields exactly
  as they were (the latter via a full transaction rollback, `GenerationRun`
  included); only an `'applied'` success ever moves them, and only to the
  exact `(ctx.runId, ctx.fencingVersion)` this attempt was fenced on. A run
  that fails after writing its own claim-scoped PDF (crash, storage error, a
  later fence loss) simply leaves that object an unpublished orphan — the
  previously published `(runId, fencingVersion)`, if any, is untouched.
- **One resolver decides what's published — `resolvePublishedPdfNamespace`**
  (`generation-artifact-namespace.ts`), layered on B1's
  `resolvePublishedNamespace` plus `Book.previewPdfUrl` (used strictly to
  disambiguate, never as an ownership signal by itself). Never consults
  `activeRunId`, `lastGenerationRunId`/`lastGenerationFencingVersion`, the
  latest `GenerationRun`, `Book.status` alone, or a storage-existence probe
  to decide ownership — only the published pointer pair below (plus the one
  disambiguating read of `previewPdfUrl`):

| publishedRunId | publishedRunFencingVersion | previewPdfUrl | Resolves to                                                                 |
| -------------- | -------------------------- | ------------- | --------------------------------------------------------------------------- |
| set            | set                        | —             | `{ kind: 'claim', runId, fencingVersion }` — the exact published claim      |
| set            | `null`                     | —             | `{ kind: 'legacy' }` — pre-Phase-B completion                               |
| `null`         | `null`                     | set           | `{ kind: 'legacy' }` — pre-`GenerationRun` completion                       |
| `null`         | `null`                     | `null`        | `{ kind: 'not_ready' }` — nothing published yet                             |
| `null`         | set                        | —             | throws `InvalidGenerationArtifactPointerError` — never falls back to legacy |

- **Every production PDF read/existence path resolves through it.**
  `BooksService.getPreviewPdfBuffer` (the `GET /api/books/:id/pdf/preview`
  handler's backing method), `BooksService.getGenerationDiagnostics`'s
  `pdfStorage.keyPresent`/`previewAvailable` fields, and `AgentService`'s own
  pre-render "was a PDF already published before this attempt" diagnostics
  check all call `resolvePublishedPdfNamespace(book)` and then dispatch
  through the discriminated-namespace helpers `getPublishedPreviewPdf`/
  `publishedPreviewPdfExists` (`pdf-storage.ts`) — never a boolean
  `useLegacy` flag, never a direct `pdfStorage.getPreviewPdf`/
  `previewPdfExists` call outside those two dispatchers. A claim-scoped
  publication whose object is missing reports the existing not-found/storage-
  inconsistency behavior; it never silently falls back to the legacy key.
- **External behavior is unchanged.** The endpoint URL, ownership/auth
  checks, response `Content-Type`, download filename
  (`storyme-preview-{bookId}.pdf`), `BookDto`/diagnostics shape, and frontend
  link construction are all identical regardless of which namespace actually
  served the bytes — the frontend never learns a `runId` or
  `fencingVersion` exists.
- **`previewPdfUrl` stays a storage marker, never the ownership authority.**
  `AgentService` still writes it (now to the claim-scoped URL
  `saveClaimPreviewPdf` returns) only on success, and only as part of the
  `GenerationOutcome.bookUpdate` the coordinator applies inside the same
  fenced transaction that decides whether this attempt's outcome is applied
  at all — a failed or superseded attempt's `bookUpdate` never carries
  `previewPdfUrl`, so it can never overwrite a prior successful marker with
  an unpublished claim's path.
- **Legacy PDFs remain fully readable.** `savePreviewPdf`/`getPreviewPdf`/
  `previewPdfExists` are untouched and still used for both flavors of legacy
  publication in the table above — no migration, backfill, or behavior change
  for any row that predates this slice.
- **Known limitations (B4 explicitly does not build):** no cleanup/deletion
  of unpublished orphan claim objects (a failed or superseded claim's PDF
  simply sits at its own namespace forever); no `GenerationArtifact` model;
  no change to `AgentLog` fencing or outbox dispatch. Cleanup of orphaned
  claim-scoped artifacts (images, character sheets, and now PDFs) remains
  future work across all of Phase B, not something this slice attempts.
- **Deployment constraint: worker and API fleets must upgrade to Slices
  B1–B4 atomically, not on a rolling/mixed basis.** A pre-B4 worker's
  `completeRun` equivalent only ever set `publishedRunId` on success — it has
  no `publishedRunFencingVersion` field to write, and a Prisma partial
  `update` leaves an unlisted column exactly as it was. If a book was already
  published under a claim pointer by a post-B4 worker
  (`publishedRunFencingVersion` non-null) and a later run on that same book
  is then completed by a still-running pre-B4 worker, the result is
  `publishedRunId` pointing at the new run while `publishedRunFencingVersion`
  is left at the old run's stale value — a pair that doesn't identify any
  claim either run actually wrote, so `resolvePublishedPdfNamespace` resolves
  a claim-scoped path nothing was ever saved to and `GET /pdf/preview` 404s
  for a book that did finish generating (bytes sit unreachable at the legacy
  key the old worker actually wrote to). The same hazard applies one slice
  earlier to `lastGenerationRunId`/`lastGenerationFencingVersion`: a pre-B3
  worker's Phase 1 write updates `lastGenerationInputHash` (pre-Phase-B) but
  not the two B3 pointer fields, so a subsequent retry's copy-forward can
  read a stale, unrelated claim as its source — silently reusing an older
  generation's images rather than failing loudly. Both directions are safe
  (old-publishes-old, new-publishes-new, and old-then-legacy-read/new-then-
  claim-read all resolve correctly — see the rollout-compatibility tests in
  `pdf-publication.integration.spec.ts`); only an old completion landing
  _after_ a newer claim-scoped one on the same book is unsafe. Deploy the API
  and worker services for this range of slices together, not as an
  independently-rolled pair.

## Phase C — Orphaned claim-artifact cleanup: operations runbook

Closes the "no cleanup of unpublished orphan claim objects" limitation Phase B
(Slice B4) explicitly left open (see above). `ClaimArtifactCleanupService`
(`src/agent/claim-artifact-cleanup.service.ts`) is a storage-listing sweeper —
it lists whatever claim-scoped keys currently exist in `ImageAssetStorage`/
`PdfStorage`, groups them into `(bookId, runId, fencingVersion)` namespaces,
and deletes only the ones no live Book pointer (published, resumable, or
active-run) references and that are older than `CLAIM_CLEANUP_RETENTION_MS`.

**Cleanup is not required for generation correctness.** No read path
(publish, resume, copy-forward, PDF preview) depends on this service ever
running. An orphaned claim namespace that is never cleaned up simply
occupies storage forever — it is never read, never blocks a future run, and
never causes a book to fail. This service is pure storage-cost hygiene, safe
to leave off indefinitely and safe to enable at any later time with no
migration or backfill step.

**Default state: disabled AND dry-run.** Both `CLAIM_CLEANUP_ENABLED=false`
and `CLAIM_CLEANUP_DRY_RUN=true` (the default when unset) must be true for
this service to do nothing at all — with `CLAIM_CLEANUP_ENABLED` unset/false
it never even runs its once-on-bootstrap pass or acquires its lease. A
deployment that never touches these two variables is byte-for-byte
unaffected by this feature existing.

### Recommended rollout

1. **Deploy with the feature disabled** (`CLAIM_CLEANUP_ENABLED` unset, or
   explicitly `"false"`). Confirms the new code path ships with zero runtime
   behavior change.
2. **Enable dry-run on one environment**: `CLAIM_CLEANUP_ENABLED="true"`,
   `CLAIM_CLEANUP_DRY_RUN="true"` (the default — leaving it unset also works).
   The service now runs its full discovery/classification pass on a real
   schedule but only ever counts, never deletes or acquires the lease for
   writing (dry-run skips the pre-delete DB revalidation and
   `deleteNamespace` entirely).
3. **Observe pass summaries for at least one full `CLAIM_CLEANUP_INTERVAL_MS`
   interval** (default 30 minutes) before touching anything else. Each pass
   logs one line at `info` level from `ClaimArtifactCleanupService`, e.g.:
   `Claim artifact cleanup (dryRun=true): discovered N object(s), M
malformed/skipped, ... protected: ... dry-run eligible, ...`.
4. **Confirm the protected/eligible/malformed counts look sane** before
   enabling real deletion:
   - `protectedPublished` / `protectedResumable` / `protectedActiveRun` /
     `protectedRetention` — expected, healthy protection; these namespaces
     are never touched regardless of dry-run.
   - `dryRunEligibleNamespaces` — what _would_ be deleted if dry-run were
     off. Spot-check a few of these bookIds/runIds against what you expect
     to be genuinely orphaned (failed/superseded runs) before trusting the
     number.
   - `malformedObjects` — storage keys that didn't parse as the claim-key
     grammar at all; should be 0 in practice (every key this service ever
     writes matches the grammar by construction). A nonzero count here is
     worth investigating on its own, not something to enable deletion past.
   - `incompleteNamespaces` — namespaces discovered but deliberately never
     classified this pass because discovery itself was cut off mid-way by
     `CLAIM_CLEANUP_MAX_OBJECTS_PER_PASS`/`CLAIM_CLEANUP_MAX_NAMESPACES_PER_PASS`
     (see "Per-pass bounds" below). Always safe/expected to be nonzero on a
     large or growing storage tree — it means "retried whole next pass,"
     never "silently dropped."
5. **Enable real deletion on one instance/environment first**:
   `CLAIM_CLEANUP_DRY_RUN="false"` (leaving `CLAIM_CLEANUP_ENABLED="true"`).
   The app refuses to boot with a clear error (`assertClaimCleanupRetentionSafety`)
   if `CLAIM_CLEANUP_RETENTION_MS` is not comfortably above `RECOVERY_LEASE_MS`
   — see "Retention vs. lease timing" below — so a misconfigured retention
   window cannot silently reach production.
6. **Expand gradually** — roll the same `CLAIM_CLEANUP_DRY_RUN="false"`
   setting out to the remaining environments/instances only after the first
   one has run several real passes with `deletedNamespaces` /
   `partialFailureNamespaces` counts matching expectations and no unexpected
   errors in logs.

### Retention vs. lease timing

`CLAIM_CLEANUP_RETENTION_MS` (default 24h) is the _only_ thing that protects
a namespace a live-but-momentarily-stale worker is still writing to — there
is no per-namespace DB row recording "in progress," only the namespace's own
storage-reported `lastModified`. This must stay safely above the window in
which `GenerationRunRecoveryService` could still be waiting to notice a
worker has gone stale, i.e. `RECOVERY_LEASE_MS` (default 5 minutes).
`assertClaimCleanupRetentionSafety` enforces `CLAIM_CLEANUP_RETENTION_MS` is
at least 10× `RECOVERY_LEASE_MS` at boot and throws (refusing to schedule
any work) otherwise — this ratio is deliberately generous, not a tight bound,
so do not lower `CLAIM_CLEANUP_RETENTION_MS` to just barely clear it.

### Leadership and per-pass bounds

Exactly one instance runs a given pass, elected via the same fencing-token
`RecoveryLease` row mechanism `GenerationRunRecoveryService` uses (a plain
conditional `UPDATE ... WHERE lease_owner IS NULL OR lease_expires_at < NOW()`,
safe under Prisma's pooled connections — see "Recovery leadership" above),
under its own dedicated lease id (`claim_artifact_cleanup`, seeded by
migration `20260716000000_phase_c_claim_cleanup_lease`) so the two sweeps
never contend for the same row and can run concurrently on the same or
different instances (verified in
`test/integration/claim-artifact-cleanup-lease.integration.spec.ts`).
Leadership is re-checked before every namespace deletion during a real
(non-dry-run) pass, so a pass that outlives its own lease (long pass, lost
leadership to a new instance) stops immediately rather than continuing to
delete past its authority — the remainder is picked up by whichever instance
holds the lease on the next scheduled pass.

Two independent caps bound a single pass's work so it can never run
unboundedly long or touch unboundedly many namespaces at once:
`CLAIM_CLEANUP_MAX_OBJECTS_PER_PASS` (default 10,000 raw storage objects
listed across both drivers) and `CLAIM_CLEANUP_MAX_NAMESPACES_PER_PASS`
(default 200 namespaces classified/deleted). Hitting either stops the pass
early (`truncated: true` in the summary) — anything not reached this pass is
simply retried whole on the next scheduled interval.

### Partial failures and malformed/incomplete namespace warnings

A namespace's deletion is only ever reported `deleted` when _every_ key in
it (across both the image and PDF drivers) is confirmed deleted or already
absent. Any single key failure — a permission error, a disk error, or the
new TOCTOU defense below refusing a suspicious path — marks the whole
namespace `partial_failure` and logs a `warn`-level line naming the specific
failed keys; only those still-outstanding keys are retried on a later pass
(already-deleted keys in the same namespace are not re-attempted, since a
prior partial pass may have already removed them).

`incompleteNamespaces` (see step 4 above) means discovery itself was cut off
before both storage drivers finished listing — those namespace groups are
never classified or deleted at all this pass (not even reported as
protected or eligible), since their true key set/age isn't fully known yet.

### Rollback

Set `CLAIM_CLEANUP_ENABLED="false"` (or simply revert to leaving it unset)
and restart/redeploy. **Rollback never requires a database rollback or
migration down** — the seeded `recovery_leases` row for
`claim_artifact_cleanup` is inert with the service disabled, and no other
schema object depends on this feature.

**Deleted orphan artifacts are intentionally not restorable by this
feature.** There is no soft-delete, quarantine, or undo — `deleteNamespace`
issues real `unlink`/`DeleteObjectsCommand` calls. This is acceptable because
a namespace only ever becomes eligible after it is confirmed unreferenced by
any live Book pointer and older than the retention window (see above); if a
deletion turns out to have been unwanted, the only recovery path is
regenerating the book, not undoing this service's work.

**No real S3/R2 smoke test runs automatically as part of this feature or
its rollout.** `pnpm --filter @book/api test`/`test:integration` never touch
a real bucket — cloud-driver behavior is covered by mocked-client unit tests
(`image-asset-storage.claim-cleanup.spec.ts`,
`pdf-storage.claim-cleanup.spec.ts`) only. Verifying against a real S3/R2
bucket, if ever needed, is exactly the existing manual, explicitly-invoked
`pnpm --filter @book/api smoke:pdf-storage` convention (see
`docs/pdf-storage-smoke-test.md`) — never something CI or this service runs
on its own.

### Local-filesystem deletion hardening (TOCTOU defense)

`deleteLocalClaimArtifacts` (`src/agent/claim-artifact-local-walk.ts`), used
by both `LocalImageAssetStorage` and `LocalPdfStorage`, re-verifies with
`lstat` — immediately before acting, never `existsSync`/`stat`, which
dereference symlinks — that every ancestor directory in a previously-listed
key's path is still a real, non-symlink directory and that the leaf is still
a plain file. This closes a real time-of-check-to-time-of-use gap: a plain
string-based "resolved path starts with the configured root" check (the
pre-existing defense) proves nothing about what an `unlink` call will
actually touch if an ancestor directory was swapped for a symlink/junction
between listing and deletion — verified concretely (see
`claim-artifact-local-walk.spec.ts`) on both Windows (a directory junction,
creatable without elevation) and Linux (a plain symlink, creatable by any
unprivileged user) by watching an out-of-root sentinel file actually get
deleted through the naive path-string check alone.

A suspicious ancestor/leaf is reported `failed` (skipped, retried next pass)
never `deleted`; a key that legitimately disappeared (idempotent concurrent
cleanup) is still reported `not_found`. **Residual limitation, stated
precisely**: Node's public `fs` API has no `openat`/`unlinkat`-equivalent
that pins an unlink to a directory handle verified moments earlier, so a
single-syscall gap remains between the last `lstat` check and the `unlink`
call itself — closing that completely would require a native addon, out of
scope for this stack. This does not weaken cloud storage in any way
(`CloudPdfStorage`/`CloudImageAssetStorage` never touch a local filesystem,
so this class of race does not apply to them).

## Phase D — generation-claim-owned `AgentLog` persistence

Closes the "`AgentLog` ownership" limitation Phase A explicitly left open (see
above): before this phase, `AgentService.startBookGeneration` called
`prisma.agentLog.createMany` directly, unconditionally, at two points in the
pipeline (the story-generation-failure early return, and the final success/
failure return) — a stale or superseded claim that made it far enough to
reach either call still wrote its `AgentLog` rows, even though every other
durable write it attempted was already correctly fenced.

**The fix moves persistence, not computation.** `AgentService` still builds
the exact same `AgentLog` row shapes it always did — same steps, same
`traceId`, same provider/model/duration fields, same safe error text — but no
longer calls Prisma at all. Instead it returns those rows as
`GenerationOutcome.agentLogs` (`generation-outcome.ts`), and
`GenerationRunCoordinator`'s existing `runFencedTerminalTransition` helper
(`generation-run-coordinator.service.ts`, the single choke point every
terminal GenerationRun/Book transition already went through — see its own
doc comment) inserts them via `tx.agentLog.createMany` as the _last_
statement inside the same transaction as the fenced `GenerationRun` write and
the Book mirror write, and only after both have held. Concretely:

1. `GenerationRun.updateMany` fenced on `(id, status: 'running',
fencingVersion)` — 0 rows matched means this claim is stale; the
   transaction returns `'stale_fence'` immediately and the AgentLog insert is
   never reached.
2. `Book.updateMany` fenced on `(id, activeRunId)` — 0 rows matched means the
   run/Book mirror invariant is broken; the transaction throws
   `BookMirrorMismatchError`, which rolls back the entire transaction
   (including step 1's already-applied `GenerationRun` write) — the AgentLog
   insert is again never reached, and nothing from step 1 survives either.
3. Only once both above have matched does `tx.agentLog.createMany` run (and
   is skipped entirely — no query at all — when `agentLogs` is empty, which
   is only ever the case for a caller that has no outcome to report, e.g.
   `failInvalidSnapshot`/`failAbandoned`, neither of which ever ran
   `AgentService` in the first place).

This means a stale/superseded claim now writes **zero** `AgentLog` rows,
exactly like it writes no other durable state — the diagnostics rows for a
book's generation history are exactly the rows the currently-accepted claim
produced, nothing from an attempt that lost the fencing race.

**Retry history stays append-only.** Nothing about this change touches how
prior claims' already-committed `AgentLog` rows are read or cleaned up — see
"`AgentLog` history is untouched" under Startup recovery, and the "Retry
history" notes under Generation diagnostics — a newer accepted run's rows are
simply inserted alongside older ones, keyed by their own distinct `traceId`;
this phase only closes the gap where a _non_-accepted run's rows could have
been inserted at all.

**No schema migration.** `AgentLog`'s shape (`prisma/schema.prisma`) is
unchanged — this phase is purely about _when_ and _by whom_ rows get
inserted, not what they contain.

**Verified behavior:**

- An accepted successful run's nine `AgentLog` rows, and an accepted failed/
  partial run's truthful error rows, are byte-for-byte the same as before
  this phase (`agent.service.spec.ts` — every prior assertion on row shape
  was migrated from asserting `prisma.agentLog.createMany`'s call arguments
  directly to asserting the returned `GenerationOutcome.agentLogs`, since
  `AgentService` itself no longer calls Prisma).
- `GenerationRunCoordinator.completeRun` persists `outcome.agentLogs` only on
  `'applied'`, never on `'stale_fence'` or `'book_mirror_mismatch'`
  (`generation-run-coordinator.service.spec.ts`, unit-level with a mocked
  Prisma; `generation-fencing.integration.spec.ts`, against a real Postgres).
- A deterministic real-Postgres race — a run reclaimed by a newer delivery
  (`GenerationRunService.claim` bumping `fencingVersion`) mid-pipeline —
  proves the old claim's `completeRun` call is rejected and writes zero
  `AgentLog` rows, while the new claim's own completion writes only its own
  rows (`generation-fencing.integration.spec.ts`). Built from explicit,
  sequentially-awaited claim/complete steps, not `Promise.all` timing, so the
  interleaving is exact rather than probabilistic.
- The `book_mirror_mismatch` rollback test additionally proves the AgentLog
  insert itself — the last statement in the transaction — never commits when
  an earlier statement in the same transaction throws.

**Residual limitation, stated precisely:** claim _artifact_ writes (images,
character sheets, PDFs, via `ImageAssetStorage`/`PdfStorage`) still are not
DB-fenced — they rely only on the same-process, best-effort
`assertNotSuperseded` check (see Phase B's own limitations) or nothing at
all, and a stale claim's in-flight artifact write can still land as an
unpublished orphan object even after this phase. `AgentLog` was the only
piece of state in this codebase that was both (a) written directly by
`AgentService` outside of `applyFencedBookWrite`/`GenerationRunCoordinator`
and (b) a genuine DB row rather than a storage object — closing it here does
not change the storage-side picture at all.

## Worker process separation

Closes the last limitation Phase 3K flagged: `GenerationQueueProcessor` no
longer runs embedded inside the API process. Nothing about the queue
contract, `BooksService.runGenerationPipeline`, or `AgentService`'s pipeline
changed — only which process registers the BullMQ worker.

- **Previous limitation** — every API instance also ran the BullMQ worker
  in-process (`@Processor(QUEUES.BOOK_GENERATION)` was an unconditional
  provider in `books.module.ts`). That coupled HTTP request-handling capacity
  to generation-worker capacity: you couldn't scale API replicas without also
  multiplying workers (or vice versa), and a slow/stuck generation job shared
  the same Node event loop as HTTP traffic.
- **`AppModule`/`BooksModule` are now dynamic modules** —
  `AppModule.register({ enableGenerationWorker })` /
  `BooksModule.register({ enableGenerationWorker })` — instead of static
  `@Module({...})` classes. `GenerationQueueProcessor` (whose `@Processor`
  decorator opens a real BullMQ `Worker`/Redis connection the moment Nest
  instantiates it) is only included in `BooksModule`'s `providers` array when
  `enableGenerationWorker` is `true`. Every other provider/controller — the
  entire rest of the app — is identical between the two modes, so there is no
  duplicated business logic between API and worker.
- **`apps/api/src/main.ts`** (API entrypoint, unchanged behavior otherwise):
  calls `NestFactory.create(AppModule.register({ enableGenerationWorker }))`
  where `enableGenerationWorker = process.env.ENABLE_GENERATION_WORKER ===
'true'`. **Defaults to `false`** — the API never registers the processor
  unless that var is explicitly set, matching the "don't consume jobs unless
  explicitly enabled" requirement. Still starts the HTTP server exactly as
  before.
- **`apps/api/src/worker.ts`** (new entrypoint) — boots
  `AppModule.register({ enableGenerationWorker: true })` (always `true`,
  regardless of `ENABLE_GENERATION_WORKER`) via
  `NestFactory.createApplicationContext(...)`, **not**
  `NestFactory.create(...)`: no HTTP adapter, no `app.listen()`, no port
  opened, no `/api/*` routes reachable — a process that only holds a DI
  container and whatever BullMQ workers/schedulers get instantiated inside
  it. `app.enableShutdownHooks()` is still called so `SIGTERM`/`SIGINT` close
  the Redis connection and let in-flight jobs finish (or get picked back up
  by BullMQ's stalled-job detection) instead of being killed mid-write.
- **`GenerationJobRecoveryService` is unaffected** — it's still an
  unconditional `BooksModule` provider (`OnApplicationBootstrap`), so it runs
  in _both_ the API and the worker on their respective boots. This is
  deliberately left as-is rather than pinned to one process: it's a
  DB-only fail-safe sweep (see "Startup recovery (Phase 3J)" above), every
  write is an idempotent last-write-wins `update`, and running it twice on a
  simultaneous API+worker cold start is harmless — strictly safer than
  picking one process and having recovery silently not run if that process
  happens to be down. Removing it, or narrowing it to one process, was not
  attempted since neither is required and BullMQ's stalled-job handling still
  doesn't fully replace it (see Phase 3J's "Known limitations").
- **`apps/api/nest-cli.json`**: `compilerOptions.deleteOutDir` changed from
  `true` to `false`. `nest start --watch` for the API and the worker both
  compile into the same `apps/api/dist/`; with `deleteOutDir: true`, starting
  one while the other is already running would wipe the other's freshly
  built output out from under it. `false` is safe for both single- and
  dual-process local dev.
- **Package scripts** (`apps/api/package.json`):
  - `dev:worker` — `nest start --watch --entryFile worker`, the worker
    equivalent of the existing `dev` script (`nest start --watch`, entry file
    `main` by default).
  - `start:api` / `start:worker` — `node dist/main` / `node dist/worker`,
    for running a built image directly (`start:api` is identical to the
    pre-existing `start`, kept for backward compatibility).
  - `start:prod:api` / `start:prod:worker` — same commands again, named
    explicitly for use as each Railway service's start command (see
    `docs/deployment-readiness.md`'s "Recommended deployment architecture").
  - `build` (`tsc -p tsconfig.build.json`) was already unchanged: it compiles
    every file under `src/`, so `dist/worker.js` is produced automatically
    alongside `dist/main.js` with no build-script changes needed.
- **Tests** — `apps/api/src/books/books.module.spec.ts` and
  `apps/api/src/app.module.spec.ts` assert on the `DynamicModule` metadata
  `BooksModule.register(...)`/`AppModule.register(...)` produce (whether
  `GenerationQueueProcessor` is in the resulting `providers` array), rather
  than booting a real Nest application — a real boot needs live
  Postgres/Redis (`DatabaseModule`/`QueueModule` connect eagerly), which
  normal tests must not depend on. This is enough to prove the API and
  worker entrypoints genuinely produce different module graphs.
- **Known limitations**:
  - Not verified against a live Postgres/Redis in this environment (no Docker
    daemon available when this phase was implemented) — verified via
    typecheck/lint/tests/build only. Before relying on this in a real
    deployment, run `pnpm --filter @book/api dev` and
    `pnpm --filter @book/api dev:worker` side by side against
    `docker-compose.yml`'s Postgres/Redis and confirm a real
    `generate`/`retry-generation` call is picked up by the worker process's
    logs, not the API process's.
  - `GenerationJobRecoveryService` still runs redundantly in both processes
    on every cold start (see above) — harmless, but not eliminated.
  - No independent horizontal scaling guidance beyond "run more worker
    replicas" — BullMQ already distributes jobs across however many worker
    processes are running (Phase 3K), so this phase doesn't need to add
    anything there.

## Book creation input contract (Phase 4A)

Phase 4A hardens the shape of `POST /books`' request body — validation,
normalization, and how the validated fields reach the generation pipeline —
without changing the pipeline's architecture or adding new provider
concepts.

### Stable input shape

`CreateBookDto` (`apps/api/src/books/dto/create-book.dto.ts`), enforced by the
global `ValidationPipe` (`whitelist: true`, `forbidNonWhitelisted: true`):

| Field                | Required | Bounds / rules                                                                                         |
| -------------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `title`              | yes      | trimmed, 1–120 chars                                                                                   |
| `childName`          | yes      | trimmed, 1–80 chars                                                                                    |
| `childAge`           | yes      | integer, 1–12                                                                                          |
| `language`           | no       | `SupportedLanguage` enum (`en`/`ru`/`pl`); defaults to `en`                                            |
| `theme`              | yes      | trimmed, 1–120 chars                                                                                   |
| `educationalMessage` | no       | trimmed, 1–300 chars if present                                                                        |
| `pageCount`          | no       | integer, `MIN_BOOK_PAGE_COUNT`–`MAX_BOOK_PAGE_COUNT` (4–12); defaults to `DEFAULT_BOOK_PAGE_COUNT` (6) |

`MIN_BOOK_PAGE_COUNT` / `MAX_BOOK_PAGE_COUNT` / `DEFAULT_BOOK_PAGE_COUNT` are
exported from `@book/types` (`packages/types/src/book.types.ts`) and shared by
the DTO, `BooksService`, and both `StoryGenerationProvider` implementations —
one source of truth for the accepted range. This range coincidentally matches
the default `REAL_GENERATION_MAX_PAGES` cost guardrail (see above), but the
two are independently configurable: `REAL_GENERATION_MAX_PAGES` is an
env-tunable cap on real (paid) image generation cost, not a request-input
bound.

`title`, `childName`, `theme`, and `educationalMessage` are trimmed by a
`class-transformer` `@Transform` before `class-validator` runs, so a
whitespace-only value (`"   "`) fails the `@Length(1, N)` check the same way
an empty string does — normalization and validation see the same value.

### Normalization and defaults

`BooksService.create` is the single place defaults are applied:

```ts
language: dto.language ?? SupportedLanguage.English,
educationalMessage: dto.educationalMessage ?? null,
pageCount: dto.pageCount ?? DEFAULT_BOOK_PAGE_COUNT,
```

Everything the pipeline reads afterward comes from the persisted `Book` row —
there is no separate "raw request" object floating around for
`AgentService`/`StoryGenerationProvider` to re-normalize. This is also what
makes retry (Phase 3G) automatically use normalized input: `retryGeneration`
re-reads the same `Book` row and calls the same
`AgentService.startBookGeneration`, so a retried generation targets the same
already-normalized `pageCount`/`educationalMessage`/`theme` as the original
attempt.

### Persistence

`Book.pageCount` (added in the Phase 1 schema but previously unused by the
pipeline) and a new nullable `Book.educationalMessage` column
(`educational_message`, migration
`20260702010000_phase4a_book_input_contract`) store the normalized input.
`BookDto` and `toBookDto` (`books.mapper.ts`) expose both fields to the
frontend.

### How input feeds generation

`StoryGenerationInput` (`apps/api/src/agent/story-generation-provider.ts`)
gained two optional fields: `pageCount` and `educationalMessage`.
`AgentService.startBookGeneration` passes `book.pageCount` and
`book.educationalMessage` straight through (both `?? undefined` if null).

- **`resolveTargetPageCount(pageCount)`** (exported from
  `story-generation-provider.ts`) clamps to `[MIN_BOOK_PAGE_COUNT,
MAX_BOOK_PAGE_COUNT]` and defaults to `DEFAULT_BOOK_PAGE_COUNT` when absent
  or non-numeric — a defense-in-depth clamp behind the DTO's own bounds
  (relevant for books created before this migration, whose `pageCount` is
  `null`).
- **`MockStoryGenerationProvider`** now builds a variable number of chapters
  (`CHAPTER_TEMPLATES`, up to 6, `Math.ceil(pageCount / 2)` of them) and pages
  to match the resolved page count, trimming the final chapter to one page
  for an odd count. The default call shape (`pageCount` omitted) is
  unchanged: 3 chapters, 6 pages, identical template text to before Phase 4A.
  A provided `educationalMessage` replaces the generated
  `storyPlan.educationalMessage` outright; otherwise the same
  theme-derived default text is generated as before.
- **`OpenAIStoryGenerationProvider`** resolves `targetPageCount` per call —
  `input.pageCount` (clamped) if present, else the constructor's own default
  — and passes it into `buildStoryGenerationPrompt`, which asks the model for
  exactly that many pages. When `educationalMessage` is present, the prompt
  adds a line naming it and instructs the model to reflect it in the
  response's `educationalMessage` field. The LLM response schema's page-count
  bounds (`min(4).max(12)`) already matched `MIN_BOOK_PAGE_COUNT`/
  `MAX_BOOK_PAGE_COUNT` and now import them directly instead of duplicating
  the literals.

### Frontend

`apps/web/src/app/dashboard/books/new/page.tsx`'s existing 3-step wizard
gained two fields on the "Story" step: a `pageCount` `<select>` (options
`MIN_BOOK_PAGE_COUNT`…`MAX_BOOK_PAGE_COUNT`, default `DEFAULT_BOOK_PAGE_COUNT`)
and an optional `educationalMessage` `<textarea>` (`maxLength={300}`).
`handleCreate` trims `childName`/`theme`/`educationalMessage` before building
the request body and only includes `educationalMessage` in the payload when
non-empty after trimming — the frontend never sends internal provider
settings (model name, provider selection, timeouts/retries), only the same
`CreateBookInput` shape the backend validates.

### Known limitations (Phase 4A)

- **No `storyTone` field.** The phase brief suggested one "if already
  supported or easy to add" — it isn't currently supported anywhere in the
  pipeline (no enum, no prompt wiring), and threading it through DTO →
  schema → both providers → prompts with the same care as
  `educationalMessage` was judged out of scope for this pass. Deferred to a
  future phase if product wants it.
- **No protagonist/character-detail fields beyond `childName`/`childAge`.**
  None exist yet in the input contract to hedge on; `CharacterCard`'s
  appearance/personality fields remain fully generated by the provider.
- **Pre-Phase-4A books have `pageCount: null`.** They fall back to
  `DEFAULT_BOOK_PAGE_COUNT` via `resolveTargetPageCount` at generation time
  rather than being backfilled by the migration.

## Status transitions

```text
created --(generate: validation + status/runner/job check)--> char_build --[background pipeline]--> layout --> complete
                                                                                                              \-> failed
```

The HTTP response for `generate`/`retry-generation` now observes `char_build`
(the just-scheduled state), not the final outcome. `layout` remains a
transient intermediate value written mid-pipeline; the poll loop (or a
manual refresh) is what eventually observes `complete` or `failed`.

## Preview endpoint behavior

`GET /api/books/:id/pdf/preview` (`BooksService.getPreviewPdfBuffer`):

1. `findOwnedOrThrow` — 404 (`NotFoundException`) if the book doesn't exist,
   belongs to another user, or is soft-deleted.
2. If `previewPdfUrl` is still `null` (generation hasn't completed, or
   failed) — 409 (`ConflictException`, "PDF not ready — book generation is
   not complete").
3. `pdfStorage.getPreviewPdf(bookId)` — 404 (`NotFoundException`, "PDF file
   not found in storage") if `previewPdfUrl` is set but the file is missing
   from storage (e.g. manually deleted from `tmp/`).
4. Otherwise returns `{ buffer, contentType: 'application/pdf', filename }`,
   and `BooksController.getPreviewPdf` sets `Content-Type`,
   `Content-Disposition: inline`, and `Content-Length` headers and streams it
   back as a `StreamableFile`.

`:id` route params (`findOne`, `update`, `generate`, `remove`,
`pdf/preview`) are all decorated with Nest's built-in `ParseUUIDPipe`, which
rejects non-UUID values with a 400 before the controller method runs. That's
a framework-level guarantee exercised by Nest's own tests, not this repo's;
this repo has no HTTP-level (supertest/e2e) test harness today, so it isn't
re-verified here — see "Test coverage" below.

## Failure states summary

| State                                            | Trigger                                                                                                                                                                                                                                                             | HTTP surface                                                                                                                                                                                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BadRequestException` (400)                      | `generate` called with missing draft fields                                                                                                                                                                                                                         | `POST /:id/generate`                                                                                                                                                                                                                    |
| `ConflictException` (409)                        | `update`/`remove` after `status !== created`                                                                                                                                                                                                                        | `PATCH /:id`, `DELETE /:id`                                                                                                                                                                                                             |
| `ConflictException` (409)                        | `generate` called when `status !== created`                                                                                                                                                                                                                         | `POST /:id/generate`                                                                                                                                                                                                                    |
| `ConflictException` (409)                        | `retry-generation` called when `status !== failed`                                                                                                                                                                                                                  | `POST /:id/retry-generation`                                                                                                                                                                                                            |
| `ConflictException` (409)                        | `generate`/`retry-generation` called while an active (`queued`/`running`) `GenerationJob` exists for the book (Phase 3I)                                                                                                                                            | `POST /:id/generate`, `POST /:id/retry-generation`                                                                                                                                                                                      |
| `InternalServerErrorException` (500)             | enqueueing the pipeline onto the durable queue itself fails, e.g. Redis unreachable (Phase 3K)                                                                                                                                                                      | `POST /:id/generate`, `POST /:id/retry-generation`                                                                                                                                                                                      |
| `ConflictException` (409)                        | preview requested before `previewPdfUrl` is set                                                                                                                                                                                                                     | `GET /:id/pdf/preview`                                                                                                                                                                                                                  |
| `NotFoundException` (404)                        | book missing / not owned / soft-deleted                                                                                                                                                                                                                             | any `:id` route                                                                                                                                                                                                                         |
| `NotFoundException` (404)                        | `previewPdfUrl` set but file missing from storage                                                                                                                                                                                                                   | `GET /:id/pdf/preview`                                                                                                                                                                                                                  |
| `BookStatus.failed`                              | PDF render or `pdfStorage.savePreviewPdf` throws                                                                                                                                                                                                                    | observed via polling `GET /:id` or `GET /:id/generation-diagnostics` — not the `generate` response body since Phase 3H                                                                                                                  |
| `BookStatus.failed`                              | `storyGenerationProvider.generateStory` throws (`failedStep: 'story_plan'`)                                                                                                                                                                                         | observed via polling — see above                                                                                                                                                                                                        |
| `BookStatus.failed`                              | an unexpected error escapes `AgentService.startBookGeneration` entirely (no `failedStep`)                                                                                                                                                                           | observed via polling — caught defensively by `BooksService.runGenerationPipeline` (Phase 3H)                                                                                                                                            |
| `BookStatus.failed` (`failedStep: 'pdf_render'`) | `imageGenerationProvider.generateImage` or `ImageAssetStorage.saveImageAsset` throws for one or more entries (up to and including all of them), or `MAX_GENERATED_IMAGES_PER_BOOK` capped an entry — `assertAllImagesResolved` then fails the book before rendering | observed via polling `GET /:id` or `GET /:id/generation-diagnostics`; see `imageGenerationResult.generatedImageCount`/`failedImageCount`/`lastImageError`, and the `pdf_render` `AgentLog` row's `error` for which page(s) were missing |

## Test coverage

- `apps/api/src/books/books.service.spec.ts` — `create`, `findAllForUser`,
  `findOneForUser`, `update`, `remove`, `startGeneration` (all validation
  branches), `getPreviewPdfBuffer` (ready/not-ready/missing-file).
- `apps/api/src/books/books.controller.spec.ts` — thin pass-through wiring
  for every route plus exception propagation (404/409/400), and the preview
  endpoint's header-setting behavior.
- `apps/api/src/agent/agent.service.spec.ts` — every stage of
  `startBookGeneration` with `renderStorybookPdf` mocked (story/layout/image
  metadata, AgentLog rows, success/failure status transitions), plus
  dedicated coverage for the `StoryGenerationProvider` boundary (a failing
  provider marks the book `failed` without saving images/building
  layout/rendering a PDF, and `AgentService` calls `generateStory` with the
  expected input) and the `ImageGenerationProvider` boundary (a provider
  that fails for some or all entries records `generatedImageCount`/
  `failedImageCount`/`lastImageError` accordingly, but — since
  `assertAllImagesResolved` requires every planned illustration to have
  bytes — the book is then marked `failed` at `pdf_render` rather than
  completing with placeholders for the failed entries; the `image_gen`
  `AgentLog` row itself still stays `success` with a summary error, since the
  failure is only realized at the later `pdf_render` step).
- `apps/api/src/agent/story-generation-provider.spec.ts` —
  `MockStoryGenerationProvider` in isolation: deterministic output for the
  same input, varies with `childName`/`theme`/`bookId`, and every required
  field is present on the returned `characterCard`, `storyPlan`,
  `bookPreview`, and `imageGenerationResult`.
- `apps/api/src/agent/agent.service.local-pipeline.spec.ts` — the one test
  in this file runs the **real** `MockImageGenerationProvider` (wrapping
  `generateMockImagePng`) → `LocalImageAssetStorage` →
  `buildImageBufferResolver` → `renderStorybookPdf` chain (nothing mocked
  except `PrismaService` and `PdfStorage`) and asserts the resulting PDF
  buffer is non-trivially sized and contains a real `/Subtype /Image`
  object — proof that mock image bytes are actually embedded end-to-end, not
  just that each boundary works in isolation.
- `apps/api/src/images/image-generation-provider.spec.ts` —
  `MockImageGenerationProvider` in isolation: deterministic PNG bytes for the
  same entry seed, different bytes for different seeds.
- `apps/api/src/images/image-generation-provider.factory.spec.ts` —
  `createImageGenerationProvider` provider selection (mock default,
  explicit `mock`/`openai`, missing-`OPENAI_API_KEY` error, unknown-value
  error).
- `apps/api/src/images/openai-image-generation-provider.spec.ts` —
  `buildImagePrompt` content, and `OpenAIImageGenerationProvider` request
  shape, response mapping, and error paths (HTTP error, network failure,
  missing `b64_json`) via an injected `fetchImpl` — no real network call.
- `apps/api/src/images/image-asset-storage.spec.ts` and
  `apps/api/src/pdf/pdf-renderer.spec.ts` cover the storage and rendering
  boundaries directly, including the `/Subtype /Image` marker for a
  hand-supplied buffer.
- `apps/api/src/common/openai-request.spec.ts` — `readOpenAIRetryConfig` env
  parsing/fallbacks, and `fetchWithRetry`: first-attempt success, no retry on
  non-retryable statuses (400/401), retry-then-succeed on 429/500, retry
  exhaustion on a persistently failing status, and `OpenAIRequestError` with
  the correct `reason` (`timeout` vs `network`) on abort/network failure —
  all via fake timers and a mocked `fetchImpl`, no real network or real
  delays.
- `apps/api/src/agent/openai-story-generation-provider.spec.ts` and
  `apps/api/src/images/openai-image-generation-provider.spec.ts` — extended
  with timeout (`AbortController` fires → provider-specific error), retry
  (429/500 succeed on the second attempt), non-retry (400/401 fail on the
  first attempt), and API-key-not-leaked-in-error-message coverage; the image
  provider spec also covers the `REAL_GENERATION_MAX_PAGES` guardrail
  (rejects a `page` entry above the cap without calling `fetch`, allows one
  at the cap, never caps `cover`/`back_cover`).
- `apps/api/scripts/smoke-real-generation.spec.ts` — the smoke script's
  precondition check (`checkPreconditions` in
  `smoke-real-generation-helpers.ts`) in isolation: missing `OPENAI_API_KEY`,
  either provider not `openai`, and the all-clear case; plus
  `formatDiagnosticsSummary` (Phase 3E): renders provider/model/page-count/
  duration/PDF-url, includes `failedStep`/`errorMessage` on failure, and
  never contains an API key, `b64_json`, or the word "base64" — the main
  script itself is never imported by a test, so `pnpm test` never boots Nest
  or calls a real API.
- `apps/api/src/books/generation-diagnostics.spec.ts` (Phase 3E) —
  `buildGenerationMetadata`: provider/model resolution (`AgentLog` row vs.
  `Book.aiModelVersions`, `'unknown'` fallback), `generatedPages` from
  `bookPreview.pages.length`, `durationMs`/`startedAt`/`completedAt` derived
  from `Book.generationTimeMs`/`updatedAt`, `failedAt`/`failedStep`/
  `errorMessage` on a failed book, everything omitted while a book is still
  in progress, and no secrets/prompts/base64 in the serialized output.
  `buildGenerationDiagnostics`: composes `bookId`/`status`/`previewPdfUrl`/
  `recentLogs` correctly and never leaks a key, `b64_json`, or raw
  `choices` response shape through `recentLogs`.
- `apps/api/src/books/books.service.spec.ts` (Phase 3E) —
  `getGenerationDiagnostics`: fetches the owned book plus its 20 most recent
  `AgentLog` rows and returns the composed diagnostics; 404s for a
  missing/not-owned book without querying `AgentLog`. Also (Phase 3J)
  `retryGeneration` succeeds for a book left `failed` by startup recovery
  with `GENERATION_INTERRUPTED_MESSAGE` as its `errorMessage` — proving retry
  treats a recovered book exactly like any other failure.
- `apps/api/src/agent/generation-job.service.spec.ts` (Phase 3J) —
  `findStaleActiveJobs` queries queued/running jobs with `updatedAt` before
  the given cutoff, oldest first.
- `apps/api/src/agent/generation-job-recovery.service.spec.ts` (Phase 3J) —
  `readGenerationJobStaleAfterMs` env parsing/fallbacks (default 30 minutes,
  malformed/non-positive values fall back); `recover`: a stale `queued` job
  is marked `failed`, a stale `running` job is marked `failed`, a related
  book still in a non-terminal generating status is marked `failed`, a
  `complete` book is left untouched, an already-`failed` book is left
  untouched, fresh (non-stale) jobs are excluded via the `findStaleActiveJobs`
  cutoff query, one job failing to recover doesn't stop the rest and is
  counted in the summary; `onApplicationBootstrap` runs `recover` with the
  configured threshold and never throws even if recovery itself rejects.
- `apps/api/src/books/books.controller.spec.ts` (Phase 3E) — thin
  pass-through wiring for `GET /:id/generation-diagnostics` plus
  `NotFoundException` propagation.
- `apps/api/src/books/books.service.spec.ts` (Phase 3G) — `retryGeneration`:
  clears `failedStep`/`errorMessage` and delegates to
  `AgentService.startBookGeneration` with the cleared book; rejects with
  `ConflictException` when status is not `failed` (covers both an
  in-progress and an already-`complete` book); 404s for a missing/not-owned
  book without touching `prisma.book.update` or
  `AgentService.startBookGeneration`; never calls `agentLog.deleteMany`/
  `agentLog.delete`.
- `apps/api/src/books/books.controller.spec.ts` (Phase 3G) — thin
  pass-through wiring for `POST /:id/retry-generation` plus
  `ConflictException`/`NotFoundException` propagation.
- `apps/web/src/app/dashboard/books/[id]/page.test.tsx` (Phase 3G) — the
  "Retry generation" button renders only when `status === Failed`; clicking
  it POSTs to `/books/:id/retry-generation`; the button is disabled and reads
  "Retrying…" while the request is in flight; a failed retry request shows
  its message in a `role="alert"` banner; a successful retry that returns a
  non-terminal status resumes the existing poll effect through to a terminal
  status.
- `apps/api/src/agent/agent.service.spec.ts` (Phase 3E) — the final book
  update carries `generationTimeMs`/`aiModelVersions` on success; every
  `AgentLog` row is tagged with the injected providers'
  `providerName`/`modelName`; `story_plan`/`image_gen`/`layout`/`pdf_render`
  entries carry a measured `durationMs`; an injected real-provider-shaped
  story provider (`providerName: 'openai'`, `modelName: 'gpt-4o-mini'`)
  produces the matching labels in both `aiModelVersions` and the
  `story_plan` log row.
- `apps/web/src/app/dashboard/books/[id]/page.test.tsx` (Phase 3F) —
  `GenerationDiagnosticsPanel` renders provider/model/generated-page-count/
  formatted-duration; shows `failedStep` and the safe `errorMessage` plus the
  "try again later" hint on a failed book; shows a "PDF: ready" row once
  `previewPdfUrl` is set; diagnostics refresh on each poll tick while
  generating and stop once status is terminal; a failed diagnostics fetch
  degrades to a "Diagnostics unavailable" message without breaking the rest
  of the page. (The suite's `fetch` mock was changed from a plain call-order
  queue to one routed by request URL, since the page now issues a second,
  concurrent `/generation-diagnostics` call alongside every `/books/:id`
  call/poll; existing tests were otherwise left as-is.)

- `apps/api/src/books/books.service.spec.ts` (Phase 3H, updated Phase 3K) —
  `startGeneration`/`retryGeneration`: the returned response carries
  `char_build` (not a terminal status) and `AgentService.startBookGeneration`
  is not called synchronously; `generationQueueService.enqueue` is called
  with `{ bookId, jobId }`; calling `service.runGenerationPipeline(bookId,
jobId)` directly (as `GenerationQueueProcessor` would) calls
  `AgentService.startBookGeneration` with the freshly-reloaded book; invoking
  it when `AgentService.startBookGeneration` rejects marks the book `failed`
  with the caught error's message instead of throwing; an
  `InternalServerErrorException` is thrown (after marking the job/book
  failed) when `generationQueueService.enqueue` itself rejects right after
  the atomic status claim.
- `apps/api/src/agent/generation-queue.service.spec.ts` (Phase 3K) —
  `GenerationQueueService` in isolation: `enqueue` adds one job to the
  injected BullMQ `Queue` with `data.jobId` as the BullMQ job id; a rejection
  from the underlying queue (e.g. Redis unreachable) propagates unchanged.
- `apps/api/src/agent/generation-queue.processor.spec.ts` (Phase 3K) —
  `GenerationQueueProcessor` in isolation: `process(job)` delegates to
  `BooksService.runGenerationPipeline` with the job's `bookId`/`jobId`.

- `apps/api/src/agent/generation-job.service.spec.ts` (Phase 3I) —
  `GenerationJobService` in isolation: `findActive` queries `queued`/`running`
  jobs newest-first, `findLatest` queries any status newest-first,
  `createQueued` writes `status: 'queued'` with the given type/attempt,
  `markRunning`/`markCompleted`/`markFailed` set the right status plus their
  respective timestamp, and `markFailed` defaults `failedStep` to `null` when
  omitted.
- `apps/api/src/books/books.service.spec.ts` (Phase 3I) — `startGeneration`/
  `retryGeneration` create a queued `GenerationJob` (`generate`/`attempt: 1`,
  or `retry`/`attempt: clearedBook.retryCount + 1`); the scheduled task marks
  the job `running` then `completed` on a successful pipeline run, `failed`
  (with `failedStep`/`errorMessage`) when `AgentService.startBookGeneration`
  returns a `failed` book, and `failed` when the pipeline throws
  unexpectedly; both `startGeneration` and `retryGeneration` throw
  `ConflictException` (without touching `prisma.book.update` or scheduling
  anything) when `generationJobService.findActive` reports an active job; a
  retry is still allowed when the book is `failed` and no active job exists,
  regardless of any prior `completed`/`failed` job on record;
  `getGenerationDiagnostics` includes `latestJob` from
  `generationJobService.findLatest` (or `null` when none exists).
- `apps/api/src/books/generation-diagnostics.spec.ts` (Phase 3I) —
  `buildGenerationDiagnostics` maps a `GenerationJob` row into the safe
  `latestJob` summary (id/type/status/attempt/timestamps/failedStep/
  errorMessage), returns `latestJob: null` when no job is passed, and never
  leaks `runnerId` through the serialized diagnostics.

Not covered, deliberately: real HTTP requests through Nest's pipes/filters
(no supertest/e2e harness exists in this package; see
`apps/api/src/books/books.controller.spec.ts` for controller-level
alternatives instead).

## What's intentionally not real yet

- **AI story generation** — `MockStoryGenerationProvider` (behind the
  `StoryGenerationProvider` boundary, see above) is hand-written templates,
  not an LLM call.
- **AI image generation** — `MockImageGenerationProvider` (behind the
  `ImageGenerationProvider` boundary, see above) wraps
  `generateMockImagePng`, which produces a solid-color 8×8 PNG swatch keyed
  by a deterministic hash of the entry's seed, not artwork from an image
  model. A real `OpenAIImageGenerationProvider` exists but is only used when
  `IMAGE_GENERATION_PROVIDER=openai` is explicitly set.
- **Public image serving** — mock image bytes live only in
  `ImageAssetStorage` (local disk under `tmp/images/`) to be embedded into
  the PDF; nothing serves them over HTTP, and the `/mock-images/...` URLs
  recorded on `GeneratedImageEntry.imageUrl` resolve to nothing.
- ~~Async queues/workers~~ **Done in Phase 3K** — see "Durable generation
  queue (Phase 3K)" above. Generation is now scheduled through a real
  BullMQ/Redis-backed queue (`QUEUES.BOOK_GENERATION`), not in-process
  scheduling — it survives an API process restart and BullMQ distributes jobs
  across multiple API instances' workers. Still true: no mid-pipeline
  resume (a re-run always restarts `AgentService.startBookGeneration` from
  the top) and no scheduling-level retry/backoff beyond `AgentService`'s own
  provider-level retries (Phase 3D) — see "Known limitations" under Phase 3K.
- **Payments/auth** — `DevAuthGuard` stands in for real authentication;
  there's no payment gating on generation or preview access.

## Local demo (frontend)

The web app (`apps/web`) already has a full click-through UI for this
lifecycle — no extra wiring needed.

1. Start the API: `pnpm --filter @book/api dev` (defaults to
   `http://localhost:4000`).
2. Start the web app: `pnpm --filter @book/web dev` (defaults to
   `http://localhost:3000`; set `NEXT_PUBLIC_API_URL` if the API runs
   elsewhere).
3. Open `http://localhost:3000/dashboard` — click **+ New Book**, fill in
   the child/story wizard, and submit to create a `created` book.
4. Open the new book's detail page and click **Generate Story**. Since Phase
   3H, the button only shows "Generating…" for the brief `POST
/:id/generate` request itself (which returns as soon as the book is
   flipped to `char_build`) — the whole pipeline (story/layout/mock
   images/PDF render) then runs in the background, and the detail page
   auto-polls every 2.5s until it reaches a terminal `complete`/`failed`
   status, showing a step-specific message (e.g. "Writing your story…",
   "Rendering PDF…") on each tick.
5. Once `status` is `complete`, an "Your PDF is ready" panel appears with
   **Open PDF** (new tab) and **Download PDF** links, both pointing at
   `GET /api/books/:id/pdf/preview`.

Everything shown — story text, illustration prompts, image URLs, the PDF
itself — is mock/local per "What's intentionally not real yet" above; no
external AI or network calls happen at any point in this flow.

## Quick start: generating a real OpenAI book locally

Everything below still runs entirely on your machine (Postgres/Redis/local
disk) — the only thing that becomes "real" is the OpenAI API calls. Nothing
here touches Railway or any cloud storage; `PDF_STORAGE_DRIVER`/
`IMAGE_STORAGE_DRIVER` stay `local` (the default).

1. **Set env vars** in `apps/api/.env` (see `.env.example` at the repo root
   for the full annotated list):

   ```sh
   OPENAI_API_KEY="sk-..."
   STORY_GENERATION_PROVIDER="openai"
   IMAGE_GENERATION_PROVIDER="openai"
   # OPENAI_STORY_MODEL="gpt-4o-mini"    # optional, this is the default
   # OPENAI_IMAGE_MODEL="gpt-image-1"    # optional, this is the default
   # Must cover every illustration the book plans (cover + pages + back cover),
   # or PDF rendering fails at the pdf_render step — see assertAllImagesResolved
   # in agent.service.ts. For the default 6-page book that's 8 (1 cover + 6
   # pages + 1 back cover); raise this if you pick a longer pageCount.
   MAX_GENERATED_IMAGES_PER_BOOK="9"
   PDF_STORAGE_DRIVER="local"
   IMAGE_STORAGE_DRIVER="local"
   ```

   Never commit `.env` or print `OPENAI_API_KEY` — it's already git-ignored.

2. **Have local Postgres + Redis running** (same prerequisite as any other
   local generation run — see the repo root README/`.env.example` for
   connection strings).
3. **Run the API and a worker.** The generation queue (Phase 3K) needs a
   worker process actually consuming `book-generation` jobs, or a book will
   sit in `char_build` forever:
   - One-process option (simplest for local dev): set
     `ENABLE_GENERATION_WORKER="true"` in `apps/api/.env`, then just run
     `pnpm --filter @book/api dev` — the API process registers the worker too.
   - Two-process option (matches the recommended production topology): run
     `pnpm --filter @book/api dev` (API, `ENABLE_GENERATION_WORKER` unset/`false`)
     and `pnpm --filter @book/api dev:worker` (dedicated worker) in separate
     terminals.
4. **Run the web app**: `pnpm --filter @book/web dev`.
5. **Generate a book** exactly as in "Local demo (frontend)" above — create a
   book, click **Generate Story**. Story text/prompts now come from
   `OPENAI_STORY_MODEL` (a real OpenAI chat completion) and every illustration
   (cover, every page, back cover) comes from `OPENAI_IMAGE_MODEL` (real
   OpenAI image generation), as long as `MAX_GENERATED_IMAGES_PER_BOOK` covers
   the book's total illustration count. If it doesn't, or any individual
   image request fails, the book is marked `failed` at the `pdf_render` step
   instead of completing with placeholder pages — check the book detail
   page's diagnostics panel (or `GET /api/books/:id/generation-diagnostics`
   directly) for `generatedImageCount`/`failedImageCount`, and the API logs
   for the `Missing generated illustration for ...` line naming the page.
6. **Alternative: the scripted smoke test** —
   `pnpm --filter @book/api smoke:real-generation` runs the same real pipeline
   once end-to-end without the web app, printing a diagnostics summary. See
   "Manual end-to-end smoke test" above; it makes real, billed API calls same
   as the UI flow.

**Controlling image cost**: `MAX_GENERATED_IMAGES_PER_BOOK` (default `3`) caps
how many illustrations are actually requested from OpenAI per book. Since
every planned illustration must have real bytes for the PDF to render (see
above), set it to the book's total illustration count for a full test, or
pick a shorter `pageCount` when creating the book to keep the total (and the
bill) small — don't lower the cap below the book's total illustration count,
or generation will fail. `REAL_GENERATION_MAX_PAGES` (default `12`) is a
separate, higher hard limit on page number. Story generation is always
exactly one chat-completion call per book regardless of page count.

**Where local files live**:

- Generated PDFs: `apps/api/tmp/books/<bookId>/storybook.pdf`
  (`LocalPdfStorage`).
- Generated image bytes: `apps/api/tmp/images/<bookId>/*.png`
  (`LocalImageAssetStorage`).

**Cleaning up local generated files**: delete `apps/api/tmp/books/` and
`apps/api/tmp/images/` (e.g. `rm -rf apps/api/tmp/books apps/api/tmp/images`
from the repo root, or just `tmp/books`/`tmp/images` from inside `apps/api`).
Both directories are re-created on demand the next time a book generates —
nothing else on disk needs cleaning up. This only removes local files; it
does not delete the `Book`/`AgentLog`/`GenerationJob` rows themselves (use
the normal delete-book flow or a direct database query for that).

## How a future real-provider phase should slot in

Both generation boundaries already have a real implementation, gated
entirely behind explicit env selection (`STORY_GENERATION_PROVIDER=openai`,
`IMAGE_GENERATION_PROVIDER=openai`) — the default and every test/CI
run still use the mock providers with zero network calls. Both real
providers also have timeout/retry hardening, request logging, and a real
image-generation cost guardrail (see "Real provider hardening (Phase 3D)"
above), plus a manual smoke test
(`pnpm --filter @book/api smoke:real-generation`). What's left:

- ~~Cloud storage~~ **Done**: both `PdfStorage` (`CloudPdfStorage`, behind
  `PDF_STORAGE_DRIVER`) and `ImageAssetStorage` (`CloudImageAssetStorage`,
  behind `IMAGE_STORAGE_DRIVER`) have S3/R2 implementations — see
  `apps/api/docs/pdf-rendering.md`'s "Image asset storage boundary" section
  and `docs/deployment-readiness.md`.
- **Public image serving**: mock/real image bytes still live only in
  `ImageAssetStorage` for PDF embedding — nothing serves them over HTTP yet
  (see "What's intentionally not real yet" above).
