import { lstat, readdir, unlink } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { DeleteObjectsCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';

export interface BookArtifactDeletionResult {
  /** True only after a fresh verification finds no remaining scoped artifact. */
  readonly complete: boolean;
  readonly deletedCount: number;
  readonly remainingCount: number;
  readonly failureCount: number;
  /** Bounded operational code; never a raw provider message or storage key. */
  readonly errorCode: 'ARTIFACT_LIST_FAILED' | 'ARTIFACT_DELETE_FAILED' | null;
}

const SAFE_SEGMENT = /^[\w-]+$/;
const CLOUD_PAGE_SIZE = 1000;

function assertSafeSegments(segments: readonly string[]): void {
  if (segments.length === 0 || segments.some((segment) => !SAFE_SEGMENT.test(segment))) {
    throw new Error('Unsafe book artifact scope');
  }
}

/**
 * Deletes only regular files beneath exact, caller-owned book directories.
 * Symlinks/junctions are never followed or removed; they fail closed and keep
 * the result incomplete so an operator can inspect the storage anomaly.
 */
export async function deleteLocalBookArtifactRoots(
  root: string,
  relativeRoots: readonly (readonly string[])[],
): Promise<BookArtifactDeletionResult> {
  let deletedCount = 0;
  let failureCount = 0;
  const resolvedRoot = resolve(root) + sep;

  const walkAndDelete = async (segments: readonly string[]): Promise<void> => {
    assertSafeSegments(segments);
    const path = resolve(root, ...segments);
    if (!path.startsWith(resolvedRoot)) {
      failureCount += 1;
      return;
    }
    let stat;
    try {
      stat = await lstat(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') failureCount += 1;
      return;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      failureCount += 1;
      return;
    }
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      failureCount += 1;
      return;
    }
    for (const entry of entries) {
      if (!SAFE_SEGMENT.test(entry.name.replace(/\.[\w-]+$/, ''))) {
        failureCount += 1;
        continue;
      }
      const childSegments = [...segments, entry.name];
      const childPath = join(root, ...childSegments);
      if (entry.isSymbolicLink()) {
        failureCount += 1;
      } else if (entry.isDirectory()) {
        await walkAndDelete(childSegments);
      } else if (entry.isFile()) {
        try {
          const fresh = await lstat(childPath);
          if (!fresh.isFile() || fresh.isSymbolicLink()) {
            failureCount += 1;
            continue;
          }
          await unlink(childPath);
          deletedCount += 1;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') failureCount += 1;
        }
      } else {
        failureCount += 1;
      }
    }
  };

  for (const segments of relativeRoots) await walkAndDelete(segments);

  let remainingCount = 0;
  const countRemaining = async (segments: readonly string[]): Promise<void> => {
    const path = resolve(root, ...segments);
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') remainingCount += 1;
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await countRemaining([...segments, entry.name]);
      } else {
        remainingCount += 1;
      }
    }
  };
  for (const segments of relativeRoots) await countRemaining(segments);

  return {
    complete: failureCount === 0 && remainingCount === 0,
    deletedCount,
    remainingCount,
    failureCount,
    errorCode: failureCount > 0 ? 'ARTIFACT_DELETE_FAILED' : null,
  };
}

async function listCloudKeys(client: S3Client, bucket: string, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const result = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        MaxKeys: CLOUD_PAGE_SIZE,
        ContinuationToken: cursor,
      }),
    );
    keys.push(
      ...(result.Contents ?? [])
        .map((entry) => entry.Key)
        .filter((key): key is string => typeof key === 'string'),
    );
    cursor = result.IsTruncated ? result.NextContinuationToken : undefined;
  } while (cursor);
  return keys;
}

/** Deletes and then freshly re-lists every exact book prefix. */
export async function deleteCloudBookArtifactPrefixes(
  client: S3Client,
  bucket: string,
  prefixes: readonly string[],
): Promise<BookArtifactDeletionResult> {
  let keys: string[];
  try {
    keys = (
      await Promise.all(prefixes.map((prefix) => listCloudKeys(client, bucket, prefix)))
    ).flat();
  } catch {
    return {
      complete: false,
      deletedCount: 0,
      remainingCount: 1,
      failureCount: 1,
      errorCode: 'ARTIFACT_LIST_FAILED',
    };
  }

  let deletedCount = 0;
  let failureCount = 0;
  for (let index = 0; index < keys.length; index += CLOUD_PAGE_SIZE) {
    const batch = keys.slice(index, index + CLOUD_PAGE_SIZE);
    try {
      const result = await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: false },
        }),
      );
      failureCount += result.Errors?.length ?? 0;
      deletedCount += batch.length - (result.Errors?.length ?? 0);
    } catch {
      failureCount += batch.length;
    }
  }

  let remainingCount: number;
  try {
    remainingCount = (
      await Promise.all(prefixes.map((prefix) => listCloudKeys(client, bucket, prefix)))
    ).flat().length;
  } catch {
    return {
      complete: false,
      deletedCount,
      remainingCount: 1,
      failureCount: failureCount + 1,
      errorCode: 'ARTIFACT_LIST_FAILED',
    };
  }
  return {
    complete: failureCount === 0 && remainingCount === 0,
    deletedCount,
    remainingCount,
    failureCount,
    errorCode: failureCount > 0 || remainingCount > 0 ? 'ARTIFACT_DELETE_FAILED' : null,
  };
}
