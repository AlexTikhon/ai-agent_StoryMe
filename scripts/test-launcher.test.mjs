import assert from 'node:assert/strict';
import test from 'node:test';
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
    spawnProcess: () => {
      calls++;
      return { once() {}, kill() {} };
    },
  });
  assert.equal(calls, 1);
});
