import { spawnSync } from 'node:child_process';
import { connect } from 'node:net';

const DATABASE_URL = 'postgresql://storyme:storyme_e2e@127.0.0.1:5440/storyme_e2e';
const REDIS_URL = 'redis://127.0.0.1:6380/15';

function fail(message) {
  console.error(`Integration preflight failed: ${message}`);
  console.error('Run `pnpm test:infra:up` from the repository root, then retry.');
  process.exit(1);
}

function assertIsolatedTarget(name, actual, expected) {
  if (actual !== undefined && actual !== expected) {
    fail(
      `${name} must target the disposable integration service. Refusing the supplied value to protect non-test data.`,
    );
  }
}

function waitForPort(host, port, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = connect({ host, port });
      socket.setTimeout(1_000);
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      const retry = () => {
        socket.destroy();
        if (Date.now() >= deadline) {
          reject(new Error(`${label} is not ready on ${host}:${port}`));
          return;
        }
        setTimeout(attempt, 250);
      };
      socket.once('error', retry);
      socket.once('timeout', retry);
    };
    attempt();
  });
}

function run(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

assertIsolatedTarget('DATABASE_URL', process.env.DATABASE_URL, DATABASE_URL);
assertIsolatedTarget('REDIS_URL', process.env.REDIS_URL, REDIS_URL);

const env = {
  ...process.env,
  NODE_ENV: 'test',
  DATABASE_URL,
  REDIS_URL,
  STORY_GENERATION_PROVIDER: 'mock',
  CHARACTER_PROFILE_PROVIDER: 'mock',
  IMAGE_GENERATION_PROVIDER: 'mock',
  RUN_PAID_AI_EVALS: 'false',
};

// Credentials are deliberately removed from the child process. Integration
// fixtures use only deterministic local providers.
for (const key of Object.keys(env)) {
  if (/^(OPENAI|ANTHROPIC|GOOGLE).*(_KEY|_TOKEN)$/i.test(key)) delete env[key];
}

try {
  await Promise.all([
    waitForPort('127.0.0.1', 5440, 'PostgreSQL'),
    waitForPort('127.0.0.1', 6380, 'Redis'),
  ]);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const migrationStatus = run(pnpm, ['exec', 'prisma', 'migrate', 'deploy'], env);
if (migrationStatus !== 0) process.exit(migrationStatus);

const forwardedArgs = process.argv.slice(2);
process.exit(
  run(
    pnpm,
    ['exec', 'vitest', 'run', '--config', 'vitest.integration.config.ts', ...forwardedArgs],
    env,
  ),
);
