import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const pnpmCli = process.env.npm_execpath;
const safeLauncher = resolve('scripts/test-launcher.mjs');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false, ...options });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

let exitCode = 1;
try {
  const up = run(process.execPath, [safeLauncher, 'infra-up']);
  if (up !== 0) throw new Error('Disposable PostgreSQL/Redis failed to become healthy.');

  if (!pnpmCli) throw new Error('Run this command through pnpm so its CLI can be located safely.');
  exitCode = run(process.execPath, [pnpmCli, '--filter', '@book/web', 'test:e2e'], {
    env: {
      ...process.env,
      DATABASE_URL: 'postgresql://storyme:storyme_e2e@127.0.0.1:5440/storyme_e2e',
      REDIS_URL: 'redis://127.0.0.1:6380/15',
    },
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
} finally {
  const down = run(process.execPath, [safeLauncher, 'infra-down']);
  if (down !== 0) {
    console.error('Disposable infrastructure cleanup failed; run pnpm local:home:down.');
    exitCode = exitCode || down;
  }
}

process.exit(exitCode);
