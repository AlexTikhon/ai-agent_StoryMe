import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';

/**
 * Replace one file with a complete new version, so a reader (or a process that
 * is terminated mid-write) only ever sees the previous complete content or the
 * new complete content, never a truncated one.
 *
 * The temporary file lives in the same directory as the target so the final
 * rename never crosses a filesystem boundary. It is created exclusively and is
 * removed again if anything fails; an unrelated file that happens to occupy the
 * temporary name is never touched.
 */

export interface ReplaceOps {
  /** Exclusive create + write + flush. Must throw when the file already exists. */
  writeTemp: (file: string, text: string) => void;
  rename: (from: string, to: string) => void;
  remove: (file: string) => void;
  tempPath: (target: string) => string;
}

export const defaultReplaceOps: ReplaceOps = {
  writeTemp: (file, text) => {
    const fd = openSync(file, 'wx');
    try {
      writeSync(fd, text, null, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  },
  rename: renameSync,
  remove: unlinkSync,
  tempPath: (target) =>
    path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(6).toString('hex')}.tmp`),
};

export function replaceFileAtomically(
  target: string,
  text: string,
  ops: ReplaceOps = defaultReplaceOps,
): void {
  const temp = ops.tempPath(target);
  try {
    ops.writeTemp(temp, text);
    ops.rename(temp, target);
  } catch (error) {
    // EEXIST means the temporary name was not ours: leave that file alone.
    if ((error as NodeJS.ErrnoException | undefined)?.code !== 'EEXIST') {
      try {
        ops.remove(temp);
      } catch {
        // Nothing more can be done; the target itself was never touched.
      }
    }
    throw error;
  }
}
