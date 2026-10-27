import { execFile } from 'node:child_process';
import { constants } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  acceptsConnections,
  API_CREDENTIAL_BLOCKS,
  DEMO,
  DEMO_PORTS,
  defaultIsPortInUse,
  defaultListProjectContainers,
  defaultStopProcessTree,
  inheritedEnvironment,
  spawnOwned,
} from './demo-local.mjs';
import { resolvePnpmInvocation } from './pnpm-invocation.mjs';
import { COMMANDS, launchTestCommand } from './test-launcher.mjs';
import { explicitTestEnvironment, TEST_TARGET } from './test-target-policy.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const STATUS = Object.freeze({
  pass: 'PASS',
  fail: 'FAIL',
  unavailable: 'UNAVAILABLE',
  notRun: 'NOT RUN',
});

export const USAGE =
  'Usage: pnpm verify:local [--profile offline|integration|browser]  (default: offline)';

const pnpmStep = (label, args) => ({ label, kind: 'command', command: { pnpm: args } });
const launcherStep = (label, mode) => ({ label, kind: 'command', command: { launcher: mode } });

// The same preparation the CI jobs run before their checks.
const PREPARE = [
  pnpmStep('Prisma client', ['--filter', '@book/api', 'prisma:generate']),
  pnpmStep('Shared types build', ['--filter', '@book/types', 'build']),
];
const INFRA_UP = {
  ...launcherStep('Disposable PostgreSQL/Redis startup', 'infra-up'),
  acquires: true,
};
const INFRA_DOWN = {
  ...launcherStep('Disposable PostgreSQL/Redis teardown', 'infra-down'),
  when: 'infra',
};
const NOT_IN_THIS_STEP =
  'production builds (pnpm build, test:e2e:production): not part of verify:local';
const PAID = 'real/paid AI providers: mock providers are forced and paid evaluations disabled';

/**
 * Each profile is independent: `steps` run in order and stop at the first
 * failure (read-only `probe` steps all run, so every missing prerequisite is
 * reported at once); `cleanup` steps run only for what this invocation acquired.
 */
export const PROFILES = Object.freeze({
  offline: {
    environment: 'checks',
    steps: [
      ...PREPARE,
      pnpmStep('Lint', ['lint']),
      pnpmStep('Typecheck', ['typecheck']),
      pnpmStep('API script typecheck', ['--filter', '@book/api', 'typecheck:scripts']),
      pnpmStep('Tests', ['test']),
      pnpmStep('Story offline eval', ['eval:story:offline']),
      pnpmStep('Interactive offline eval', ['eval:interactive:offline']),
      pnpmStep('Authoring offline eval', ['eval:interactive:authoring:offline']),
    ],
    cleanup: [],
    outOfScope: [
      'API integration suite against PostgreSQL/Redis: run --profile integration',
      'browser journeys: run --profile browser',
      NOT_IN_THIS_STEP,
      PAID,
    ],
  },
  integration: {
    environment: 'integration',
    steps: [
      {
        label: 'Disposable resource ownership',
        kind: 'ownership',
        probe: true,
        ports: [Number(TEST_TARGET.databasePort), Number(TEST_TARGET.redisPort)],
      },
      ...PREPARE,
      INFRA_UP,
      launcherStep('API integration suite', 'integration'),
    ],
    cleanup: [INFRA_DOWN],
    outOfScope: [
      'lint, typecheck, unit tests, offline evals: run --profile offline',
      'browser journeys: run --profile browser',
      NOT_IN_THIS_STEP,
      PAID,
    ],
  },
  browser: {
    environment: 'browser',
    steps: [
      { label: 'Disposable resource ownership', kind: 'ownership', probe: true, ports: DEMO_PORTS },
      { label: 'Playwright Chromium', kind: 'browser', probe: true },
      ...PREPARE,
      INFRA_UP,
      // Playwright's own webServer config migrates, seeds, and starts the API
      // and web app; its global teardown removes the synthetic fixtures.
      {
        ...pnpmStep('Browser journeys', [
          '--filter',
          '@book/web',
          'test:e2e',
          'e2e/storyme.smoke.spec.ts',
          'e2e/interactive.spec.ts',
        ]),
        startsServers: true,
      },
    ],
    cleanup: [
      // Idempotent and scoped to the synthetic accounts; covers a cancelled or
      // crashed run whose Playwright global teardown never ran.
      { ...launcherStep('Synthetic fixture cleanup', 'cleanup'), when: 'servers' },
      INFRA_DOWN,
      {
        label: 'Owned server ports released',
        kind: 'ports',
        ports: [DEMO.apiPort, DEMO.webPort],
        when: 'servers',
      },
    ],
    outOfScope: [
      'Playwright specs other than storyme.smoke and interactive, and browsers other than Chromium',
      'lint, typecheck, unit tests, offline evals: run --profile offline',
      'API integration suite: run --profile integration',
      NOT_IN_THIS_STEP,
      PAID,
    ],
  },
});

