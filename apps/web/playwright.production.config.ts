import { defineConfig, devices } from '@playwright/test';

const webPort = 3200;
const baseURL = `http://127.0.0.1:${webPort}`;

export default defineConfig({
  testDir: './e2e-production',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? 'line' : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: `pnpm --filter @book/web exec next start --hostname 127.0.0.1 --port ${webPort}`,
    cwd: '../..',
    url: baseURL,
    timeout: 60_000,
    reuseExistingServer: false,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PRODUCT_MODE: 'home',
      NEXT_PUBLIC_PRODUCT_MODE: 'home',
      NEXT_PUBLIC_API_URL: 'http://127.0.0.1:4100/api',
      NEXT_PUBLIC_AUTH_MODE: 'jwt',
    },
  },
});
