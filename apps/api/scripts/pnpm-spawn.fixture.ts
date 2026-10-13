import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { resolvePnpmInvocation } from '../../../scripts/pnpm-invocation.mjs';

/**
 * Runs pnpm for a spec with no shell on every platform. Arguments are passed as
 * raw array values, so a path is given exactly as it is on disk: never wrap it in
 * quotes (without a shell they would become part of the filename).
 *
 * Resolution (npm_execpath, pnpm.exe, the JS CLI next to a .cmd shim) lives in
 * the repository's `scripts/pnpm-invocation.mjs` and is deliberately not repeated here.
 */
export function spawnPnpm(
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number },
): SpawnSyncReturns<string> {
  const invocation = resolvePnpmInvocation(args, { env: options.env });
  return spawnSync(invocation.command, invocation.args, {
    cwd: options.cwd,
    encoding: 'utf8',
    shell: invocation.shell,
    env: options.env,
    timeout: options.timeout,
  });
}