class UsageError extends Error {}

export function parseArguments(argv) {
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];
  let profile;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    let value;
    if (arg === '--profile') {
      value = args[++index];
      if (value === undefined || value.startsWith('-')) {
        throw new UsageError('--profile requires a value.');
      }
    } else if (arg.startsWith('--profile=')) {
      value = arg.slice('--profile='.length);
    } else {
      throw new UsageError(`Unknown argument: ${arg}`);
    }
    if (profile !== undefined) throw new UsageError('--profile may be given only once.');
    if (!Object.hasOwn(PROFILES, value)) {
      throw new UsageError(
        `Unknown profile "${value}". Expected one of: ${Object.keys(PROFILES).join(', ')}.`,
      );
    }
    profile = value;
  }
  return { profile: profile ?? 'offline' };
}

// Mirrors the workflow-level env in .github/workflows/ci.yml.
const CHECK_SETTINGS = Object.freeze({
  NODE_ENV: 'test',
  STORY_GENERATION_PROVIDER: 'mock',
  CHARACTER_PROFILE_PROVIDER: 'mock',
  IMAGE_GENERATION_PROVIDER: 'mock',
  RUN_PAID_AI_EVALS: 'false',
  NEXT_PUBLIC_API_URL: 'http://localhost:3001/api',
});

/** Inherited credentials and service targets are dropped before the explicit settings apply. */
export function verifyEnvironments(base = process.env) {
  const inherited = inheritedEnvironment(base);
  return {
    checks: { ...inherited, ...CHECK_SETTINGS },
    integration: explicitTestEnvironment(inherited),
    // Playwright passes its environment to the API server, whose config loader
    // would otherwise backfill credentials from apps/api/.env.
    browser: explicitTestEnvironment({ ...inherited, ...API_CREDENTIAL_BLOCKS }),
  };
}

export function describeCommand(command) {
  if (!command) return '';
  return `pnpm ${(command.pnpm ?? COMMANDS[command.launcher]).join(' ')}`;
}

function describeExit(code, signal) {
  return code === null || code === undefined ? `signal ${signal ?? 'unknown'}` : `exit ${code}`;
}

function exitStatusFor(code, signal) {
  if (typeof code === 'number' && code !== 0) return code;
  const number = signal ? constants.signals[signal] : undefined;
  return number ? 128 + number : 1;
}

function firstLine(value) {
  return (
    String(value)
      .split(/\r?\n/)
      .find((line) => line.trim())
      ?.trim() ?? ''
  );
}

function errorMessage(error) {
  return firstLine(error instanceof Error ? error.message : error);
}

