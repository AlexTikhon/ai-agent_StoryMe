import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listLocalClaimArtifacts, deleteLocalClaimArtifacts } from './claim-artifact-local-walk';

/**
 * Phase C security hardening — deterministic proof that deleteLocalClaimArtifacts
 * cannot be tricked into deleting outside its configured root even when a
 * concurrent attacker swaps a directory in the discovered key's path for a
 * symlink/junction between discovery and deletion.
 *
 * Node is single-threaded, so the real race (another OS process mutating the
 * filesystem while this process is between two `await`s) is modeled exactly
 * by performing the attacker's mutation, synchronously, between an awaited
 * "discovery" call and an awaited "deletion" call — that boundary is the only
 * place a concurrent process could actually interleave.
 */

const roots: string[] = [];
const outsideDirs: string[] = [];

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'claim-toctou-root-'));
  roots.push(root);
  return root;
}

function freshOutsideDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'claim-toctou-outside-'));
  outsideDirs.push(dir);
  return dir;
}

/** Directory symlinks (on Windows: junctions) never require elevated privileges — used for every ancestor-swap test. */
function replaceDirWithLink(realDir: string, target: string): void {
  rmSync(realDir, { recursive: true, force: true });
  symlinkSync(target, realDir, process.platform === 'win32' ? 'junction' : 'dir');
}

/** File symlinks require admin/Developer Mode on Windows without elevation — callers must skip gracefully if this throws EPERM. */
function tryReplaceFileWithLink(realFile: string, target: string): boolean {
  rmSync(realFile, { force: true });
  return tryPlantFileSymlink(target, realFile);
}

/** Same privilege constraint as tryReplaceFileWithLink, for planting a brand-new symlink rather than replacing an existing file. */
function tryPlantFileSymlink(target: string, linkPath: string): boolean {
  try {
    symlinkSync(target, linkPath, 'file');
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw err;
  }
}

afterEach(async () => {
  for (const dir of [...roots, ...outsideDirs]) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  roots.length = 0;
  outsideDirs.length = 0;
});

