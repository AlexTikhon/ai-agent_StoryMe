import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDisposableTestTargets, testComposeProject } from './test-target-policy.mjs';

export function runTestInfra(action, options = {}) {
  const env = options.env ?? process.env;
  assertDisposableTestTargets(env);
  if (action !== 'up' && action !== 'down')
    throw new Error('Expected test infrastructure action up or down.');

  const args = ['compose', '-p', testComposeProject(env), '-f', 'docker-compose.e2e.yml', action];
  if (action === 'up') args.push('-d', '--wait', 'postgres-e2e', 'redis-e2e');
  if (action === 'down') args.push('-v', '--remove-orphans');

  const result = (options.spawnProcess ?? spawnSync)('docker', args, {
    cwd: resolve(fileURLToPath(new URL('.', import.meta.url)), '..'),
    env,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runTestInfra(process.argv[2]);
}
