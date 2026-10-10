import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { launchTestCommand, runTestCommandSync } from './test-launcher.mjs';
import { TEST_TARGET } from './test-target-policy.mjs';

const allowed = {
  DATABASE_URL: TEST_TARGET.databaseUrl,
  REDIS_URL: TEST_TARGET.redisUrl,
};

for (const [name, value] of [
  ['database host', 'postgresql://storyme:storyme_e2e@localhost:5440/storyme_e2e'],
  ['database port', 'postgresql://storyme:storyme_e2e@127.0.0.1:5432/storyme_e2e'],
  ['database name', 'postgresql://storyme:storyme_e2e@127.0.0.1:5440/storyme_dev'],
  ['redis host', 'redis://localhost:6380/15'],
  ['redis port', 'redis://127.0.0.1:6379/15'],
  ['redis database', 'redis://127.0.0.1:6380/0'],
]) {
  test(`rejects a disallowed ${name} before migration/server/fixture spawn`, () => {
    let calls = 0;
    const env = {
      ...allowed,
      ...(name.startsWith('redis') ? { REDIS_URL: value } : { DATABASE_URL: value }),
    };
    assert.throws(() => launchTestCommand('api-e2e', { env, spawnProcess: () => calls++ }));
    assert.equal(calls, 0);
  });
}

test('rejects cleanup on a disallowed target with zero cleanup calls', () => {
  let calls = 0;
  assert.throws(() =>
    runTestCommandSync('cleanup', {
      env: { ...allowed, REDIS_URL: 'redis://127.0.0.1:6380/0' },
      spawnProcess: () => calls++,
    }),
  );
  assert.equal(calls, 0);
});

test('rejects infrastructure teardown on a disallowed target with zero teardown calls', () => {
  let calls = 0;
  assert.throws(() =>
    runTestCommandSync('infra-down', {
      env: { ...allowed, DATABASE_URL: 'postgresql://storyme:x@127.0.0.1:5440/not_test' },
      spawnProcess: () => calls++,
    }),
  );
  assert.equal(calls, 0);
});

test('spawns exactly once after both exact targets pass', () => {
  let calls = 0;
  launchTestCommand('api-e2e', {
    env: allowed,
    resolveInvocation: (args) => ({ command: 'fake-pnpm', args, shell: false }),
    spawnProcess: () => {
      calls++;
      return { once() {}, kill() {} };
    },
  });
  assert.equal(calls, 1);
});

test('rejected targets never reach invocation resolution', () => {
  let resolved = 0;
  assert.throws(() =>
    launchTestCommand('api-e2e', {
      env: { ...allowed, DATABASE_URL: 'postgresql://storyme:x@127.0.0.1:5432/storyme_e2e' },
      resolveInvocation: () => resolved++,
      spawnProcess: () => assert.fail('must not spawn'),
    }),
  );
  assert.equal(resolved, 0);
});

test('launcher uses the shared resolver result with shell:false and unchanged args', () => {
  const cli = 'C:\\Users\\Some User\\pnpm\\pnpm.cjs';
  let seen;
  runTestCommandSync('cleanup', {
    env: { ...allowed, npm_execpath: cli },
    resolveInvocation: (args, options) => {
      assert.equal(options.env.npm_execpath, cli);
      return { command: 'node-bin', args: [cli, ...args], shell: false };
    },
    spawnProcess: (command, args, options) => {
      seen = { command, args, options };
      return { status: 0 };
    },
  });
  assert.equal(seen.command, 'node-bin');
  assert.deepEqual(seen.args, [cli, '--filter', '@book/api', 'e2e:cleanup']);
  assert.equal(seen.options.shell, false);
  assert.equal(seen.options.stdio, 'inherit');
});

test('unknown launcher mode is refused before any resolution or spawn', () => {
  assert.throws(
    () =>
      launchTestCommand('unknown', {
        env: allowed,
        resolveInvocation: () => assert.fail('must not resolve'),
        spawnProcess: () => assert.fail('must not spawn'),
      }),
    /Unknown safe test launcher mode/,
  );
});

test('the real inner entry exits non-zero on a rejected target without running anything', () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./api-e2e-entry.mjs', import.meta.url))],
    {
      env: {
        PATH: process.env.PATH ?? process.env.Path ?? '',
        DATABASE_URL: 'postgresql://x:y@127.0.0.1:5432/prod',
        REDIS_URL: allowed.REDIS_URL,
      },
      encoding: 'utf8',
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DATABASE_URL must use the exact disposable host/);
});
