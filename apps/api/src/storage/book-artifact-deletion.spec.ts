import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeleteObjectsCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import {
  deleteCloudBookArtifactPrefixes,
  deleteLocalBookArtifactRoots,
} from './book-artifact-deletion';

describe('book artifact deletion', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'storyme-hard-delete-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('deletes legacy and claim files for only the exact local book scope', async () => {
    const ownLegacy = join(root, 'images', 'book-1', 'child-photo-v1.png');
    const ownClaim = join(
      root,
      'images',
      'books',
      'book-1',
      'runs',
      'run-1',
      'claims',
      '1',
      'cover.png',
    );
    const other = join(root, 'images', 'book-10', 'cover.png');
    await Promise.all([
      mkdir(join(ownLegacy, '..'), { recursive: true }),
      mkdir(join(ownClaim, '..'), { recursive: true }),
      mkdir(join(other, '..'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(ownLegacy, 'private-photo'),
      writeFile(ownClaim, 'generated-image'),
      writeFile(other, 'keep-me'),
    ]);

    const result = await deleteLocalBookArtifactRoots(root, [
      ['images', 'book-1'],
      ['images', 'books', 'book-1'],
    ]);

    expect(result).toEqual({
      complete: true,
      deletedCount: 2,
      remainingCount: 0,
      failureCount: 0,
      errorCode: null,
    });
    await expect(readFile(other, 'utf8')).resolves.toBe('keep-me');
  });

  it('refuses to follow an intermediate symlink or junction outside the storage root', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'storyme-hard-delete-outside-'));
    const outsideBook = join(outside, 'book-1');
    const outsideFile = join(outsideBook, 'private.png');
    await mkdir(outsideBook, { recursive: true });
    await writeFile(outsideFile, 'must-survive');
    await mkdir(join(root, 'images'), { recursive: true });
    await symlink(
      outside,
      join(root, 'images', 'books'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    try {
      const result = await deleteLocalBookArtifactRoots(root, [['images', 'books', 'book-1']]);

      expect(result.complete).toBe(false);
      expect(result.deletedCount).toBe(0);
      expect(result.failureCount).toBeGreaterThan(0);
      await expect(readFile(outsideFile, 'utf8')).resolves.toBe('must-survive');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('treats a partial cloud provider failure as incomplete and observable', async () => {
    let listCalls = 0;
    const client = {
      send: vi.fn(async (command: unknown) => {
        if (command instanceof ListObjectsV2Command) {
          listCalls += 1;
          return {
            Contents: [{ Key: 'images/book-1/child-photo-v1.png' }],
            IsTruncated: false,
          };
        }
        if (command instanceof DeleteObjectsCommand) {
          return {
            Errors: [
              {
                Key: 'images/book-1/child-photo-v1.png',
                Code: 'AccessDenied',
              },
            ],
          };
        }
        throw new Error('unexpected command');
      }),
    } as unknown as S3Client;

    const result = await deleteCloudBookArtifactPrefixes(client, 'bucket', ['images/book-1/']);

    expect(listCalls).toBe(2);
    expect(result).toEqual({
      complete: false,
      deletedCount: 0,
      remainingCount: 1,
      failureCount: 1,
      errorCode: 'ARTIFACT_DELETE_FAILED',
    });
  });
});