function formatDuration(ms) {
  return ms === undefined ? '-' : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Runs one profile with every process/probe operation injectable. Never throws;
 * `run` resolves to the exit status. `cancel` stops the running owned child and
 * lets cleanup of acquired resources proceed; it never interrupts cleanup.
 */
export function createVerifier(options = {}) {
  const env = options.env ?? process.env;
  const buildEnvironments = options.buildEnvironments ?? verifyEnvironments;
  const launch = options.launch ?? defaultLaunch;
  const stopProcessTree = options.stopProcessTree ?? defaultStopProcessTree;
  const isPortInUse = options.isPortInUse ?? defaultIsPortInUse;
  const isPortListening = options.isPortListening ?? acceptsConnections;
  const listProjectContainers = options.listProjectContainers ?? defaultListProjectContainers;
  const probeBrowser = options.probeBrowser ?? defaultProbeBrowser;
  const log = options.log ?? ((message) => console.log(message));
  const logError = options.logError ?? ((message) => console.error(message));
  const now = options.now ?? (() => performance.now());
  // On Windows, Ctrl+C reaches the children too; give the parent's handler a
  // moment to record the cancellation before a child's exit is called a failure.
  const cancelGraceMs = options.cancelGraceMs ?? 500;
  const sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));

  let cancelled = null;
  let cleaningUp = false;
  let current = null;
  let stopping = null;
  const stopFailures = [];

  function cancel(signal = 'SIGINT') {
    if (cancelled) {
      log('Cancellation already in progress; waiting for cleanup to finish.');
      return;
    }
    cancelled = signal;
    log(`\n${signal} received; stopping owned processes and cleaning up...`);
    if (current && !cleaningUp) {
      stopping = stopProcessTree(current).catch((error) => {
        stopFailures.push(errorMessage(error));
      });
    }
  }

  async function execute(command, stepEnv) {
    let child;
    try {
      child = launch(command, stepEnv);
    } catch (error) {
      return {
        status: STATUS.fail,
        exitCode: 1,
        reason: `could not start: ${errorMessage(error)}`,
      };
    }
    current = child;
    const outcome = await new Promise((done) => {
      child.once('error', (error) => done({ error }));
      child.once('exit', (code, signal) => done({ code, signal }));
    });
    if (current === child) current = null;
    if (outcome.error) {
      return {
        status: STATUS.fail,
        exitCode: 1,
        reason: `failed to start: ${errorMessage(outcome.error)}`,
      };
    }
    if (outcome.code === 0) return { status: STATUS.pass };
    return {
      status: STATUS.fail,
      exitCode: exitStatusFor(outcome.code, outcome.signal),
      reason: describeExit(outcome.code, outcome.signal),
    };
  }

  async function checkOwnership(ports) {
    const problems = [];
    const inUse = await Promise.all(ports.map((port) => isPortInUse(port)));
    const busy = ports.filter((_, index) => inUse[index]);
    if (busy.length > 0) {
      problems.push(`port(s) ${busy.join(', ')} already in use by another session or service`);
    }
    try {
      const containers = await listProjectContainers();
      if (containers.length > 0) {
        problems.push(
          `Compose project "${DEMO.composeProject}" already has ${containers.length} container(s) ` +
            'from another session',
        );
      }
    } catch (error) {
      problems.push(`Docker is not available (${errorMessage(error)})`);
    }
    if (problems.length === 0) return { status: STATUS.pass };
    return {
      status: STATUS.unavailable,
      exitCode: 1,
      reason: `${problems.join('; ')}. Nothing was started or stopped.`,
    };
  }

  async function checkBrowser(stepEnv) {
    const result = await probeBrowser(stepEnv);
    if (result.ok) return { status: STATUS.pass };
    return {
      status: STATUS.unavailable,
      exitCode: 1,
      reason:
        `Chromium cannot launch (${result.reason}). verify:local never installs browsers; ` +
        'install it yourself: pnpm --filter @book/web exec playwright install chromium',
    };
  }

  async function checkPortsReleased(ports) {
    const listening = await Promise.all(ports.map((port) => isPortListening(port)));
    const leftover = ports.filter((_, index) => listening[index]);
    if (leftover.length === 0) return { status: STATUS.pass };
    return {
      status: STATUS.fail,
      exitCode: 1,
      reason:
        `port(s) ${leftover.join(', ')} still listening after the owned processes stopped; ` +
        'not killed by port because the listener is unknown',
    };
  }

  async function performStep(step, stepEnv, owned) {
    try {
      switch (step.kind) {
        case 'ownership':
          return await checkOwnership(step.ports);
        case 'browser':
          return await checkBrowser(stepEnv);
        case 'ports':
          return await checkPortsReleased(step.ports);
        default:
          // Marked owned before launch: a partial start still needs teardown.
          if (step.acquires) owned.infra = true;
          if (step.startsServers) owned.servers = true;
          return await execute(step.command, stepEnv);
      }
    } catch (error) {
      return { status: STATUS.fail, exitCode: 1, reason: errorMessage(error) };
    }
  }

  async function timed(step, stepEnv, owned, position) {
    const command = describeCommand(step.command);
    log(`\n[verify:local] ${position} ${step.label}${command ? `: ${command}` : ''}`);
    const started = now();
    let outcome = await performStep(step, stepEnv, owned);
    if (outcome.status !== STATUS.pass && !cancelled && !cleaningUp) await sleep(cancelGraceMs);
    if (outcome.status !== STATUS.pass && cancelled && !cleaningUp) {
      outcome = {
        ...outcome,
        status: STATUS.fail,
        reason: `interrupted by ${cancelled} (${outcome.reason})`,
      };
    }
    return { step, ...outcome, durationMs: now() - started };
  }

  async function run(argv = []) {
    let profileName;
    try {
      profileName = parseArguments(argv).profile;
    } catch (error) {
      logError(error.message);
      logError(USAGE);
      return 2;
    }
    const profile = PROFILES[profileName];
    const stepEnv = buildEnvironments(env)[profile.environment];
    const owned = { infra: false, servers: false };
    const results = [];
    let failure = null;
    let cleanupFailure = null;

    log(`[verify:local] profile: ${profileName}`);
    for (const [index, step] of profile.steps.entries()) {
      if (cancelled || (failure && !step.probe)) {
        results.push({
          step,
          status: STATUS.notRun,
          reason: cancelled
            ? `cancelled by ${cancelled}`
            : `not scheduled: ${failure.label} did not pass`,
        });
        continue;
      }
      const result = await timed(step, stepEnv, owned, `(${index + 1}/${profile.steps.length})`);
      results.push(result);
      if (result.status !== STATUS.pass) {
        failure ??= { label: step.label, exitCode: result.exitCode || 1 };
      }
    }

    cleaningUp = true;
    if (stopping) await stopping;
    if (stopFailures.length > 0) {
      results.push({
        step: { label: 'Stop interrupted process tree' },
        status: STATUS.fail,
        reason: stopFailures.join('; '),
      });
      cleanupFailure ??= 1;
    }
    for (const step of profile.cleanup) {
      if (!owned[step.when]) {
        results.push({
          step,
          status: STATUS.notRun,
          reason: `nothing to clean: this run started no ${step.when === 'infra' ? 'infrastructure' : 'servers'}`,
        });
        continue;
      }
      const result = await timed(step, stepEnv, owned, '(cleanup)');
      results.push(result);
      if (result.status !== STATUS.pass) cleanupFailure ??= result.exitCode || 1;
    }

    let exitCode = 0;
    if (cancelled) exitCode = 128 + (constants.signals[cancelled] ?? 2);
    else if (failure) exitCode = failure.exitCode;
    else if (cleanupFailure) exitCode = cleanupFailure;

    log(formatSummary({ profileName, profile, results, exitCode, cancelled, owned }));
    return exitCode;
  }

  return { run, cancel };
}

