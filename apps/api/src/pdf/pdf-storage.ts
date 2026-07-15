import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import {
  claimArtifactBasePath,
  type ClaimArtifactNamespace,
} from '../agent/generation-artifact-namespace';

const TMP_ROOT = resolve(__dirname, '..', '..', 'tmp');

export interface PreviewPdfResult {
  buffer: Buffer;
  contentType: 'application/pdf';
  filename: string;
}

/**
 * Storage boundary for generated PDF previews. Every driver (local disk today;
 * S3/R2 later) implements this contract so callers (BooksService, controllers)
 * never branch on which backend is active.
 */
export interface PdfStorage {
  /** Which driver this instance is — surfaced read-only for diagnostics (never a secret/path). */
  readonly driver: 'local' | 's3' | 'r2';
  savePreviewPdf(bookId: string, buffer: Buffer): Promise<{ url: string; path?: string }>;
  getPreviewPdf(bookId: string): Promise<PreviewPdfResult | null>;
  /** Cheap existence check that avoids reading the file into memory. */
  previewPdfExists(bookId: string): Promise<boolean>;
  /**
   * Claim-scoped counterparts to the three legacy methods above (Phase B,
   * Slice B2 — see claimPreviewPdfKey below). Not yet called by any
   * production path: BooksService/GenerationRunCoordinator still read/write
   * only the legacy positional methods. Accepting `ClaimArtifactNamespace`
   * (never the legacy union) makes "no silent legacy fallback" a compile-time
   * guarantee for these three methods specifically.
   */
  saveClaimPreviewPdf(
    bookId: string,
    namespace: ClaimArtifactNamespace,
    buffer: Buffer,
  ): Promise<{ url: string; path?: string }>;
  getClaimPreviewPdf(
    bookId: string,
    namespace: ClaimArtifactNamespace,
  ): Promise<PreviewPdfResult | null>;
  claimPreviewPdfExists(bookId: string, namespace: ClaimArtifactNamespace): Promise<boolean>;
}

export const PDF_STORAGE_TOKEN = 'PDF_STORAGE';

/** bookId is embedded directly into filesystem paths, so it must never contain path separators or traversal sequences. */
function validateBookId(bookId: string): void {
  if (!/^[\w-]+$/.test(bookId)) {
    throw new Error(`Invalid bookId for PDF storage: "${bookId}"`);
  }
}

/**
 * Local filesystem implementation.
 * Output path: <api-root>/tmp/books/<bookId>/storybook.pdf
 * Not served as a static file — only readable via getPreviewPdf(), which
 * BooksService.getPreviewPdfBuffer() calls after an ownership check (see
 * GET /api/books/:id/pdf/preview). The `url` returned here is stored on
 * Book.previewPdfUrl purely as a "PDF exists" marker for BookDto/diagnostics;
 * it is not, and must not become, a fetchable HTTP route.
 */
export class LocalPdfStorage implements PdfStorage {
  readonly driver = 'local' as const;

  private legacyPath(bookId: string): string {
    return join(TMP_ROOT, 'books', bookId, 'storybook.pdf');
  }

  /** claimPreviewPdfKey already validates bookId + namespace before returning a key. */
  private claimPath(bookId: string, namespace: ClaimArtifactNamespace): string {
    return join(TMP_ROOT, ...claimPreviewPdfKey(bookId, namespace).split('/'));
  }

