import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  CopyObjectCommand,
} from '@aws-sdk/client-s3';
import type { BookLayoutEntry } from '@book/types';
import type { ImageBufferResolver } from '../pdf/pdf-renderer';
import { readCloudConfig, type CloudPdfStorageConfig } from '../pdf/pdf-storage';
import {
  claimArtifactBasePath,
  type ClaimArtifactNamespace,
  type GenerationArtifactNamespace,
} from '../agent/generation-artifact-namespace';

const TMP_ROOT = resolve(__dirname, '..', '..', 'tmp');

export type ImageAssetContentType = 'image/png' | 'image/jpeg' | 'image/svg+xml' | 'image/webp';

const CONTENT_TYPE_EXTENSIONS: Record<ImageAssetContentType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
};

export interface ImageAssetRef {
  key: string;
  path: string;
  contentType: ImageAssetContentType;
}

/**
 * Local-first boundary for storing/reading generated image bytes by a stable
 * key. Mirrors the PdfStorage boundary (see ../pdf/pdf-storage.ts) so a
 * cloud-backed implementation can be added later without touching callers.
 */
export interface ImageAssetStorage {
  saveImageAsset(
    key: string,
    buffer: Buffer,
    contentType: ImageAssetContentType,
  ): Promise<ImageAssetRef>;
  getImageAsset(key: string): Promise<Buffer | undefined>;
  /**
   * Server-/filesystem-native copy of an already-saved asset to a new key,
   * without the API process ever holding the full bytes in memory purely to
   * relay them. Added in Phase B, Slice B2 for the future copy-forward retry
   * algorithm (not wired to any caller yet — see claimImageAssetKey's doc
   * comment); every driver must resolve `undefined` only for a genuinely
   * missing source and let every other failure (validation, permission,
   * network, malformed metadata) propagate.
   */
  copyImageAsset(sourceKey: string, destinationKey: string): Promise<ImageAssetRef | undefined>;
}

export const IMAGE_ASSET_STORAGE_TOKEN = 'IMAGE_ASSET_STORAGE';

/**
 * Keys are joined into filesystem paths, so every "/"-separated segment must
 * be a safe, traversal-free path component (e.g. "<bookId>/cover").
 */
function validateImageAssetKey(key: string): string[] {
  const segments = key.split('/');
  if (segments.length === 0 || segments.some((segment) => !/^[\w-]+$/.test(segment))) {
    throw new Error(`Invalid image asset key: "${key}"`);
  }
  return segments;
}

function extensionFor(contentType: ImageAssetContentType): string {
  const ext = CONTENT_TYPE_EXTENSIONS[contentType];
  if (!ext) {
    throw new Error(`Unsupported image content type: "${contentType}"`);
  }
  return ext;
}

/**
 * Local filesystem implementation.
 * Output path: <api-root>/tmp/images/<key segments...>.<ext for contentType>
 *
 * getImageAsset does not know the contentType a key was saved with, so it
 * probes the small fixed set of supported extensions. This is fine at our
 * scale (three formats) and keeps the read side key-only, matching the
 * "read them back by stable key/id" requirement.
 */
