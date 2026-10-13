import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Mutating filesystem primitives are wrapped so the spec can prove that an
 * inspection performs none of them (bundles are built before counting starts).
 */
const hooks = vi.hoisted(() => ({
  counting: false,
  mutations: [] as string[],
  providersConstructed: 0,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const wrapped: Record<string, unknown> = {};
  const MUTATING = [
    'writeFileSync',
    'appendFileSync',
    'mkdirSync',
    'rmSync',
    'rmdirSync',
    'renameSync',
    'unlinkSync',
    'copyFileSync',
    'cpSync',
    'writeSync',
    'ftruncateSync',
    'truncateSync',
    'symlinkSync',
    'utimesSync',
    'chmodSync',
  ] as const;
  for (const name of MUTATING) {
    const original = (actual as Record<string, unknown>)[name] as (...a: unknown[]) => unknown;
    wrapped[name] = (...args: unknown[]) => {
      if (hooks.counting) hooks.mutations.push(name);
      return original(...args);
    };
  }
  const openSync = actual.openSync as (...a: unknown[]) => number;
  wrapped['openSync'] = (...args: unknown[]) => {
    const flags = args[1];
    if (hooks.counting && flags !== undefined && flags !== 'r')
      hooks.mutations.push(`openSync:${String(flags)}`);
    return openSync(...args);
  };
  return { ...actual, ...wrapped };
});

vi.mock('../src/interactive/authoring/openai-provider', () => ({
  OpenAIScenarioDraftProvider: class {
    constructor() {
      hooks.providersConstructed += 1;
    }
  },
}));

import {
  awaitingResponseBundle,
  cloneBundle,
  completeBundle,
  providerStoppedBundle,
  recordingBundle,
  runFixture,
  type Bundle,
} from './experiment-bundles.fixture';
import { EXIT_CODES, runCli } from './inspect-interactive-experiment';
import { spawnPnpm } from './pnpm-spawn.fixture';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

let shared: string;
let bundles: {
  complete: Bundle;
  stopped: Bundle;
  awaiting: Bundle;
  recording: Bundle;
  /** Frozen at the instant a provider stop is durable but its artifacts are not. */
  haltedRecording: Bundle;
};
let tmp: string;
let out: string[];
let err: string[];
let counter = 0;
const io = () => ({ out: (l: string) => out.push(l), err: (l: string) => err.push(l) });

beforeAll(async () => {
  shared = mkdtempSync(path.join(tmpdir(), 'inspect-cli-shared-'));
  bundles = {
    complete: await completeBundle(path.join(shared, 'complete')),
    stopped: await providerStoppedBundle(path.join(shared, 'stopped')),
    awaiting: await awaitingResponseBundle(path.join(shared, 'awaiting')),
    recording: await recordingBundle(path.join(shared, 'recording')),
    haltedRecording: (await runFixture(path.join(shared, 'halted'), 'generation-provider-stop'))
      .haltedRecording!,
  };
});
afterAll(() => {
  rmSync(shared, { recursive: true, force: true });
});
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'inspect-cli-spec-'));
  out = [];
  err = [];
  hooks.counting = false;
  hooks.mutations = [];
  hooks.providersConstructed = 0;
});
afterEach(() => {
  hooks.counting = false;
  vi.unstubAllGlobals();
  rmSync(tmp, { recursive: true, force: true });
});

const copyOf = (bundle: Bundle): Bundle =>
  cloneBundle(bundle, path.join(tmp, `bundle-${counter++}`));

function digest(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        result[path.relative(root, full)] =
          createHash('sha256').update(readFileSync(full)).digest('hex') +
          `:${statSync(full).mtimeMs}`;
      }
    }
  };
  walk(root);
  return result;
}