export function formatSummary({ profileName, profile, results, exitCode, cancelled, owned }) {
  const indent = ' '.repeat(23);
  const lines = ['', '=================== verify:local summary ===================', ''];
  lines.push(`Profile: ${profileName}`, '');
  for (const result of results) {
    const command = describeCommand(result.step.command);
    lines.push(
      `  ${result.status.padEnd(11)} ${formatDuration(result.durationMs).padStart(8)}  ` +
        `${result.step.label}${command ? ` (${command})` : ''}`,
    );
    if (result.reason) lines.push(`${indent}${result.reason}`);
  }

  let verdict = exitCode === 0 ? 'PASS' : `FAIL (exit ${exitCode})`;
  if (cancelled) verdict = `CANCELLED by ${cancelled} (exit ${exitCode})`;
  lines.push('', `Result: ${verdict}`);

  const mainSteps = new Set(profile.steps);
  const unverified = results
    .filter((result) => mainSteps.has(result.step) && result.status !== STATUS.pass)
    .map((result) => `${result.step.label} (${result.status})`);
  lines.push('', 'Not verified by this run:');
  for (const item of [...unverified, ...profile.outOfScope]) lines.push(`  - ${item}`);

  const cleanupIncomplete = results.some(
    (result) => !mainSteps.has(result.step) && result.status === STATUS.fail,
  );
  if (cleanupIncomplete && owned.infra) {
    lines.push(
      '',
      `Cleanup incomplete. If "${DEMO.composeProject}" containers remain, run: pnpm test:infra:down`,
    );
  }
  lines.push('============================================================');
  return lines.join('\n');
}

// ─── Real process/probe implementations ─────────────────────────────────────

function defaultLaunch(command, stepEnv) {
  // Launcher modes revalidate the disposable targets before spawning.
  if (command.launcher) {
    return launchTestCommand(command.launcher, { env: stepEnv, spawnProcess: spawnOwned });
  }
  const invocation = resolvePnpmInvocation(command.pnpm, { env: stepEnv });
  return spawnOwned(invocation.command, invocation.args, {
    cwd: repoRoot,
    env: stepEnv,
    stdio: 'inherit',
    shell: false,
  });
}

// Launches and closes headless Chromium through the web package's Playwright;
// prints only the first line of a failure (the missing executable path).
const BROWSER_PROBE = [
  "const fail = (e) => { console.error(String((e && e.message) || e).split('\\n')[0]); process.exit(1); };",
  "try { require('@playwright/test').chromium.launch().then((b) => b.close()).catch(fail); } catch (e) { fail(e); }",
].join('\n');

async function defaultProbeBrowser(probeEnv) {
  try {
    await promisify(execFile)(process.execPath, ['-e', BROWSER_PROBE], {
      cwd: join(repoRoot, 'apps', 'web'),
      env: probeEnv,
      timeout: 60_000,
      windowsHide: true,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: firstLine(error.stderr ?? '') || errorMessage(error) };
  }
}

async function main() {
  const verifier = createVerifier();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => verifier.cancel(signal));
  }
  process.exit(await verifier.run(process.argv.slice(2)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
