import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTHORING_CORPUS } from '../src/interactive/authoring/corpus';
import { scenarioToWire } from '../src/interactive/authoring/wire';

// Counts adapter constructions; the real class is otherwise untouched.
const constructed = vi.hoisted(() => ({ count: 0 }));
vi.mock('../src/interactive/authoring/openai-provider', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/interactive/authoring/openai-provider')>();
  class Counting extends mod.OpenAIScenarioDraftProvider {
    constructor(options: ConstructorParameters<typeof mod.OpenAIScenarioDraftProvider>[0]) {
      super(options);
      constructed.count += 1;
    }
  }
  return { ...mod, OpenAIScenarioDraftProvider: Counting };
});

import { EXIT_CODES, runCli } from './experiment-interactive-authoring';

const SECRET = 'sk-experiment-cli-secret-0123456789';
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const API_ROOT = path.resolve(__dirname, '..');

let tmp: string;
let draftsRoot: string;
let out: string[];
let err: string[];
let fetchSpy: ReturnType<typeof vi.fn>;

const io = () => ({ out: (l: string) => out.push(l), err: (l: string) => err.push(l) });
const stdout = () => out.join('\n');
const stderr = () => err.join('\n');

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'authoring-experiment-cli-'));
  draftsRoot = path.join(tmp, 'scenario-drafts');
  out = [];
  err = [];
  constructed.count = 0;
  fetchSpy = vi.fn(() => Promise.reject(new Error('network is off in this test')));
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // Only the directory this test created (guarded by prefix and location).
  if (tmp.startsWith(tmpdir()) && path.basename(tmp).startsWith('authoring-experiment-cli-')) {
    rmSync(tmp, { recursive: true, force: true });
  }
});

function digest(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else
        result[path.relative(root, full)] = createHash('sha256')
          .update(readFileSync(full))
          .digest('hex');
    }
  };
  if (existsSync(root)) walk(root);
  return result;
}
const treeOf = (root: string): string[] => Object.keys(digest(root)).sort();

const deps = (extra: Record<string, unknown> = {}) => ({
  defaultDraftsRoot: draftsRoot,
  now: new Date(Date.UTC(2026, 9, 12, 12, 0, 0)),
  ...extra,
});

const completion = (content: string) =>
  new Response(
    JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content } }],
      usage: { prompt_tokens: 1200, completion_tokens: 900 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );

const manifestOf = (dirLine: string) =>
  JSON.parse(readFileSync(path.join(dirLine, 'manifest.json'), 'utf8')) as Record<string, any>;
const experimentDir = (): string => {
  const line = out.find((l) => l.startsWith('Experiment: '));
  if (!line) throw new Error('no experiment directory was reported');
  return line.slice('Experiment: '.length);
};

// ── plan ────────────────────────────────────────────────────────────────────

describe('plan mode (default)', () => {
  it('prints one versioned JSON plan and performs no calls, constructions or writes', async () => {
    const before = treeOf(tmp);
    const code = await runCli([], { OPENAI_API_KEY: SECRET }, io(), undefined, deps());
    expect(code).toBe(EXIT_CODES.OK);
    expect(out).toHaveLength(1);
    const plan = JSON.parse(out[0]!) as Record<string, any>;
    expect(plan['schema']).toBe('interactive-authoring-experiment-plan/v1');
    expect(plan['executes']).toBe(false);
    expect(plan['budget'].maxRequests).toBe(6);
    expect(plan['entries']).toHaveLength(3);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(constructed.count).toBe(0);
    expect(treeOf(tmp)).toEqual(before);
    expect(existsSync(draftsRoot)).toBe(false);
    expect(stdout()).not.toContain(SECRET);
    expect(stderr()).toBe('');
  });

  it('reports a selected model without needing or reading a key', async () => {
    const code = await runCli(['--mode', 'plan', '--model', 'model-x'], {}, io(), undefined, deps());
    expect(code).toBe(EXIT_CODES.OK);
    expect(JSON.parse(out[0]!)['selectedModel']).toBe('model-x');
    expect(constructed.count).toBe(0);
  });

  it('derives the plan budget from configured limits', async () => {
    await runCli(
      ['--max-output-tokens', '2000', '--deadline-ms', '60000'],
      {},
      io(),
      undefined,
      deps(),
    );
    const plan = JSON.parse(out[0]!) as Record<string, any>;
    expect(plan['budget'].maxOutputTokens).toBe(3 * 2 * 2000);
    expect(plan['budget'].maxRuntimeMs).toBe(3 * 60000);
  });
});