export class LocalImageAssetStorage implements ImageAssetStorage {
  async saveImageAsset(
    key: string,
    buffer: Buffer,
    contentType: ImageAssetContentType,
  ): Promise<ImageAssetRef> {
    const segments = validateImageAssetKey(key);
    const ext = extensionFor(contentType);
    const dir = join(TMP_ROOT, 'images', ...segments.slice(0, -1));
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${segments[segments.length - 1]}.${ext}`);
    await writeFile(path, buffer);
    return { key, path, contentType };
  }

  async getImageAsset(key: string): Promise<Buffer | undefined> {
    const segments = validateImageAssetKey(key);
    const dir = join(TMP_ROOT, 'images', ...segments.slice(0, -1));
    const base = segments[segments.length - 1]!;
    for (const ext of Object.values(CONTENT_TYPE_EXTENSIONS)) {
      const path = join(dir, `${base}.${ext}`);
      if (existsSync(path)) {
        return readFile(path);
      }
    }
    return undefined;
  }

  /**
   * Locates the source by the same fixed-extension probe getImageAsset uses,
   * then hands the copy to fs.copyFile (an OS-level copy, not a
   * read-into-memory-then-write) rather than reading the source into a Buffer.
   */
  async copyImageAsset(
    sourceKey: string,
    destinationKey: string,
  ): Promise<ImageAssetRef | undefined> {
    const sourceSegments = validateImageAssetKey(sourceKey);
    const destinationSegments = validateImageAssetKey(destinationKey);

    const sourceDir = join(TMP_ROOT, 'images', ...sourceSegments.slice(0, -1));
    const sourceBase = sourceSegments[sourceSegments.length - 1]!;
    const found = (
      Object.entries(CONTENT_TYPE_EXTENSIONS) as [ImageAssetContentType, string][]
    ).find(([, ext]) => existsSync(join(sourceDir, `${sourceBase}.${ext}`)));
    if (!found) return undefined;
    const [contentType, ext] = found;
    const sourcePath = join(sourceDir, `${sourceBase}.${ext}`);

    const destinationDir = join(TMP_ROOT, 'images', ...destinationSegments.slice(0, -1));
    const destinationPath = join(
      destinationDir,
      `${destinationSegments[destinationSegments.length - 1]}.${ext}`,
    );

    // Same logical key: nothing to copy, and fs.copyFile(path, path) is
    // unsafe/driver-defined behavior rather than a guaranteed no-op.
    if (sourcePath === destinationPath) {
      return { key: destinationKey, path: destinationPath, contentType };
    }

    await mkdir(destinationDir, { recursive: true });
    await copyFile(sourcePath, destinationPath);
    return { key: destinationKey, path: destinationPath, contentType };
  }
}

/** True for the S3-shaped "object not found" errors returned by GetObject. */
function isNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: unknown }).name;
  if (name === 'NoSuchKey' || name === 'NotFound') return true;
  const statusCode = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return statusCode === 404;
}

/** GetObject's Body is a Node.js Readable augmented with SDK helpers; normalize to a Buffer. */
async function bodyToBuffer(body: unknown): Promise<Buffer> {
  const withByteArray = body as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof withByteArray.transformToByteArray === 'function') {
    return Buffer.from(await withByteArray.transformToByteArray());
  }
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer | Uint8Array>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Cloud object key for a saved image asset: images/<key>.<ext for contentType>,
 * e.g. "images/book-1/cover.png". Mirrors PdfStorage's objectKey naming style
 * (see ../pdf/pdf-storage.ts).
 */
export function imageObjectKey(key: string, contentType: ImageAssetContentType): string {
  const segments = validateImageAssetKey(key);
  return `images/${segments.join('/')}.${extensionFor(contentType)}`;
}

/**
 * S3's CopySource header is "<bucket>/<key>", where the key portion must be
 * URL-encoded but the "/" segment separators must survive encoding — encoding
 * the whole string with a single encodeURIComponent would turn every "/" in a
 * multi-segment key into "%2F" and point CopyObjectCommand at a key that does
 * not exist. Encode each segment independently instead.
 */
function encodeCopySource(bucket: string, key: string): string {
  return `${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * S3-compatible object storage driver (AWS S3 or Cloudflare R2), mirroring
 * CloudPdfStorage (see ../pdf/pdf-storage.ts). Reuses the same PDF_STORAGE_*
 * credentials/bucket as CloudPdfStorage — image assets live alongside PDF
 * previews in the same bucket under an "images/" prefix instead of a
 * dedicated bucket, so no new credential env vars are needed.
 *
 * getImageAsset only has a key, not the contentType it was saved with, so it
 * probes the same fixed set of supported extensions LocalImageAssetStorage
 * does, issuing one GetObject per candidate until one succeeds.
 */
export class CloudImageAssetStorage implements ImageAssetStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: CloudPdfStorageConfig) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      region: config.region,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      forcePathStyle: config.forcePathStyle ?? Boolean(config.endpoint),
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async saveImageAsset(
    key: string,
    buffer: Buffer,
    contentType: ImageAssetContentType,
  ): Promise<ImageAssetRef> {
    const cloudKey = imageObjectKey(key, contentType);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: cloudKey,
        Body: buffer,
        ContentType: contentType,
      }),
    );
    return { key, path: cloudKey, contentType };
  }

  async getImageAsset(key: string): Promise<Buffer | undefined> {
    const segments = validateImageAssetKey(key);
    for (const ext of Object.values(CONTENT_TYPE_EXTENSIONS)) {
      const cloudKey = `images/${segments.join('/')}.${ext}`;
      try {
        const result = await this.client.send(
          new GetObjectCommand({ Bucket: this.bucket, Key: cloudKey }),
        );
        return await bodyToBuffer(result.Body);
      } catch (err) {
        if (isNotFoundError(err)) continue;
        throw err;
      }
    }
    return undefined;
  }

  /**
   * Locates the source with HeadObjectCommand (metadata only, no body) probed
   * across the same fixed extension set getImageAsset reads, then issues a
   * server-side CopyObjectCommand — the object's bytes never transit this
   * process, unlike a GetObject-then-PutObject relay.
   */
  async copyImageAsset(
    sourceKey: string,
    destinationKey: string,
  ): Promise<ImageAssetRef | undefined> {
    const sourceSegments = validateImageAssetKey(sourceKey);
    validateImageAssetKey(destinationKey);

    let sourceCloudKey: string | undefined;
    let contentType: ImageAssetContentType | undefined;
    for (const [candidateType, ext] of Object.entries(CONTENT_TYPE_EXTENSIONS) as [
      ImageAssetContentType,
      string,
    ][]) {
      const candidateKey = `images/${sourceSegments.join('/')}.${ext}`;
      let head;
      try {
        head = await this.client.send(
          new HeadObjectCommand({ Bucket: this.bucket, Key: candidateKey }),
        );
      } catch (err) {
        if (isNotFoundError(err)) continue;
        throw err;
      }
      if (head.ContentType !== candidateType) {
        throw new Error(
          `Cannot copy image asset "${sourceKey}": object at "${candidateKey}" has ` +
            `${head.ContentType ? `unexpected content-type metadata "${head.ContentType}"` : 'missing content-type metadata'} ` +
            `(expected "${candidateType}").`,
        );
      }
      sourceCloudKey = candidateKey;
      contentType = candidateType;
      break;
    }
    if (!sourceCloudKey || !contentType) return undefined;

    const destinationCloudKey = imageObjectKey(destinationKey, contentType);
    if (sourceCloudKey !== destinationCloudKey) {
      // Same-key CopyObjectCommand without MetadataDirective: 'REPLACE' is
      // rejected by S3 ("copy request is illegal... without changing the
      // object's metadata") — the identical-key case is handled explicitly
      // above instead of relying on that error.
      await this.client.send(
        new CopyObjectCommand({
          Bucket: this.bucket,
          CopySource: encodeCopySource(this.bucket, sourceCloudKey),
          Key: destinationCloudKey,
        }),
      );
    }
    return { key: destinationKey, path: destinationCloudKey, contentType };
  }
}

