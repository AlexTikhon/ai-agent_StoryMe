import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUTHORING_CORPUS } from '../src/interactive/authoring/corpus';

/**
 * A real process, terminated for real. The only synchronisation is IPC: the
 * child announces that the second brief is waiting for its response and the
 * parent kills it at that moment. No sleeps, no network, no paid provider.
 */

const API_ROOT = path.resolve(__dirname, '..');
const WORKER = path.join(__dirname, 'experiment-interrupt-worker.fixture.ts');
const PREFIX = 'authoring-experiment-interrupt-spec-';

let tmp: string;
let draftsRoot: string;
let child: ChildProcess | null;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), PREFIX));
  draftsRoot = path.join(tmp, 'scenario-drafts');
  child = null;
});
afterEach(() => {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  // Only the directory this test created (guarded by prefix and location).
  if (tmp.startsWith(tmpdir()) && path.basename(tmp).startsWith(PREFIX)) {
    rmSync(tmp, { recursive: true, force: true });
  }
});

function waitFor<T>(proc: ChildProcess, predicate: (message: unknown) => T | undefined): Promise<T> {
  return new Promise((resolve, reject) => {
    proc.on('message', (message) => {
      const found = predicate(message);
      if (found !== undefined) resolve(found);
    });
    proc.once('error', reject);
    proc.once('exit', (code, signal) =>
      reject(new Error(`worker exited before the barrier (code ${code}, signal ${signal})`)),
    );
  });
}

describe('experiment interruption (real child process)', () => {
  it('leaves a checkpoint that keeps the first result, marks the second unresolved and the third unattempted', async () => {
    child = fork(WORKER, [draftsRoot], {
      cwd: API_ROOT,
      execArgv: ['-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register'],
      env: { ...process.env, TS_NODE_PROJECT: 'tsconfig.scripts.json' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const proc = child;
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      proc.once('exit', (code, signal) => resolve({ code, signal })),
    );

    await waitFor(proc, (m) =>
      typeof m === 'object' && m !== null && (m as { type?: string }).type === 'waiting' ? true : undefined,
    );
    // Abrupt termination: no handlers run, nothing is finalised.
    proc.kill('SIGKILL');
    const end = await exited;
    expect(proc.killed).toBe(true);
    // Not a clean exit, and not the worker's own "ran to the end" / "failed" codes.
    expect([0, 64, 65, 66, 67]).not.toContain(end.code);

    const names = readdirSync(draftsRoot);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/\.incomplete$/);
    const work = path.join(draftsRoot, names[0]!);
    expect(readdirSync(work).filter((n) => n.endsWith('.tmp'))).toEqual([]);

    const manifest = JSON.parse(readFileSync(path.join(work, 'manifest.json'), 'utf8')) as Record<
      string,
      any
    >;
    expect(manifest['schema']).toBe('interactive-authoring-experiment-manifest/v2');
    expect(manifest['checkpoint'].state).toBe('IN_PROGRESS');
    expect(manifest['completeness']).toMatchObject({
      status: 'INCOMPLETE',
      completed: 1,
      awaitingResponse: 1,
      unattempted: 1,
    });
    expect(manifest['comparisonReport']).toBeNull();

    const [first, second, third] = manifest['entries'] as Array<Record<string, any>>;
    expect(first).toMatchObject({
      key: AUTHORING_CORPUS[0]!.key,
      status: 'completed',
      outcome: 'REVIEW_REQUIRED',
      requests: 1,
      usage: 'REPORTED',
    });
    expect(first!['artifacts'].files).toContain('validation-report.json');
    expect(second).toMatchObject({
      key: AUTHORING_CORPUS[1]!.key,
      briefHash: AUTHORING_CORPUS[1]!.expect.briefHash,
      status: 'awaiting_response',
      outcome: null,
      requests: null,
      httpAttempts: null,
      usage: 'UNKNOWN',
    });
    expect(third).toMatchObject({
      key: AUTHORING_CORPUS[2]!.key,
      status: 'unattempted',
      usage: 'NONE',
    });

    // The unknown entry's usage is not zero, and the budget claim is withheld.
    expect(manifest['observed']).toMatchObject({
      requests: 1,
      withinBudget: null,
      coverage: { status: 'PARTIAL', reported: 1, unknown: 1, notDispatched: 1 },
    });
    // The first run's artifacts really are on disk where the checkpoint says.
    expect(readdirSync(path.join(work, first!['artifacts'].dir))).toContain('validation-report.json');
  }, 90_000);
});
