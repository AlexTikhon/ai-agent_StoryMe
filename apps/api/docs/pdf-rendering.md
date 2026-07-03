# PDF rendering notes

Covers `apps/api/src/pdf/pdf-renderer.ts`: how text is laid out, current font
limitations, how image embedding works, and what future phases should do.

## Text wrapping

Line wrapping is handled entirely by PDFKit's built-in `.text(text, x, y, {
width, height, align, lineGap })` call in `renderTextBlock`. There is no
custom line-wrap helper in this codebase — an earlier `wrapText` utility
existed but was never wired into the renderer (PDFKit's wrapping already
covers the deterministic layout engine's needs) and was removed as dead code
in Phase 2T.

If a future requirement needs explicit line-by-line control (e.g. precise
line-count budgeting before layout, or custom hyphenation), reintroduce a
small pure helper and wire it into `renderTextBlock` deliberately, with
tests — don't let it sit unused again.

## Font / Unicode limitation

`resolveFont` maps layout font families to PDFKit's built-in fonts only:
`Helvetica`, `Helvetica-Bold`, `Times-Roman`, `Times-Bold`. These built-in
fonts only support the **WinAnsi encoding** (roughly Latin-1). Characters
outside that range — CJK, Cyrillic, Arabic, Hebrew, many accented Latin
characters, emoji — will render blank or as missing glyphs.

This is a known, accepted limitation for the current phase. Book text
containing such characters currently passes DTO validation and layout, but
will render incorrectly in the final PDF.

### BACKLOG: `ru`/`pl` PDF output is not production-ready

`SupportedLanguage` (`packages/types/src/book.types.ts`) offers `en` | `ru` |
`pl` in the book-creation form, and story generation (mock and OpenAI) both
produce correct `ru`/`pl` text — this limitation is PDF-rendering-only.
Concretely, for a book created with:

- `ru` (Russian) — Cyrillic is entirely outside WinAnsi. Every character in
  the story text renders as a blank/missing glyph. The PDF is effectively
  unreadable.
- `pl` (Polish) — mostly Latin, but the diacritic letters (`ą ć ę ł ń ó ś ź
  ż`, upper and lower case) fall outside WinAnsi and will render blank while
  surrounding ASCII text renders fine — visibly broken rather than fully
  unreadable, but still wrong.

**Do not ship `ru`/`pl` as a real feature (marketing, public launch) until
this is fixed** — today it's a silent per-glyph rendering gap, not a hard
error, so nothing currently blocks a user from generating and downloading a
broken PDF. Treat this the same as the other public-production blockers in
`docs/deployment-readiness.md` (rate limiting, email verification, password
reset): known, documented, not yet scheduled.

Not fixed in this pass deliberately — embedding a Unicode-capable font
requires picking and vendoring a specific font file, which is a licensing
decision (redistribution rights, font file size in the repo/image) that
shouldn't be made silently as a side effect of an unrelated change. See
"Future Unicode font phase" below for the actual implementation plan once
that decision is made.

## Future Unicode font phase (not implemented)

To support non-Latin text, a future phase should:

1. Embed one or more real Unicode-capable TTF/OTF fonts as project assets
   (properly licensed for embedding/redistribution).
2. Register them once per render via `doc.registerFont(name, fontPathOrBuffer)`.
3. Extend `resolveFont` (or a small font-registry seam next to it) to select
   an embedded font instead of a built-in name when the layout requires it.
4. Add rendering tests that assert non-Latin text no longer produces blank
   glyphs (e.g. via extracted PDF text streams, not full binary snapshots).

Do not attempt this by downloading fonts at runtime or depending on fonts
installed on the host system — rendering must stay deterministic and
network-free.

## Images

Covers image handling in `renderStorybookPdf` / `renderImageBlock` in
`apps/api/src/pdf/pdf-renderer.ts`.

### The embedding boundary

`renderStorybookPdf(layout, options?)` accepts an optional
`options.resolveImageBuffer: (imageBlock, entry) => Buffer | undefined`. This
is the *only* way the renderer ever gets image bytes:

- It is called synchronously, once per image block, purely in-process.
- Returning `undefined` (or omitting the option entirely) means "no bytes
  available" and the renderer draws the existing labelled placeholder
  rectangle — today's default behavior is unchanged.
- Returning a `Buffer` embeds it via PDFKit's `doc.image()`, using `cover`
  for `objectFit: 'cover'` and `fit` for `objectFit: 'contain'`, both with
  `align: 'center'` / `valign: 'center'` — this fits/covers the image inside
  the layout box, preserves aspect ratio, never overflows the box, and
  centers it, matching the layout engine's `LayoutImageBlock.objectFit`.

The renderer deliberately does **not**:

- fetch `imageBlock.imageUrl` over the network or from disk itself,
- call any AI/image-generation API,
- read from S3/R2 or any other cloud storage.

Those concerns belong to whatever supplies the resolver, not to the PDF
renderer — this keeps rendering local, deterministic, and side-effect-free.

### Current pipeline state

`imageUrl` values produced by the local-mock image generation step
(`apps/api/src/agent/agent.service.ts`, `buildImageGenerationResult`) are
still placeholder path strings like `/mock-images/<bookId>/cover.svg` — no
file is ever written to that path and nothing serves it; `imageUrl` is used
only for display/metadata. Real embedded bytes come from a separate path,
below.

`AgentService.startBookGeneration` calls `renderStorybookPdf` with a
`resolveImageBuffer` option (via `buildImageBufferResolver`, see below), and
now *does* save real image bytes for every generated image entry before
rendering — see "Local mock image producer" below — so images embed for
real, end-to-end, during book generation. Only the standalone
`scripts/render-pdf.ts` sample script (used by `pnpm render:pdf`) still
renders placeholder-only, since it calls `renderStorybookPdf` directly with a
hardcoded sample layout and never goes through `AgentService` or
`ImageAssetStorage`.

### Local mock image producer

`apps/api/src/images/mock-image-producer.ts` defines
`generateMockImagePng(seed: string): Buffer`, a deterministic, local,
network-free stand-in for a real image-generation provider:

- Produces a tiny (8×8 px) valid PNG — a solid color swatch, not artwork.
- The fill color is derived from an FNV-1a hash of `seed`, so different seeds
  produce different (but stable) colors, and the same seed always produces
  byte-identical output.
- Built entirely from Node's built-in `zlib` (`deflateSync`, required for
  PNG's DEFLATE-compressed `IDAT` chunk) plus hand-rolled PNG chunk/CRC
  framing — no new dependencies, no external assets, no network calls.
- PNG was chosen over JPEG/SVG because it's simplest to construct correctly
  by hand (an uncompressed-per-pixel raster plus one deflate call), and
  PDFKit's `doc.image()` embeds it directly.

`AgentService.startBookGeneration` calls a private
`generateAndSaveImageAssets` helper right after building
`imageGenerationResult` and before building `bookLayout`: for every
`GeneratedImageEntry`, it calls the injected `ImageGenerationProvider`
(`apps/api/src/images/image-generation-provider.ts` — see
`apps/api/docs/local-generation-pipeline.md` for the full boundary contract)
to get bytes, then saves them via
`ImageAssetStorage.saveImageAsset(imageAssetKey(bookId, entry.kind,
entry.pageNumber), buffer, contentType)`. The default `MockImageGenerationProvider`
wraps `generateMockImagePng(entry.seed)`, so its output is byte-identical to
before this boundary existed. Saves run in parallel and each is wrapped in
its own try/catch: a failure logs a warning (`Failed to save mock image
asset for entry "<id>": <message>`) and is skipped — it never fails book
generation. Because `buildImageBufferResolver` already treats a missing
asset as "no bytes available", a skipped save degrades that one image to the
existing placeholder rectangle. A `generateImage` failure from the provider
itself (as opposed to a storage-save failure) is treated more strictly —
see "Failure behavior" in `local-generation-pipeline.md`.

`generateMockImagePng` itself is explicitly **not** real AI image
generation — it exists so the pipeline has *some* real, embeddable image
bytes to prove the storage → resolver → renderer path end-to-end. A real
`OpenAIImageGenerationProvider` (behind the same `ImageGenerationProvider`
interface) also exists and is used when `IMAGE_GENERATION_PROVIDER_TOKEN=openai`
is explicitly set — see `local-generation-pipeline.md`. No changes to
`buildImageBufferResolver` or the renderer were needed to add it.

### Image asset storage boundary

`apps/api/src/images/image-asset-storage.ts` defines `ImageAssetStorage`, a
key/value byte store for generated image assets, independent of the PDF
renderer and of `PdfStorage`. Two implementations exist, selected via
`IMAGE_STORAGE_DRIVER` (`local` default | `s3` | `r2`) through
`createImageAssetStorage`:

- `LocalImageAssetStorage` — writes bytes under
  `<api-root>/tmp/images/<key>.<ext>` (ext derived from `contentType`:
  `image/png` → `.png`, `image/jpeg` → `.jpg`, `image/svg+xml` → `.svg`).
- `CloudImageAssetStorage` — an S3-compatible driver (AWS S3 or Cloudflare
  R2), mirroring `CloudPdfStorage` and reusing the same `PDF_STORAGE_*`
  bucket/credential env vars (image assets live alongside PDF previews in
  the same bucket, under an `images/` prefix, so no separate credentials are
  needed). Registered the same way as the local driver, via
  `IMAGE_ASSET_STORAGE_TOKEN` in `books.module.ts`.

Both implementations share the same interface:

- `saveImageAsset(key, buffer, contentType)` — persists bytes.
- `getImageAsset(key)` — reads bytes back by key, returning `undefined` if
  nothing was saved for it (or, for the cloud driver, on a not-found
  response from the object store).
- Keys are `"/"`-separated segments (e.g. `"<bookId>/cover"`); every segment
  must match `^[\w-]+$` or the call throws — this rejects path traversal
  (`../`, absolute paths, backslashes) before touching the filesystem or
  building a cloud object key.
- `imageAssetKey(bookId, kind, pageNumber?)` builds the stable key for a
  book's cover / page / back-cover slot, matching the same identity already
  used for `GeneratedImageEntry.id` (`<bookId>-cover`, `<bookId>-page-<n>`,
  `<bookId>-back-cover`).
- `buildImageBufferResolver(storage, bookId, entries)` pre-resolves every
  layout entry's bytes from storage (async, before rendering starts) into a
  `Map`, then returns a synchronous `ImageBufferResolver` closure over that
  map — bridging the necessarily-async storage read to the renderer's
  necessarily-synchronous embedding seam. This works identically regardless
  of which driver is configured, since both implement the same interface.

Out of scope for this boundary, deliberately:

- AI/image generation of any kind.
- Fetching remote URLs.
- Publicly serving saved image assets over HTTP.

### Real-image phase

`AgentService` gets image bytes from the injected `ImageGenerationProvider`
(`apps/api/src/images/image-generation-provider.ts`) and saves them via
`ImageAssetStorage.saveImageAsset`, keyed by `imageAssetKey`. The default
`MockImageGenerationProvider` wraps `generateMockImagePng`; a real
`OpenAIImageGenerationProvider` is selected via
`IMAGE_GENERATION_PROVIDER_TOKEN=openai` (see
`local-generation-pipeline.md` for the full boundary contract). No changes
to `buildImageBufferResolver` or the renderer itself were needed — the
boundary was already in place end-to-end; saved bytes are picked up and
embedded automatically on the next render.

### Failure handling

If a resolver returns a `Buffer` but PDFKit fails to parse/embed it (e.g.
corrupt or unsupported image bytes), the renderer logs a warning
(`[pdf-renderer] Failed to embed image for entry "<id>" (<kind>): <message>`)
and falls back to the placeholder rectangle for that image only — it does not
fail the whole page or PDF. A malformed layout box (a structural layout bug,
not an image-bytes problem) still fails the whole page, as before, and is
caught by the existing per-entry try/catch that renders a red error page.
