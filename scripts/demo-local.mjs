import { spawn, spawnSync } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePnpmInvocation } from './pnpm-invocation.mjs';
import { launchTestCommand, runTestCommandSync } from './test-launcher.mjs';
import { assertDisposableTestTargets, TEST_TARGET } from './test-target-policy.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const DEMO = Object.freeze({
  apiPort: 4100,
  webPort: 3100,
  webUrl: 'http://127.0.0.1:3100',
  apiUrl: 'http://127.0.0.1:4100/api',
  apiHealthUrl: 'http://127.0.0.1:4100/api/health',
  // Same project name test-infra-entry.mjs uses for the disposable stack.
  composeProject: 'storyme-integration',
  // Must match apps/api/scripts/e2e-fixtures.ts (asserted by demo-local.test.mjs).
  loginEmail: 'verified-login@e2e.storyme.test',
  loginPassword: 'StoryMeE2E1!',
});

/** Every resource the disposable stack binds. Any one in use means another session owns it. */
export const DEMO_PORTS = Object.freeze([
  Number(TEST_TARGET.databasePort),
  Number(TEST_TARGET.redisPort),
  DEMO.apiPort,
  DEMO.webPort,
]);

// Inherited values that could point a child at a real service or carry a
// credential. They are dropped before the explicit demo settings are applied.
const INHERITED_SECRET = /(_API_KEY|SECRET|_TOKEN|PASSWORD|_ACCESS_KEY)/i;
const INHERITED_SERVICE =
  /^(OPENAI|ANTHROPIC|FAL|STRIPE|RESEND|EMAIL|GOOGLE|R2|AWS|PDF_STORAGE|IMAGE_STORAGE|MOCK|DATABASE|REDIS|NEXT_PUBLIC)_|^PG[A-Z]*$/i;

// @nestjs/config copies apps/api/.env values into process.env for every key the
// child does not already define, so stripping is not enough: each credential the
// schema accepts is pinned to an inert value. OPENAI_API_KEY must be non-empty to
// pass validation; it is only read when a provider is "openai", never here.
const API_CREDENTIAL_BLOCKS = Object.freeze({
  OPENAI_API_KEY: 'storyme-demo-openai-disabled',
  ANTHROPIC_API_KEY: '',
  FAL_API_KEY: '',
  RESEND_API_KEY: '',
  STRIPE_SECRET_KEY: '',
  STRIPE_WEBHOOK_SECRET: '',
  STRIPE_PRICE_ID_STARTER: '',
  STRIPE_PRICE_ID_PRO: '',
  STRIPE_PRICE_ID_BUNDLE: '',
  GOOGLE_CLIENT_ID: '',
  GOOGLE_CLIENT_SECRET: '',
  R2_ACCOUNT_ID: '',
  R2_ACCESS_KEY_ID: '',
  R2_SECRET_ACCESS_KEY: '',
  R2_BUCKET_NAME: '',
  PDF_STORAGE_BUCKET: '',
  PDF_STORAGE_ACCESS_KEY_ID: '',
  PDF_STORAGE_SECRET_ACCESS_KEY: '',
});

function inheritedEnvironment(base) {
  return Object.fromEntries(
    Object.entries(base).filter(
      ([key, value]) =>
        value !== undefined && !INHERITED_SECRET.test(key) && !INHERITED_SERVICE.test(key),
    ),
  );
}

/** Child environments for the disposable infra, the API (+ embedded worker), and web. */
export function demoEnvironments(base = process.env) {
  const inherited = inheritedEnvironment(base);
  const targets = { DATABASE_URL: TEST_TARGET.databaseUrl, REDIS_URL: TEST_TARGET.redisUrl };
  const productMode = { PRODUCT_MODE: 'home', NEXT_PUBLIC_PRODUCT_MODE: 'home' };
  return {
    infra: { ...inherited, ...targets },
    api: {
      ...inherited,
      ...API_CREDENTIAL_BLOCKS,
      ...targets,
      ...productMode,
      NODE_ENV: 'development',
      PORT: String(DEMO.apiPort),
      AUTH_MODE: 'jwt',
      JWT_SECRET: 'storyme-local-demo-jwt-secret-synthetic-only',
      JWT_REFRESH_SECRET: 'storyme-local-demo-refresh-secret-synthetic-only',
      // Every full page load restores the session through /auth/refresh, which
      // has a per-IP budget of 30 per 15 minutes by default.
      AUTH_RATE_LIMIT_IP_MAX_ATTEMPTS: '300',
      ALLOWED_ORIGINS: DEMO.webUrl,
      WEB_APP_URL: DEMO.webUrl,
      STORY_GENERATION_PROVIDER: 'mock',
      CHARACTER_PROFILE_PROVIDER: 'mock',
      IMAGE_GENERATION_PROVIDER: 'mock',
      MOCK_FAILURES_ENABLED: 'false',
      STORY_REPAIR_ENABLED: 'false',
      RUN_PAID_AI_EVALS: 'false',
      PDF_STORAGE_DRIVER: 'local',
      IMAGE_STORAGE_DRIVER: 'local',
      EMAIL_PROVIDER: 'console',
      STRIPE_BILLING_ENABLED: 'false',
      ENABLE_GENERATION_WORKER: 'true',
    },
    web: {
      ...inherited,
      ...productMode,
      NODE_ENV: 'development',
      NEXT_PUBLIC_API_URL: DEMO.apiUrl,
      NEXT_PUBLIC_APP_URL: DEMO.webUrl,
      NEXT_PUBLIC_AUTH_MODE: 'jwt',
      NEXT_TELEMETRY_DISABLED: '1',
    },
  };
}

