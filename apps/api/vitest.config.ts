import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.{spec,test}.ts', 'test/**/*.{spec,test}.ts', 'scripts/**/*.{spec,test}.ts'],
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
