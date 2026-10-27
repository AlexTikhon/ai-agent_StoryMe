import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import test from 'node:test';
import {
  acceptsConnections,
  createDemo,
  defaultIsPortInUse,
  defaultStopProcessTree,
  DEMO,
  DEMO_PORTS,
  demoEnvironments,
  spawnOwned,
} from './demo-local.mjs';
import { TEST_TARGET } from './test-target-policy.mjs';

// ─── Real (no Docker) checks of the process/port primitives ─────────────────

test('the real port probe detects a listener and its release', async () => {
  const server = createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  assert.equal(await defaultIsPortInUse(port), true);
  await new Promise((done) => server.close(done));
  assert.equal(await defaultIsPortInUse(port), false);
});

test('the real tree stop removes an owned child and the grandchild it spawned', async () => {
  // Parent spawns a grandchild that holds a listening port, as pnpm -> nest/next do.
  const grandchild =
    "require('net').createServer().listen(0,'127.0.0.1',function(){console.log(this.address().port)})";
  const parent = `const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'inherit'});setInterval(()=>{},1000)`;
  const child = spawnOwned(process.execPath, ['-e', parent], {
    stdio: ['ignore', 'pipe', 'inherit'],
    shell: false,
  });
  const port = await new Promise((done, fail) => {
    child.stdout.once('data', (chunk) => done(Number(String(chunk).trim())));
    child.once('exit', () => fail(new Error('parent exited early')));
  });
  assert.equal(await acceptsConnections(port), true);
  await defaultStopProcessTree(child);
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'owned child exited');
  let listening = true;
  for (let attempt = 0; attempt < 50 && listening; attempt++) {
    listening = await acceptsConnections(port);
    if (listening) await new Promise((done) => setTimeout(done, 100));
  }
  assert.equal(listening, false, 'grandchild listener was stopped with the tree');
  // Idempotent: stopping an already-exited child is a no-op.
  await defaultStopProcessTree(child);
});

// ─── Lifecycle (injected seams) ─────────────────────────────────────────────