class DemoFailure extends Error {
  constructor(message, status = 1) {
    super(message);
    this.status = status;
  }
}

function describeExit(code, signal) {
  return code === null || code === undefined ? `signal ${signal ?? 'unknown'}` : `exit ${code}`;
}

function childAlive(child) {
  return child.exitCode === null && child.signalCode === null;
}

/**
 * The demo lifecycle with every process/probe operation injectable:
 * validate -> preflight (read-only) -> infra-up -> API (migrate, seed, serve)
 * + web -> bounded readiness -> run until shutdown. `shutdown` is idempotent
 * and only touches what this instance started.
 */
export function createDemo(options = {}) {
  const env = options.env ?? process.env;
  const buildEnvironments = options.buildEnvironments ?? demoEnvironments;
  const runSync = options.runSync ?? defaultRunSync;
  const launchApi = options.launchApi ?? defaultLaunchApi;
  const launchWeb = options.launchWeb ?? defaultLaunchWeb;
  const isPortInUse = options.isPortInUse ?? defaultIsPortInUse;
  const isPortListening = options.isPortListening ?? acceptsConnections;
  const listProjectContainers = options.listProjectContainers ?? defaultListProjectContainers;
  const probeHttp = options.probeHttp ?? defaultProbeHttp;
  const stopProcessTree = options.stopProcessTree ?? defaultStopProcessTree;
  const log = options.log ?? ((message) => console.log(message));
  const logError = options.logError ?? ((message) => console.error(message));
  const readinessTimeoutMs = options.readinessTimeoutMs ?? 240_000;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const childExitGraceMs = options.childExitGraceMs ?? 500;
  const sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));

  const owned = { environments: null, infra: false, infraReady: false, api: null, web: null };
  let stopping = false;
  let shutdownPromise = null;
  let resolveStopped = () => {};
  const stopped = new Promise((done) => {
    resolveStopped = done;
  });
  let reportChildFailure = () => {};
  const childFailure = new Promise((_, reject) => {
    reportChildFailure = reject;
  });
  childFailure.catch(() => {});

  function watchChild(name, child) {
    child.once('error', (error) => {
      if (!stopping)
        reportChildFailure(new DemoFailure(`${name} failed to start: ${error.message}`));
    });
    child.once('exit', (code, signal) => {
      // On Windows, Ctrl+C reaches the children as well; give the parent's
      // SIGINT handler a moment to claim the shutdown before calling it a failure.
      void sleep(childExitGraceMs).then(() => {
        if (stopping) return;
        const status = typeof code === 'number' && code !== 0 ? code : 1;
        reportChildFailure(
          new DemoFailure(`${name} exited unexpectedly (${describeExit(code, signal)}).`, status),
        );
      });
    });
  }

  async function waitUntilReady(name, url) {
    const deadline = Date.now() + readinessTimeoutMs;
    for (;;) {
      if (stopping) throw new DemoFailure(`${name} readiness wait interrupted by shutdown.`);
      if (await probeHttp(url)) return;
      if (Date.now() >= deadline) {
        throw new DemoFailure(
          `${name} did not become ready at ${url} within ${Math.round(readinessTimeoutMs / 1000)}s.`,
        );
      }
      await sleep(pollIntervalMs);
    }
  }

  async function preflight() {
    const busy = [];
    const results = await Promise.all(DEMO_PORTS.map((port) => isPortInUse(port)));
    results.forEach((inUse, index) => inUse && busy.push(DEMO_PORTS[index]));
    if (busy.length > 0) {
      throw new DemoFailure(
        `Refusing to start: port(s) ${busy.join(', ')} already in use. Another demo/E2E session ` +
          'or local service owns them; this command never stops or attaches to it.',
      );
    }
    let containers;
    try {
      containers = await listProjectContainers();
    } catch (error) {
      throw new DemoFailure(
        `Docker is not available (${error instanceof Error ? error.message : error}). Start Docker and retry.`,
      );
    }
    if (containers.length > 0) {
      throw new DemoFailure(
        `Refusing to start: Compose project "${DEMO.composeProject}" already has ${containers.length} ` +
          'container(s) from another session. Stop that session first (or run pnpm test:infra:down if it is stale).',
      );
    }
  }

  function runStep(label, mode, stepEnv) {
    const result = runSync(mode, stepEnv);
    if (result.error) throw new DemoFailure(`${label} failed: ${result.error.message}`);
    if (result.status !== 0) {
      throw new DemoFailure(
        `${label} failed (${describeExit(result.status, result.signal)}).`,
        typeof result.status === 'number' ? result.status : 1,
      );
    }
  }

  async function start() {
    try {
      const environments = buildEnvironments(env);
      assertDisposableTestTargets(environments.infra);
      assertDisposableTestTargets(environments.api);
      await preflight();
      if (stopping) return stopped;

      owned.environments = environments;
      log(`Starting disposable PostgreSQL/Redis (${DEMO.composeProject})...`);
      owned.infra = true;
      runStep('Disposable infrastructure startup', 'infra-up', environments.infra);
      owned.infraReady = true;

      log('Migrating, seeding the synthetic account, and starting the API and web app...');
      owned.api = launchApi(environments.api);
      watchChild('API', owned.api);
      owned.web = launchWeb(environments.web);
      watchChild('Web app', owned.web);

      await Promise.race([
        Promise.all([
          waitUntilReady('API', DEMO.apiHealthUrl),
          waitUntilReady('Web app', DEMO.webUrl),
        ]),
        childFailure,
      ]);
    } catch (error) {
      if (stopping) return stopped;
      logError(error instanceof Error ? error.message : String(error));
      return shutdown(error instanceof DemoFailure ? error.status : 1);
    }

    if (stopping) return stopped;
    log(readyBanner());
    childFailure.catch((error) => {
      if (stopping) return;
      logError(error.message);
      void shutdown(error.status);
    });
    // Keep running until a signal, a child failure, or an explicit shutdown.
    return stopped;
  }

  async function teardown(status) {
    const failures = [];
    for (const [name, child] of [
      ['web app', owned.web],
      ['API', owned.api],
    ]) {
      if (!child) continue;
      try {
        await stopProcessTree(child);
      } catch (error) {
        failures.push(`stopping the ${name}: ${error instanceof Error ? error.message : error}`);
      }
    }

    const environments = owned.environments;
    if (owned.api && owned.infraReady) {
      // Scoped e2e fixture cleanup: synthetic users, their books, and only
      // those books' artifact folders under apps/api/tmp.
      try {
        runStep('Synthetic fixture cleanup', 'cleanup', environments.api);
      } catch (error) {
        failures.push(error.message);
      }
    }
    if (owned.infra) {
      try {
        runStep('Disposable infrastructure teardown', 'infra-down', environments.infra);
      } catch (error) {
        failures.push(error.message);
      }
    }

    if (owned.api || owned.web) {
      // Something still listening means an owned descendant survived; it is
      // reported, never killed by port, since the listener's owner is unknown.
      const listening = await Promise.all(
        [DEMO.apiPort, DEMO.webPort].map((port) => isPortListening(port)),
      );
      const leftover = [DEMO.apiPort, DEMO.webPort].filter((_, index) => listening[index]);
      if (leftover.length > 0) {
        failures.push(
          `port(s) ${leftover.join(', ')} still listening after stopping owned processes`,
        );
      }
    }

    if (failures.length > 0) {
      logError(`Demo cleanup incomplete:\n  - ${failures.join('\n  - ')}`);
      if (owned.infra) logError('If containers remain, run: pnpm test:infra:down');
      return status || 1;
    }
    if (owned.infra) log('Demo stopped; disposable containers and synthetic data removed.');
    return status;
  }

  function shutdown(status = 0) {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    shutdownPromise = teardown(status).then(
      (code) => (resolveStopped(code), code),
      (error) => {
        logError(`Demo cleanup crashed: ${error instanceof Error ? error.message : error}`);
        const code = status || 1;
        resolveStopped(code);
        return code;
      },
    );
    return shutdownPromise;
  }

  return { start, shutdown };
}