// ── gates ───────────────────────────────────────────────────────────────────

describe('paid gates', () => {
  const refusals: Array<[string, string[], NodeJS.ProcessEnv]> = [
    ['no paid flag', ['--mode', 'openai', '--model', 'm1'], { OPENAI_API_KEY: SECRET }],
    ['no model', ['--mode', 'openai', '--allow-paid-calls'], { OPENAI_API_KEY: SECRET }],
    ['no key', ['--mode', 'openai', '--allow-paid-calls', '--model', 'm1'], {}],
    ['paid flag without openai', ['--allow-paid-calls', '--model', 'm1'], { OPENAI_API_KEY: SECRET }],
    ['key and model env only', [], { OPENAI_API_KEY: SECRET, INTERACTIVE_AUTHORING_MODEL: 'm1' }],
  ];

  it.each(refusals.slice(0, 4))(
    'refuses before any side effect: %s',
    async (_label, argv, env) => {
      const code = await runCli(argv, env, io(), undefined, deps());
      expect(code).toBe(EXIT_CODES.USAGE);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(constructed.count).toBe(0);
      expect(existsSync(draftsRoot)).toBe(false);
      expect(treeOf(tmp)).toEqual([]);
      expect(stdout() + stderr()).not.toContain(SECRET);
    },
  );

  it('an API key and model in the environment alone never execute anything', async () => {
    const [, , env] = refusals[4]!;
    const code = await runCli([], env, io(), undefined, deps());
    expect(code).toBe(EXIT_CODES.OK);
    expect(JSON.parse(out[0]!)['executes']).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(constructed.count).toBe(0);
    expect(existsSync(draftsRoot)).toBe(false);
  });

  it('rejects a drafts root outside the convention before doing anything', async () => {
    const code = await runCli(
      ['--mode', 'offline', '--drafts-root', path.join(tmp, 'elsewhere')],
      {},
      io(),
      undefined,
      deps(),
    );
    expect(code).toBe(EXIT_CODES.USAGE);
    expect(treeOf(tmp)).toEqual([]);
  });
});

// ── offline ─────────────────────────────────────────────────────────────────

