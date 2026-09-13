import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { assertDisposableTestTargets, TEST_TARGET } from './test-target-policy.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const COMMANDS = Object.freeze({
  'api-e2e': ['exec', 'node', 'scripts/api-e2e-entry.mjs'],
  cleanup: ['--filter', '@book/api', 'e2e:cleanup'],
  integration: ['--filter', '@book/api', 'exec', 'node', 'scripts/run-integration-tests.mjs'],
  'infra-up': ['exec', 'node', 'scripts/test-infra-entry.mjs', 'up'],
  'infra-down': ['exec', 'node', 'scripts/test-infra-entry.mjs', 'down'],
});

function pnpmInvocation(args, env) {
  const pnpmCli = env.npm_execpath;
  return pnpmCli
    ? { command: process.execPath, args: [pnpmCli, ...args], shell: false }
    : {
        command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
        args,
        shell: process.platform === 'win32',
      };
}

/** Validate before invoking the injected spawn function. Tests use this seam
 * to prove rejection performs zero child-process operations. */
export function launchTestCommand(mode, options = {}) {
  const env = options.env ?? process.env;
  const spawnProcess = options.spawnProcess ?? spawn;
  const commandArgs = COMMANDS[mode];
  if (!commandArgs) throw new Error(`Unknown safe test launcher mode: ${mode}`);
  assertDisposableTestTargets(env);

  const invocation = pnpmInvocation(commandArgs, env);
  return spawnProcess(invocation.command, invocation.args, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
    shell: invocation.shell,
  });
}

export function runTestCommandSync(mode, options = {}) {
  const env = options.env ?? process.env;
  const spawnProcess = options.spawnProcess ?? spawnSync;
  const commandArgs = COMMANDS[mode];
  if (!commandArgs) throw new Error(`Unknown safe test launcher mode: ${mode}`);
  assertDisposableTestTargets(env);
  const invocation = pnpmInvocation(commandArgs, env);
  return spawnProcess(invocation.command, invocation.args, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
    shell: invocation.shell,
  });
}

async function main() {
  const mode = process.argv[2];
  const env =
    mode === 'infra-up' || mode === 'infra-down'
      ? {
          ...process.env,
          DATABASE_URL: TEST_TARGET.databaseUrl,
          REDIS_URL: TEST_TARGET.redisUrl,
        }
      : process.env;
  const child = launchTestCommand(mode, { env });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal));
  }
  child.once('error', (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
