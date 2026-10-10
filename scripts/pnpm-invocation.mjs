import { existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';

const JS_EXTENSIONS = new Set(['.js', '.cjs', '.mjs']);
const SHELL_SCRIPT_EXTENSIONS = new Set(['.cmd', '.bat', '.ps1']);

function pathApiFor(platform) {
  return platform === 'win32' ? win32 : posix;
}

function lookupEnv(env, name, platform) {
  if (platform !== 'win32') return env[name];
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

/**
 * Describe how to run pnpm with an argument array and no shell.
 *
 * Preference order:
 *  1. `npm_execpath` set by a pnpm parent process: the real pnpm CLI, run via
 *     `process.execPath` when it is JavaScript, or directly when it is a native
 *     binary. npm's own `npm_execpath` (or a .cmd shim) is never trusted.
 *  2. Windows without `npm_execpath`: a native `pnpm.exe` on PATH, or the JS CLI
 *     that sits next to an npm/corepack `pnpm.cmd` shim, launched via Node. The
 *     `.cmd` file itself is never spawned, because Node (CVE-2024-27980) rejects
 *     it with EINVAL unless a shell is used, and a shell would re-parse arguments.
 *  3. Other platforms: `pnpm` on PATH.
 *
 * The returned object is always `{ command, args, shell: false }`.
 */
export function resolvePnpmInvocation(args, options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const execPath = options.execPath ?? process.execPath;
  const exists = options.exists ?? existsSync;
  const pathApi = pathApiFor(platform);

  const pnpmCli = env.npm_execpath;
  if (pnpmCli && pathApi.basename(pnpmCli).toLowerCase().startsWith('pnpm')) {
    const extension = pathApi.extname(pnpmCli).toLowerCase();
    if (JS_EXTENSIONS.has(extension)) {
      return { command: execPath, args: [pnpmCli, ...args], shell: false };
    }
    if (!SHELL_SCRIPT_EXTENSIONS.has(extension)) {
      return { command: pnpmCli, args: [...args], shell: false };
    }
  }

  if (platform !== 'win32') return { command: 'pnpm', args: [...args], shell: false };

  const searchPath = lookupEnv(env, 'PATH', platform) ?? '';
  for (const directory of searchPath.split(pathApi.delimiter).filter(Boolean)) {
    const nativeBinary = pathApi.join(directory, 'pnpm.exe');
    if (exists(nativeBinary)) return { command: nativeBinary, args: [...args], shell: false };

    if (!exists(pathApi.join(directory, 'pnpm.cmd'))) continue;
    for (const entry of ['pnpm.cjs', 'pnpm.mjs']) {
      const cli = pathApi.join(directory, 'node_modules', 'pnpm', 'bin', entry);
      if (exists(cli)) return { command: execPath, args: [cli, ...args], shell: false };
    }
  }

  throw new Error(
    'Unable to locate the pnpm CLI without a shell. Run this command through pnpm ' +
      '(so npm_execpath is set) or install pnpm so pnpm.exe, or pnpm.cmd with its ' +
      'node_modules/pnpm/bin CLI, is on PATH.',
  );
}

/**
 * Forward termination signals to a test-owned child and mirror its outcome onto
 * the parent exit code. Spawn errors and non-zero/signal exits become non-zero.
 */
export function superviseChild(child, processRef = process) {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    processRef.on(signal, () => child.kill(signal));
  }
  child.once('error', (error) => {
    console.error(error instanceof Error ? error.message : error);
    processRef.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    processRef.exitCode = code ?? (signal ? 1 : 0);
  });
}
