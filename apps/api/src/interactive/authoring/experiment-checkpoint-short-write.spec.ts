import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { replaceFileAtomically } from './atomic-replace';
import { AUTHORING_CORPUS, type CorpusEntry } from './corpus';
import { runExperiment, type RunExperimentOptions } from './experiment';
import type { PipelineLimits } from './pipeline';
import type { ScenarioDraftProvider } from './provider';
import { ScriptedDraftProvider } from './scripted-provider';
import { scenarioToWire } from './wire';

/**
 * Checkpoint writes go through the real `replaceFileAtomically` and its real
 * default writer; only the `writeSync` primitive underneath it is intercepted so
 * a device that accepts a few bytes and then stalls can be simulated.
 */
type WriteArgs = [
  fd: number,
  data: string | Uint8Array,
  offset?: number | null,
  length?: number | string | null,
  position?: number | null,
];
type WriteFn = (...args: WriteArgs) => number;

const fsHooks = vi.hoisted(() => ({
  realWriteSync: undefined as WriteFn | undefined,
  writeSync: undefined as WriteFn | undefined,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  fsHooks.realWriteSync = actual.writeSync as unknown as WriteFn;
  return {
    ...actual,
    writeSync: (...args: WriteArgs) => (fsHooks.writeSync ?? fsHooks.realWriteSync!)(...args),
  };
});

const FAST: PipelineLimits = { maxOutputTokens: 4000, requestTimeoutMs: 20, deadlineMs: 5000 };

let tmp: string;
let draftsRoot: string;
let counter = 0;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'authoring-experiment-short-write-spec-'));
  draftsRoot = path.join(tmp, 'scenario-drafts');
  counter = 0;
});
afterEach(() => {
  fsHooks.writeSync = undefined;
  rmSync(tmp, { recursive: true, force: true });
});

/** One scripted provider per corpus entry so every dispatch is countable. */
function scripted() {
  const providers = new Map<CorpusEntry['key'], ScriptedDraftProvider>();
  for (const entry of AUTHORING_CORPUS) {
    providers.set(
      entry.key,
      new ScriptedDraftProvider([{ candidate: JSON.stringify(scenarioToWire(entry.scenario)) }]),
    );
  }
  return {
    providerFor: (entry: CorpusEntry): ScenarioDraftProvider => providers.get(entry.key)!,
    dispatched: (key: CorpusEntry['key']) => providers.get(key)!.requests.length,
    totalDispatched: () => [...providers.values()].reduce((n, p) => n + p.requests.length, 0),
  };
}

function run(options: Pick<RunExperimentOptions, 'providerFor'> & Partial<RunExperimentOptions>) {
  return runExperiment({
    mode: 'offline',
    limits: FAST,
    draftsRoot,
    now: new Date(Date.UTC(2026, 9, 12, 10, 0, 0)),
    randomHex: () => (counter++).toString(16).padStart(8, '0'),
    ...options,
  });
}

/** Accepts at most `cap` bytes per call, genuinely written, and reports the count. */
const shortWrites =
  (cap: number): WriteFn =>
  (fd, data, offset, length, position) => {
    const isText = typeof data === 'string';
    const bytes = isText ? Buffer.from(data, 'utf8') : data;
    const start = isText ? 0 : (offset ?? 0);
    const wanted = isText || typeof length !== 'number' ? bytes.length - start : length;
    return fsHooks.realWriteSync!(fd, bytes, start, Math.min(cap, wanted), isText ? null : (position ?? null));
  };

/**
 * Manifest writes number 1, 2, ...; from `stallFrom` on, each write accepts a
 * few bytes and then makes no progress, as a full or failing device can.
 */
function stallingManifestWriter(stallFrom: number) {
  let write = 0;
  let callInWrite = 0;
  const real = (...args: WriteArgs) => fsHooks.realWriteSync!(...args);
  fsHooks.writeSync = (...args) => {
    callInWrite += 1;
    if (write < stallFrom) return real(...args);
    return callInWrite === 1 ? shortWrites(3)(...args) : 0;
  };
  return (file: string, text: string) => {
    write += 1;
    callInWrite = 0;
    replaceFileAtomically(file, text);
  };
}

const workDir = () => path.join(draftsRoot, readdirSync(draftsRoot).find((n) => n.endsWith('.incomplete'))!);
const tempLeftovers = (dir: string) => readdirSync(dir).filter((n) => n.endsWith('.tmp'));

describe('runExperiment (checkpoint writer short writes)', () => {
  it('dispatches nothing when the very first checkpoint cannot be fully written', async () => {
    const s = scripted();
    const result = await run({
      providerFor: s.providerFor,
      writeManifest: stallingManifestWriter(1),
    });

    expect(result).toMatchObject({ ok: false, code: 'CHECKPOINT_WRITE_FAILED' });
    expect(s.totalDispatched()).toBe(0);
    // No truncated manifest was left behind, and the failed attempt cleaned up after itself.
    expect(existsSync(path.join(workDir(), 'manifest.json'))).toBe(false);
    expect(tempLeftovers(workDir())).toEqual([]);
  });

  it('stops before the next dispatch and keeps the previous parseable checkpoint', async () => {
    const s = scripted();
    // Writes: 1 initial, 2 first in-flight, 3 result, 4 recorded, 5 second in-flight.
    const result = await run({
      providerFor: s.providerFor,
      writeManifest: stallingManifestWriter(5),
    });

    expect(result).toMatchObject({ ok: false, code: 'MANIFEST_WRITE_FAILED' });
    expect(s.dispatched('last-tram')).toBe(1);
    expect(s.dispatched('harbour-ledger')).toBe(0);
    expect(s.dispatched('clock-blackout')).toBe(0);

    const dir = workDir();
    const survivor = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as {
      checkpoint: { state: string; sequence: number };
      entries: Array<{ status: string }>;
    };
    expect(survivor.checkpoint).toEqual({ state: 'IN_PROGRESS', sequence: 4 });
    expect(survivor.entries.map((e) => e.status)).toEqual([
      'completed',
      'unattempted',
      'unattempted',
    ]);
    expect(tempLeftovers(dir)).toEqual([]);
  });

  it('still finishes with an intact final manifest when every write is merely short', async () => {
    const s = scripted();
    fsHooks.writeSync = shortWrites(7);
    const result = await run({ providerFor: s.providerFor });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(s.totalDispatched()).toBe(3);
    const final = JSON.parse(readFileSync(path.join(result.dir, 'manifest.json'), 'utf8')) as {
      checkpoint: { state: string };
      completeness: { status: string };
    };
    expect(final.checkpoint.state).toBe('FINAL');
    expect(final.completeness.status).toBe('COMPLETE');
    expect(path.basename(result.dir)).toMatch(/--complete$/);
  });
});
