import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.{spec,test}.ts', 'test/**/*.{spec,test}.ts', 'scripts/**/*.{spec,test}.ts'],
    // Integration tests hit a real Postgres/Redis (see docker-compose.yml) and
    // are deliberately excluded from the default run — invoke explicitly via
    // `pnpm test:integration` (vitest.integration.config.ts), mirroring the
    // existing "manual S3/R2 smoke test" opt-in convention.
    exclude: ['node_modules/**', 'dist/**', 'test/integration/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/**',
        'dist/**',
        'src/main.ts',
        '**/*.module.ts',
        '**/test-utils/**',
        'prisma/**',
      ],
    },
  },
  resolve: {
    alias: {
      '@book/types': resolve(__dirname, '../../packages/types/src/index.ts'),
    },
  },
});
