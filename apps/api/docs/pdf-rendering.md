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
only for display/metadata (see the local image asset boundary below for the
real embedding path).

`AgentService.startBookGeneration` *does* now call `renderStorybookPdf` with
a `resolveImageBuffer` option (via `buildImageBufferResolver`, see below).
Because the local-mock pipeline never saves real image bytes anywhere, every
lookup that resolver performs misses, so every image still renders as a
placeholder rectangle in practice — identical output to before this phase.
The wiring exists so a future phase that actually saves bytes needs no
changes to `AgentService` or the renderer, only a real image-generation step
that calls `ImageAssetStorage.saveImageAsset`.

### Local image asset storage boundary

`apps/api/src/images/image-asset-storage.ts` defines `ImageAssetStorage`, a
local-first key/value byte store for generated image assets, independent of
the PDF renderer and of `PdfStorage`:

- `saveImageAsset(key, buffer, contentType)` — writes bytes under
  `<api-root>/tmp/images/<key>.<ext>` (ext derived from `contentType`:
  `image/png` → `.png`, `image/jpeg` → `.jpg`, `image/svg+xml` → `.svg`).
- `getImageAsset(key)` — reads bytes back by key, returning `undefined` if
  nothing was saved for it.
- Keys are `"/"`-separated segments (e.g. `"<bookId>/cover"`); every segment
  must match `^[\w-]+$` or the call throws — this rejects path traversal
  (`../`, absolute paths, backslashes) before touching the filesystem.
- `LocalImageAssetStorage` is the only implementation today, registered via
  `IMAGE_ASSET_STORAGE_TOKEN` in `books.module.ts`, mirroring the
  `PdfStorage` / `PDF_STORAGE_TOKEN` pattern so a cloud-backed implementation
  can be added later without changing callers.
- `imageAssetKey(bookId, kind, pageNumber?)` builds the stable key for a
  book's cover / page / back-cover slot, matching the same identity already
  used for `GeneratedImageEntry.id` (`<bookId>-cover`, `<bookId>-page-<n>`,
  `<bookId>-back-cover`).
- `buildImageBufferResolver(storage, bookId, entries)` pre-resolves every
  layout entry's bytes from storage (async, before rendering starts) into a
  `Map`, then returns a synchronous `ImageBufferResolver` closure over that
  map — bridging the necessarily-async storage read to the renderer's
  necessarily-synchronous embedding seam.

Out of scope for this boundary, deliberately:

- AI/image generation of any kind.
- Fetching remote URLs.
- Cloud image storage (S3/R2) — `ImageAssetStorage` is local-only today; a
  cloud implementation would follow the same pattern as `CloudPdfStorage`.
- Publicly serving saved image assets over HTTP.

### Future real-image phase (not implemented)

A future phase that wires up real image generation should call
`ImageAssetStorage.saveImageAsset` with the key produced by `imageAssetKey`
for each generated image, right after generating it. No changes to
`AgentService`'s rendering call, `buildImageBufferResolver`, or the renderer
itself are needed — the boundary is already in place end-to-end; saved bytes
will be picked up and embedded automatically on the next render.

### Failure handling

If a resolver returns a `Buffer` but PDFKit fails to parse/embed it (e.g.
corrupt or unsupported image bytes), the renderer logs a warning
(`[pdf-renderer] Failed to embed image for entry "<id>" (<kind>): <message>`)
and falls back to the placeholder rectangle for that image only — it does not
fail the whole page or PDF. A malformed layout box (a structural layout bug,
not an image-bytes problem) still fails the whole page, as before, and is
caught by the existing per-entry try/catch that renders a red error page.