describe('offline mode', () => {
  it('runs all three corpus briefs with scripted fixtures and says it is harness verification', async () => {
    const code = await runCli(['--mode', 'offline'], { OPENAI_API_KEY: SECRET }, io(), undefined, deps());
    expect(code).toBe(EXIT_CODES.OK);
    expect(stdout()).toMatch(/HARNESS VERIFICATION ONLY/);
    expect(stdout()).toMatch(/not model performance/i);
    for (const entry of AUTHORING_CORPUS) expect(stdout()).toContain(entry.key);
    expect(stdout()).toMatch(/Completeness: COMPLETE/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(constructed.count).toBe(0);

    const dir = experimentDir();
    expect(path.dirname(dir)).toBe(draftsRoot);
    const manifest = manifestOf(dir);
    expect(manifest['completeness'].status).toBe('COMPLETE');
    expect(manifest['entries'].map((e: any) => e.outcome)).toEqual([
      'REVIEW_REQUIRED',
      'REVIEW_REQUIRED',
      'REVIEW_REQUIRED',
    ]);
    expect(stdout()).not.toContain(SECRET);
  });

  it('writes only inside a fresh directory and leaves earlier artifacts untouched', async () => {
    mkdirSync(draftsRoot, { recursive: true });
    const earlier = path.join(draftsRoot, '20260101T000000Z-earlier--review-required');
    mkdirSync(earlier);
    writeFileSync(path.join(earlier, 'validated-candidate.json'), '{"earlier":true}\n');
    const before = digest(draftsRoot);

    await runCli(['--mode', 'offline'], {}, io(), undefined, deps());
    const after = digest(draftsRoot);
    for (const [file, hash] of Object.entries(before)) expect(after[file]).toBe(hash);
    expect(Object.keys(after).length).toBeGreaterThan(Object.keys(before).length);
  });

  it('exits 1 and prints stable codes when an interruption leaves work unfinished', async () => {
    const controller = new AbortController();
    controller.abort();
    const code = await runCli(['--mode', 'offline'], {}, io(), controller.signal, deps());
    expect(code).toBe(EXIT_CODES.INCOMPLETE);
    expect(stdout()).toMatch(/Completeness: INCOMPLETE/);
    expect(stdout()).toMatch(/CANCELLED/);
    expect(manifestOf(experimentDir())['entries'].every((e: any) => e.status === 'unattempted')).toBe(true);
  });
});

// ── openai (injected transport only) ────────────────────────────────────────

describe('openai mode (intercepted transport)', () => {
  const argv = ['--mode', 'openai', '--allow-paid-calls', '--model', 'test-model-1'];
  const env = { OPENAI_API_KEY: SECRET };

  const variation = (index: number): string => {
    const wire = structuredClone(scenarioToWire(AUTHORING_CORPUS[index]!.scenario));
    wire.title = `${wire.title} (generated variation)`;
    return JSON.stringify(wire);
  };

  it('sends exactly one request per brief through the injected fetch and never the global one', async () => {
    let call = 0;
    const injected = vi.fn(async () => completion(variation(call++)));
    const code = await runCli(argv, env, io(), undefined, deps({ fetchImpl: injected }));
    expect(code).toBe(EXIT_CODES.OK);
    expect(injected).toHaveBeenCalledTimes(3);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(constructed.count).toBe(1);

    const manifest = manifestOf(experimentDir());
    expect(manifest['configuration'].model).toBe('test-model-1');
    expect(manifest['configuration'].provider).toBe('openai');
    expect(manifest['observed']).toMatchObject({ requests: 3, httpAttempts: 3, withinBudget: true });
    expect(manifest['completeness'].status).toBe('COMPLETE');
    // Generated variations are validated against their brief, not fixture hashes.
    expect(manifest['entries'].map((e: any) => e.outcome)).toEqual([
      'REVIEW_REQUIRED',
      'REVIEW_REQUIRED',
      'REVIEW_REQUIRED',
    ]);
    expect(stdout()).toContain('PAID');
    expect(stdout() + stderr()).not.toContain(SECRET);
    expect(JSON.stringify(manifest)).not.toContain(SECRET);
  });

  it('keeps content repair inside six HTTP attempts and never retries transport', async () => {
    const bad = (index: number): string => {
      const wire = structuredClone(scenarioToWire(AUTHORING_CORPUS[index]!.scenario));
      wire.scenes.flatMap((s) => s.choices)[0]!.to = 's-missing';
      return JSON.stringify(wire);
    };
    // brief 0 repairs, brief 1 is rejected after repair, brief 2 is clean.
    const responses = [bad(0), variation(0), bad(1), bad(1), variation(2)];
    const injected = vi.fn(async () => completion(responses.shift()!));
    const code = await runCli(argv, env, io(), undefined, deps({ fetchImpl: injected }));
    expect(code).toBe(EXIT_CODES.OK);
    expect(injected).toHaveBeenCalledTimes(5);
    const manifest = manifestOf(experimentDir());
    expect(manifest['observed'].httpAttempts).toBeLessThanOrEqual(6);
    expect(manifest['entries'].map((e: any) => e.outcome)).toEqual([
      'REVIEW_REQUIRED',
      'REJECTED',
      'REVIEW_REQUIRED',
    ]);
  });

  it('stops after a transport failure: no retry and no later brief', async () => {
    const injected = vi.fn(async () => new Response('{"error":"rate limited"}', { status: 429 }));
    const code = await runCli(argv, env, io(), undefined, deps({ fetchImpl: injected }));
    expect(code).toBe(EXIT_CODES.INCOMPLETE);
    expect(injected).toHaveBeenCalledTimes(1);
    const manifest = manifestOf(experimentDir());
    expect(manifest['entries'].map((e: any) => e.status)).toEqual([
      'stopped',
      'unattempted',
      'unattempted',
    ]);
    expect(manifest['halt']).toMatchObject({ kind: 'PROVIDER_STOP', reason: 'RATE_LIMITED' });
    expect(stdout() + stderr()).not.toContain('rate limited');
    expect(stdout() + stderr()).not.toContain(SECRET);
  });

  it('aborts on interruption and starts no further brief', async () => {
    const controller = new AbortController();
    const injected = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    );
    const pending = runCli(argv, env, io(), controller.signal, deps({ fetchImpl: injected }));
    await vi.waitFor(() => expect(injected).toHaveBeenCalledTimes(1));
    controller.abort();
    expect(await pending).toBe(EXIT_CODES.INCOMPLETE);
    expect(injected).toHaveBeenCalledTimes(1);
    const manifest = manifestOf(experimentDir());
    expect(manifest['halt'].kind).toBe('CANCELLED');
    expect(manifest['entries'].map((e: any) => e.status)).toEqual([
      'stopped',
      'unattempted',
      'unattempted',
    ]);
  });
});

