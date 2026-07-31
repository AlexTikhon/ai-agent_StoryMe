import { defineConfig, devices } from '@playwright/test';

const webPort = 3100;
const apiPort = 4100;
const webBaseUrl = `http://127.0.0.1:${webPort}`;
const apiBaseUrl = `http://127.0.0.1:${apiPort}/api`;

process.env['DATABASE_URL'] ??= 'postgresql://storyme:storyme_e2e@127.0.0.1:5440/storyme_e2e';
process.env['REDIS_URL'] ??= 'redis://127.0.0.1:6380/15';
process.env['JWT_SECRET'] ??= 'storyme-e2e-jwt-secret-minimum-32-characters';
process.env['JWT_REFRESH_SECRET'] ??= 'storyme-e2e-refresh-secret-minimum-32-characters';

const sharedEnv = {
  ...process.env,
  DATABASE_URL: process.env['DATABASE_URL'],
  REDIS_URL: process.env['REDIS_URL'],
  JWT_SECRET: process.env['JWT_SECRET'],
  JWT_REFRESH_SECRET: process.env['JWT_REFRESH_SECRET'],
};

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI']
    ? [['line'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: webBaseUrl,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  globalTeardown: './e2e/global-teardown.ts',
  webServer: [
    {
      command: 'pnpm --filter @book/api start:e2e',
      cwd: '../..',
      url: `http://127.0.0.1:${apiPort}/api/health`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        ...sharedEnv,
        NODE_ENV: 'test',
        PORT: String(apiPort),
        AUTH_MODE: 'jwt',
        ENABLE_GENERATION_WORKER: 'true',
        ALLOWED_ORIGINS: webBaseUrl,
        WEB_APP_URL: webBaseUrl,
        STORY_GENERATION_PROVIDER: 'mock',
        IMAGE_GENERATION_PROVIDER: 'mock',
        EMAIL_PROVIDER: 'console',
        STRIPE_BILLING_ENABLED: 'false',
        PRODUCT_MODE: 'home',
        NEXT_PUBLIC_PRODUCT_MODE: 'home',
        PDF_STORAGE_DRIVER: 'local',
        IMAGE_STORAGE_DRIVER: 'local',
      },
    },
    {
      command: `pnpm --filter @book/web exec next dev --port ${webPort}`,
      cwd: '../..',
      url: webBaseUrl,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        ...sharedEnv,
        NODE_ENV: 'development',
        NEXT_PUBLIC_API_URL: apiBaseUrl,
        NEXT_PUBLIC_AUTH_MODE: 'jwt',
        PRODUCT_MODE: 'home',
        NEXT_PUBLIC_PRODUCT_MODE: 'home',
      },
    },
  ],
});
