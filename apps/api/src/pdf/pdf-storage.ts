import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';

const TMP_ROOT = resolve(__dirname, '..', '..', 'tmp');

/**
 * Storage boundary for generated PDF previews. Every driver (local disk today;
 * S3/R2 later) implements this contract so callers (BooksService, controllers)
 * never branch on which backend is active.
 */
export interface PdfStorage {
  savePreviewPdf(bookId: string, buffer: Buffer): Promise<{ url: string; path?: string }>;
  getPreviewPdf(bookId: string): Promise<{
    buffer: Buffer;
    contentType: 'application/pdf';
    filename: string;
  } | null>;
  /** Cheap existence check that avoids reading the file into memory. */
  previewPdfExists(bookId: string): Promise<boolean>;
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
 * Served at:   /files/books/<bookId>/storybook.pdf
 */
export class LocalPdfStorage implements PdfStorage {
  async savePreviewPdf(bookId: string, buffer: Buffer): Promise<{ url: string; path?: string }> {
    validateBookId(bookId);
    const dir = join(TMP_ROOT, 'books', bookId);
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'storybook.pdf');
    await writeFile(path, buffer);
    return { url: `/files/books/${bookId}/storybook.pdf`, path };
  }

  async getPreviewPdf(bookId: string): Promise<{
    buffer: Buffer;
    contentType: 'application/pdf';
    filename: string;
  } | null> {
    validateBookId(bookId);
    const path = join(TMP_ROOT, 'books', bookId, 'storybook.pdf');
    if (!existsSync(path)) return null;
    const buffer = await readFile(path);
    return { buffer, contentType: 'application/pdf', filename: `storyme-preview-${bookId}.pdf` };
  }

  async previewPdfExists(bookId: string): Promise<boolean> {
    validateBookId(bookId);
    const path = join(TMP_ROOT, 'books', bookId, 'storybook.pdf');
    return existsSync(path);
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

  async savePreviewPdf(bookId: string, buffer: Buffer): Promise<{ url: string; path?: string }> {
    validateBookId(bookId);
    const key = objectKey(bookId);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: 'application/pdf',
      }),
    );
    return { url: key };
  }

  async getPreviewPdf(bookId: string): Promise<{
    buffer: Buffer;
    contentType: 'application/pdf';
    filename: string;
  } | null> {
    validateBookId(bookId);
    const key = objectKey(bookId);
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      const buffer = await bodyToBuffer(result.Body);
      return { buffer, contentType: 'application/pdf', filename: `storyme-preview-${bookId}.pdf` };
    } catch (err) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
  }

  async previewPdfExists(bookId: string): Promise<boolean> {
    validateBookId(bookId);
    const key = objectKey(bookId);
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (err) {
      if (isNotFoundError(err)) return false;
      throw err;
    }
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