// ── import safety ───────────────────────────────────────────────────────────

describe('importing the CLI', () => {
  it('starts no work, installs no handlers and touches no filesystem or network', async () => {
    vi.resetModules();
    const once = vi.spyOn(process, 'once');
    const before = treeOf(tmp);
    const mod = await import('./experiment-interactive-authoring');
    expect(typeof mod.runCli).toBe('function');
    expect(once).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(treeOf(tmp)).toEqual(before);
    expect(out).toEqual([]);
  });
});

// ── real pnpm entry points ──────────────────────────────────────────────────

describe('pnpm entry points', () => {
  const quote = (arg: string) => (/[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg);
  const pnpm = (args: string[], env: NodeJS.ProcessEnv = {}) => {
    const result = spawnSync(['pnpm', ...args].map(quote).join(' '), {
      cwd: REPO_ROOT,
      shell: true,
      encoding: 'utf8',
      timeout: 170_000,
      env: {
        ...process.env,
        OPENAI_API_KEY: undefined,
        INTERACTIVE_AUTHORING_MODEL: undefined,
        ...env,
      } as NodeJS.ProcessEnv,
    });
    return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  const defaultDrafts = path.join(API_ROOT, 'scenario-drafts');
  const listing = () => (existsSync(defaultDrafts) ? readdirSync(defaultDrafts).sort() : null);

  it('root plan prints the plan and writes nothing, even with a key in the environment', () => {
    const before = { tmp: treeOf(tmp), drafts: listing() };
    const result = pnpm(['--silent', 'experiment:interactive:authoring'], { OPENAI_API_KEY: SECRET });
    expect(result.code).toBe(0);
    const plan = JSON.parse(result.stdout) as Record<string, any>;
    expect(plan['schema']).toBe('interactive-authoring-experiment-plan/v1');
    expect(plan['executes']).toBe(false);
    expect(result.stdout + result.stderr).not.toContain(SECRET);
    expect({ tmp: treeOf(tmp), drafts: listing() }).toEqual(before);
  }, 180_000);

  it('root offline run writes a complete experiment into a test-owned drafts root', () => {
    mkdirSync(draftsRoot, { recursive: true });
    const earlier = path.join(draftsRoot, '20260101T000000Z-earlier--rejected');
    mkdirSync(earlier);
    writeFileSync(path.join(earlier, 'run-report.json'), '{"earlier":true}\n');
    const before = digest(draftsRoot);
    const defaultBefore = listing();

    const result = pnpm(
      ['experiment:interactive:authoring', '--mode', 'offline', '--drafts-root', draftsRoot],
      { OPENAI_API_KEY: SECRET },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/HARNESS VERIFICATION ONLY/);
    expect(result.stdout + result.stderr).not.toContain(SECRET);

    const after = digest(draftsRoot);
    for (const [file, hash] of Object.entries(before)) expect(after[file]).toBe(hash);
    const created = readdirSync(draftsRoot).filter((n) => n.includes('authoring-experiment'));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatch(/--complete$/);
    const manifest = manifestOf(path.join(draftsRoot, created[0]!));
    expect(manifest['completeness'].status).toBe('COMPLETE');
    expect(manifest['entries']).toHaveLength(3);
    expect(listing()).toEqual(defaultBefore);
  }, 180_000);

  it('the API package entry point refuses an ungated paid run without side effects', () => {
    const result = pnpm(
      ['--dir', 'apps/api', 'experiment:interactive:authoring', '--mode', 'openai', '--model', 'm1', '--drafts-root', draftsRoot],
      { OPENAI_API_KEY: SECRET },
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--allow-paid-calls');
    expect(result.stdout + result.stderr).not.toContain(SECRET);
    expect(existsSync(draftsRoot)).toBe(false);
  }, 180_000);
});
