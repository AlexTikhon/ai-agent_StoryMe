import { spawnSync } from 'node:child_process';
import path from 'node:path';

export default function globalTeardown(): void {
  const repoRoot = path.resolve(__dirname, '../../..');
  const pnpmCli = process.env['npm_execpath'];
  const result = pnpmCli
    ? spawnSync(process.execPath, [pnpmCli, '--filter', '@book/api', 'e2e:cleanup'], {
        cwd: repoRoot,
        env: process.env,
        stdio: 'inherit',
      })
    : spawnSync(
        process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
        ['--filter', '@book/api', 'e2e:cleanup'],
        {
          cwd: repoRoot,
          env: process.env,
          stdio: 'inherit',
          shell: process.platform === 'win32',
        },
      );

  if (result.status !== 0) {
    throw new Error('Failed to clean up disposable StoryMe E2E fixtures.');
  }
}
