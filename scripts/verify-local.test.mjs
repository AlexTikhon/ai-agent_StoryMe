import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { TEST_TARGET } from './test-target-policy.mjs';
import { createVerifier, describeCommand, parseArguments, PROFILES } from './verify-local.mjs';

const launcher = (mode) => describeCommand({ launcher: mode });
const PREPARE = ['pnpm --filter @book/api prisma:generate', 'pnpm --filter @book/types build'];
const OFFLINE_COMMANDS = [
  ...PREPARE,
  'pnpm lint',
  'pnpm typecheck',
  'pnpm --filter @book/api typecheck:scripts',
  'pnpm test',
  'pnpm eval:story:offline',
  'pnpm eval:interactive:offline',
  'pnpm eval:interactive:authoring:offline',
];
const BROWSER_SUITE =
  'pnpm --filter @book/web test:e2e e2e/storyme.smoke.spec.ts e2e/interactive.spec.ts';
const LEAKED_SECRET = 'sk-live-should-not-leak';

function fakeChild(key) {
  const child = new EventEmitter();
  child.key = key;
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  child.exit = (code, signal = null) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.exitCode = code;
    child.signalCode = signal;
    child.emit('exit', code, signal);
  };
  return child;
}

/**
 * Records every probe and command in order; nothing touches Docker, a browser,
 * or a real process. `exits` maps a command to its exit code, `{ signal }`,
 * 'hang' (stays running until stopped or `onHang` ends it), 'spawn-error', or
 * 'throw' (the launch itself throws, as an unresolvable pnpm does).
 */
function harness(overrides = {}) {
  const calls = [];
  const logs = [];
  const errors = [];
  const envs = {};
  const exits = overrides.exits ?? {};
  const ref = {};
  const options = {
    env: {
      PATH: 'C:\\bin',
      DATABASE_URL: 'postgresql://prod:secret@db.example.com:5432/storyme',
      REDIS_URL: 'redis://cache.example.com:6379/0',
      OPENAI_API_KEY: LEAKED_SECRET,
      STRIPE_SECRET_KEY: LEAKED_SECRET,
      STORY_GENERATION_PROVIDER: 'openai',
      RUN_PAID_AI_EVALS: 'true',
      ...overrides.env,
    },
    launch: (command, env) => {
      const key = describeCommand(command);
      calls.push(`run:${key}`);
      envs[key] = env;
      const behavior = exits[key] ?? 0;
      if (behavior === 'throw') throw new Error('Unable to locate the pnpm CLI without a shell.');
      const child = fakeChild(key);
      if (behavior === 'hang') overrides.onHang?.(key, child, ref.verifier);
      else if (behavior === 'spawn-error') {
        setImmediate(() => child.emit('error', new Error('spawn ENOENT')));
      } else if (typeof behavior === 'object')
        setImmediate(() => child.exit(null, behavior.signal));
      else setImmediate(() => child.exit(behavior));
      return child;
    },
    stopProcessTree: async (child) => {
      calls.push(`stop:${child.key}`);
      if (overrides.stopError) throw new Error(overrides.stopError);
      child.exit(null, 'SIGTERM');
    },
    isPortInUse: async (port) => {
      calls.push(`port:${port}`);
      return (overrides.busyPorts ?? []).includes(port);
    },
    isPortListening: async (port) => (overrides.leftoverPorts ?? []).includes(port),
    listProjectContainers: async () => {
      calls.push('containers');
      if (overrides.dockerError) throw new Error(overrides.dockerError);
      return overrides.containers ?? [];
    },
    probeBrowser: async () => {
      calls.push('browser');
      return overrides.browser ?? { ok: true };
    },
    log: (message) => logs.push(message),
    logError: (message) => errors.push(message),
    cancelGraceMs: 0,
    ...overrides.options,
  };
  ref.verifier = createVerifier(options);
  return {
    calls,
    logs,
    errors,
    envs,
    verifier: ref.verifier,
    run: (argv) => ref.verifier.run(argv),
    commands: () => calls.filter((call) => call.startsWith('run:')).map((call) => call.slice(4)),
    summary: () => logs.at(-1),
    output: () => [...logs, ...errors].join('\n'),
  };
}

