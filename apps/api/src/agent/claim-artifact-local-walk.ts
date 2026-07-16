import { readdir, stat, lstat, unlink } from 'node:fs/promises';
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
 * TOCTOU defense for deleteLocalClaimArtifacts: `resolve(root, ...key.split('/'))`
 * is pure string manipulation and never touches the filesystem, so
 * `resolvedPath.startsWith(resolvedRoot)` proves nothing about what a
 * subsequent `unlink(resolvedPath)` will actually operate on. The OS resolves
 * every directory component of that path fresh at unlink time — if an
 * ancestor directory this process created (e.g. the `{bookId}`, `{runId}`, or
 * `{fencingVersion}` segment) was replaced with a symlink or a Windows
 * junction between listing and deletion, the unlink follows it and can delete
 * a file outside the configured storage root even though the resolved string
 * looked safe. Verified empirically (see Phase C security hardening notes):
 * on both Windows (junction, no elevation required) and Linux (plain
 * symlink), swapping an ancestor directory and then unlinking the
 * originally-listed path deletes the attacker's target, not the real file.
 *
 * This walks every directory segment from `root` down to the key's parent
 * with `lstat` (never `stat`/`existsSync`, which dereference symlinks) and
 * requires each to still be a real, non-symlink directory. A symlink or
 * junction at any level reports `isDirectory() === false` under `lstat`
 * (the link entry itself is inspected, not its target), so this reliably
 * detects the swap without following it.
 *
 * This does not close the race completely: Node's public fs API has no
 * `openat`/`unlinkat`-style call that pins an unlink to a previously-verified
 * directory handle, so there remains an unavoidable single-syscall gap
 * between this last check and the `unlink` call below. Closing that
 * completely would require a native addon (explicitly out of scope). What
 * this does guarantee: the window is a single syscall, not the full
 * discovery-to-deletion pass, and any ancestor swap that happens to land
 * inside that window is still bounded by the same check failing on the next
 * retried pass — it can never succeed silently as a 'deleted' outcome.
 */
async function verifyRealDirectoryChain(
  root: string,
  dirSegments: readonly string[],
): Promise<'ok' | 'missing' | 'suspicious'> {
  let current = resolve(root);
  for (const segment of dirSegments) {
    current = join(current, segment);
    let entryStat;
    try {
      entryStat = await lstat(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
      // Any other lstat failure (permission, I/O, unexpected type) fails
      // closed as suspicious rather than being treated as "doesn't exist".
      return 'suspicious';
    }
    if (!entryStat.isDirectory()) return 'suspicious';
  }
  return 'ok';
}

/**
 * Deletes an exact set of already-listed local claim-artifact keys, shared by
 * LocalImageAssetStorage/LocalPdfStorage. Defense in depth, not the only
 * safety mechanism (ClaimArtifactCleanupService validates every key via
 * parseClaimArtifactStorageKey before it ever reaches here): re-parses each
 * key, re-resolves it against `root`, and — see verifyRealDirectoryChain above
 * — re-verifies with `lstat` immediately before acting that every ancestor
 * directory is still a real directory and the leaf is still a plain file.
 * Never uses `existsSync`/`stat` for these checks, since both dereference
 * symlinks and would report "exists" for a swapped ancestor pointing at a
 * real file elsewhere. A key that fails any check is reported 'failed'
 * (suspicious, retried next pass) or 'not_found' (genuinely gone, idempotent)
 * — never silently skipped, and never deleted anyway.
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
    const segments = key.split('/');
    const resolvedPath = resolve(root, ...segments);
    if (!resolvedPath.startsWith(resolvedRoot)) {
      outcomes.push({ key, outcome: 'failed', error: 'Resolved path escapes storage root' });
      continue;
    }

    const chain = await verifyRealDirectoryChain(root, segments.slice(0, -1));
    if (chain === 'missing') {
      outcomes.push({ key, outcome: 'not_found' });
      continue;
    }
    if (chain === 'suspicious') {
      outcomes.push({
        key,
        outcome: 'failed',
        error:
          'An ancestor directory for this key is no longer a plain directory (symlink, junction, or ' +
          'unexpected type) — refusing to delete; will be retried on a later pass',
      });
      continue;
    }

    let leafStat;
    try {
      leafStat = await lstat(resolvedPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        outcomes.push({ key, outcome: 'not_found' });
      } else {
        outcomes.push({
          key,
          outcome: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }
    if (!leafStat.isFile()) {
      outcomes.push({
        key,
        outcome: 'failed',
        error:
          'Path no longer resolves to a plain file (symlink or unexpected type) — refusing to delete; ' +
          'will be retried on a later pass',
      });
      continue;
    }

    try {
      await unlink(resolvedPath);
      outcomes.push({ key, outcome: 'deleted' });
    } catch (err) {
      outcomes.push({
        key,
        outcome: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return outcomes;
}
