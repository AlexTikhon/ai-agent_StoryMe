import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDisposableTestTargets } from './test-target-policy.mjs';

assertDisposableTestTargets(process.env);
const action = process.argv[2];
if (action !== 'up' && action !== 'down')
  throw new Error('Expected test infrastructure action up or down.');

const args = ['compose', '-p', 'storyme-integration', '-f', 'docker-compose.e2e.yml', action];
if (action === 'up') args.push('-d', '--wait', 'postgres-e2e', 'redis-e2e');
if (action === 'down') args.push('-v', '--remove-orphans');

const result = spawnSync('docker', args, {
  cwd: resolve(fileURLToPath(new URL('.', import.meta.url)), '..'),
  env: process.env,
  stdio: 'inherit',
  shell: false,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