/** The summary row for a step: its fixed-width status and the reason line under it, if any. */
function row(summary, label) {
  const lines = summary.split('\n');
  const index = lines.findIndex(
    (line) => /^ {2}(PASS|FAIL|UNAVAILABLE|NOT RUN) /.test(line) && line.includes(`  ${label}`),
  );
  assert.ok(index >= 0, `no summary row for ${label}`);
  const next = lines[index + 1] ?? '';
  return {
    status: lines[index].slice(2, 13).trim(),
    reason: /^ {23}\S/.test(next) ? next.trim() : '',
  };
}

// ─── Arguments ──────────────────────────────────────────────────────────────

test('profile arguments: offline by default, both flag forms, and a pnpm "--" separator', () => {
  assert.deepEqual(parseArguments([]), { profile: 'offline' });
  assert.deepEqual(parseArguments(['--profile', 'integration']), { profile: 'integration' });
  assert.deepEqual(parseArguments(['--profile=browser']), { profile: 'browser' });
  assert.deepEqual(parseArguments(['--', '--profile', 'offline']), { profile: 'offline' });
});

for (const argv of [
  ['--profile', 'full'],
  ['--profile'],
  ['--profile', '--verbose'],
  ['--profile=', 'offline'],
  ['--profile', 'offline', '--profile', 'browser'],
  ['offline'],
  ['--skip-lint'],
  ['--profile', 'offline', 'extra'],
]) {
  test(`rejects ${JSON.stringify(argv)} before any probe or command`, async () => {
    const h = harness();
    assert.equal(await h.run(argv), 2);
    assert.deepEqual(h.calls, []);
    assert.match(h.errors.join('\n'), /Usage: pnpm verify:local/);
  });
}

// ─── Profile execution ──────────────────────────────────────────────────────

test('offline runs the CI checks in order with forced mock providers and no Docker', async () => {
  const h = harness();
  assert.equal(await h.run([]), 0);
  assert.deepEqual(h.commands(), OFFLINE_COMMANDS);
  assert.ok(!h.calls.some((call) => /^(port|containers|browser|stop)/.test(call)));

  for (const env of Object.values(h.envs)) {
    assert.equal(env.NODE_ENV, 'test');
    assert.equal(env.STORY_GENERATION_PROVIDER, 'mock');
    assert.equal(env.CHARACTER_PROFILE_PROVIDER, 'mock');
    assert.equal(env.IMAGE_GENERATION_PROVIDER, 'mock');
    assert.equal(env.RUN_PAID_AI_EVALS, 'false');
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.STRIPE_SECRET_KEY, undefined);
    assert.equal(env.DATABASE_URL, undefined);
    assert.equal(env.PATH, 'C:\\bin');
  }

  const summary = h.summary();
  assert.match(summary, /Profile: offline/);
  for (const command of OFFLINE_COMMANDS) assert.ok(summary.includes(`(${command})`), command);
  assert.equal(row(summary, 'Lint').status, 'PASS');
  assert.match(summary, /Result: PASS/);
  assert.match(summary, /production builds \(pnpm build/);
  assert.match(summary, /run --profile integration/);
  assert.ok(!h.output().includes(LEAKED_SECRET));
});

test('integration acquires infra after the read-only probes and always releases it', async () => {
  const h = harness();
  assert.equal(await h.run(['--profile', 'integration']), 0);
  assert.deepEqual(h.calls, [
    'port:5440',
    'port:6380',
    'containers',
    ...PREPARE.map((command) => `run:${command}`),
    `run:${launcher('infra-up')}`,
    `run:${launcher('integration')}`,
    `run:${launcher('infra-down')}`,
  ]);
  const suiteEnv = h.envs[launcher('integration')];
  assert.equal(suiteEnv.DATABASE_URL, TEST_TARGET.databaseUrl);
  assert.equal(suiteEnv.REDIS_URL, TEST_TARGET.redisUrl);
  assert.equal(suiteEnv.STORY_GENERATION_PROVIDER, 'mock');
  assert.equal(suiteEnv.RUN_PAID_AI_EVALS, 'false');
  assert.equal(suiteEnv.OPENAI_API_KEY, undefined);
  assert.ok(!h.commands().some((command) => /lint|typecheck|eval/.test(command)));
  assert.equal(row(h.summary(), 'Disposable PostgreSQL/Redis teardown').status, 'PASS');
  assert.match(h.summary(), /Result: PASS/);
});