describe('inspect-interactive-experiment: results', () => {
  it('prints exactly one JSON inspection for a complete experiment and exits 0', () => {
    const code = runCli(['--manifest', bundles.complete.manifestPath], io());
    expect(code).toBe(EXIT_CODES.OK);
    expect(err).toEqual([]);
    expect(out).toHaveLength(1);
    const result = JSON.parse(out[0]!);
    expect(result).toMatchObject({
      schema: 'interactive-authoring-experiment-inspection/v1',
      status: 'VALID',
      checkpoint: { state: 'FINAL' },
      completeness: { status: 'COMPLETE' },
      issues: [],
    });
  });

  it('exits 0 for a valid but incomplete checkpoint and keeps unknown usage unknown', () => {
    expect(runCli(['--manifest', bundles.awaiting.manifestPath], io())).toBe(EXIT_CODES.OK);
    const result = JSON.parse(out[0]!);
    expect(result.checkpoint.state).toBe('IN_PROGRESS');
    expect(result.entries[1]).toMatchObject({
      usage: 'UNKNOWN',
      requests: null,
      httpAttempts: null,
    });
    expect(result.observed).toMatchObject({ withinBudget: null, totalsAreLowerBound: true });
  });

  it.each([
    ['provider-stopped', () => bundles.stopped],
    ['recording', () => bundles.recording],
  ])('exits 0 for a %s bundle', (_name, pick) => {
    expect(runCli(['--manifest', pick().manifestPath], io())).toBe(EXIT_CODES.OK);
    expect(JSON.parse(out[0]!).status).toBe('VALID');
  });

  it('exits 0 for a frozen halted-recording bundle without claiming liveness or billing', () => {
    const bundle = copyOf(bundles.haltedRecording);
    const before = digest(bundle.dir);

    expect(runCli(['--manifest', bundle.manifestPath], io())).toBe(EXIT_CODES.OK);
    expect(err).toEqual([]);
    expect(out).toHaveLength(1);
    const result = JSON.parse(out[0]!);
    expect(result).toMatchObject({
      status: 'VALID',
      checkpoint: { state: 'IN_PROGRESS' },
      halt: { kind: 'PROVIDER_STOP', entry: 'harbour-ledger', reason: 'NETWORK' },
      issues: [],
    });
    expect(result.entries[1]).toMatchObject({
      status: 'recording',
      outcome: 'STOPPED',
      usage: 'REPORTED',
      requests: 1,
      httpAttempts: 1,
      stop: { kind: 'PROVIDER_STOP', reason: 'NETWORK' },
    });
    expect(result.entries[1].artifacts.state).toBe('NOT_RECORDED');
    expect(result.observed).toMatchObject({
      withinBudget: null,
      coverage: { status: 'PARTIAL' },
    });
    expect(out[0]).not.toMatch(/\bdead\b|crash|killed|terminated|is running|currently running/i);
    expect(result.evidenceLimits.join(' ')).toMatch(/billing/i);
    expect(digest(bundle.dir)).toEqual(before);
  });

  it('is deterministic byte for byte', () => {
    runCli(['--manifest', bundles.stopped.manifestPath], io());
    const first = out[0];
    out = [];
    runCli(['--manifest', bundles.stopped.manifestPath], io());
    expect(out[0]).toBe(first);
  });
});

