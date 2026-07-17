import { describe, it, expect } from 'vitest';
import {
  checkMigrationTarget,
  CONFIRMATION_PHRASES,
  type MigrationTargetGuardInput,
} from './migration-target-guard';

const STAGING_URL =
  'postgresql://app_user:hunter2@staging-db.internal.example.com:5432/storyme_staging';
const PRODUCTION_URL =
  'postgresql://app_user:hunter2@prod-db.internal.example.com:5432/storyme_production';

function stagingInput(
  overrides: Partial<MigrationTargetGuardInput> = {},
): MigrationTargetGuardInput {
  return {
    environment: 'staging',
    databaseUrl: STAGING_URL,
    expectedHostname: 'staging-db.internal.example.com',
    expectedDatabaseName: 'storyme_staging',
    confirmationPhrase: CONFIRMATION_PHRASES.staging,
    gitRef: 'refs/heads/feature/some-branch',
    ...overrides,
  };
}

function productionInput(
  overrides: Partial<MigrationTargetGuardInput> = {},
): MigrationTargetGuardInput {
  return {
    environment: 'production',
    databaseUrl: PRODUCTION_URL,
    expectedHostname: 'prod-db.internal.example.com',
    expectedDatabaseName: 'storyme_production',
    confirmationPhrase: CONFIRMATION_PHRASES.production,
    gitRef: 'refs/heads/main',
    ...overrides,
  };
}

