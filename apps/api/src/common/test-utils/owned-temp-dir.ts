import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * Per-test filesystem fixtures. Each call creates a fresh directory directly
 * under the OS temporary directory, so a test never shares a storage root with
 * the application's own `apps/api/tmp` data or with concurrently running suites.
 */
export async function createOwnedTempDir(prefix: string): Promise<string> {
  assertPrefix(prefix);
  return mkdtemp(join(tmpdir(), prefix));
}

/**
 * Removes exactly one directory previously returned by createOwnedTempDir.
 * Refuses (throws) unless the resolved target is a real, non-symlink directory
 * that is a direct child of the OS temporary directory and carries the prefix
 * it was created with — a recursive delete must never reach anything else.
 */
export async function removeOwnedTempDir(dir: string, prefix: string): Promise<void> {
  assertPrefix(prefix);
  const target = resolve(dir);
  const parent = resolve(tmpdir());
  const name = basename(target);
  if (dirname(target) !== parent || !name.startsWith(prefix) || name.length <= prefix.length) {
    throw new Error(`Refusing to remove ${target}: not an owned temporary directory`);
  }
  let entry;
  try {
    entry = await lstat(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (!entry.isDirectory()) {
    throw new Error(`Refusing to remove ${target}: not a plain directory`);
  }
  await rm(target, { recursive: true });
}

function assertPrefix(prefix: string): void {
  if (!/^[a-z0-9][a-z0-9-]*-$/.test(prefix)) {
    throw new Error(`Invalid temporary directory prefix: ${prefix}`);
  }
}
