/**
 * Phase F3 — CLI entry point for the migration target-identity guard, run by
 * `.github/workflows/migrate.yml` after Prisma Client generation and before
 * any `prisma migrate` command touches a database.
 *
 * Reads everything from process.env (never a CLI flag) so it matches exactly
 * what the workflow step's `env:` block provides:
 *
 *   TARGET_ENVIRONMENT   - "staging" | "production"
 *   DATABASE_URL         - the environment-scoped secret being validated
 *   EXPECTED_DB_HOSTNAME - environment-scoped expected hostname
 *   EXPECTED_DB_NAME     - environment-scoped expected database name
 *   CONFIRMATION_PHRASE  - the workflow_dispatch confirmation input
 *   GIT_REF              - github.ref of the triggering run
 *
 * Validation only — makes no network connection, mutates nothing, and never
 * prints DATABASE_URL or any hostname/database-name/username/password/query
 * parameter it contains (see migration-target-guard.ts for that guarantee).
 * Exits non-zero on any mismatch, which the workflow step relies on to stop
 * before Prisma runs.
 *
 * Usage: pnpm --filter @book/api migrate:target-guard
 */
import {
  checkMigrationTarget,
  type MigrationTargetGuardInput,
} from '../src/config/migration-target-guard';

function readInput(env: NodeJS.ProcessEnv): MigrationTargetGuardInput {
  return {
    environment: env['TARGET_ENVIRONMENT'] ?? '',
    databaseUrl: env['DATABASE_URL'],
    expectedHostname: env['EXPECTED_DB_HOSTNAME'],
    expectedDatabaseName: env['EXPECTED_DB_NAME'],
    confirmationPhrase: env['CONFIRMATION_PHRASE'],
    gitRef: env['GIT_REF'],
  };
}

function main(): void {
  const targetEnvironment = process.env['TARGET_ENVIRONMENT'] ?? '(unset)';
  const result = checkMigrationTarget(readInput(process.env));

  console.log(`Migration target guard — environment: ${targetEnvironment}`);
  console.log('');

  if (result.ok) {
    console.log('✔ Target identity, confirmation phrase, and branch guard all passed.');
    console.log(
      'This does not verify the database is reachable — only that the configured target matches expectations.',
    );
    return;
  }

  console.error(
    `✘ ${result.issues.length} issue(s) found — refusing to proceed before Prisma runs:\n`,
  );
  for (const i of result.issues) {
    console.error(`  [${i.code}] ${i.message}\n`);
  }
  process.exitCode = 1;
}

try {
  main();
} catch {
  console.error('Migration target guard failed to run — treating as a failure.');
  process.exitCode = 1;
}
