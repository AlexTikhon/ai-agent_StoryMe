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
   - Delegates to `AgentService.startBookGeneration(book)`.
4. **Generation** — `AgentService.startBookGeneration` (see below) runs
   synchronously within the request and returns the final `Book` row
   (`complete` or `failed`).
5. **Preview** — `GET /api/books/:id/pdf/preview`
   (`BooksService.getPreviewPdfBuffer` → `PdfStorage.getPreviewPdf`) streams
   the rendered PDF back as `application/pdf`.

There is no queue/worker: generation runs inline inside the `generate`
request handler and the HTTP response only returns once the whole pipeline
(including PDF render) has finished or failed.

## What `AgentService.startBookGeneration` does, in order

All of steps (a)–(d) are pure, deterministic local functions — no I/O, no
randomness beyond hashing the book's own fields:

- (a) `buildCharacterCard`, `buildStoryPlan`, `buildPagePlan`,
  `buildStoryDraft`, `buildIllustrationPlan`, `buildBookPreview` — build a
  mock story (3 chapters × 2 pages = 6 pages) purely from `childName`,
  `childAge`, `theme` already on the book row.
- (b) `buildImageGenerationResult` — builds one `GeneratedImageEntry` per
  cover / page / back-cover slot (8 entries total for the default 6-page
  story). `imageUrl` on each entry is a `/mock-images/<bookId>/...svg`
  placeholder path — nothing is ever written there and nothing serves it;
  it exists for display/metadata only.
- (c) `saveMockImageAssets` (private helper) — for every entry, generates
  deterministic PNG bytes via `generateMockImagePng(entry.seed)`
  (`apps/api/src/images/mock-image-producer.ts`) and saves them through
  `ImageAssetStorage.saveImageAsset(imageAssetKey(bookId, kind, pageNumber),
  buffer, 'image/png')`. Saves run in parallel; a failure on any one image is
  caught, logged (`Failed to save mock image asset for entry "<id>": ...`),
  and skipped — it does **not** fail generation. A skipped image just
  degrades to a placeholder rectangle at render time (see below).
- (d) `buildBookLayout` — builds the print-ready `BookLayout` (2400×2400px
  canvas, `square_8x8` trim), referencing the same mock `imageUrl`s.

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

## Status transitions

```
created --(generate: validation + status check)--> [in-request pipeline] --> layout --> complete
                                                                                      \-> failed
```

`created` and `layout` are both transient from the caller's perspective —
`layout` only exists as the Phase-1 intermediate value inside the same
request; the HTTP response always observes the final `complete` or `failed`
status, never `layout`.

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
| `ConflictException` (409) | preview requested before `previewPdfUrl` is set | `GET /:id/pdf/preview` |
| `NotFoundException` (404) | book missing / not owned / soft-deleted | any `:id` route |
| `NotFoundException` (404) | `previewPdfUrl` set but file missing from storage | `GET /:id/pdf/preview` |
| `BookStatus.failed` | PDF render or `pdfStorage.savePreviewPdf` throws | `POST /:id/generate` response body |
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
  metadata, AgentLog rows, success/failure status transitions).
- `apps/api/src/agent/agent.service.local-pipeline.spec.ts` — the one test
  in this file runs the **real** `generateMockImagePng` →
  `LocalImageAssetStorage` → `buildImageBufferResolver` →
  `renderStorybookPdf` chain (nothing mocked except `PrismaService` and
  `PdfStorage`) and asserts the resulting PDF buffer is non-trivially sized
  and contains a real `/Subtype /Image` object — proof that mock image bytes
  are actually embedded end-to-end, not just that each boundary works in
  isolation.
- `apps/api/src/images/image-asset-storage.spec.ts` and
  `apps/api/src/pdf/pdf-renderer.spec.ts` cover the storage and rendering
  boundaries directly, including the `/Subtype /Image` marker for a
  hand-supplied buffer.

Not covered, deliberately: real HTTP requests through Nest's pipes/filters
(no supertest/e2e harness exists in this package; see
`apps/api/src/books/books.controller.spec.ts` for controller-level
alternatives instead).

## What's intentionally not real yet

- **AI story generation** — `buildStoryPlan` / `buildPagePlan` /
  `buildStoryDraft` are hand-written templates, not an LLM call.
- **AI image generation** — `generateMockImagePng` produces a solid-color
  8×8 PNG swatch keyed by a deterministic hash of the entry's seed, not
  artwork from an image model.
- **Public image serving** — mock image bytes live only in
  `ImageAssetStorage` (local disk under `tmp/images/`) to be embedded into
  the PDF; nothing serves them over HTTP, and the `/mock-images/...` URLs
  recorded on `GeneratedImageEntry.imageUrl` resolve to nothing.
- **Async queues/workers** — generation runs inline in the `generate`
  request handler; there's no BullMQ job or background worker wired up yet
  (despite `@nestjs/bullmq` being a dependency).
- **Payments/auth** — `DevAuthGuard` stands in for real authentication;
  there's no payment gating on generation or preview access.

## How a future real-provider phase should slot in

Both mock boundaries were built so a real provider drops in without
touching callers:

- **Real image generation**: replace the call to `generateMockImagePng` in
  `AgentService.saveMockImageAssets` with a real provider call, still saved
  through `ImageAssetStorage.saveImageAsset`. No changes needed to
  `buildImageBufferResolver` or `renderStorybookPdf` — see
  `apps/api/docs/pdf-rendering.md` for the detailed boundary contract.
- **Real story generation**: replace `buildStoryPlan` / `buildPagePlan` /
  `buildStoryDraft` / `buildIllustrationPlan` with real LLM calls that
  return the same `StoryPlan` / `PagePlan` / `IllustrationPlan` shapes
  (`@book/types`) already consumed by `buildBookPreview` and
  `buildBookLayout` — those two and everything downstream (layout, PDF
  render, storage) do not need to change.
- **Cloud storage**: `PdfStorage` already has a `CloudPdfStorage` (S3/R2)
  implementation behind `PDF_STORAGE_DRIVER`; `ImageAssetStorage` would need
  an equivalent cloud implementation following the same pattern before image
  bytes could live outside local disk.
