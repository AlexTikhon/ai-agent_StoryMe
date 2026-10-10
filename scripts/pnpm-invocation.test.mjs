import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { resolvePnpmInvocation, superviseChild } from './pnpm-invocation.mjs';

const ARGS = ['--filter', '@book/api', 'exec', 'nest', 'start'];
const NODE = 'C:\\Program Files\\nodejs\\node.exe';

function winExists(...present) {
  const set = new Set(present.map((p) => p.toLowerCase()));
  return (candidate) => set.has(candidate.toLowerCase());
}

test('npm_execpath JS CLI runs through Node with unchanged argument boundaries', () => {
  const cli = 'C:\\Users\\Some User\\AppData\\pnpm global\\pnpm.cjs';
  const args = ['--filter', 'name with space', 'a&b', '"quoted"'];
  assert.deepEqual(
    resolvePnpmInvocation(args, {
      env: { npm_execpath: cli },
      platform: 'win32',
      execPath: NODE,
    }),
    { command: NODE, args: [cli, ...args], shell: false },
  );
});

test('npm_execpath with spaces works on posix too', () => {
  const cli = '/home/some user/.local/share/pnpm/pnpm.mjs';
  assert.deepEqual(
    resolvePnpmInvocation(ARGS, {
      env: { npm_execpath: cli },
      platform: 'linux',
      execPath: '/usr/bin/node',
    }),
    { command: '/usr/bin/node', args: [cli, ...ARGS], shell: false },
  );
});

test('a native npm_execpath binary is executed directly', () => {
  const exe = 'C:\\Program Files\\pnpm\\pnpm.exe';
  assert.deepEqual(
    resolvePnpmInvocation(ARGS, { env: { npm_execpath: exe }, platform: 'win32', execPath: NODE }),
    { command: exe, args: ARGS, shell: false },
  );
});

test('npm_execpath that is not pnpm (npm-cli.js) is ignored', () => {
  assert.deepEqual(
    resolvePnpmInvocation(ARGS, {
      env: { npm_execpath: '/usr/lib/node_modules/npm/bin/npm-cli.js' },
      platform: 'linux',
      execPath: '/usr/bin/node',
    }),
    { command: 'pnpm', args: ARGS, shell: false },
  );
});

test('absent npm_execpath on linux keeps plain pnpm without a shell', () => {
  assert.deepEqual(resolvePnpmInvocation(ARGS, { env: {}, platform: 'linux' }), {
    command: 'pnpm',
    args: ARGS,
    shell: false,
  });
});

test('windows fallback launches the CLI next to pnpm.cmd through Node, never the .cmd', () => {
  const dir = 'C:\\Users\\Some User\\AppData\\Roaming\\npm';
  const cli = `${dir}\\node_modules\\pnpm\\bin\\pnpm.cjs`;
  const invocation = resolvePnpmInvocation(ARGS, {
    env: { Path: `C:\\Windows;${dir}` },
    platform: 'win32',
    execPath: NODE,
    exists: winExists(`${dir}\\pnpm.cmd`, cli),
  });
  assert.deepEqual(invocation, { command: NODE, args: [cli, ...ARGS], shell: false });
  assert.ok(!invocation.command.toLowerCase().endsWith('.cmd'));
});

test('windows fallback falls back to pnpm.mjs when pnpm.cjs is absent', () => {
  const dir = 'C:\\tools\\npm';
  const cli = `${dir}\\node_modules\\pnpm\\bin\\pnpm.mjs`;
  assert.deepEqual(
    resolvePnpmInvocation(ARGS, {
      env: { PATH: dir },
      platform: 'win32',
      execPath: NODE,
      exists: winExists(`${dir}\\pnpm.cmd`, cli),
    }),
    { command: NODE, args: [cli, ...ARGS], shell: false },
  );
});

test('windows fallback prefers a native pnpm.exe on PATH', () => {
  const exe = 'C:\\Program Files\\pnpm\\pnpm.exe';
  assert.deepEqual(
    resolvePnpmInvocation(ARGS, {
      env: { PATH: 'C:\\Program Files\\pnpm' },
      platform: 'win32',
      execPath: NODE,
      exists: winExists(exe),
    }),
    { command: exe, args: ARGS, shell: false },
  );
});

test('windows fallback fails closed when only an unusable .cmd shim is found', () => {
  const dir = 'C:\\shims';
  assert.throws(
    () =>
      resolvePnpmInvocation(ARGS, {
        env: { PATH: dir },
        platform: 'win32',
        execPath: NODE,
        exists: winExists(`${dir}\\pnpm.cmd`),
      }),
    /Unable to locate the pnpm CLI without a shell/,
  );
});

test('a .cmd npm_execpath is never handed to Node as JavaScript', () => {
  const dir = 'C:\\shims';
  assert.throws(() =>
    resolvePnpmInvocation(ARGS, {
      env: { npm_execpath: `${dir}\\pnpm.cmd`, PATH: dir },
      platform: 'win32',
      execPath: NODE,
      exists: () => false,
    }),
  );
});

function fakeChild() {
  const child = new EventEmitter();
  child.signals = [];
  child.kill = (signal) => child.signals.push(signal);
  return child;
}
function fakeProcess() {
  const proc = new EventEmitter();
  proc.exitCode = undefined;
  return proc;
}

test('superviseChild forwards SIGINT and SIGTERM to the child', () => {
  const child = fakeChild();
  const proc = fakeProcess();
  superviseChild(child, proc);
  proc.emit('SIGINT');
  proc.emit('SIGTERM');
  assert.deepEqual(child.signals, ['SIGINT', 'SIGTERM']);
});

test('superviseChild propagates spawn errors as exit code 1', () => {
  const child = fakeChild();
  const proc = fakeProcess();
  const original = console.error;
  console.error = () => {};
  try {
    superviseChild(child, proc);
    child.emit('error', new Error('spawn ENOENT'));
  } finally {
    console.error = original;
  }
  assert.equal(proc.exitCode, 1);
});

for (const [name, args, expected] of [
  ['non-zero exit code', [3, null], 3],
  ['clean exit', [0, null], 0],
  ['signal termination', [null, 'SIGKILL'], 1],
]) {
  test(`superviseChild maps ${name} to parent exit code ${expected}`, () => {
    const child = fakeChild();
    const proc = fakeProcess();
    superviseChild(child, proc);
    child.emit('exit', ...args);
    assert.equal(proc.exitCode, expected);
  });
}