describe('inspect-interactive-experiment: invalid input', () => {
  it('exits 1 with stable issue codes and no success-shaped result', () => {
    const bundle = copyOf(bundles.complete);
    const manifest = JSON.parse(readFileSync(bundle.manifestPath, 'utf8'));
    manifest.observed.requests += 1;
    writeFileSync(bundle.manifestPath, JSON.stringify(manifest));

    expect(runCli(['--manifest', bundle.manifestPath], io())).toBe(EXIT_CODES.INVALID);
    expect(out).toHaveLength(1);
    const result = JSON.parse(out[0]!);
    expect(result.status).toBe('INVALID');
    expect(result.issues).toContainEqual({ code: 'OBSERVED_TOTALS_MISMATCH' });
    for (const key of ['entries', 'observed', 'completeness', 'checkpoint', 'artifactChecks']) {
      expect(result).not.toHaveProperty(key);
    }
    expect(err.join('\n')).not.toContain(bundle.dir);
  });

  it.each([
    ['a missing file', () => path.join(tmp, 'missing', 'manifest.json')],
    ['a directory', () => tmp],
  ])('exits 1 for %s without echoing the path', (_name, target) => {
    const given = target();
    expect(runCli(['--manifest', given], io())).toBe(EXIT_CODES.INVALID);
    expect(JSON.parse(out[0]!).issues).toEqual([{ code: 'MANIFEST_UNREADABLE' }]);
    expect(out.join('') + err.join('')).not.toContain(given);
  });

  it('exits 1 for a missing referenced file', () => {
    const bundle = copyOf(bundles.complete);
    rmSync(path.join(bundle.dir, 'comparison-report.json'));
    expect(runCli(['--manifest', bundle.manifestPath], io())).toBe(EXIT_CODES.INVALID);
    expect(JSON.parse(out[0]!).issues).toEqual([{ code: 'ARTIFACT_MISSING' }]);
  });

  it('exits 1 for an unsupported schema', () => {
    const bundle = copyOf(bundles.complete);
    const manifest = JSON.parse(readFileSync(bundle.manifestPath, 'utf8'));
    manifest.schema = 'interactive-authoring-experiment-manifest/v1';
    writeFileSync(bundle.manifestPath, JSON.stringify(manifest));
    expect(runCli(['--manifest', bundle.manifestPath], io())).toBe(EXIT_CODES.INVALID);
    expect(JSON.parse(out[0]!).issues).toEqual([{ code: 'SCHEMA_UNSUPPORTED' }]);
  });

  it('does not leak credentials or raw exception text from hostile content', () => {
    const bundle = copyOf(bundles.complete);
    writeFileSync(bundle.manifestPath, '{"schema": "sk-live-secret-0123456789" ');
    expect(runCli(['--manifest', bundle.manifestPath], io())).toBe(EXIT_CODES.INVALID);
    const printed = out.join('\n') + err.join('\n');
    expect(printed).not.toContain('sk-live');
    expect(printed).not.toMatch(/SyntaxError|Unexpected token|at \w+ \(/);
  });
});

describe('inspect-interactive-experiment: usage errors', () => {
  it.each([
    ['no arguments', []],
    ['an unknown flag', ['--manifest', 'x', '--fix']],
    ['a positional argument', ['manifest.json']],
    ['a repeated flag', ['--manifest', 'a', '--manifest', 'b']],
    ['a missing value', ['--manifest']],
    ['a flag as value', ['--manifest', '--manifest']],
    ['an empty value', ['--manifest', '']],
    ['an equals form', ['--manifest=manifest.json']],
  ])('exits 2 for %s and prints nothing on stdout', (_name, argv) => {
    expect(runCli(argv, io())).toBe(EXIT_CODES.USAGE);
    expect(out).toEqual([]);
    expect(err.join('\n')).toContain('Usage: pnpm --silent inspect:interactive:experiment');
  });
});

describe('inspect-interactive-experiment: side effects', () => {
  it('performs no write, provider construction or network call', () => {
    const bundle = copyOf(bundles.awaiting);
    const complete = copyOf(bundles.complete);
    const before = { a: digest(bundle.dir), c: digest(complete.dir) };
    const fetchSpy = vi.fn(() => {
      throw new Error('network is not allowed');
    });
    vi.stubGlobal('fetch', fetchSpy);

    hooks.counting = true;
    runCli(['--manifest', bundle.manifestPath], io());
    runCli(['--manifest', complete.manifestPath], io());
    runCli(['--manifest', path.join(tmp, 'absent.json')], io());
    hooks.counting = false;

    expect(hooks.mutations).toEqual([]);
    expect(hooks.providersConstructed).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(digest(bundle.dir)).toEqual(before.a);
    expect(digest(complete.dir)).toEqual(before.c);
  });

  it('starts no work when imported', async () => {
    vi.resetModules();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitCode = process.exitCode;
    hooks.counting = true;
    try {
      const imported = await import('./inspect-interactive-experiment');
      expect(typeof imported.runCli).toBe('function');
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(exitCode);
      expect(hooks.mutations).toEqual([]);
    } finally {
      hooks.counting = false;
      log.mockRestore();
      error.mockRestore();
    }
  });
});

describe('inspect-interactive-experiment: the pnpm entry point', () => {
  const pnpm = (args: string[], cwd: string) =>
    spawnPnpm(args, {
      cwd,
      env: { ...process.env, OPENAI_API_KEY: '' },
      timeout: 180_000,
    });

  it('inspects a complete experiment from the repository root', () => {
    const result = pnpm(
      ['--silent', 'inspect:interactive:experiment', '--manifest', bundles.complete.manifestPath],
      REPO_ROOT,
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const inspection = JSON.parse(result.stdout);
    expect(inspection).toMatchObject({ status: 'VALID', completeness: { status: 'COMPLETE' } });
  }, 200_000);

  it('inspects an interrupted checkpoint from the API package and exits 0', () => {
    const result = pnpm(
      ['--silent', 'inspect:interactive:experiment', '--manifest', bundles.awaiting.manifestPath],
      path.join(REPO_ROOT, 'apps', 'api'),
    );
    expect(result.status).toBe(0);
    const inspection = JSON.parse(result.stdout);
    expect(inspection.checkpoint.state).toBe('IN_PROGRESS');
    expect(inspection.entries[1]).toMatchObject({ status: 'awaiting_response', usage: 'UNKNOWN' });
  }, 200_000);

  it('reports the completeness mismatch of an inconsistent bundle at a path with spaces and leaves it unchanged', () => {
    const bundle = cloneBundle(
      bundles.complete,
      path.join(tmp, 'a directory with spaces', `bundle-${counter++}`),
    );
    expect(bundle.manifestPath).toContain(' ');
    const inspect = () =>
      pnpm(
        ['--silent', 'inspect:interactive:experiment', '--manifest', bundle.manifestPath],
        REPO_ROOT,
      );

    // Positive control: the same readable path, before any tampering, inspects cleanly.
    // A quoting mistake would show up here as MANIFEST_UNREADABLE, not as a validation result.
    const control = inspect();
    expect(control.status).toBe(0);
    expect(JSON.parse(control.stdout)).toMatchObject({
      status: 'VALID',
      completeness: { status: 'COMPLETE' },
      issues: [],
    });

    const manifest = JSON.parse(readFileSync(bundle.manifestPath, 'utf8'));
    manifest.completeness.completed = 1;
    writeFileSync(bundle.manifestPath, JSON.stringify(manifest));
    const before = digest(bundle.dir);

    const invalid = inspect();
    // pnpm 9 reports every failed script as exit 1; the precise codes are checked on the
    // script process itself below.
    expect(invalid.status).not.toBe(0);
    const result = JSON.parse(invalid.stdout);
    expect(result.status).toBe('INVALID');
    expect(result.issues).toContainEqual({ code: 'COMPLETENESS_MISMATCH' });
    // An unreadable manifest is also INVALID; it must never be what satisfies this test.
    expect(result.issues).not.toContainEqual({ code: 'MANIFEST_UNREADABLE' });
    expect(digest(bundle.dir)).toEqual(before);
  }, 200_000);

  it('fails through pnpm for a usage error with nothing on stdout', () => {
    const usage = pnpm(['--silent', 'inspect:interactive:experiment'], REPO_ROOT);
    expect(usage.status).not.toBe(0);
    expect(usage.stdout).toBe('');
  }, 200_000);
});

describe('inspect-interactive-experiment: the script process', () => {
  const script = path.join(__dirname, 'inspect-interactive-experiment.ts');
  const run = (args: string[]) =>
    spawnSync(
      process.execPath,
      ['-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register', script, ...args],
      {
        cwd: path.resolve(__dirname, '..'),
        encoding: 'utf8',
        env: { ...process.env, TS_NODE_PROJECT: 'tsconfig.scripts.json', OPENAI_API_KEY: '' },
        timeout: 120_000,
      },
    );

  it('exits 0 for valid checkpoints, including an incomplete one', () => {
    expect(run(['--manifest', bundles.complete.manifestPath]).status).toBe(0);
    expect(run(['--manifest', bundles.awaiting.manifestPath]).status).toBe(0);
  }, 200_000);

  it('exits 1 for inconsistent input and 2 for a usage error', () => {
    const bundle = copyOf(bundles.complete);
    const manifest = JSON.parse(readFileSync(bundle.manifestPath, 'utf8'));
    manifest.completeness.completed = 1;
    writeFileSync(bundle.manifestPath, JSON.stringify(manifest));
    const invalid = run(['--manifest', bundle.manifestPath]);
    expect(invalid.status).toBe(1);
    expect(JSON.parse(invalid.stdout).status).toBe('INVALID');

    const usage = run([]);
    expect(usage.status).toBe(2);
    expect(usage.stdout).toBe('');
  }, 200_000);
});
