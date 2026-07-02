import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { BookLayoutEntry } from '@book/types';
import type { ImageBufferResolver } from '../pdf/pdf-renderer';

const TMP_ROOT = resolve(__dirname, '..', '..', 'tmp');

export type ImageAssetContentType = 'image/png' | 'image/jpeg' | 'image/svg+xml';

const CONTENT_TYPE_EXTENSIONS: Record<ImageAssetContentType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/svg+xml': 'svg',
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
 * Pre-resolves every layout entry's image bytes from local storage (if any
 * were saved) into a Map, then returns a synchronous ImageBufferResolver over
 * that Map. renderStorybookPdf's resolveImageBuffer seam is intentionally
 * synchronous (see pdf-renderer.ts), so all async storage reads must happen
 * up front — this is that bridge.
 *
 * When nothing has been saved (the current pipeline never saves real image
 * bytes yet — see docs/pdf-rendering.md), every lookup misses and the
 * returned resolver behaves exactly like passing no resolver at all.
 */
export async function buildImageBufferResolver(
  storage: ImageAssetStorage,
  bookId: string,
  entries: readonly BookLayoutEntry[],
): Promise<ImageBufferResolver> {
  const buffers = new Map<string, Buffer>();

  await Promise.all(
    entries
      .filter((entry) => entry.imageBlock)
      .map(async (entry) => {
        const key = imageAssetKey(bookId, entry.kind, entry.pageNumber);
        const buffer = await storage.getImageAsset(key);
        if (buffer) buffers.set(entry.id, buffer);
      }),
  );

  return (_imageBlock, entry) => buffers.get(entry.id);
}
