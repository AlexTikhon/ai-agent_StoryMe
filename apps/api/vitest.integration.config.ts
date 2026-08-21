import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

/**
 * Durable integration suite against the disposable PostgreSQL/Redis services
 * in docker-compose.e2e.yml (ports 5440/6380), never the developer database.
 * `pnpm test:integration` validates both targets, checks readiness, deploys
 * migrations, and then invokes this config.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/integration/**/*.integration.spec.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    setupFiles: ['test/integration/setup.ts'],
    // Integration files share one disposable database, including the two
    // singleton RecoveryLease rows. Running files concurrently lets one
    // file's cleanup invalidate another file's persisted lease assertions.
    // Keep concurrency inside each test where it is explicitly barrier-driven.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      '@book/types': resolve(__dirname, '../../packages/types/src/index.ts'),
    },
  },
});
