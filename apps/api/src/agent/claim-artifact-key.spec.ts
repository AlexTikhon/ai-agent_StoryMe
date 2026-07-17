import { describe, it, expect } from 'vitest';
import { parseClaimArtifactStorageKey, claimArtifactNamespaceGroupKey } from './claim-artifact-key';

describe('parseClaimArtifactStorageKey', () => {
  it('parses a valid PDF claim key (no "images/" prefix)', () => {
    const parsed = parseClaimArtifactStorageKey(
      'books/book-1/runs/run-1/claims/3/storyme-preview-book-1.pdf',
    );
    expect(parsed).toEqual({
      bookId: 'book-1',
      runId: 'run-1',
      fencingVersion: 3,
      relativeSegments: ['storyme-preview-book-1.pdf'],
    });
  });

  it('parses a valid image claim key with the "images/" prefix stripped', () => {
    const parsed = parseClaimArtifactStorageKey(
      'images/books/book-1/runs/run-1/claims/1/cover.png',
    );
    expect(parsed).toEqual({
      bookId: 'book-1',
      runId: 'run-1',
      fencingVersion: 1,
      relativeSegments: ['cover.png'],
    });
  });

  it('accepts UUID-style bookId/runId segments', () => {
    const bookId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const runId = 'f0e1d2c3-b4a5-6789-0abc-def123456789';
    const parsed = parseClaimArtifactStorageKey(
      `images/books/${bookId}/runs/${runId}/claims/42/page-1.png`,
    );
    expect(parsed).toEqual({
      bookId,
      runId,
      fencingVersion: 42,
      relativeSegments: ['page-1.png'],
    });
  });

  it('supports multi-segment relative paths after claims/{fencingVersion}/', () => {
    const parsed = parseClaimArtifactStorageKey(
      'images/books/b/runs/r/claims/1/nested/deep/file.png',
    );
    expect(parsed?.relativeSegments).toEqual(['nested', 'deep', 'file.png']);
  });

  it.each([
    ['empty string', ''],
    ['wrong top-level literal', 'previews/book-1/runs/run-1/claims/1/file.pdf'],
    ['legacy positional PDF key (no runs/claims)', 'books/book-1/storybook.pdf'],
    ['legacy positional image key (no runs/claims)', 'images/book-1/cover.png'],
    ['missing "runs" literal', 'books/book-1/xruns/run-1/claims/1/file.pdf'],
    ['missing "claims" literal', 'books/book-1/runs/run-1/xclaims/1/file.pdf'],
    ['fencing version zero', 'books/book-1/runs/run-1/claims/0/file.pdf'],
    ['negative fencing version', 'books/book-1/runs/run-1/claims/-1/file.pdf'],
    ['non-numeric fencing version', 'books/book-1/runs/run-1/claims/abc/file.pdf'],
    ['fencing version with leading zero', 'books/book-1/runs/run-1/claims/01/file.pdf'],
    ['fencing version with decimal point', 'books/book-1/runs/run-1/claims/1.5/file.pdf'],
    ['no relative segment after fencing version', 'books/book-1/runs/run-1/claims/1'],
    ['no relative segment, trailing slash', 'books/book-1/runs/run-1/claims/1/'],
    ['unsafe bookId (path traversal)', 'books/../etc/runs/run-1/claims/1/file.pdf'],
    [
      'unsafe bookId (slash-smuggling via encoding)',
      'books/book%2Fid/runs/run-1/claims/1/file.pdf',
    ],
    ['traversal relative segment ".."', 'books/book-1/runs/run-1/claims/1/../../../etc/passwd'],
    ['relative segment "."', 'books/book-1/runs/run-1/claims/1/.'],
    ['empty relative segment (double slash)', 'books/book-1/runs/run-1/claims/1//file.pdf'],
    [
      'unsafe runId (contains slash via extra segment)',
      'books/book-1/runs/run-1/extra/claims/1/file.pdf',
    ],
    ['unsafe bookId characters', 'books/book!1/runs/run-1/claims/1/file.pdf'],
  ])('rejects: %s', (_label, key) => {
    expect(parseClaimArtifactStorageKey(key)).toBeNull();
  });

  it('rejects non-string input defensively', () => {
    expect(parseClaimArtifactStorageKey(undefined as unknown as string)).toBeNull();
    expect(parseClaimArtifactStorageKey(null as unknown as string)).toBeNull();
  });
});

describe('claimArtifactNamespaceGroupKey', () => {
  it('produces a stable, distinct key per (bookId, runId, fencingVersion)', () => {
    const a = claimArtifactNamespaceGroupKey('book-1', 'run-1', 1);
    const b = claimArtifactNamespaceGroupKey('book-1', 'run-1', 2);
    const c = claimArtifactNamespaceGroupKey('book-1', 'run-2', 1);
    const d = claimArtifactNamespaceGroupKey('book-2', 'run-1', 1);
    const again = claimArtifactNamespaceGroupKey('book-1', 'run-1', 1);

    expect(new Set([a, b, c, d]).size).toBe(4);
    expect(a).toBe(again);
  });
});
