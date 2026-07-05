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
  `GeneratedImageEntry` in the provider's `imageGenerationResult`, calls the
  injected `ImageGenerationProvider.generateImage({ bookId, entry,
  characterCard })` (see "Image generation provider boundary" below) to get
  real image bytes, then saves them through
  `ImageAssetStorage.saveImageAsset(imageAssetKey(bookId, kind, pageNumber),
  buffer, contentType)`. This step has two separate failure domains:
  - If any `generateImage` call throws (e.g. a real provider's API outage),
    the whole call rejects. `AgentService` catches it before Phase 1 runs,
    marks the book `failed` (`failedStep: 'image_gen'`, `errorMessage` from
    the caught error), writes a single `image_gen` `AgentLog` row with
    `status: 'error'`, and returns immediately — no layout is built, no PDF
    is rendered.
  - Once an image's bytes exist, saving them runs in parallel with the
    others; a failure on any one `saveImageAsset` call is caught, logged
    (`Failed to save mock image asset for entry "<id>": ...`), and skipped —
    it does **not** fail generation. A skipped image just degrades to a
    placeholder rectangle at render time (see below).
- (c) `buildBookLayout` (private function in `agent.service.ts`) — builds the
  print-ready `BookLayout` (2400×2400px canvas, `square_8x8` trim),
  referencing the same mock `imageUrl`s. This step stays in `AgentService`
  rather than the story provider — it's print-layout logic over already-built
  story/image data, not story content itself.

Then, in three phases against the database:

- **Phase 1** — one `prisma.book.update`: status → `layout`, persists
  `characterCard`, `storyPlan`, `bookPreview`, `imageGenerationResult`,
  `bookLayout`.
- **Phase 2** — PDF render, wrapped in try/catch:
  1. `buildImageBufferResolver(imageAssetStorage, bookId, layout.entries)`
     pre-resolves every layout entry's saved bytes (if any) from
     `ImageAssetStorage` into a synchronous lookup closure.
  2. `renderStorybookPdf(bookLayout, { resolveImageBuffer })` renders one PDF
     page per layout entry, embedding real bytes for any entry the resolver
     has bytes for, and drawing a labelled placeholder rectangle for the
     rest.
  3. `pdfStorage.savePreviewPdf(bookId, buffer)` persists the PDF (default
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
  storyPlan: StoryPlan & { pages: Array<PagePlan & { storyText: string; illustration: IllustrationPlan }> };
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
- Image *metadata* (prompts, mock `imageUrl` placeholder paths,
  `GeneratedImageEntry` records) is built by the provider as part of
  `imageGenerationResult`. Actual image *bytes* are not — that stays behind
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
    `OPENAI_MODEL` (defaults to `gpt-4o-mini`).
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
for producing the actual image *bytes* for one `GeneratedImageEntry`
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

- Registered via `IMAGE_GENERATION_PROVIDER_TOKEN` in `books.module.ts`,
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
  `books.module.ts`'s `useFactory` for `IMAGE_GENERATION_PROVIDER_TOKEN`:
  - `IMAGE_GENERATION_PROVIDER_TOKEN` unset, empty, or `"mock"` →
    `MockImageGenerationProvider`.
  - `IMAGE_GENERATION_PROVIDER_TOKEN=openai` → `OpenAIImageGenerationProvider`,
    constructed with `OPENAI_API_KEY` (required — throws a clear `Error` at
    provider-construction time if missing) and optional `OPENAI_IMAGE_MODEL`
    (defaults to `gpt-image-1`).
  - Any other value throws a clear `Error` naming the invalid value.
- **Failure behavior** — if any `generateImage` call throws,
  `AgentService.generateAndSaveImageAssets` rejects before any bytes are
  saved. `AgentService` catches it before Phase 1 runs, marks the book
  `failed` (`failedStep: 'image_gen'`, `errorMessage` from the caught
  error's message), writes one `image_gen` `AgentLog` row with `status:
  'error'`, and returns — no layout is built, no PDF is rendered or stored.
  This is deliberately stricter than the `ImageAssetStorage.saveImageAsset`
  per-image swallow-and-continue behavior below it: a generation-provider
  failure (e.g. a real API outage) is systemic and affects every image,
  while a storage-save failure is a one-off, recoverable-with-a-placeholder
  problem.

To try real image generation locally: set `IMAGE_GENERATION_PROVIDER_TOKEN=openai`
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
  - HTTP `408`, `429`, `500`, `502`, `503`, `504`.
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
Since `AgentService.generateAndSaveImageAssets` fails the whole book
(`failedStep: 'image_gen'`) if any single `generateImage` call throws, this
effectively caps real (paid) generation to books with at most
`REAL_GENERATION_MAX_PAGES` story pages.

### Per-book illustration budget — `MAX_ILLUSTRATIONS_PER_BOOK`

A second, tighter cost guardrail lives in `AgentService.generateAndSaveImageAssets`
itself (`apps/api/src/agent/agent.service.ts`), not the provider: when the
injected `ImageGenerationProvider.providerName === 'openai'`, only the first
`MAX_ILLUSTRATIONS_PER_BOOK` entries (default `3` if unset/malformed — see
`resolveMaxIllustrationsPerBook` in `apps/api/src/images/image-generation-provider.ts`)
of a book's `images` array (cover, then pages in order, then back cover) are
actually sent to the provider. The remaining entries are skipped entirely —
no network call, no cost — and render as the ordinary placeholder rectangle
at PDF-render time, exactly like any entry `ImageAssetStorage` has no bytes
for. `MockImageGenerationProvider` is never capped (`providerName === 'mock'`),
since it's free — every test/CI run, which always uses the mock provider,
still gets one real (mock) image per entry, unaffected by this cap.

This is deliberately independent of `REAL_GENERATION_MAX_PAGES` above: that
guardrail rejects (hard error, fails the whole book) any single page request
beyond a page-number threshold; this one silently limits the *count* of real
illustrations per book to control cost on every real-provider book generation,
regardless of page count, without ever failing generation.

### Manual end-to-end smoke test

`apps/api/scripts/smoke-real-generation.ts`
(`pnpm --filter @book/api smoke:real-generation`) runs the full real pipeline
once, end-to-end, against the real OpenAI API:

- Fails fast with a clear message (no network calls, no Nest bootstrap) if
  `OPENAI_API_KEY` is missing or if `STORY_GENERATION_PROVIDER` /
  `IMAGE_GENERATION_PROVIDER_TOKEN` aren't both set to `openai` — the
  precondition check lives in `smoke-real-generation-helpers.ts` and is unit
  tested directly (`smoke-real-generation.spec.ts`) without ever importing
  the main script, so normal test runs never invoke `main()` or touch the
  network.
- Otherwise boots the real Nest application context (`AppModule`) — requires
  a running local Postgres + Redis, same as `pnpm --filter @book/api dev` —
  finds-or-creates a fixed smoke-test user, creates one small 4-chapter/
  6-page test book via `PrismaService`, and calls
  `AgentService.startBookGeneration` directly.
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
- Verifies the book reaches `BookStatus.complete`, that every generated image
  entry's bytes were actually saved to `ImageAssetStorage`, and that the
  rendered PDF exists in `PdfStorage` — then prints the book id and PDF
  preview URL.
- Exits non-zero with a clear error on any failed check. Not part of
  `pnpm --filter @book/api test` or CI — matches the existing
  `smoke:pdf-storage` script's pattern (see
  `apps/api/docs/pdf-storage-smoke-test.md`).

**Known limitations**: this smoke test creates real rows against whatever
database `DATABASE_URL` points at (nothing is cleaned up afterward — same as
manually creating a book through the API) and makes real, billed OpenAI API
calls (one story completion + one image generation per page/cover/back
cover). Run it deliberately, not routinely.

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
                                           // startedAt, completedAt, failedAt, durationMs,
                                           // failedStep, errorMessage
  recentLogs: AgentLogSummary[];          // up to 20 most recent AgentLog rows, newest first
  previewPdfUrl?: string | null;
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
- `startedAt` is derived (`Book.updatedAt - Book.generationTimeMs`) since
  there's no dedicated start-timestamp column; `completedAt`/`failedAt` use
  `Book.updatedAt` when `status` is terminal.

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
smoke test" above) now builds and prints a `GenerationDiagnosticsDto`
summary after the pipeline finishes, via
`formatDiagnosticsSummary` (`apps/api/scripts/smoke-real-generation-helpers.ts`):
book id, status, story/image provider + model, generated page count,
duration, PDF preview url, and (only on failure) `failedStep` and
`errorMessage`. `formatDiagnosticsSummary` is a pure function — unit tested
directly in `smoke-real-generation.spec.ts` without booting Nest or making
a network call — and only ever prints fields already proven safe by
`GenerationDiagnosticsDto`/`GenerationMetadata`.

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
> transition is persisted, pipeline runs after) is unchanged — only *what*
> runs it changed.

`POST /api/books/:id/generate` and `POST /api/books/:id/retry-generation`
return as soon as the status transition is persisted — they no longer wait
for the whole pipeline (including PDF render) to finish. The pipeline itself
is unchanged; only *when* the HTTP response is sent changed.

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
  error escaping *all* of `AgentService`'s handling (a truly unexpected bug);
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
row — a typed, persisted record of that one generation *attempt*. This is
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
    retried — see "Startup recovery (Phase 3J)" below for what *does* happen
    to it on the next boot (a fail-safe, not a resume).
  - ~~Still in-process, still no cross-instance coordination.~~ **Done in
    Phase 3K** — see "Durable generation queue (Phase 3K)" below.
    `maxAttempts` and `runnerId` remain schema-only/unused; BullMQ's own
    per-job `attempts`/backoff options are configured instead (see
    `queue.module.ts`), and `runnerId` was never needed since BullMQ tracks
    job ownership itself.

## Startup recovery (Phase 3J)

Phase 3I made a `GenerationJob` stuck in `queued`/`running` after an API
crash or redeploy *visible* via diagnostics but didn't fix it — the book
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
  - A job that goes stale *between* recovery runs (i.e., the API stays up but
    the worker silently stops progressing without throwing or the process
    crashing) is not detected until the next process restart — recovery only
    runs on boot, not on an interval. BullMQ's own stalled-job detection (see
    below) narrows this further but doesn't eliminate it.

## Durable generation queue (Phase 3K)

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
    schedules. The *request-time* duplicate-generation guard
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
  in *both* the API and the worker on their respective boots. This is
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

| Field | Required | Bounds / rules |
| --- | --- | --- |
| `title` | yes | trimmed, 1–120 chars |
| `childName` | yes | trimmed, 1–80 chars |
| `childAge` | yes | integer, 1–12 |
| `language` | no | `SupportedLanguage` enum (`en`/`ru`/`pl`); defaults to `en` |
| `theme` | yes | trimmed, 1–120 chars |
| `educationalMessage` | no | trimmed, 1–300 chars if present |
| `pageCount` | no | integer, `MIN_BOOK_PAGE_COUNT`–`MAX_BOOK_PAGE_COUNT` (4–12); defaults to `DEFAULT_BOOK_PAGE_COUNT` (6) |

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

| State | Trigger | HTTP surface |
| --- | --- | --- |
| `BadRequestException` (400) | `generate` called with missing draft fields | `POST /:id/generate` |
| `ConflictException` (409) | `update`/`remove` after `status !== created` | `PATCH /:id`, `DELETE /:id` |
| `ConflictException` (409) | `generate` called when `status !== created` | `POST /:id/generate` |
| `ConflictException` (409) | `retry-generation` called when `status !== failed` | `POST /:id/retry-generation` |
| `ConflictException` (409) | `generate`/`retry-generation` called while an active (`queued`/`running`) `GenerationJob` exists for the book (Phase 3I) | `POST /:id/generate`, `POST /:id/retry-generation` |
| `InternalServerErrorException` (500) | enqueueing the pipeline onto the durable queue itself fails, e.g. Redis unreachable (Phase 3K) | `POST /:id/generate`, `POST /:id/retry-generation` |
| `ConflictException` (409) | preview requested before `previewPdfUrl` is set | `GET /:id/pdf/preview` |
| `NotFoundException` (404) | book missing / not owned / soft-deleted | any `:id` route |
| `NotFoundException` (404) | `previewPdfUrl` set but file missing from storage | `GET /:id/pdf/preview` |
| `BookStatus.failed` | PDF render or `pdfStorage.savePreviewPdf` throws | observed via polling `GET /:id` or `GET /:id/generation-diagnostics` — not the `generate` response body since Phase 3H |
| `BookStatus.failed` | `storyGenerationProvider.generateStory` throws (`failedStep: 'story_plan'`) | observed via polling — see above |
| `BookStatus.failed` | `imageGenerationProvider.generateImage` throws for any entry (`failedStep: 'image_gen'`) | observed via polling — see above |
| `BookStatus.failed` | an unexpected error escapes `AgentService.startBookGeneration` entirely (no `failedStep`) | observed via polling — caught defensively by `BooksService.runGenerationPipeline` (Phase 3H) |
| per-image save failure (non-fatal) | one `ImageAssetStorage.saveImageAsset` call throws | logged only; that image renders as a placeholder |

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
  expected input) and the `ImageGenerationProvider` boundary (a failing
  provider marks the book `failed` with `failedStep: 'image_gen'` without
  saving images/building layout/rendering a PDF).
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
  `IMAGE_GENERATION_PROVIDER_TOKEN=openai` is explicitly set.
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

## How a future real-provider phase should slot in

Both generation boundaries already have a real implementation, gated
entirely behind explicit env selection (`STORY_GENERATION_PROVIDER=openai`,
`IMAGE_GENERATION_PROVIDER_TOKEN=openai`) — the default and every test/CI
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
