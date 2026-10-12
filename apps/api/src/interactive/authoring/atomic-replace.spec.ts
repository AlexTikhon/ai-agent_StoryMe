import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultReplaceOps, replaceFileAtomically } from './atomic-replace';

type WriteArgs = [
  fd: number,
  data: string | Uint8Array,
  offset?: number | null,
  length?: number | string | null,
  position?: number | null,
];
type WriteFn = (...args: WriteArgs) => number;
type FdFn = (fd: number) => void;

/**
 * The default writer is exercised through the real `node:fs`; only the three
 * descriptor primitives it uses can be intercepted, and each one falls back to
 * the real implementation unless a test installs a hook.
 */
const fsHooks = vi.hoisted(() => ({
  real: {} as { writeSync: WriteFn; fsyncSync: FdFn; closeSync: FdFn },
  writeSync: undefined as WriteFn | undefined,
  fsyncSync: undefined as FdFn | undefined,
  closeSync: undefined as FdFn | undefined,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  fsHooks.real = {
    writeSync: actual.writeSync as unknown as WriteFn,
    fsyncSync: actual.fsyncSync,
    closeSync: actual.closeSync,
  };
  return {
    ...actual,
    writeSync: (...args: WriteArgs) => (fsHooks.writeSync ?? fsHooks.real.writeSync)(...args),
    fsyncSync: (fd: number) => (fsHooks.fsyncSync ?? fsHooks.real.fsyncSync)(fd),
    closeSync: (fd: number) => (fsHooks.closeSync ?? fsHooks.real.closeSync)(fd),
  };
});

let tmp: string;
let target: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'authoring-atomic-replace-spec-'));
  target = path.join(tmp, 'manifest.json');
});
afterEach(() => {
  fsHooks.writeSync = undefined;
  fsHooks.fsyncSync = undefined;
  fsHooks.closeSync = undefined;
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * A `writeSync` that genuinely writes at most `cap` bytes per call and reports
 * the count, as a real descriptor may. `script` can override a call: return a
 * number to report that many bytes after writing, or throw.
 */
function shortWrites(
  cap: number,
  calls: number[] = [],
  script?: (call: number, written: number) => number | void,
): WriteFn {
  return (fd, data, offset, length, position) => {
    if (calls.length > 200) throw new Error('runaway writeSync loop');
    const isText = typeof data === 'string';
    const bytes = isText ? Buffer.from(data, 'utf8') : data;
    const start = isText ? 0 : (offset ?? 0);
    const wanted = isText || typeof length !== 'number' ? bytes.length - start : length;
    const written = fsHooks.real.writeSync(
      fd,
      bytes,
      start,
      Math.min(cap, wanted),
      isText ? null : (position ?? null),
    );
    calls.push(written);
    const reported = script?.(calls.length, written);
    return typeof reported === 'number' ? reported : written;
  };
}

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

  describe('short writes (default writer)', () => {
    const NEXT = '{"next":true,"items":[1,2,3,4,5,6,7,8,9]}\n';

    const seedPrevious = () => writeFileSync(target, '{"previous":true}\n');
    const expectPreserved = (before: string[]) => {
      expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ previous: true });
      expect(readdirSync(tmp).sort()).toEqual(before);
    };

    it('keeps writing until every byte is accepted when each call takes only a few', () => {
      const calls: number[] = [];
      fsHooks.writeSync = shortWrites(3, calls);
      replaceFileAtomically(target, NEXT);
      expect(calls.length).toBeGreaterThan(1);
      expect(calls.every((n) => n > 0 && n <= 3)).toBe(true);
      expect(calls.reduce((a, b) => a + b, 0)).toBe(Buffer.byteLength(NEXT));
      expect(readFileSync(target).equals(Buffer.from(NEXT, 'utf8'))).toBe(true);
      expect(readdirSync(tmp)).toEqual(['manifest.json']);
    });

    it('advances by byte offsets so multibyte characters split across writes stay intact', () => {
      const text = `${JSON.stringify({ title: 'Zażółć gęślą jaźń — 日本語 🚋 Привет', n: 1 })}\n`;
      expect(Buffer.byteLength(text)).toBeGreaterThan(text.length);
      for (const cap of [1, 2, 3, 5]) {
        const calls: number[] = [];
        fsHooks.writeSync = shortWrites(cap, calls);
        replaceFileAtomically(target, text);
        const bytes = readFileSync(target);
        expect(bytes.equals(Buffer.from(text, 'utf8'))).toBe(true);
        expect(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).toBe(text);
        expect(JSON.parse(bytes.toString('utf8'))).toMatchObject({ n: 1 });
        expect(calls.reduce((a, b) => a + b, 0)).toBe(Buffer.byteLength(text));
      }
    });

    it('fails and preserves the old target when a write makes no progress after a partial write', () => {
      seedPrevious();
      const before = readdirSync(tmp).sort();
      const calls: number[] = [];
      // First call accepts 3 bytes, every later call accepts none.
      fsHooks.writeSync = shortWrites(3, calls, (call) => (call === 1 ? undefined : 0));
      expect(() => replaceFileAtomically(target, NEXT)).toThrow(/progress/i);
      expect(calls.length).toBeLessThan(10);
      expectPreserved(before);
    });

    it('preserves the old target when a write throws after a partial write', () => {
      seedPrevious();
      const before = readdirSync(tmp).sort();
      fsHooks.writeSync = shortWrites(3, [], (call) => {
        if (call === 2) throw new Error('disk full');
      });
      expect(() => replaceFileAtomically(target, NEXT)).toThrow('disk full');
      expectPreserved(before);
    });

    it('does not replace the target when the flush fails', () => {
      seedPrevious();
      const before = readdirSync(tmp).sort();
      const events: string[] = [];
      fsHooks.fsyncSync = () => {
        events.push('fsync');
        throw new Error('flush refused');
      };
      fsHooks.closeSync = (fd) => {
        events.push('close');
        fsHooks.real.closeSync(fd);
      };
      let renames = 0;
      expect(() =>
        replaceFileAtomically(target, NEXT, {
          ...defaultReplaceOps,
          rename: (from, to) => {
            renames += 1;
            defaultReplaceOps.rename(from, to);
          },
        }),
      ).toThrow('flush refused');
      expect(renames).toBe(0);
      expect(events).toEqual(['fsync', 'close']);
      expectPreserved(before);
    });

    it('flushes and closes the completed temporary file before renaming it', () => {
      const events: string[] = [];
      fsHooks.writeSync = shortWrites(4);
      fsHooks.fsyncSync = (fd) => {
        events.push('fsync');
        fsHooks.real.fsyncSync(fd);
      };
      fsHooks.closeSync = (fd) => {
        events.push('close');
        fsHooks.real.closeSync(fd);
      };
      replaceFileAtomically(target, NEXT, {
        ...defaultReplaceOps,
        rename: (from, to) => {
          events.push('rename');
          // The complete content is already on the temporary file at rename time.
          expect(readFileSync(from, 'utf8')).toBe(NEXT);
          defaultReplaceOps.rename(from, to);
        },
      });
      expect(events).toEqual(['fsync', 'close', 'rename']);
    });

    it('removes only its own temporary file on a handled failure and leaves other files alone', () => {
      seedPrevious();
      const bystander = path.join(tmp, '.manifest.json.deadbeef0000.tmp');
      const notes = path.join(tmp, 'notes.txt');
      writeFileSync(bystander, 'unrelated temp-looking file');
      writeFileSync(notes, 'unrelated notes');
      const before = readdirSync(tmp).sort();

      let owned = '';
      fsHooks.writeSync = shortWrites(3, [], (call) => {
        if (call === 3) throw new Error('disk full');
      });
      expect(() =>
        replaceFileAtomically(target, NEXT, {
          ...defaultReplaceOps,
          tempPath: (t) => {
            owned = defaultReplaceOps.tempPath(t);
            return owned;
          },
        }),
      ).toThrow('disk full');

      expect(owned).not.toBe('');
      expect(existsSync(owned)).toBe(false);
      expect(readFileSync(bystander, 'utf8')).toBe('unrelated temp-looking file');
      expect(readFileSync(notes, 'utf8')).toBe('unrelated notes');
      expectPreserved(before);
    });
  });
});
