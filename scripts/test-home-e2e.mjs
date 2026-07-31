import { spawnSync } from 'node:child_process';

const composeArgs = ['compose', '-f', 'docker-compose.e2e.yml'];
const pnpmCli = process.env.npm_execpath;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false, ...options });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (run('docker', ['info', '--format', '{{.ServerVersion}}']) !== 0) {
  console.error('Docker is unavailable. Start Docker Desktop/Engine and retry.');
  process.exit(1);
}

let exitCode = 1;
try {
  const up = run('docker', [...composeArgs, 'up', '-d', '--wait']);
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
  const down = run('docker', [...composeArgs, 'down']);
  if (down !== 0) {
    console.error('Disposable infrastructure cleanup failed; run pnpm local:home:down.');
    exitCode = exitCode || down;
  }
}

process.exit(exitCode);
