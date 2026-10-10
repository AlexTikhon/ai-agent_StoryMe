import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { resolvePnpmInvocation, superviseChild } from './pnpm-invocation.mjs';
import { assertDisposableTestTargets, TEST_TARGET } from './test-target-policy.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const COMMANDS = Object.freeze({
  'api-e2e': ['exec', 'node', 'scripts/api-e2e-entry.mjs'],
  cleanup: ['--filter', '@book/api', 'e2e:cleanup'],
  integration: ['--filter', '@book/api', 'exec', 'node', 'scripts/run-integration-tests.mjs'],
  'infra-up': ['exec', 'node', 'scripts/test-infra-entry.mjs', 'up'],
  'infra-down': ['exec', 'node', 'scripts/test-infra-entry.mjs', 'down'],
});

/** Validate before resolving or invoking anything. Tests use the injected
 * `spawnProcess`/`resolveInvocation` seams to prove rejection performs zero
 * child-process operations. */
function spawnGuarded(mode, spawnProcess, options) {
  const env = options.env ?? process.env;
  const commandArgs = COMMANDS[mode];
  if (!commandArgs) throw new Error(`Unknown safe test launcher mode: ${mode}`);
  assertDisposableTestTargets(env);

  const invocation = (options.resolveInvocation ?? resolvePnpmInvocation)(commandArgs, { env });
  return spawnProcess(invocation.command, invocation.args, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
    shell: false,
  });
}

export function launchTestCommand(mode, options = {}) {
  return spawnGuarded(mode, options.spawnProcess ?? spawn, options);
}

export function runTestCommandSync(mode, options = {}) {
  return spawnGuarded(mode, options.spawnProcess ?? spawnSync, options);
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
  superviseChild(child);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
