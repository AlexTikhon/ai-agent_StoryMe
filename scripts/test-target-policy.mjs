export const TEST_TARGET = Object.freeze({
  databaseUrl: 'postgresql://storyme:storyme_e2e@127.0.0.1:5440/storyme_e2e',
  databaseHost: '127.0.0.1',
  databasePort: '5440',
  databaseName: 'storyme_e2e',
  redisUrl: 'redis://127.0.0.1:6380/15',
  redisHost: '127.0.0.1',
  redisPort: '6380',
  redisDatabase: '15',
});

function parseUrl(name, value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be set explicitly to the disposable StoryMe test target.`);
  }
  try {
    return new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL; refusing to run test infrastructure commands.`);
  }
}

/**
 * Fail-closed policy shared by every command that can migrate, seed, clean up,
 * or start a process against the E2E/integration stores. Exact component
 * checks keep innocuous-looking URL aliases and inherited developer settings
 * from crossing the destructive test boundary.
 */
export function assertDisposableTestTargets(env) {
  const database = parseUrl('DATABASE_URL', env.DATABASE_URL);
  const redis = parseUrl('REDIS_URL', env.REDIS_URL);
  const databaseName = decodeURIComponent(database.pathname.replace(/^\//, ''));
  const redisDatabase = decodeURIComponent(redis.pathname.replace(/^\//, ''));

  const databaseAllowed =
    database.protocol === 'postgresql:' &&
    database.hostname === TEST_TARGET.databaseHost &&
    (database.port || '5432') === TEST_TARGET.databasePort &&
    databaseName === TEST_TARGET.databaseName;
  const redisAllowed =
    redis.protocol === 'redis:' &&
    redis.hostname === TEST_TARGET.redisHost &&
    (redis.port || '6379') === TEST_TARGET.redisPort &&
    redisDatabase === TEST_TARGET.redisDatabase;

  if (!databaseAllowed) {
    throw new Error(
      `DATABASE_URL must use the exact disposable host, port, and database (${TEST_TARGET.databaseHost}:${TEST_TARGET.databasePort}/${TEST_TARGET.databaseName}).`,
    );
  }
  if (!redisAllowed) {
    throw new Error(
      `REDIS_URL must use the exact disposable host, port, and database (${TEST_TARGET.redisHost}:${TEST_TARGET.redisPort}/${TEST_TARGET.redisDatabase}).`,
    );
  }
}

export function explicitTestEnvironment(base = {}) {
  return {
    ...base,
    NODE_ENV: 'test',
    DATABASE_URL: TEST_TARGET.databaseUrl,
    REDIS_URL: TEST_TARGET.redisUrl,
    STORY_GENERATION_PROVIDER: 'mock',
    CHARACTER_PROFILE_PROVIDER: 'mock',
    IMAGE_GENERATION_PROVIDER: 'mock',
    RUN_PAID_AI_EVALS: 'false',
  };
}
