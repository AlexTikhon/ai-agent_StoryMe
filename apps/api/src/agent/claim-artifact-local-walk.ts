import { readdir, stat, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type {
  ClaimArtifactDeleteOutcome,
  ClaimArtifactListPage,
  ClaimArtifactStorageEntry,
} from './claim-artifact-key';
import { parseClaimArtifactStorageKey } from './claim-artifact-key';

/**
 * Grammar-aware bounded walk of a local claim-artifact tree, shared by
 * LocalImageAssetStorage and LocalPdfStorage (Phase C). Deliberately does NOT
 * do a generic recursive directory walk + parse-and-reject: it only ever
 * descends through the exact literal structure claimArtifactBasePath
 * produces (`books/{bookId}/runs/{runId}/claims/{fencingVersion}/...`), so it
 * never touches — and never has to reason about — legacy positional artifacts
 * that happen to share `booksRoot` as a parent directory (e.g. local PDF's
 * `books/<bookId>/storybook.pdf`, a sibling of `books/<bookId>/runs/`).
 *
 * Every directory read uses `withFileTypes: true` and explicitly skips any
 * entry reported as a symlink — claim artifacts are only ever plain
 * files/dirs this process itself created, so a symlink appearing anywhere in
 * this tree is never legitimate and must never be followed.
 *
 * Pagination: performs a fresh full (bounded) enumeration on every call,
 * returns entries in a stable sort order (by relative key), and the opaque
 * cursor is simply the last key already returned — the caller resumes by
 * skipping everything at or before that key. Correct as long as the tree
 * doesn't change page-to-page mid-listing at scales far beyond this
 * project's actual object counts; a real multi-million-object deployment
 * would need a persisted cursor/index instead.
 */
export async function listLocalClaimArtifacts(
  booksRoot: string,
  keyPrefix: string,
  params: { cursor?: string | null; pageSize: number },
): Promise<ClaimArtifactListPage> {
  const all = await collectAll(booksRoot, keyPrefix);
  all.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const cursor = params.cursor ?? null;
  const startIndex = cursor == null ? 0 : all.findIndex((entry) => entry.key > cursor);
  const remaining = startIndex === -1 ? [] : all.slice(startIndex);

  const pageSize = Math.max(1, Math.min(params.pageSize, 1000));
  const page = remaining.slice(0, pageSize);
  const nextCursor = remaining.length > pageSize ? page[page.length - 1]!.key : null;

  return { entries: page, nextCursor };
}

async function collectAll(
  booksRoot: string,
  keyPrefix: string,
): Promise<ClaimArtifactStorageEntry[]> {
  const results: ClaimArtifactStorageEntry[] = [];

  const bookDirs = await safeReadDir(booksRoot);
  for (const bookDir of bookDirs) {
    if (!bookDir.isDirectory) continue;
    const runsDir = join(booksRoot, bookDir.name, 'runs');
    const runDirs = await safeReadDir(runsDir);
    for (const runDir of runDirs) {
      if (!runDir.isDirectory) continue;
      const claimsDir = join(runsDir, runDir.name, 'claims');
      const fencingDirs = await safeReadDir(claimsDir);
      for (const fencingDir of fencingDirs) {
        if (!fencingDir.isDirectory) continue;
        const fencingPath = join(claimsDir, fencingDir.name);
        const files = await safeReadDir(fencingPath);
        for (const file of files) {
          if (!file.isFile) continue;
          const relKey = [
            keyPrefix,
            'books',
            bookDir.name,
            'runs',
            runDir.name,
            'claims',
            fencingDir.name,
            file.name,
          ]
            .filter((segment) => segment.length > 0)
            .join('/');
          const fileStat = await safeStat(join(fencingPath, file.name));
          results.push({
            key: relKey,
            size: fileStat?.size,
            lastModified: fileStat?.mtime,
          });
        }
      }
    }
  }

  return results;
}

interface SafeDirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
}

/** Never follows a symlinked entry (directory or file) — returns it neither as traversable nor as a listed file. Returns [] for a missing/unreadable directory rather than throwing, since most of this tree's directories won't exist for most books. */
async function safeReadDir(dir: string): Promise<SafeDirEntry[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => !entry.isSymbolicLink())
    .map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
    }));
}

async function safeStat(path: string): Promise<{ size: number; mtime: Date } | undefined> {
  try {
    const s = await stat(path);
    return { size: s.size, mtime: s.mtime };
  } catch {
    return undefined;
  }
}

/**
 * Deletes an exact set of already-listed local claim-artifact keys, shared by
 * LocalImageAssetStorage/LocalPdfStorage. Defense in depth, not the primary
 * safety mechanism (ClaimArtifactCleanupService validates every key via
 * parseClaimArtifactStorageKey before it ever reaches here): re-parses each
 * key and re-resolves it against `root`, refusing to unlink anything whose
 * resolved path falls outside `root` — a key that fails either check is
 * reported 'failed', never silently skipped or, worse, deleted anyway.
 */
export async function deleteLocalClaimArtifacts(
  root: string,
  keys: readonly string[],
): Promise<ClaimArtifactDeleteOutcome[]> {
  const resolvedRoot = resolve(root) + sep;
  const outcomes: ClaimArtifactDeleteOutcome[] = [];

  for (const key of keys) {
    if (!parseClaimArtifactStorageKey(key)) {
      outcomes.push({ key, outcome: 'failed', error: 'Key does not match claim artifact grammar' });
      continue;
    }
    const resolvedPath = resolve(root, ...key.split('/'));
    if (!resolvedPath.startsWith(resolvedRoot)) {
      outcomes.push({ key, outcome: 'failed', error: 'Resolved path escapes storage root' });
      continue;
    }
    if (!existsSync(resolvedPath)) {
      outcomes.push({ key, outcome: 'not_found' });
      continue;
    }
    try {
      await unlink(resolvedPath);
      outcomes.push({ key, outcome: 'deleted' });
    } catch (err) {
      outcomes.push({ key, outcome: 'failed', error: err instanceof Error ? err.message : String(err) });
    }
  }

  return outcomes;
}
