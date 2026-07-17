/**
 * Phase F3 — pre-Prisma target-identity guard for the manual migration
 * release workflow (.github/workflows/migrate.yml). Confirms a migration run
 * is pointed at the database operators actually intended before any Prisma
 * command runs, since a mistargeted `prisma migrate deploy` (wrong host,
 * wrong environment, wrong branch) can silently apply schema changes to the
 * wrong database.
 *
 * Pure — no I/O, no network, safe to unit-test with fake strings. Every
 * issue message is static/generic: it never interpolates the supplied
 * DATABASE_URL, hostname, database name, or any of their substrings, so this
 * module is safe to run against a real production DATABASE_URL and print the
 * result to a CI log (same guarantee `preflight-deploy-checks.ts` makes for
 * env values).
 */

export type MigrationEnvironment = 'staging' | 'production';

const ENVIRONMENTS: readonly MigrationEnvironment[] = ['staging', 'production'];

export function isMigrationEnvironment(value: string): value is MigrationEnvironment {
  return (ENVIRONMENTS as readonly string[]).includes(value);
}

/** Distinct, exact-match phrases per environment — never reused across environments. */
export const CONFIRMATION_PHRASES: Record<MigrationEnvironment, string> = {
  staging: 'APPLY_STAGING_MIGRATIONS',
  production: 'APPLY_PRODUCTION_MIGRATIONS',
};

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

export interface MigrationTargetGuardInput {
  /** Raw value of the workflow's selected-environment input — validated, not assumed. */
  environment: string;
  databaseUrl: string | undefined;
  /** Expected hostname for `environment`, sourced from a GitHub Environment variable/secret scoped to it. */
  expectedHostname: string | undefined;
  /** Expected database name for `environment`, same scoping requirement as expectedHostname. */
  expectedDatabaseName: string | undefined;
  confirmationPhrase: string | undefined;
  /** e.g. `refs/heads/main` (github.ref) or a bare branch name — both accepted. */
  gitRef: string | undefined;
}

export interface MigrationTargetIssue {
  /** Stable, grep-able identifier — useful for tests/tooling, not shown as the primary message. */
  code: string;
  /** Always safe to print: static guidance text, never a value derived from the supplied input. */
  message: string;
}

export interface MigrationTargetResult {
  ok: boolean;
  issues: MigrationTargetIssue[];
}

function issue(code: string, message: string): MigrationTargetIssue {
  return { code, message };
}

function normalizeRef(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

/**
 * Validates the migration target end-to-end: confirmation phrase, DATABASE_URL
 * shape/host/database-name against the environment-scoped expected values, and
 * (for production) that the run originates from `main`. Every check that can
 * run independently does — this returns every issue found, not just the
 * first, so a single guard run tells an operator everything wrong at once.
 */
export function checkMigrationTarget(input: MigrationTargetGuardInput): MigrationTargetResult {
  if (!isMigrationEnvironment(input.environment)) {
    return {
      ok: false,
      issues: [
        issue(
          'invalid_environment',
          'Selected environment must be exactly "staging" or "production".',
        ),
      ],
    };
  }
  const environment = input.environment;
  const issues: MigrationTargetIssue[] = [];

  // ─── Confirmation phrase ────────────────────────────────────────────────
  const expectedPhrase = CONFIRMATION_PHRASES[environment];
  if (!input.confirmationPhrase || input.confirmationPhrase.trim().length === 0) {
    issues.push(
      issue(
        'confirmation_missing',
        'A confirmation phrase is required and must exactly match the phrase for the selected environment.',
      ),
    );
  } else if (input.confirmationPhrase !== expectedPhrase) {
    issues.push(
      issue(
        'confirmation_mismatch',
        `Confirmation phrase does not exactly match the required phrase for the "${environment}" target. ` +
          'Re-run the workflow and enter the exact phrase shown in its input description.',
      ),
    );
  }

  // ─── DATABASE_URL shape ─────────────────────────────────────────────────
  let parsed: URL | null = null;
  if (!input.databaseUrl || input.databaseUrl.trim().length === 0) {
    issues.push(
      issue('database_url_missing', 'DATABASE_URL is required and was not provided to the guard.'),
    );
  } else {
    try {
      parsed = new URL(input.databaseUrl);
    } catch {
      issues.push(
        issue(
          'database_url_malformed',
          'DATABASE_URL could not be parsed as a valid URL. Check the environment secret is set correctly.',
        ),
      );
    }
  }

  if (parsed) {
    const protocol = parsed.protocol.replace(/:$/, '');
    if (protocol !== 'postgresql' && protocol !== 'postgres') {
      issues.push(
        issue(
          'database_url_not_postgres',
          'DATABASE_URL must use the postgresql:// (or postgres://) scheme.',
        ),
      );
    }

    const hostname = parsed.hostname.toLowerCase();
    if (!hostname) {
      issues.push(
        issue('database_url_empty_host', 'DATABASE_URL must include a non-empty hostname.'),
      );
    } else if (LOOPBACK_HOSTNAMES.has(hostname)) {
      issues.push(
        issue(
          'database_url_loopback_host',
          'DATABASE_URL must not point at localhost or a loopback address for a staging/production migration.',
        ),
      );
    }

    if (!input.expectedHostname || input.expectedHostname.trim().length === 0) {
      issues.push(
        issue(
          'expected_hostname_missing',
          `No expected database hostname is configured for the "${environment}" environment. ` +
            'A repository administrator must set it as a GitHub Environment variable or secret scoped to this environment.',
        ),
      );
    } else if (hostname && hostname !== input.expectedHostname.trim().toLowerCase()) {
      issues.push(
        issue(
          'hostname_mismatch',
          'The DATABASE_URL hostname does not match the expected hostname configured for this environment.',
        ),
      );
    }

    const databaseName = parsed.pathname.replace(/^\//, '');
    if (!input.expectedDatabaseName || input.expectedDatabaseName.trim().length === 0) {
      issues.push(
        issue(
          'expected_database_name_missing',
          `No expected database name is configured for the "${environment}" environment. ` +
            'A repository administrator must set it as a GitHub Environment variable or secret scoped to this environment.',
        ),
      );
    } else if (databaseName && databaseName !== input.expectedDatabaseName.trim()) {
      issues.push(
        issue(
          'database_name_mismatch',
          'The DATABASE_URL database name does not match the expected database name configured for this environment.',
        ),
      );
    }
  }

  // ─── Production branch guard ────────────────────────────────────────────
  if (environment === 'production') {
    const ref = input.gitRef ?? '';
    if (ref.trim().length === 0 || normalizeRef(ref) !== 'main') {
      issues.push(
        issue(
          'production_requires_main',
          'Production migrations may only be run from the "main" branch.',
        ),
      );
    }
  }

  return { ok: issues.length === 0, issues };
}