export function readyBanner() {
  return [
    '',
    '================ StoryMe local demo is ready ================',
    `  Open:        ${DEMO.webUrl}   (use 127.0.0.1, not localhost)`,
    `  Sign in:     ${DEMO.loginEmail}`,
    `  Password:    ${DEMO.loginPassword}`,
    `  API:         ${DEMO.apiUrl}`,
    '',
    '  Data is session-scoped: PostgreSQL/Redis live in tmpfs containers, so',
    '  reloads keep progress while this command runs. Ctrl+C stops the app,',
    '  removes the synthetic account and its files under apps/api/tmp, and',
    '  deletes the containers. Nothing persists after teardown.',
    '==============================================================',
    '',
  ].join('\n');
}

// ─── Real process/probe implementations ─────────────────────────────────────

function defaultRunSync(mode, stepEnv) {
  return runTestCommandSync(mode, { env: stepEnv });
}

// POSIX children get their own process group so teardown can signal the whole
// tree. Windows has no groups; there taskkill /T walks the tree instead.
export function spawnOwned(command, args, spawnOptions) {
  return spawn(command, args, { ...spawnOptions, detached: process.platform !== 'win32' });
}

function defaultLaunchApi(apiEnv) {
  // Revalidates the targets, then migrate -> e2e seed -> nest start.
  return launchTestCommand('api-e2e', { env: apiEnv, spawnProcess: spawnOwned });
}