test('browser runs the two journeys through Playwright and cleans up what it owns', async () => {
  const h = harness();
  assert.equal(await h.run(['--profile=browser']), 0);
  assert.deepEqual(h.calls, [
    'port:5440',
    'port:6380',
    'port:4100',
    'port:3100',
    'containers',
    'browser',
    ...PREPARE.map((command) => `run:${command}`),
    `run:${launcher('infra-up')}`,
    `run:${BROWSER_SUITE}`,
    `run:${launcher('cleanup')}`,
    `run:${launcher('infra-down')}`,
  ]);
  assert.ok(
    !h.commands().some((command) => /demo-local|interactive:demo|playwright install/.test(command)),
  );
  const suiteEnv = h.envs[BROWSER_SUITE];
  assert.equal(suiteEnv.DATABASE_URL, TEST_TARGET.databaseUrl);
  assert.equal(suiteEnv.OPENAI_API_KEY, 'storyme-demo-openai-disabled');
  assert.equal(suiteEnv.STRIPE_SECRET_KEY, '');
  assert.equal(suiteEnv.STORY_GENERATION_PROVIDER, 'mock');
  assert.equal(row(h.summary(), 'Owned server ports released').status, 'PASS');
  assert.ok(!h.output().includes(LEAKED_SECRET));
});

// ─── Fail-fast and exit status ──────────────────────────────────────────────

test('the first failure stops scheduling, keeps its exit status, and is summarized', async () => {
  const h = harness({ exits: { 'pnpm lint': 3 } });
  assert.equal(await h.run(['--profile', 'offline']), 3);
  assert.deepEqual(h.commands(), [...PREPARE, 'pnpm lint']);
  const summary = h.summary();
  assert.deepEqual(row(summary, 'Lint'), { status: 'FAIL', reason: 'exit 3' });
  assert.deepEqual(row(summary, 'Authoring offline eval'), {
    status: 'NOT RUN',
    reason: 'not scheduled: Lint did not pass',
  });
  assert.match(summary, /NOT RUN\s+-\s+Typecheck/);
  assert.match(summary, /Result: FAIL \(exit 3\)/);
  assert.match(summary, /- Lint \(FAIL\)/);
  assert.match(summary, /- Tests \(NOT RUN\)/);
});

test('a signal-killed command fails with 128 + signal number', async () => {
  const h = harness({ exits: { 'pnpm test': { signal: 'SIGKILL' } } });
  assert.equal(await h.run([]), 137);
  assert.equal(row(h.summary(), 'Tests').reason, 'signal SIGKILL');
});

test('an unresolvable pnpm or a spawn error is a failure, not a skip', async () => {
  const thrown = harness({ exits: { [PREPARE[0]]: 'throw' } });
  assert.equal(await thrown.run([]), 1);
  assert.match(row(thrown.summary(), 'Prisma client').reason, /could not start: Unable to locate/);
  assert.deepEqual(thrown.commands(), [PREPARE[0]]);

  const spawnError = harness({ exits: { 'pnpm typecheck': 'spawn-error' } });
  assert.equal(await spawnError.run([]), 1);
  assert.match(row(spawnError.summary(), 'Typecheck').reason, /failed to start: spawn ENOENT/);
});

// ─── Unavailable dependencies and ownership conflicts ───────────────────────

for (const profile of ['integration', 'browser']) {
  test(`${profile}: Docker unavailable is UNAVAILABLE and non-zero with nothing mutated`, async () => {
    const h = harness({ dockerError: 'error during connect: pipe not found\nmore detail' });
    assert.equal(await h.run(['--profile', profile]), 1);
    assert.deepEqual(h.commands(), []);
    const ownership = row(h.summary(), 'Disposable resource ownership');
    assert.equal(ownership.status, 'UNAVAILABLE');
    assert.match(
      ownership.reason,
      /Docker is not available \(error during connect: pipe not found\)/,
    );
    assert.match(
      row(h.summary(), 'Disposable PostgreSQL/Redis teardown').reason,
      /nothing to clean: this run started no infrastructure/,
    );
    assert.match(h.summary(), /Result: FAIL \(exit 1\)/);
  });
}

