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

## Font / Unicode support

`resolveFont` maps every layout font family to one embedded Unicode font,
**Noto Sans** (regular + bold), instead of PDFKit's built-in
`Helvetica`/`Times-Roman` fonts. The built-ins only support the **WinAnsi
encoding** (roughly Latin-1) — Cyrillic, Greek, and Latin-Extended
(diacritics) all fall outside that range and previously rendered as blank
glyphs or mojibake. Noto Sans covers Latin, Cyrillic, and Greek, so `en`,
`ru`, and `pl` book text (`SupportedLanguage` in
`packages/types/src/book.types.ts`) all render correctly today.

### Font asset & licensing

- Files: `apps/api/assets/fonts/NotoSans-Regular.ttf`,
  `NotoSans-Bold.ttf`, and `OFL.txt` (the license text).
- Source: [notofonts/noto-fonts](https://github.com/notofonts/noto-fonts),
  `hinted/ttf/NotoSans/`.
- License: SIL Open Font License 1.1 — free to embed and redistribute
  (including in a PDF's font program) without a separate license purchase;
  see `apps/api/assets/fonts/OFL.txt` for the full text.
- Registration: `registerFonts(doc)` in `pdf-renderer.ts` calls
  `doc.registerFont(name, fontPath)` once per document, for both weights,
  before any page is drawn. `resolveFont` then returns `'NotoSans'` or
  `'NotoSans-Bold'` for every layout font family — there is no per-family
  built-in-font mapping anymore.
- Paths are resolved via `path.join(__dirname, '..', '..', 'assets', 'fonts', ...)`,
  which lands on `apps/api/assets/fonts/` whether running compiled
  (`dist/pdf/pdf-renderer.js`) or via `ts-node` (`src/pdf/pdf-renderer.ts`) —
  both sit two directories below `apps/api/`. This is a repo-relative path,
  not an OS font path, so it works identically in local dev and in the
  Railway/Docker production runtime (the `assets/` directory is explicitly
  `COPY`'d into the runtime image in `apps/api/Dockerfile`, alongside
  `dist/`, `node_modules/`, and `prisma/`).
- Do not add other fonts, download fonts at runtime, or depend on fonts
  installed on the host system — rendering must stay deterministic and
  network-free.

## Images

Covers image handling in `renderStorybookPdf` / `renderImageBlock` in
`apps/api/src/pdf/pdf-renderer.ts`.

### The embedding boundary

`renderStorybookPdf(layout, options?)` accepts an optional
`options.resolveImageBuffer: (imageBlock, entry) => Buffer | undefined`. This
is the _only_ way the renderer ever gets image bytes:

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
now _does_ save real image bytes for every generated image entry before
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
generation — it exists so the pipeline has _some_ real, embeddable image
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

This renderer-level placeholder fallback is still exercised directly by
`pdf-renderer.spec.ts` and by the standalone `pnpm render:pdf` sample script
(neither goes through `AgentService`). **The real book-generation path no
longer reaches it**: `AgentService.startBookGeneration` calls
`assertAllImagesResolved` (in `agent.service.ts`) right before
`renderStorybookPdf`, which resolves every layout entry's image bytes via the
same `resolveImageBuffer` the renderer would use and throws a single clear
error naming every page still missing bytes — whether that's because
`MAX_GENERATED_IMAGES_PER_BOOK` capped it, the real provider failed for it, or
the save to `ImageAssetStorage` failed. The book is then marked `failed` at
the `pdf_render` step instead of silently completing with a placeholder
rectangle labelled with the page's `altText` (e.g. "Page 2 illustration").