/**
 * Returns the configured ImageAssetStorage implementation.
 * Supported drivers: local (default), s3, r2.
 * s3/r2 reuse the PDF_STORAGE_* credential env vars (see readCloudConfig in
 * ../pdf/pdf-storage.ts) — only the driver selection is separate
 * (IMAGE_STORAGE_DRIVER), so PDF previews and image assets can independently
 * opt into cloud storage without duplicating bucket/credential config.
 */
export function createImageAssetStorage(
  driver = 'local',
  env: NodeJS.ProcessEnv = process.env,
): ImageAssetStorage {
  if (driver === 'local') return new LocalImageAssetStorage();
  if (driver === 's3' || driver === 'r2') {
    return new CloudImageAssetStorage(readCloudConfig(driver, env, 'IMAGE_STORAGE_DRIVER'));
  }
  throw new Error(
    `IMAGE_STORAGE_DRIVER "${driver}" is not implemented yet. Supported drivers: local, s3, r2`,
  );
}

/**
 * Stable image asset key for a book's cover / page / back-cover slot, matching
 * the identity already used for GeneratedImageEntry.id in agent.service.ts
 * (`<bookId>-cover`, `<bookId>-page-<n>`, `<bookId>-back-cover`), just with
 * "/" separators so it validates as a safe two-segment storage key.
 */
export function imageAssetKey(
  bookId: string,
  kind: 'cover' | 'page' | 'back_cover',
  pageNumber?: number,
): string {
  if (kind === 'page') {
    if (pageNumber == null) {
      throw new Error('pageNumber is required to build an image asset key for kind "page"');
    }
    return `${bookId}/page-${pageNumber}`;
  }
  return `${bookId}/${kind === 'back_cover' ? 'back-cover' : kind}`;
}

/**
 * Versioned image asset key for a book's uploaded child reference photo.
 * `version` must be a fresh, unique value per upload (BooksService.
 * uploadChildPhoto mints a randomUUID()) rather than a fixed suffix — a
 * GenerationInputSnapshot freezes a specific version's key, so re-uploading a
 * photo must never overwrite bytes an already-created (or in-flight) run may
 * still reference. Stored and read through the same local/cloud
 * ImageAssetStorage driver as generated illustrations (local dev path:
 * tmp/images/<bookId>/child-photo-<version>.*, never served over HTTP).
 */
export function childPhotoAssetKey(bookId: string, version: string): string {
  return `${bookId}/child-photo-${version}`;
}

/** Stable image asset key for a book's generated character-sheet reference image. Not part of BookLayoutEntry — never rendered as its own PDF page. */
export function characterSheetAssetKey(bookId: string): string {
  return `${bookId}/character-sheet`;
}

const VALID_IMAGE_ASSET_KIND_SLUGS: Record<'cover' | 'page' | 'back_cover', string> = {
  cover: 'cover',
  page: 'page',
  back_cover: 'back-cover',
};