test('browser: every read-only probe still reports, so Docker and Chromium gaps show together', async () => {
  const h = harness({
    dockerError: 'pipe not found',
    browser: {
      ok: false,
      reason: "browserType.launch: Executable doesn't exist at C:\\pw\\chrome.exe",
    },
  });
  assert.equal(await h.run(['--profile', 'browser']), 1);
  assert.ok(h.calls.includes('browser'));
  assert.deepEqual(h.commands(), []);
  const chromium = row(h.summary(), 'Playwright Chromium');
  assert.equal(chromium.status, 'UNAVAILABLE');
  assert.match(chromium.reason, /Executable doesn't exist/);
  assert.match(chromium.reason, /never installs browsers/);
});

test('browser: a missing Chromium alone fails before any infrastructure starts', async () => {
  const h = harness({ browser: { ok: false, reason: "Executable doesn't exist" } });
  assert.equal(await h.run(['--profile', 'browser']), 1);
  assert.deepEqual(h.commands(), []);
  assert.ok(!h.output().includes('playwright install --with-deps'));
});

test('a running demo:local (all ports and the Compose project in use) is left untouched', async () => {
  for (const profile of ['integration', 'browser']) {
    const h = harness({ busyPorts: [5440, 6380, 4100, 3100], containers: ['abc', 'def'] });
    assert.equal(await h.run(['--profile', profile]), 1);
    assert.deepEqual(
      h.calls.filter((call) => /^(run|stop):/.test(call)),
      [],
    );
    const reason = row(h.summary(), 'Disposable resource ownership').reason;
    assert.match(reason, /already in use by another session/);
    assert.match(reason, /"storyme-integration" already has 2 container\(s\)/);
    assert.match(reason, /Nothing was started or stopped/);
  }
});

test('integration checks only its own ports; browser also refuses a busy API/web port', async () => {
  const integration = harness({ busyPorts: [3100] });
  assert.equal(await integration.run(['--profile', 'integration']), 0);

  const browser = harness({ busyPorts: [3100] });
  assert.equal(await browser.run(['--profile', 'browser']), 1);
  assert.match(row(browser.summary(), 'Disposable resource ownership').reason, /port\(s\) 3100/);
  assert.deepEqual(browser.commands(), []);
});

// ─── Cleanup ────────────────────────────────────────────────────────────────

test('a failing integration suite still tears down and keeps the suite status', async () => {
  const h = harness({ exits: { [launcher('integration')]: 5 } });
  assert.equal(await h.run(['--profile', 'integration']), 5);
  assert.equal(h.commands().at(-1), launcher('infra-down'));
  assert.equal(row(h.summary(), 'Disposable PostgreSQL/Redis teardown').status, 'PASS');
  assert.match(h.summary(), /Result: FAIL \(exit 5\)/);
});

test('a failed infrastructure start is torn down because it may be partial', async () => {
  const h = harness({ exits: { [launcher('infra-up')]: 4 } });
  assert.equal(await h.run(['--profile', 'integration']), 4);
  assert.deepEqual(h.commands().slice(-2), [launcher('infra-up'), launcher('infra-down')]);
  assert.equal(row(h.summary(), 'API integration suite').status, 'NOT RUN');
});

test('a cleanup failure turns an otherwise passing run into a failure', async () => {
  const h = harness({ exits: { [launcher('infra-down')]: 6 } });
  assert.equal(await h.run(['--profile', 'integration']), 6);
  assert.match(h.summary(), /Result: FAIL \(exit 6\)/);
  assert.match(h.summary(), /run: pnpm test:infra:down/);
});

test('a cleanup failure does not mask the original failure status', async () => {
  const h = harness({ exits: { [launcher('integration')]: 5, [launcher('infra-down')]: 6 } });
  assert.equal(await h.run(['--profile', 'integration']), 5);
  assert.equal(row(h.summary(), 'Disposable PostgreSQL/Redis teardown').reason, 'exit 6');
});

test('browser: a failed fixture cleanup never skips teardown; a leftover listener fails', async () => {
  const h = harness({ exits: { [launcher('cleanup')]: 2 }, leftoverPorts: [4100] });
  assert.equal(await h.run(['--profile', 'browser']), 2);
  assert.deepEqual(h.commands().slice(-2), [launcher('cleanup'), launcher('infra-down')]);
  const ports = row(h.summary(), 'Owned server ports released');
  assert.equal(ports.status, 'FAIL');
  assert.match(ports.reason, /port\(s\) 4100 still listening/);
});

test('browser: a failed suite still runs the scoped fixture cleanup and teardown', async () => {
  const h = harness({ exits: { [BROWSER_SUITE]: 1 } });
  assert.equal(await h.run(['--profile', 'browser']), 1);
  assert.deepEqual(h.commands().slice(-3), [
    BROWSER_SUITE,
    launcher('cleanup'),
    launcher('infra-down'),
  ]);
});

// ─── Cancellation ───────────────────────────────────────────────────────────

test('cancelling the integration suite stops it, tears down, and exits 130', async () => {
  const h = harness({
    exits: { [launcher('integration')]: 'hang' },
    onHang: (_key, _child, verifier) => setImmediate(() => verifier.cancel('SIGINT')),
  });
  assert.equal(await h.run(['--profile', 'integration']), 130);
  assert.deepEqual(h.calls.slice(-2), [
    `stop:${launcher('integration')}`,
    `run:${launcher('infra-down')}`,
  ]);
  const summary = h.summary();
  assert.match(row(summary, 'API integration suite').reason, /^interrupted by SIGINT/);
  assert.match(summary, /Result: CANCELLED by SIGINT \(exit 130\)/);
});

test('cancelling the browser run stops Playwright, then cleans fixtures and infra', async () => {
  const h = harness({
    exits: { [BROWSER_SUITE]: 'hang' },
    onHang: (_key, _child, verifier) => setImmediate(() => verifier.cancel('SIGTERM')),
  });
  assert.equal(await h.run(['--profile', 'browser']), 143);
  assert.deepEqual(h.calls.slice(-3), [
    `stop:${BROWSER_SUITE}`,
    `run:${launcher('cleanup')}`,
    `run:${launcher('infra-down')}`,
  ]);
});

test('cancelling before infrastructure is acquired starts and tears down nothing', async () => {
  const h = harness({
    exits: { [PREPARE[0]]: 'hang' },
    onHang: (_key, _child, verifier) => setImmediate(() => verifier.cancel('SIGINT')),
  });
  assert.equal(await h.run(['--profile', 'integration']), 130);
  assert.deepEqual(h.commands(), [PREPARE[0]]);
  assert.equal(row(h.summary(), 'Shared types build').reason, 'cancelled by SIGINT');
  assert.match(row(h.summary(), 'Disposable PostgreSQL/Redis teardown').reason, /nothing to clean/);
});

test('a child dying from Ctrl+C before the signal handler runs is still a cancellation', async () => {
  const h = harness({
    exits: { 'pnpm test': 'hang' },
    options: { cancelGraceMs: 50 },
    onHang: (_key, child, verifier) => {
      setImmediate(() => child.exit(1));
      setTimeout(() => verifier.cancel('SIGINT'), 5);
    },
  });
  assert.equal(await h.run([]), 130);
  assert.equal(row(h.summary(), 'Tests').reason, 'interrupted by SIGINT (exit 1)');
  assert.ok(!h.calls.some((call) => call.startsWith('stop:')));
});

test('a second signal never interrupts cleanup', async () => {
  const h = harness({
    exits: { [launcher('integration')]: 'hang', [launcher('infra-down')]: 'hang' },
    onHang: (key, child, verifier) => {
      setImmediate(() => verifier.cancel('SIGINT'));
      if (key === launcher('infra-down')) setTimeout(() => child.exit(0), 5);
    },
  });
  assert.equal(await h.run(['--profile', 'integration']), 130);
  assert.ok(!h.calls.includes(`stop:${launcher('infra-down')}`));
  assert.match(h.output(), /Cancellation already in progress/);
  assert.equal(row(h.summary(), 'Disposable PostgreSQL/Redis teardown').status, 'PASS');
});

test('a failed stop of the interrupted process is reported as a cleanup failure', async () => {
  const h = harness({
    exits: { [launcher('integration')]: 'hang' },
    stopError: 'taskkill failed',
    onHang: (_key, child, verifier) => {
      setImmediate(() => verifier.cancel('SIGINT'));
      setTimeout(() => child.exit(1), 5);
    },
  });
  assert.equal(await h.run(['--profile', 'integration']), 130);
  assert.equal(row(h.summary(), 'Stop interrupted process tree').reason, 'taskkill failed');
  assert.equal(h.commands().at(-1), launcher('infra-down'));
});

test('every profile step is a known kind and every cleanup names what it owns', () => {
  for (const profile of Object.values(PROFILES)) {
    for (const step of profile.steps) {
      assert.ok(['command', 'ownership', 'browser'].includes(step.kind), step.label);
    }
    for (const step of profile.cleanup) assert.ok(['infra', 'servers'].includes(step.when));
    assert.ok(profile.outOfScope.length > 0);
  }
});