  private async writePdfFile(path: string, buffer: Buffer): Promise<{ path: string }> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, buffer);
    return { path };
  }

  private async readPdfFile(path: string, filename: string): Promise<PreviewPdfResult | null> {
    if (!existsSync(path)) return null;
    const buffer = await readFile(path);
    return { buffer, contentType: 'application/pdf', filename };
  }

  async savePreviewPdf(bookId: string, buffer: Buffer): Promise<{ url: string; path?: string }> {
    validateBookId(bookId);
    const { path } = await this.writePdfFile(this.legacyPath(bookId), buffer);
    return { url: `/files/books/${bookId}/storybook.pdf`, path };
  }

  async getPreviewPdf(bookId: string): Promise<PreviewPdfResult | null> {
    validateBookId(bookId);
    return this.readPdfFile(this.legacyPath(bookId), `storyme-preview-${bookId}.pdf`);
  }

  async previewPdfExists(bookId: string): Promise<boolean> {
    validateBookId(bookId);
    return existsSync(this.legacyPath(bookId));
  }

  async saveClaimPreviewPdf(
    bookId: string,
    namespace: ClaimArtifactNamespace,
    buffer: Buffer,
  ): Promise<{ url: string; path?: string }> {
    const key = claimPreviewPdfKey(bookId, namespace);
    const { path } = await this.writePdfFile(this.claimPath(bookId, namespace), buffer);
    return { url: `/files/${key}`, path };
  }

  async getClaimPreviewPdf(
    bookId: string,
    namespace: ClaimArtifactNamespace,
  ): Promise<PreviewPdfResult | null> {
    return this.readPdfFile(this.claimPath(bookId, namespace), `storyme-preview-${bookId}.pdf`);
  }

  async claimPreviewPdfExists(bookId: string, namespace: ClaimArtifactNamespace): Promise<boolean> {
    return existsSync(this.claimPath(bookId, namespace));
  }
}

export interface CloudPdfStorageConfig {
  driver: 's3' | 'r2';
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
}

export function objectKey(bookId: string): string {
  return `previews/${bookId}/storyme-preview-${bookId}.pdf`;
}

/**
 * Claim-scoped counterpart to objectKey (Phase B, Slice B1 — see
 * generation-artifact-namespace.ts). Not yet used by any production write or
 * read path: LocalPdfStorage/CloudPdfStorage still key purely by bookId, and
 * this slice does not change that. Embeds the claiming run's exact (runId,
 * fencingVersion), not just runId, so two different deliveries of the same
 * GenerationRun can never write to the same PDF object.
 */
export function claimPreviewPdfKey(bookId: string, namespace: ClaimArtifactNamespace): string {
  validateBookId(bookId);
  return `${claimArtifactBasePath(bookId, namespace)}/storyme-preview-${bookId}.pdf`;
}

/** True for the S3-shaped "object not found" errors returned by GetObject/HeadObject. */
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
 * S3-compatible object storage driver (AWS S3 or Cloudflare R2). Object layout:
 * previews/<bookId>/storyme-preview-<bookId>.pdf
 */
export class CloudPdfStorage implements PdfStorage {
  readonly driver: 's3' | 'r2';
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: CloudPdfStorageConfig) {
    this.driver = config.driver;
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

  private async putPdfObject(key: string, buffer: Buffer): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: 'application/pdf',
      }),
    );
  }

  private async getPdfObject(key: string, filename: string): Promise<PreviewPdfResult | null> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      const buffer = await bodyToBuffer(result.Body);
      return { buffer, contentType: 'application/pdf', filename };
    } catch (err) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
  }

  private async pdfObjectExists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (err) {
      if (isNotFoundError(err)) return false;
      throw err;
    }
  }

  async savePreviewPdf(bookId: string, buffer: Buffer): Promise<{ url: string; path?: string }> {
    validateBookId(bookId);
    const key = objectKey(bookId);
    await this.putPdfObject(key, buffer);
    return { url: key };
  }

  async getPreviewPdf(bookId: string): Promise<PreviewPdfResult | null> {
    validateBookId(bookId);
    return this.getPdfObject(objectKey(bookId), `storyme-preview-${bookId}.pdf`);
  }

  async previewPdfExists(bookId: string): Promise<boolean> {
    validateBookId(bookId);
    return this.pdfObjectExists(objectKey(bookId));
  }

  async saveClaimPreviewPdf(
    bookId: string,
    namespace: ClaimArtifactNamespace,
    buffer: Buffer,
  ): Promise<{ url: string; path?: string }> {
    const key = claimPreviewPdfKey(bookId, namespace);
    await this.putPdfObject(key, buffer);
    return { url: key };
  }

  async getClaimPreviewPdf(
    bookId: string,
    namespace: ClaimArtifactNamespace,
  ): Promise<PreviewPdfResult | null> {
    const key = claimPreviewPdfKey(bookId, namespace);
    return this.getPdfObject(key, `storyme-preview-${bookId}.pdf`);
  }

  async claimPreviewPdfExists(bookId: string, namespace: ClaimArtifactNamespace): Promise<boolean> {
    return this.pdfObjectExists(claimPreviewPdfKey(bookId, namespace));
  }
}