function defaultLaunchWeb(webEnv) {
  const invocation = resolvePnpmInvocation(
    [
      '--filter',
      '@book/web',
      'exec',
      'next',
      'dev',
      '--port',
      String(DEMO.webPort),
      '--hostname',
      '127.0.0.1',
    ],
    { env: webEnv },
  );
  return spawnOwned(invocation.command, invocation.args, {
    cwd: repoRoot,
    env: webEnv,
    stdio: 'inherit',
    shell: false,
  });
}

function canBind(port) {
  return new Promise((done) => {
    const server = createServer();
    server.once('error', () => done(false));
    server.listen(port, () => server.close(() => done(true)));
  });
}

export function acceptsConnections(port) {
  return new Promise((done) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    const finish = (result) => {
      socket.destroy();
      done(result);
    };
    // Windows takes ~2s to refuse a loopback connection; an unexplained
    // timeout is treated as "in use" so the check fails closed.
    socket.setTimeout(5_000, () => finish(true));
    socket.once('connect', () => finish(true));
    socket.once('error', (error) => finish(error.code !== 'ECONNREFUSED'));
  });
}

export async function defaultIsPortInUse(port) {
  if (!(await canBind(port))) return true;
  return acceptsConnections(port);
}

function defaultListProjectContainers() {
  const result = spawnSync(
    'docker',
    ['ps', '-a', '-q', '--filter', `label=com.docker.compose.project=${DEMO.composeProject}`],
    { encoding: 'utf8', shell: false, windowsHide: true },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      (result.stderr || `docker ps ${describeExit(result.status, result.signal)}`).trim(),
    );
  }
  return result.stdout.split(/\s+/).filter(Boolean);
}

async function defaultProbeHttp(url) {
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5_000) });
    return response.status >= 200 && response.status < 400;
  } catch {
    return false;
  }
}

function waitForExit(child, timeoutMs) {
  if (!childAlive(child)) return Promise.resolve(true);
  return new Promise((done) => {
    const timer = setTimeout(() => done(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      done(true);
    });
  });
}

export async function defaultStopProcessTree(child) {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    // Only while our child is alive: after it exits its PID may be reused by an
    // unrelated process, and /T would then kill that process's tree.
    if (!childAlive(child)) return;
    const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      shell: false,
      windowsHide: true,
      encoding: 'utf8',
    });
    if (result.error) throw result.error;
    if (!(await waitForExit(child, 15_000))) throw new Error(`process ${child.pid} did not exit`);
    return;
  }
  const signalGroup = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  signalGroup('SIGTERM');
  if (await waitForExit(child, 15_000)) return;
  signalGroup('SIGKILL');
  if (!(await waitForExit(child, 5_000))) throw new Error(`process ${child.pid} did not exit`);
}

async function main() {
  const demo = createDemo();
  let signals = 0;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      if (signals++ === 0) console.log(`\n${signal} received; stopping the demo...`);
      else console.log('Teardown already in progress; waiting for it to finish.');
      void demo.shutdown(0);
    });
  }
  process.exitCode = await demo.start();
  process.exit();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
