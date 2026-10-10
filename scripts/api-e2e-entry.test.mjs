import assert from 'node:assert/strict';
import test from 'node:test';
import { runApiE2e } from './api-e2e-entry.mjs';
import { TEST_TARGET } from './test-target-policy.mjs';

const allowed = { DATABASE_URL: TEST_TARGET.databaseUrl, REDIS_URL: TEST_TARGET.redisUrl };
const resolveInvocation = (args) => ({ command: 'fake-pnpm', args, shell: false });

function harness({ syncResults = [] } = {}) {
  const calls = [];
  return {
    calls,
    options: {
      env: allowed,
      cwd: 'C:\\repo with space',
      resolveInvocation,
      spawnSyncProcess: (command, args, spawnOptions) => {
        calls.push({ kind: 'sync', command, args, spawnOptions });
        return syncResults.shift() ?? { status: 0 };
      },
      spawnProcess: (command, args, spawnOptions) => {
        calls.push({ kind: 'spawn', command, args, spawnOptions });
        return { once() {}, kill() {} };
      },
    },
  };
}

for (const [name, override] of [
  ['database name', { DATABASE_URL: 'postgresql://storyme:x@127.0.0.1:5440/storyme_dev' }],
  ['database port', { DATABASE_URL: 'postgresql://storyme:x@127.0.0.1:5432/storyme_e2e' }],
  ['redis database', { REDIS_URL: 'redis://127.0.0.1:6380/0' }],
  ['redis host', { REDIS_URL: 'redis://localhost:6380/15' }],
  ['missing database url', { DATABASE_URL: undefined }],
]) {
  test(`inner entry rejects a disallowed ${name} with zero child-process calls`, () => {
    const { calls, options } = harness();
    let resolved = 0;
    options.env = { ...allowed, ...override };
    options.resolveInvocation = (args) => (resolved++, resolveInvocation(args));
    assert.throws(() => runApiE2e(options));
    assert.equal(calls.length, 0);
    assert.equal(resolved, 0);
  });
}

test('runs migration, then seed, then the server, in order with shell:false', () => {
  const { calls, options } = harness();
  runApiE2e(options);
  assert.deepEqual(
    calls.map((c) => [c.kind, c.args]),
    [
      ['sync', ['--filter', '@book/api', 'prisma:migrate:deploy']],
      ['sync', ['--filter', '@book/api', 'e2e:seed']],
      ['spawn', ['--filter', '@book/api', 'exec', 'nest', 'start']],
    ],
  );
  for (const { command, spawnOptions } of calls) {
    assert.equal(command, 'fake-pnpm');
    assert.equal(spawnOptions.shell, false);
    assert.equal(spawnOptions.cwd, 'C:\\repo with space');
    assert.equal(spawnOptions.env, allowed);
  }
});

test('migration failure stops seed and server and surfaces the exit status', () => {
  const { calls, options } = harness({ syncResults: [{ status: 7 }] });
  assert.throws(() => runApiE2e(options), /E2E migration failed with exit 7/);
  assert.equal(calls.length, 1);
});

test('seed failure stops the server', () => {
  const { calls, options } = harness({ syncResults: [{ status: 0 }, { status: 1 }] });
  assert.throws(() => runApiE2e(options), /E2E fixture seed failed with exit 1/);
  assert.deepEqual(
    calls.map((c) => c.kind),
    ['sync', 'sync'],
  );
});

test('a step killed by a signal is a failure', () => {
  const { calls, options } = harness({ syncResults: [{ status: null, signal: 'SIGTERM' }] });
  assert.throws(() => runApiE2e(options), /failed with signal SIGTERM/);
  assert.equal(calls.length, 1);
});

test('a spawn error in a required step propagates and stops later steps', () => {
  const failure = new Error('spawn EINVAL');
  const { calls, options } = harness({ syncResults: [{ error: failure, status: null }] });
  assert.throws(
    () => runApiE2e(options),
    (error) => error === failure,
  );
  assert.equal(calls.length, 1);
});

test('an unresolvable pnpm fails before any migration is attempted', () => {
  const { calls, options } = harness();
  options.resolveInvocation = () => {
    throw new Error('Unable to locate the pnpm CLI without a shell.');
  };
  assert.throws(() => runApiE2e(options), /Unable to locate the pnpm CLI/);
  assert.equal(calls.length, 0);
});