const CLOUD_REQUIRED_VARS = [
  'PDF_STORAGE_BUCKET',
  'PDF_STORAGE_REGION',
  'PDF_STORAGE_ACCESS_KEY_ID',
  'PDF_STORAGE_SECRET_ACCESS_KEY',
] as const;

/**
 * Reads and validates the PDF_STORAGE_* env vars required for the s3/r2
 * drivers. `driverEnvVarName` only affects error-message wording — pass
 * "IMAGE_STORAGE_DRIVER" when a caller reuses these same PDF_STORAGE_*
 * credentials for image asset storage (see ../images/image-asset-storage.ts)
 * so the error names the var the caller actually set.
 */
export function readCloudConfig(
  driver: 's3' | 'r2',
  env: NodeJS.ProcessEnv,
  driverEnvVarName = 'PDF_STORAGE_DRIVER',
): CloudPdfStorageConfig {
  const missing: string[] = CLOUD_REQUIRED_VARS.filter((key) => !env[key]);
  const endpoint = env['PDF_STORAGE_ENDPOINT'];
  // R2 has no default endpoint the SDK can infer, unlike S3.
  if (driver === 'r2' && !endpoint) missing.push('PDF_STORAGE_ENDPOINT');
  if (missing.length > 0) {
    throw new Error(
      `${driverEnvVarName} "${driver}" requires the following environment variable(s): ${missing.join(', ')}`,
    );
  }
  const forcePathStyleRaw = env['PDF_STORAGE_FORCE_PATH_STYLE'];
  return {
    driver,
    bucket: env['PDF_STORAGE_BUCKET']!,
    region: env['PDF_STORAGE_REGION']!,
    ...(endpoint ? { endpoint } : {}),
    accessKeyId: env['PDF_STORAGE_ACCESS_KEY_ID']!,
    secretAccessKey: env['PDF_STORAGE_SECRET_ACCESS_KEY']!,
    forcePathStyle: forcePathStyleRaw ? forcePathStyleRaw === 'true' : Boolean(endpoint),
  };
}

/**
 * Refuses to let the standalone generation-worker process (`apps/api/src/worker.ts`)
 * boot in production with `PDF_STORAGE_DRIVER=local`. The worker and the API
 * run as separate containers/processes on every recommended deploy target
 * (see `docs/deployment-readiness.md`), so a PDF `LocalPdfStorage` writes to
 * the worker's own filesystem is invisible to the API's — generation reports
 * `complete` (the write succeeded, locally), but every subsequent
 * preview/download request 404s with "PDF file not found in storage" because
 * the API's container never had the file. Call this before booting the
 * worker's Nest application context so the failure is a clear, immediate
 * boot error instead of a silent per-book 404 discovered later.
 */
export function assertPdfStorageSupportsWorker(env: NodeJS.ProcessEnv = process.env): void {
  const driver = env['PDF_STORAGE_DRIVER'] ?? 'local';
  if (env['NODE_ENV'] === 'production' && driver === 'local') {
    throw new Error(
      'PDF_STORAGE_DRIVER=local cannot be used by the generation worker in production: ' +
        'the worker and the API run as separate processes/containers on every recommended ' +
        'deploy target, so a PDF the worker saves to its own local filesystem is never visible ' +
        'to the API, and every preview/download request will 404. Set PDF_STORAGE_DRIVER=s3 or ' +
        '=r2 (plus PDF_STORAGE_BUCKET, PDF_STORAGE_REGION, PDF_STORAGE_ACCESS_KEY_ID, ' +
        'PDF_STORAGE_SECRET_ACCESS_KEY, and PDF_STORAGE_ENDPOINT for r2) on both the api and ' +
        'worker services — see docs/deployment-readiness.md.',
    );
  }
}

/**
 * Returns the configured PdfStorage implementation.
 * Supported drivers: local (default), s3, r2.
 */
export function createPdfStorage(
  driver = 'local',
  env: NodeJS.ProcessEnv = process.env,
): PdfStorage {
  if (driver === 'local') return new LocalPdfStorage();
  if (driver === 's3' || driver === 'r2') {
    return new CloudPdfStorage(readCloudConfig(driver, env));
  }
  throw new Error(
    `PDF_STORAGE_DRIVER "${driver}" is not implemented yet. Supported drivers: local, s3, r2`,
  );
}