describe('deleteLocalClaimArtifacts — ancestor/leaf swapped with a symlink or junction between discovery and deletion', () => {
  it('refuses to delete when the final namespace (fencingVersion) directory is replaced with a symlink/junction', async () => {
    const root = freshRoot();
    const outside = freshOutsideDir();

    mkdirSync(join(root, 'books', 'book1', 'runs', 'run1', 'claims', '1'), { recursive: true });
    writeFileSync(
      join(root, 'books', 'book1', 'runs', 'run1', 'claims', '1', 'storyme-preview-book1.pdf'),
      'REAL',
    );
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'storyme-preview-book1.pdf'), 'SENTINEL-OUTSIDE-ROOT');

    // discovery
    const page = await listLocalClaimArtifacts(join(root, 'books'), '', { pageSize: 100 });
    expect(page.entries).toHaveLength(1);
    const key = page.entries[0]!.key;

    // attacker: swap the fencingVersion directory itself for a junction/symlink pointing outside root
    replaceDirWithLink(join(root, 'books', 'book1', 'runs', 'run1', 'claims', '1'), outside);

    // deletion — must not follow the swapped directory
    const outcomes = await deleteLocalClaimArtifacts(root, [key]);

    expect(outcomes).toEqual([
      { key, outcome: 'failed', error: expect.stringContaining('no longer a plain directory') },
    ]);
    expect(readFileSync(join(outside, 'storyme-preview-book1.pdf'), 'utf8')).toBe(
      'SENTINEL-OUTSIDE-ROOT',
    );
  });

  it('refuses to delete when an intermediate ancestor directory (bookId) is replaced with a symlink/junction', async () => {
    const root = freshRoot();
    const outside = freshOutsideDir();

    mkdirSync(join(root, 'books', 'book1', 'runs', 'run1', 'claims', '1'), { recursive: true });
    writeFileSync(
      join(root, 'books', 'book1', 'runs', 'run1', 'claims', '1', 'storyme-preview-book1.pdf'),
      'REAL',
    );
    // sentinel mirrors the same relative sub-path the resolved (following-the-link) path would hit
    mkdirSync(join(outside, 'runs', 'run1', 'claims', '1'), { recursive: true });
    writeFileSync(
      join(outside, 'runs', 'run1', 'claims', '1', 'storyme-preview-book1.pdf'),
      'SENTINEL-OUTSIDE-ROOT',
    );

    const page = await listLocalClaimArtifacts(join(root, 'books'), '', { pageSize: 100 });
    expect(page.entries).toHaveLength(1);
    const key = page.entries[0]!.key;

    // attacker: swap the bookId directory (an intermediate ancestor, not the leaf) for a junction/symlink
    replaceDirWithLink(join(root, 'books', 'book1'), outside);

    const outcomes = await deleteLocalClaimArtifacts(root, [key]);

    expect(outcomes).toEqual([
      { key, outcome: 'failed', error: expect.stringContaining('no longer a plain directory') },
    ]);
    expect(
      readFileSync(
        join(outside, 'runs', 'run1', 'claims', '1', 'storyme-preview-book1.pdf'),
        'utf8',
      ),
    ).toBe('SENTINEL-OUTSIDE-ROOT');
  });

  it('never discovers a symlink placed inside an otherwise-valid namespace directory', async (ctx) => {
    const root = freshRoot();
    const outside = freshOutsideDir();
    mkdirSync(join(root, 'books', 'book1', 'runs', 'run1', 'claims', '1'), { recursive: true });
    writeFileSync(join(root, 'books', 'book1', 'runs', 'run1', 'claims', '1', 'real.pdf'), 'REAL');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'planted.txt'), 'SHOULD NEVER BE LISTED OR DELETED');

    const planted = tryPlantFileSymlink(
      join(outside, 'planted.txt'),
      join(root, 'books', 'book1', 'runs', 'run1', 'claims', '1', 'planted.pdf'),
    );
    if (!planted) {
      // File symlinks require elevated privileges on this Windows host without Developer Mode —
      // an unprivileged attacker on this platform cannot plant one here at all (junctions are
      // directory-only), so this scenario is Linux/mac-only in practice; still exercised there.
      ctx.skip();
      return;
    }

    const page = await listLocalClaimArtifacts(join(root, 'books'), '', { pageSize: 100 });

    expect(page.entries.map((e) => e.key)).toEqual(['books/book1/runs/run1/claims/1/real.pdf']);
  });

  it('refuses to delete (rather than reporting success) when the listed file itself is replaced with a symlink', async (ctx) => {
    const root = freshRoot();
    const outside = freshOutsideDir();
    mkdirSync(join(root, 'books', 'book1', 'runs', 'run1', 'claims', '1'), { recursive: true });
    const realFile = join(
      root,
      'books',
      'book1',
      'runs',
      'run1',
      'claims',
      '1',
      'storyme-preview-book1.pdf',
    );
    writeFileSync(realFile, 'REAL');
    mkdirSync(outside, { recursive: true });
    const outsideFile = join(outside, 'sentinel.pdf');
    writeFileSync(outsideFile, 'SENTINEL-OUTSIDE-ROOT');

    const page = await listLocalClaimArtifacts(join(root, 'books'), '', { pageSize: 100 });
    expect(page.entries).toHaveLength(1);
    const key = page.entries[0]!.key;

    const linked = tryReplaceFileWithLink(realFile, outsideFile);
    if (!linked) {
      // File symlinks require elevated privileges on this Windows host without Developer Mode.
      // The ancestor-swap tests above already prove the same lstat-based defense on this platform.
      ctx.skip();
      return;
    }

    const outcomes = await deleteLocalClaimArtifacts(root, [key]);

    expect(outcomes).toEqual([
      {
        key,
        outcome: 'failed',
        error: expect.stringContaining('no longer resolves to a plain file'),
      },
    ]);
    expect(readFileSync(outsideFile, 'utf8')).toBe('SENTINEL-OUTSIDE-ROOT');
  });

  it('is idempotent when the file already disappeared concurrently (another pass/process deleted it first)', async () => {
    const root = freshRoot();
    mkdirSync(join(root, 'books', 'book1', 'runs', 'run1', 'claims', '1'), { recursive: true });
    const realFile = join(
      root,
      'books',
      'book1',
      'runs',
      'run1',
      'claims',
      '1',
      'storyme-preview-book1.pdf',
    );
    writeFileSync(realFile, 'REAL');

    const page = await listLocalClaimArtifacts(join(root, 'books'), '', { pageSize: 100 });
    const key = page.entries[0]!.key;

    rmSync(realFile);

    const outcomes = await deleteLocalClaimArtifacts(root, [key]);

    expect(outcomes).toEqual([{ key, outcome: 'not_found' }]);
  });

  it('is idempotent when an ancestor directory already disappeared concurrently (whole run cleaned up already)', async () => {
    const root = freshRoot();
    mkdirSync(join(root, 'books', 'book1', 'runs', 'run1', 'claims', '1'), { recursive: true });
    writeFileSync(
      join(root, 'books', 'book1', 'runs', 'run1', 'claims', '1', 'storyme-preview-book1.pdf'),
      'REAL',
    );

    const page = await listLocalClaimArtifacts(join(root, 'books'), '', { pageSize: 100 });
    const key = page.entries[0]!.key;

    rmSync(join(root, 'books', 'book1'), { recursive: true, force: true });

    const outcomes = await deleteLocalClaimArtifacts(root, [key]);

    expect(outcomes).toEqual([{ key, outcome: 'not_found' }]);
  });

  it('still deletes normally when nothing was tampered with (no false positives from the new checks)', async () => {
    const root = freshRoot();
    mkdirSync(join(root, 'books', 'book1', 'runs', 'run1', 'claims', '1'), { recursive: true });
    const realFile = join(
      root,
      'books',
      'book1',
      'runs',
      'run1',
      'claims',
      '1',
      'storyme-preview-book1.pdf',
    );
    writeFileSync(realFile, 'REAL');

    const page = await listLocalClaimArtifacts(join(root, 'books'), '', { pageSize: 100 });
    const key = page.entries[0]!.key;

    const outcomes = await deleteLocalClaimArtifacts(root, [key]);

    expect(outcomes).toEqual([{ key, outcome: 'deleted' }]);
    expect(existsSync(realFile)).toBe(false);
  });

  it('still refuses a key whose resolved path escapes the root via literal traversal segments (pre-existing check, unaffected by the new lstat checks)', async () => {
    const root = freshRoot();
    const outcomes = await deleteLocalClaimArtifacts(root, ['../escape']);
    expect(outcomes).toEqual([
      {
        key: '../escape',
        outcome: 'failed',
        error: expect.stringContaining('grammar'),
      },
    ]);
  });
});
