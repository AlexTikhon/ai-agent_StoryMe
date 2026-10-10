import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePnpmInvocation, superviseChild } from './pnpm-invocation.mjs';
import { assertDisposableTestTargets } from './test-target-policy.mjs';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

const REQUIRED_STEPS = Object.freeze([
  { label: 'E2E migration', args: ['--filter', '@book/api', 'prisma:migrate:deploy'] },
  { label: 'E2E fixture seed', args: ['--filter', '@book/api', 'e2e:seed'] },
]);
const SERVER_ARGS = Object.freeze(['--filter', '@book/api', 'exec', 'nest', 'start']);

/**
 * Validate the disposable targets, then migrate -> seed -> start the API.
 * Validation and invocation resolution happen before the first child process,
 * so a rejected target or missing pnpm performs zero child-process operations.
 * Returns the long-running server child.
 */
export function runApiE2e(options = {}) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? repoRoot;
  const spawnSyncProcess = options.spawnSyncProcess ?? spawnSync;
  const spawnProcess = options.spawnProcess ?? spawn;
  const resolveInvocation =
    options.resolveInvocation ?? ((args) => resolvePnpmInvocation(args, { env }));

  assertDisposableTestTargets(env);

  const steps = REQUIRED_STEPS.map((step) => ({
    ...step,
    invocation: resolveInvocation(step.args),
  }));
  const server = resolveInvocation(SERVER_ARGS);
  const spawnOptions = { cwd, env, stdio: 'inherit', shell: false };

  for (const { label, invocation } of steps) {
    const result = spawnSyncProcess(invocation.command, invocation.args, spawnOptions);
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `${label} failed with ${result.status === null || result.status === undefined ? `signal ${result.signal ?? 'unknown'}` : `exit ${result.status}`}.`,
      );
    }
  }

  return spawnProcess(server.command, server.args, spawnOptions);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    superviseChild(runApiE2e());
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
