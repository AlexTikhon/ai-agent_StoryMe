import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

/**
 * Durable integration suite against a real Postgres (docker-compose.yml,
 * localhost:5433) — not mocks. Requires DATABASE_URL to point at a live,
 * migrated database. Run via `pnpm test:integration`; kept out of the
 * default `pnpm test` run (vitest.config.ts excludes this directory) since it
 * needs real infrastructure up, mirroring the project's existing
 * "manual S3/R2 smoke test" opt-in convention.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/integration/**/*.integration.spec.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      '@book/types': resolve(__dirname, '../../packages/types/src/index.ts'),
    },
  },
});
