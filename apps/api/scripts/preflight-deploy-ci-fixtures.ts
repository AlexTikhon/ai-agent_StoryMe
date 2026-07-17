/**
 * Phase F2 — CI deployment-safety gate for the Phase F1 preflight tool.
 *
 * Exercises the real `preflight:deploy` CLI (`scripts/preflight-deploy.ts`,
 * unmodified — this file never reimplements or duplicates its checks) as an
 * actual subprocess against three deterministic, checked-in, no-network
 * fixture environments:
 *
 *   1. a fully valid `--role=api` production env  -> must exit 0
 *   2. a fully valid `--role=worker` production env -> must exit 0
 *   3. the same api env with AUTH_MODE=dev (a real production misconfig)
 *      -> must exit non-zero, name the unsafe setting, and never echo any
 *         fixture credential value back in its output
 *
 * Run via `pnpm --filter @book/api preflight:deploy:ci-check` — this is the
 * command the "Deployment preflight" CI job invokes. Safe to run anywhere:
 * makes no network call and mutates nothing (same guarantee as the CLI it
 * wraps).
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');

/** Never a real credential — only used to prove it does NOT appear in CLI output. */
const SECRET_MARKER = 'ci-fixture-secret-DO-NOT-LEAK-9f3c2a';

const VALID_API_ENV: Record<string, string> = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://user:pass@db.internal:5432/storyme',
  REDIS_URL: 'redis://cache.internal:6379',
  JWT_SECRET: `jwt-${SECRET_MARKER}-padding-to-32-chars-aaaa`,
  JWT_REFRESH_SECRET: `jwt-refresh-${SECRET_MARKER}-padding-aaaa`,
  AUTH_MODE: 'jwt',
  WEB_APP_URL: 'https://storyme-demo.example.com',
  ALLOWED_ORIGINS: 'https://storyme-demo.example.com',
  EMAIL_PROVIDER: 'resend',
  RESEND_API_KEY: `resend-${SECRET_MARKER}`,
  EMAIL_FROM: 'StoryMe <noreply@storyme.app>',
  PDF_STORAGE_DRIVER: 'r2',
  PDF_STORAGE_BUCKET: 'storyme-previews',
  PDF_STORAGE_REGION: 'auto',
  PDF_STORAGE_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
  PDF_STORAGE_ACCESS_KEY_ID: `access-${SECRET_MARKER}`,
  PDF_STORAGE_SECRET_ACCESS_KEY: `secret-${SECRET_MARKER}`,
  IMAGE_STORAGE_DRIVER: 'r2',
};

/** Same deployment, from the worker's env panel — no auth/email/CORS vars, per the ownership matrix. */
const VALID_WORKER_ENV: Record<string, string> = {
  NODE_ENV: 'production',
  DATABASE_URL: VALID_API_ENV['DATABASE_URL'] as string,
  REDIS_URL: VALID_API_ENV['REDIS_URL'] as string,
  JWT_SECRET: VALID_API_ENV['JWT_SECRET'] as string,
  JWT_REFRESH_SECRET: VALID_API_ENV['JWT_REFRESH_SECRET'] as string,
  PDF_STORAGE_DRIVER: VALID_API_ENV['PDF_STORAGE_DRIVER'] as string,
  PDF_STORAGE_BUCKET: VALID_API_ENV['PDF_STORAGE_BUCKET'] as string,
  PDF_STORAGE_REGION: VALID_API_ENV['PDF_STORAGE_REGION'] as string,
  PDF_STORAGE_ENDPOINT: VALID_API_ENV['PDF_STORAGE_ENDPOINT'] as string,
  PDF_STORAGE_ACCESS_KEY_ID: VALID_API_ENV['PDF_STORAGE_ACCESS_KEY_ID'] as string,
  PDF_STORAGE_SECRET_ACCESS_KEY: VALID_API_ENV['PDF_STORAGE_SECRET_ACCESS_KEY'] as string,
  IMAGE_STORAGE_DRIVER: VALID_API_ENV['IMAGE_STORAGE_DRIVER'] as string,
};

/** Real-world production incident this guards against: dev-mode auth left on for a public deploy. */
const INVALID_API_ENV: Record<string, string> = {
  ...VALID_API_ENV,
  AUTH_MODE: 'dev',
};

interface Scenario {
  name: string;
  role: 'api' | 'worker';
  env: Record<string, string>;
  expectSuccess: boolean;
  /** Only for failure scenarios — the stable PreflightIssue.code that must appear in the output. */
  expectedCode?: string;
}

const scenarios: Scenario[] = [
  { name: 'valid production api env', role: 'api', env: VALID_API_ENV, expectSuccess: true },
  { name: 'valid production worker env', role: 'worker', env: VALID_WORKER_ENV, expectSuccess: true },
  {
    name: 'AUTH_MODE=dev on a production api deploy (expected failure)',
    role: 'api',
    env: INVALID_API_ENV,
    expectSuccess: false,
    expectedCode: 'auth_mode_not_jwt',
  },
];

function runScenario(scenario: Scenario): boolean {
  // `scenario.role` only ever comes from the fixed literals above ('api' |
  // 'worker'), never external input, so building this as a single shell
  // string (required for pnpm's Windows .cmd shim to resolve via PATH) is
  // safe here — no injection surface.
  const command = `pnpm --filter @book/api preflight:deploy --role=${scenario.role}`;
  const result = spawnSync(command, {
    cwd: REPO_ROOT,
    env: { ...process.env, ...scenario.env },
    encoding: 'utf-8',
    shell: true,
  });

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const exitCode = result.status;

  console.log(`\n── ${scenario.name} ──`);
  console.log(`role=${scenario.role} exitCode=${exitCode}`);

  let ok = true;

  if (scenario.expectSuccess) {
    if (exitCode !== 0) {
      console.error(`✘ expected exit 0, got ${exitCode}`);
      console.error(output);
      ok = false;
    } else {
      console.log('✔ passed as expected (exit 0)');
    }
  } else {
    if (exitCode === 0 || exitCode === null) {
      console.error(`✘ expected a non-zero exit code, got ${exitCode}`);
      ok = false;
    } else {
      console.log(`✔ exited non-zero (${exitCode}) as expected`);
    }

    if (scenario.expectedCode && !output.includes(scenario.expectedCode)) {
      console.error(`✘ expected output to name the check "${scenario.expectedCode}"`);
      console.error(output);
      ok = false;
    } else if (scenario.expectedCode) {
      console.log(`✔ output names the failing check ("${scenario.expectedCode}")`);
    }
  }

  // Regardless of pass/fail direction: the fixture's own secret values must
  // never appear in the CLI's stdout/stderr — this is the actual safety
  // property Phase F1 promises ("never prints a secret value").
  if (output.includes(SECRET_MARKER)) {
    console.error(`✘ output leaked a fixture secret value (contains "${SECRET_MARKER}")`);
    ok = false;
  } else {
    console.log('✔ no fixture secret values present in output');
  }

  return ok;
}

function main(): void {
  const results = scenarios.map(runScenario);
  const failed = results.filter((ok) => !ok).length;

  console.log('');
  if (failed > 0) {
    console.error(`${failed}/${scenarios.length} preflight CI fixture scenario(s) failed.`);
    process.exitCode = 1;
    return;
  }
  console.log(`All ${scenarios.length} preflight CI fixture scenarios passed.`);
}

main();
