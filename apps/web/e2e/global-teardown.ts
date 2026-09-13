import { spawnSync } from 'node:child_process';
import path from 'node:path';

export default function globalTeardown(): void {
  const repoRoot = path.resolve(__dirname, '../../..');
  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, 'scripts/test-launcher.mjs'), 'cleanup'],
    {
      cwd: repoRoot,
      env: process.env,
      stdio: 'inherit',
    },
  );

  if (result.status !== 0) {
    throw new Error('Failed to clean up disposable StoryMe E2E fixtures.');
  }
}
