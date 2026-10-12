import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultReplaceOps, replaceFileAtomically } from './atomic-replace';

let tmp: string;
let target: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'authoring-atomic-replace-spec-'));
  target = path.join(tmp, 'manifest.json');
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('replaceFileAtomically', () => {
  it('creates the file when it does not exist and leaves no temporary file behind', () => {
    replaceFileAtomically(target, '{"a":1}\n');
    expect(readFileSync(target, 'utf8')).toBe('{"a":1}\n');
    expect(readdirSync(tmp)).toEqual(['manifest.json']);
  });

  it('replaces an existing file with the complete new content', () => {
    writeFileSync(target, '{"a":1}\n');
    replaceFileAtomically(target, '{"a":2}\n');
    expect(readFileSync(target, 'utf8')).toBe('{"a":2}\n');
    expect(readdirSync(tmp)).toEqual(['manifest.json']);
  });

  it('writes the temporary file in the same directory as the target', () => {
    const seen: string[] = [];
    replaceFileAtomically(target, 'x', {
      ...defaultReplaceOps,
      writeTemp: (file, text) => {
        seen.push(file);
        defaultReplaceOps.writeTemp(file, text);
      },
    });
    expect(seen).toHaveLength(1);
    expect(path.dirname(seen[0]!)).toBe(tmp);
    expect(seen[0]).not.toBe(target);
  });

  it('preserves the previous content and removes the temporary file when the rename fails', () => {
    writeFileSync(target, '{"previous":true}\n');
    expect(() =>
      replaceFileAtomically(target, '{"next":true}\n', {
        ...defaultReplaceOps,
        rename: () => {
          throw new Error('rename refused');
        },
      }),
    ).toThrow();
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ previous: true });
    expect(readdirSync(tmp)).toEqual(['manifest.json']);
  });

  it('preserves the previous content when writing the temporary file fails part-way', () => {
    writeFileSync(target, '{"previous":true}\n');
    expect(() =>
      replaceFileAtomically(target, '{"next":true}\n', {
        ...defaultReplaceOps,
        writeTemp: (file, text) => {
          writeFileSync(file, text.slice(0, 4));
          throw new Error('disk full');
        },
      }),
    ).toThrow();
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ previous: true });
    expect(readdirSync(tmp)).toEqual(['manifest.json']);
  });

  it('never overwrites an unrelated file that happens to share a temporary name', () => {
    writeFileSync(target, 'old');
    const clash = path.join(tmp, 'clash.tmp');
    writeFileSync(clash, 'unrelated');
    expect(() =>
      replaceFileAtomically(target, 'new', {
        ...defaultReplaceOps,
        tempPath: () => clash,
      }),
    ).toThrow();
    expect(readFileSync(clash, 'utf8')).toBe('unrelated');
    expect(readFileSync(target, 'utf8')).toBe('old');
  });
});