describe('checkMigrationTarget', () => {
  it('accepts a valid staging target', () => {
    const result = checkMigrationTarget(stagingInput());
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('accepts a valid production target run from main', () => {
    const result = checkMigrationTarget(productionInput());
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('also accepts a bare "main" ref (not just refs/heads/main) for production', () => {
    const result = checkMigrationTarget(productionInput({ gitRef: 'main' }));
    expect(result.ok).toBe(true);
  });

  it('rejects production run from a non-main ref', () => {
    const result = checkMigrationTarget(productionInput({ gitRef: 'refs/heads/release/1.2.3' }));
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('production_requires_main');
  });

  it('rejects production run with a missing ref', () => {
    const result = checkMigrationTarget(productionInput({ gitRef: undefined }));
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('production_requires_main');
  });

  it('does not require main for staging', () => {
    const result = checkMigrationTarget(stagingInput({ gitRef: 'refs/heads/feature/xyz' }));
    expect(result.ok).toBe(true);
  });

  it('rejects a missing confirmation phrase', () => {
    const result = checkMigrationTarget(stagingInput({ confirmationPhrase: '' }));
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('confirmation_missing');
  });

  it('rejects a wrong confirmation phrase', () => {
    const result = checkMigrationTarget(stagingInput({ confirmationPhrase: 'YES_DO_IT' }));
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('confirmation_mismatch');
  });

  it('rejects the staging confirmation phrase used against production', () => {
    const result = checkMigrationTarget(
      productionInput({ confirmationPhrase: CONFIRMATION_PHRASES.staging }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('confirmation_mismatch');
  });

  it('rejects the production confirmation phrase used against staging', () => {
    const result = checkMigrationTarget(
      stagingInput({ confirmationPhrase: CONFIRMATION_PHRASES.production }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('confirmation_mismatch');
  });

  it('rejects a malformed DATABASE_URL', () => {
    const result = checkMigrationTarget(stagingInput({ databaseUrl: 'not-a-url-at-all' }));
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('database_url_malformed');
  });

  it('rejects a missing DATABASE_URL', () => {
    const result = checkMigrationTarget(stagingInput({ databaseUrl: undefined }));
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('database_url_missing');
  });

  it('rejects a non-PostgreSQL URL scheme', () => {
    const result = checkMigrationTarget(
      stagingInput({
        databaseUrl: 'mysql://user:pass@staging-db.internal.example.com:3306/storyme_staging',
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('database_url_not_postgres');
  });

  it('accepts the postgres:// scheme alias', () => {
    const result = checkMigrationTarget(
      stagingInput({
        databaseUrl:
          'postgres://app_user:hunter2@staging-db.internal.example.com:5432/storyme_staging',
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a localhost hostname', () => {
    const result = checkMigrationTarget(
      stagingInput({
        databaseUrl: 'postgresql://user:pass@localhost:5432/storyme_staging',
        expectedHostname: 'localhost',
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('database_url_loopback_host');
  });

  it('rejects a loopback IP hostname (127.0.0.1)', () => {
    const result = checkMigrationTarget(
      stagingInput({
        databaseUrl: 'postgresql://user:pass@127.0.0.1:5432/storyme_staging',
        expectedHostname: '127.0.0.1',
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('database_url_loopback_host');
  });

  it('rejects a hostname that does not match the expected environment hostname', () => {
    const result = checkMigrationTarget(
      stagingInput({ expectedHostname: 'some-other-host.example.com' }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('hostname_mismatch');
  });

  it('rejects a database name that does not match the expected environment database name', () => {
    const result = checkMigrationTarget(stagingInput({ expectedDatabaseName: 'some_other_db' }));
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('database_name_mismatch');
  });

  it('rejects when the expected hostname is not configured', () => {
    const result = checkMigrationTarget(stagingInput({ expectedHostname: undefined }));
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('expected_hostname_missing');
  });

  it('rejects when the expected database name is not configured', () => {
    const result = checkMigrationTarget(stagingInput({ expectedDatabaseName: '' }));
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('expected_database_name_missing');
  });

  it('rejects an unknown environment value', () => {
    const result = checkMigrationTarget(stagingInput({ environment: 'preprod' }));
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('invalid_environment');
  });

  it('accepts a password containing URL-encoded special characters', () => {
    // Raw password before encoding: p@ss:w0rd/?#
    const encodedPasswordUrl =
      'postgresql://app_user:p%40ss%3Aw0rd%2F%3F%23@staging-db.internal.example.com:5432/storyme_staging';
    const result = checkMigrationTarget(stagingInput({ databaseUrl: encodedPasswordUrl }));
    expect(result.ok).toBe(true);
  });

  it('never includes the supplied URL, password, host, database name, or query parameters in any issue message', () => {
    const secretMarker = 'sUp3r-Secret-P@ssw0rd-9f3c2a';
    const hostMarker = 'leaky-host-marker.example.internal';
    const dbNameMarker = 'leaky_db_name_marker';
    const queryMarker = 'leaky_query_param_marker';

    const url = `postgresql://leakuser:${encodeURIComponent(secretMarker)}@${hostMarker}:5432/${dbNameMarker}?sslmode=require&marker=${queryMarker}`;

    const scenarios: MigrationTargetGuardInput[] = [
      stagingInput({
        databaseUrl: url,
        expectedHostname: hostMarker,
        expectedDatabaseName: dbNameMarker,
      }),
      stagingInput({
        databaseUrl: url,
        expectedHostname: 'wrong-host.example.com',
        expectedDatabaseName: dbNameMarker,
      }),
      stagingInput({
        databaseUrl: url,
        expectedHostname: hostMarker,
        expectedDatabaseName: 'wrong_db',
      }),
      stagingInput({ databaseUrl: url, confirmationPhrase: 'WRONG' }),
      productionInput({
        databaseUrl: url,
        expectedHostname: hostMarker,
        expectedDatabaseName: dbNameMarker,
        gitRef: 'refs/heads/not-main',
      }),
    ];

    for (const scenario of scenarios) {
      const result = checkMigrationTarget(scenario);
      const combined = result.issues.map((i) => `${i.code}:${i.message}`).join('\n');
      expect(combined).not.toContain(url);
      expect(combined).not.toContain(secretMarker);
      expect(combined).not.toContain(encodeURIComponent(secretMarker));
      expect(combined).not.toContain(hostMarker);
      expect(combined).not.toContain(dbNameMarker);
      expect(combined).not.toContain(queryMarker);
      expect(combined).not.toContain('sslmode');
    }
  });
});
