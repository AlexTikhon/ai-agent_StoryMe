import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import type { ClaimArtifactDeleteOutcome, ClaimArtifactListPage } from './claim-artifact-key';

/** S3's own hard cap on keys per DeleteObjects call — every batch is chunked to this size regardless of what the caller passes in. */
const S3_DELETE_BATCH_LIMIT = 1000;
/** S3's own hard cap on MaxKeys per ListObjectsV2 call. */
const S3_LIST_PAGE_LIMIT = 1000;

/**
 * Cloud (S3/R2) counterpart to listLocalClaimArtifacts (claim-artifact-local-walk.ts),
 * shared by CloudImageAssetStorage/CloudPdfStorage. `prefix` scopes the list
 * to exactly the claim-artifact root for that driver ("images/books/" for
 * images, "books/" for PDFs) — legacy positional objects live under different
 * prefixes entirely ("previews/" for PDFs; a bare "images/<bookId>/..." for
 * images, one segment shallower than "images/books/") so they're never
 * returned here.
 */
export async function listCloudClaimArtifacts(
  client: S3Client,
  bucket: string,
  prefix: string,
  params: { cursor?: string | null; pageSize: number },
): Promise<ClaimArtifactListPage> {
  const maxKeys = Math.max(1, Math.min(params.pageSize, S3_LIST_PAGE_LIMIT));
  const result = await client.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      MaxKeys: maxKeys,
      ContinuationToken: params.cursor ?? undefined,
    }),
  );

  const entries = (result.Contents ?? [])
    .filter((obj): obj is typeof obj & { Key: string } => typeof obj.Key === 'string')
    .map((obj) => ({
      key: obj.Key,
      size: obj.Size,
      lastModified: obj.LastModified,
    }));

  return {
    entries,
    nextCursor: result.IsTruncated ? (result.NextContinuationToken ?? null) : null,
  };
}

/** Chunks `keys` into batches of at most S3_DELETE_BATCH_LIMIT and issues one DeleteObjectsCommand per batch, mapping the response's Deleted/Errors arrays back to a per-key outcome so a partial batch failure remains observable per-key. */
export async function deleteCloudClaimArtifacts(
  client: S3Client,
  bucket: string,
  keys: readonly string[],
): Promise<ClaimArtifactDeleteOutcome[]> {
  const outcomes: ClaimArtifactDeleteOutcome[] = [];

  for (let i = 0; i < keys.length; i += S3_DELETE_BATCH_LIMIT) {
    const batch = keys.slice(i, i + S3_DELETE_BATCH_LIMIT);
    try {
      const result = await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: batch.map((key) => ({ Key: key })), Quiet: false },
        }),
      );
      const failedByKey = new Map(
        (result.Errors ?? []).map((e) => [
          e.Key ?? '',
          e.Message ?? e.Code ?? 'Unknown S3 delete error',
        ]),
      );
      for (const key of batch) {
        const error = failedByKey.get(key);
        outcomes.push(error ? { key, outcome: 'failed', error } : { key, outcome: 'deleted' });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      for (const key of batch) {
        outcomes.push({ key, outcome: 'failed', error: message });
      }
    }
  }

  return outcomes;
}