function fakeChild(name) {
  const child = new EventEmitter();
  child.name = name;
  child.pid = name === 'api' ? 101 : 202;
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

/** Records every lifecycle operation in order; nothing touches Docker or the network. */
function harness(overrides = {}) {
  const calls = [];
  const logs = [];
  const errors = [];
  const children = {};
  const ready = { api: true, web: true, ...overrides.ready };
  const syncStatus = { 'infra-up': 0, cleanup: 0, 'infra-down': 0, ...overrides.syncStatus };
  const options = {
    env: {
      PATH: 'C:\\bin',
      DATABASE_URL: 'postgresql://prod:secret@db.example.com:5432/storyme',
      REDIS_URL: 'redis://cache.example.com:6379/0',
      OPENAI_API_KEY: 'sk-live-should-not-leak',
      STRIPE_SECRET_KEY: 'sk_live_should_not_leak',
      STORY_GENERATION_PROVIDER: 'openai',
      AUTH_MODE: 'dev',
      ...overrides.env,
    },
    runSync: (mode, env) => {
      calls.push(`sync:${mode}`);
      assert.equal(env.DATABASE_URL, TEST_TARGET.databaseUrl);
      assert.equal(env.REDIS_URL, TEST_TARGET.redisUrl);
      return { status: syncStatus[mode] };
    },
    launchApi: (env) => {
      calls.push('launch:api');
      children.api = fakeChild('api');
      children.apiEnv = env;
      overrides.onLaunch?.('api', children.api);
      return children.api;
    },
    launchWeb: (env) => {
      calls.push('launch:web');
      children.web = fakeChild('web');
      children.webEnv = env;
      overrides.onLaunch?.('web', children.web);
      return children.web;
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
    probeHttp: async (url) => (url === DEMO.apiHealthUrl ? ready.api : ready.web),
    stopProcessTree: async (child) => {
      calls.push(`stop:${child.name}`);
      if (overrides.stopError === child.name) throw new Error('taskkill failed');
      child.exit(null, 'SIGTERM');
    },
    log: (message) => logs.push(message),
    logError: (message) => errors.push(message),
    readinessTimeoutMs: 40,
    pollIntervalMs: 2,
    childExitGraceMs: 0,
    ...overrides.options,
  };
  return { calls, logs, errors, children, ready, options };
}

const MUTATIONS = /^(sync|launch|stop):/;

test('the advertised credentials match the seeded synthetic account', () => {
  const fixtures = readFileSync(
    new URL('../apps/api/scripts/e2e-fixtures.ts', import.meta.url),
    'utf8',
  );
  assert.match(fixtures, /E2E_EMAIL_SUFFIX = '@e2e\.storyme\.test'/);
  assert.equal(DEMO.loginEmail, 'verified-login@e2e.storyme.test');
  assert.match(fixtures, /E2E_LOGIN_EMAIL = `verified-login\$\{E2E_EMAIL_SUFFIX\}`/);
  assert.ok(fixtures.includes(`E2E_LOGIN_PASSWORD = '${DEMO.loginPassword}'`));
});

test('child environments pin the mock/local/home configuration and drop credentials', () => {
  const { api, web, infra } = demoEnvironments({
    PATH: '/usr/bin',
    OPENAI_API_KEY: 'sk-live',
    ANTHROPIC_API_KEY: 'sk-ant',
    STRIPE_SECRET_KEY: 'sk_live',
    STRIPE_BILLING_ENABLED: 'true',
    PDF_STORAGE_DRIVER: 's3',
    PDF_STORAGE_SECRET_ACCESS_KEY: 'aws-secret',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    RESEND_API_KEY: 're_live',
    EMAIL_PROVIDER: 'resend',
    GITHUB_TOKEN: 'ghp_live',
    PGPASSWORD: 'pg',
    MOCK_FAILURE_STAGE: 'story',
    NEXT_PUBLIC_ENABLE_DEVELOPER_DIAGNOSTICS: 'true',
    DATABASE_URL: 'postgresql://prod@db.example.com/storyme',
  });

  for (const env of [api, web, infra]) {
    assert.equal(env.PATH, '/usr/bin');
    for (const key of [
      'ANTHROPIC_API_KEY',
      'STRIPE_SECRET_KEY',
      'PDF_STORAGE_SECRET_ACCESS_KEY',
      'RESEND_API_KEY',
    ]) {
      assert.ok(!env[key], `${key} must not carry an inherited value`);
    }
    assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.PGPASSWORD, undefined);
    assert.equal(env.MOCK_FAILURE_STAGE, undefined);
    assert.notEqual(env.OPENAI_API_KEY, 'sk-live');
  }
  assert.equal(web.DATABASE_URL, undefined);
  assert.equal(web.NEXT_PUBLIC_ENABLE_DEVELOPER_DIAGNOSTICS, undefined);
  assert.equal(infra.DATABASE_URL, TEST_TARGET.databaseUrl);

  assert.deepEqual(
    {
      DATABASE_URL: api.DATABASE_URL,
      REDIS_URL: api.REDIS_URL,
      PORT: api.PORT,
      AUTH_MODE: api.AUTH_MODE,
      PRODUCT_MODE: api.PRODUCT_MODE,
      NEXT_PUBLIC_PRODUCT_MODE: api.NEXT_PUBLIC_PRODUCT_MODE,
      STORY_GENERATION_PROVIDER: api.STORY_GENERATION_PROVIDER,
      CHARACTER_PROFILE_PROVIDER: api.CHARACTER_PROFILE_PROVIDER,
      IMAGE_GENERATION_PROVIDER: api.IMAGE_GENERATION_PROVIDER,
      PDF_STORAGE_DRIVER: api.PDF_STORAGE_DRIVER,
      IMAGE_STORAGE_DRIVER: api.IMAGE_STORAGE_DRIVER,
      EMAIL_PROVIDER: api.EMAIL_PROVIDER,
      STRIPE_BILLING_ENABLED: api.STRIPE_BILLING_ENABLED,
      ENABLE_GENERATION_WORKER: api.ENABLE_GENERATION_WORKER,
      ALLOWED_ORIGINS: api.ALLOWED_ORIGINS,
    },
    {
      DATABASE_URL: TEST_TARGET.databaseUrl,
      REDIS_URL: TEST_TARGET.redisUrl,
      PORT: '4100',
      AUTH_MODE: 'jwt',
      PRODUCT_MODE: 'home',
      NEXT_PUBLIC_PRODUCT_MODE: 'home',
      STORY_GENERATION_PROVIDER: 'mock',
      CHARACTER_PROFILE_PROVIDER: 'mock',
      IMAGE_GENERATION_PROVIDER: 'mock',
      PDF_STORAGE_DRIVER: 'local',
      IMAGE_STORAGE_DRIVER: 'local',
      EMAIL_PROVIDER: 'console',
      STRIPE_BILLING_ENABLED: 'false',
      ENABLE_GENERATION_WORKER: 'true',
      ALLOWED_ORIGINS: DEMO.webUrl,
    },
  );
  assert.ok(api.JWT_SECRET.length >= 32 && api.JWT_REFRESH_SECRET.length >= 32);
  // Present-but-inert so @nestjs/config cannot backfill them from apps/api/.env.
  for (const key of [
    'ANTHROPIC_API_KEY',
    'STRIPE_SECRET_KEY',
    'RESEND_API_KEY',
    'GOOGLE_CLIENT_SECRET',
  ]) {
    assert.equal(api[key], '');
  }
  assert.equal(api.OPENAI_API_KEY, 'storyme-demo-openai-disabled');
  assert.deepEqual(
    [
      web.NEXT_PUBLIC_API_URL,
      web.NEXT_PUBLIC_AUTH_MODE,
      web.PRODUCT_MODE,
      web.NEXT_PUBLIC_PRODUCT_MODE,
    ],
    [DEMO.apiUrl, 'jwt', 'home', 'home'],
  );
});

for (const [name, override] of [
  [
    'database port',
    { DATABASE_URL: 'postgresql://storyme:storyme_e2e@127.0.0.1:5432/storyme_e2e' },
  ],
  ['database name', { DATABASE_URL: 'postgresql://storyme:storyme_e2e@127.0.0.1:5440/storyme' }],
  ['redis database', { REDIS_URL: 'redis://127.0.0.1:6380/0' }],
  ['redis host', { REDIS_URL: 'redis://cache.example.com:6380/15' }],
]) {
  test(`a rejected ${name} stops before any probe or mutation`, async () => {
    const h = harness({
      options: {
        buildEnvironments: (base) => {
          const envs = demoEnvironments(base);
          return { ...envs, api: { ...envs.api, ...override } };
        },
      },
    });
    const status = await createDemo(h.options).start();
    assert.equal(status, 1);
    assert.deepEqual(h.calls, []);
    assert.match(h.errors.join('\n'), /must use the exact disposable host/);
  });
}

test('inherited production targets are replaced, not trusted', async () => {
  const h = harness({ options: { readinessTimeoutMs: 1000 } });
  const demo = createDemo(h.options);
  const running = demo.start();
  await waitFor(() => h.logs.some((line) => line.includes('is ready')));
  assert.equal(h.children.apiEnv.DATABASE_URL, TEST_TARGET.databaseUrl);
  assert.equal(h.children.apiEnv.STRIPE_SECRET_KEY, '');
  assert.equal(h.children.apiEnv.STORY_GENERATION_PROVIDER, 'mock');
  assert.equal(h.children.webEnv.REDIS_URL, undefined);
  await demo.shutdown(0);
  assert.equal(await running, 0);
});

for (const port of DEMO_PORTS) {
  test(`port ${port} already in use is refused without starting or stopping anything`, async () => {
    const h = harness({ busyPorts: [port] });
    const status = await createDemo(h.options).start();
    assert.equal(status, 1);
    assert.deepEqual(
      h.calls.filter((call) => MUTATIONS.test(call)),
      [],
    );
    assert.match(h.errors.join('\n'), new RegExp(`port\\(s\\) ${port} already in use`));
  });
}

test('an existing Compose project is refused; its containers are never torn down', async () => {
  const h = harness({ containers: ['abc123', 'def456'] });
  const status = await createDemo(h.options).start();
  assert.equal(status, 1);
  assert.ok(!h.calls.includes('sync:infra-down'));
  assert.deepEqual(
    h.calls.filter((call) => MUTATIONS.test(call)),
    [],
  );
  assert.match(h.errors.join('\n'), /already has 2 container\(s\)/);
});

test('docker unavailable is reported before any mutation', async () => {
  const h = harness({ dockerError: 'error during connect: pipe not found' });
  assert.equal(await createDemo(h.options).start(), 1);
  assert.deepEqual(
    h.calls.filter((call) => MUTATIONS.test(call)),
    [],
  );
  assert.match(h.errors.join('\n'), /Docker is not available/);
});

test('failed infrastructure startup tears down what it started and keeps the status', async () => {
  const h = harness({ syncStatus: { 'infra-up': 3 } });
  const status = await createDemo(h.options).start();
  assert.equal(status, 3);
  assert.deepEqual(
    h.calls.filter((call) => MUTATIONS.test(call)),
    ['sync:infra-up', 'sync:infra-down'],
  );
  assert.ok(!h.logs.some((line) => line.includes('is ready')));
});

test('readiness timeout stops both children, cleans up, and never announces readiness', async () => {
  const h = harness({ ready: { web: false } });
  const status = await createDemo(h.options).start();
  assert.equal(status, 1);
  assert.deepEqual(
    h.calls.filter((call) => MUTATIONS.test(call)),
    [
      'sync:infra-up',
      'launch:api',
      'launch:web',
      'stop:web',
      'stop:api',
      'sync:cleanup',
      'sync:infra-down',
    ],
  );
  assert.match(h.errors.join('\n'), /Web app did not become ready at http:\/\/127\.0\.0\.1:3100/);
  assert.ok(!h.logs.some((line) => line.includes('is ready')));
});

test('a child failing during startup preserves its exit status through cleanup', async () => {
  const h = harness({
    ready: { api: false },
    options: { readinessTimeoutMs: 5_000 },
    onLaunch: (name, child) => name === 'api' && setTimeout(() => child.exit(7), 5),
  });
  const status = await createDemo(h.options).start();
  assert.equal(status, 7);
  assert.match(h.errors.join('\n'), /API exited unexpectedly \(exit 7\)/);
  assert.deepEqual(
    h.calls.filter((call) => MUTATIONS.test(call)),
    [
      'sync:infra-up',
      'launch:api',
      'launch:web',
      'stop:web',
      'stop:api',
      'sync:cleanup',
      'sync:infra-down',
    ],
  );
});

test('a child failing after readiness shuts the demo down with a failure status', async () => {
  const h = harness();
  const running = createDemo(h.options).start();
  await waitFor(() => h.logs.some((line) => line.includes('is ready')));
  h.children.web.exit(1);
  assert.equal(await running, 1);
  assert.match(h.errors.join('\n'), /Web app exited unexpectedly/);
  assert.ok(h.calls.includes('sync:infra-down'));
});

test('readiness is announced only after both probes succeed, with URL and credentials', async () => {
  const h = harness({ ready: { api: false }, options: { readinessTimeoutMs: 5_000 } });
  const demo = createDemo(h.options);
  const running = demo.start();
  await new Promise((done) => setTimeout(done, 20));
  assert.ok(!h.logs.some((line) => line.includes('is ready')));
  h.ready.api = true;
  await waitFor(() => h.logs.some((line) => line.includes('is ready')));
  const banner = h.logs.find((line) => line.includes('is ready'));
  assert.ok(banner.includes(DEMO.webUrl));
  assert.ok(banner.includes(DEMO.loginEmail) && banner.includes(DEMO.loginPassword));
  assert.match(banner, /session-scoped/);
  await demo.shutdown(0);
  assert.equal(await running, 0);
});

test('shutdown is idempotent: repeated signals stop and clean up exactly once', async () => {
  const h = harness();
  const demo = createDemo(h.options);
  const running = demo.start();
  await waitFor(() => h.logs.some((line) => line.includes('is ready')));
  const [first, second, third] = [demo.shutdown(0), demo.shutdown(0), demo.shutdown(5)];
  assert.equal(first, second);
  assert.equal(second, third);
  assert.equal(await first, 0);
  assert.equal(await running, 0);
  for (const step of ['stop:web', 'stop:api', 'sync:cleanup', 'sync:infra-down']) {
    assert.equal(h.calls.filter((call) => call === step).length, 1, step);
  }
});

test('a signal during startup (children dying from Ctrl+C) exits cleanly, not as a failure', async () => {
  const h = harness({
    ready: { api: false, web: false },
    options: { readinessTimeoutMs: 5_000, childExitGraceMs: 20 },
  });
  const demo = createDemo(h.options);
  const running = demo.start();
  await waitFor(() => h.children.web);
  h.children.api.exit(1);
  h.children.web.exit(1);
  void demo.shutdown(0);
  assert.equal(await running, 0);
  assert.deepEqual(h.errors, []);
  assert.ok(h.calls.includes('sync:infra-down'));
});

test('cleanup failures are reported and turn a clean stop into a failure', async () => {
  const h = harness({ syncStatus: { 'infra-down': 1 }, leftoverPorts: [4100] });
  const demo = createDemo(h.options);
  const running = demo.start();
  await waitFor(() => h.logs.some((line) => line.includes('is ready')));
  assert.equal(await demo.shutdown(0), 1);
  assert.equal(await running, 1);
  const report = h.errors.join('\n');
  assert.match(report, /Disposable infrastructure teardown failed \(exit 1\)/);
  assert.match(report, /port\(s\) 4100 still listening/);
  assert.match(report, /pnpm test:infra:down/);
});

test('cleanup failure does not mask the original failure status', async () => {
  const h = harness({
    ready: { api: false },
    syncStatus: { cleanup: 2 },
    stopError: 'web',
    options: { readinessTimeoutMs: 5_000 },
    onLaunch: (name, child) => name === 'api' && setTimeout(() => child.exit(9), 5),
  });
  assert.equal(await createDemo(h.options).start(), 9);
  const report = h.errors.join('\n');
  assert.match(report, /stopping the web app: taskkill failed/);
  assert.match(report, /Synthetic fixture cleanup failed \(exit 2\)/);
  // A failed stop of one child or a failed cleanup never skips the later steps.
  assert.deepEqual(h.calls.filter((call) => /^(stop|sync):/.test(call)).slice(1), [
    'stop:web',
    'stop:api',
    'sync:cleanup',
    'sync:infra-down',
  ]);
});

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((done) => setTimeout(done, 2));
  }
}
