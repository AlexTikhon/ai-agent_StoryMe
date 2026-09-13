import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDisposableTestTargets } from './test-target-policy.mjs';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
assertDisposableTestTargets(process.env);

function pnpmArgs(args) {
  const pnpmCli = process.env.npm_execpath;
  return pnpmCli
    ? { command: process.execPath, args: [pnpmCli, ...args] }
    : { command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args };
}

function runRequired(args, label) {
  const invocation = pnpmArgs(args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${label} failed with exit ${result.status ?? 'unknown'}.`);
}

runRequired(['--filter', '@book/api', 'prisma:migrate:deploy'], 'E2E migration');
runRequired(['--filter', '@book/api', 'e2e:seed'], 'E2E fixture seed');

const server = pnpmArgs(['--filter', '@book/api', 'exec', 'nest', 'start']);
const child = spawn(server.command, server.args, {
  cwd: repoRoot,
  env: process.env,
  stdio: 'inherit',
  shell: false,
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.once('error', (error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