/**
 * Claim-scoped counterpart to imageAssetKey (Phase B, Slice B1 — see
 * generation-artifact-namespace.ts). Not yet used by any production write or
 * read path: AgentService/classifyImageAssets still call the positional
 * imageAssetKey above, and this slice does not change that. Embeds the
 * claiming run's exact (runId, fencingVersion), not just runId, so two
 * different deliveries of the same GenerationRun (e.g. a stalled-job
 * redelivery — see GenerationRunService.claim) can never compute the same
 * key.
 */
export function claimImageAssetKey(
  bookId: string,
  namespace: ClaimArtifactNamespace,
  kind: 'cover' | 'page' | 'back_cover',
  pageNumber?: number,
): string {
  const slug = VALID_IMAGE_ASSET_KIND_SLUGS[kind];
  if (!slug) {
    throw new Error(`Invalid image asset kind for claim-scoped key: "${String(kind)}"`);
  }
  if (kind === 'page') {
    if (!Number.isInteger(pageNumber) || (pageNumber as number) <= 0) {
      throw new Error(
        `A positive integer pageNumber is required to build a claim-scoped image asset key for kind "page" (got ${pageNumber})`,
      );
    }
    return `${claimArtifactBasePath(bookId, namespace)}/page-${pageNumber}`;
  }
  return `${claimArtifactBasePath(bookId, namespace)}/${slug}`;
}

/** Claim-scoped counterpart to characterSheetAssetKey (Phase B, Slice B1). Not yet used by any production write or read path — see claimImageAssetKey's doc comment. */
export function claimCharacterSheetAssetKey(
  bookId: string,
  namespace: ClaimArtifactNamespace,
): string {
  return `${claimArtifactBasePath(bookId, namespace)}/character-sheet`;
}

/**
 * Resolves the right image-asset key for *any* resolved
 * GenerationArtifactNamespace — legacy or claim — without the caller having
 * to branch on `namespace.kind` itself. Phase B, Slice B3's copy-forward
 * algorithm uses this to compute a *source* key (which may legitimately be
 * legacy, a prior claim of the same run, or a different run entirely) — the
 * *current* key a claim is writing to is always built directly via
 * claimImageAssetKey, since AgentService always executes as a claim, never
 * as 'legacy'.
 */
export function imageKeyForNamespace(
  bookId: string,
  namespace: GenerationArtifactNamespace,
  kind: 'cover' | 'page' | 'back_cover',
  pageNumber?: number,
): string {
  return namespace.kind === 'legacy'
    ? imageAssetKey(bookId, kind, pageNumber)
    : claimImageAssetKey(bookId, namespace, kind, pageNumber);
}

/** Character-sheet counterpart to imageKeyForNamespace — see its doc comment. */
export function characterSheetKeyForNamespace(
  bookId: string,
  namespace: GenerationArtifactNamespace,
): string {
  return namespace.kind === 'legacy'
    ? characterSheetAssetKey(bookId)
    : claimCharacterSheetAssetKey(bookId, namespace);
}

/**
 * Pre-resolves every layout entry's image bytes from storage (if any were
 * saved) into a Map, then returns a synchronous ImageBufferResolver over that
 * Map. renderStorybookPdf's resolveImageBuffer seam is intentionally
 * synchronous (see pdf-renderer.ts), so all async storage reads must happen
 * up front — this is that bridge.
 *
 * AgentService.startBookGeneration saves real bytes for every generated
 * image entry (via the injected ImageGenerationProvider) before calling this
 * — see docs/pdf-rendering.md — so the normal book-generation path resolves
 * real bytes here, not placeholders. A per-entry lookup still misses (and
 * that entry falls back to the placeholder rectangle) when a save was
 * skipped after a provider/storage failure, or when this is called against
 * storage nothing was ever saved to (e.g. the standalone `pnpm render:pdf`
 * sample script, which renders a hardcoded layout without going through
 * AgentService or ImageAssetStorage at all).
 *
 * Phase B, Slice B3: reads exclusively from `namespace`, the claim currently
 * executing — never a source/prior namespace. Copy-forward (see
 * generation-claim-artifacts.ts) already made the current claim
 * self-contained before this is called, so the PDF renderer must never
 * cross-reference a source claim's bytes directly.
 */
export async function buildImageBufferResolver(
  storage: ImageAssetStorage,
  bookId: string,
  entries: readonly BookLayoutEntry[],
  namespace: ClaimArtifactNamespace,
): Promise<ImageBufferResolver> {
  const buffers = new Map<string, Buffer>();

  await Promise.all(
    entries
      .filter((entry) => entry.imageBlock)
      .map(async (entry) => {
        const key = claimImageAssetKey(bookId, namespace, entry.kind, entry.pageNumber);
        const buffer = await storage.getImageAsset(key);
        if (buffer) buffers.set(entry.id, buffer);
      }),
  );

  return (_imageBlock, entry) => buffers.get(entry.id);
}
