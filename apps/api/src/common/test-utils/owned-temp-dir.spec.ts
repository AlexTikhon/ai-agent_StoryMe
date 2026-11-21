import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOwnedTempDir, removeOwnedTempDir } from './owned-temp-dir';

const PREFIX = 'storyme-owned-temp-spec-';

describe('owned temporary directories', () => {
  it('creates a fresh directory under the OS temp directory and removes it recursively', async () => {
    const dir = await createOwnedTempDir(PREFIX);
    await mkdir(join(dir, 'nested'), { recursive: true });
    await writeFile(join(dir, 'nested', 'file.txt'), 'x');

    await removeOwnedTempDir(dir, PREFIX);

    expect(existsSync(dir)).toBe(false);
  });

  it('refuses targets that are not a prefixed direct child of the OS temp directory', async () => {
    const dir = await createOwnedTempDir(PREFIX);
    try {
      await mkdir(join(dir, `${PREFIX}inner`));
      await expect(removeOwnedTempDir(join(dir, `${PREFIX}inner`), PREFIX)).rejects.toThrow(
        /not an owned temporary directory/,
      );
      await expect(removeOwnedTempDir(tmpdir(), PREFIX)).rejects.toThrow(
        /not an owned temporary directory/,
      );
      await expect(removeOwnedTempDir(join(tmpdir(), PREFIX), PREFIX)).rejects.toThrow(
        /not an owned temporary directory/,
      );
      await expect(removeOwnedTempDir(join(dir, '..', '..'), PREFIX)).rejects.toThrow(
        /not an owned temporary directory/,
      );
      await expect(removeOwnedTempDir(join(tmpdir(), 'other-prefix-abc'), PREFIX)).rejects.toThrow(
        /not an owned temporary directory/,
      );
      expect(existsSync(join(dir, `${PREFIX}inner`))).toBe(true);
    } finally {
      await removeOwnedTempDir(dir, PREFIX);
    }
  });
});
