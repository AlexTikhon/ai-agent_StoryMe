import { defineConfig, type PlaywrightTestConfig } from '@playwright/test';
import baseConfig from './playwright.config';

type WebServer = Exclude<NonNullable<PlaywrightTestConfig['webServer']>, readonly unknown[]>;

// Fails the second page-2 illustration call once, then succeeds: the first
// generation is match 1, the regeneration match 2, and the retry match 3.
// The longer, bounded stage delay keeps a regeneration active long enough to
// cancel it through the UI. Only this config's own API process receives it.
const RECOVERY_API_ENV = {
  MOCK_FAILURES_ENABLED: 'true',
  MOCK_FAILURE_STAGE: 'image',
  MOCK_FAILURE_PAGE: '2',
  MOCK_FAILURE_ON_MATCH: '2',
  MOCK_STAGE_DELAY_MS: '1500',
};

const [apiServer, webServer, ...unexpected] = baseConfig.webServer as WebServer[];
if (!apiServer?.command.includes('test-launcher.mjs api-e2e') || !webServer || unexpected.length) {
  throw new Error('playwright.recovery.config.ts expects the base [guarded API, web] servers.');
}

export default defineConfig({
  ...baseConfig,
  testIgnore: [],
  testMatch: '**/storyme.recovery.spec.ts',
  workers: 1,
  retries: 0,
  // Three full generations plus a cancellation, each stage delayed.
  timeout: 300_000,
  outputDir: 'test-results/recovery',
  reporter: process.env['CI']
    ? [['line'], ['html', { open: 'never', outputFolder: 'playwright-report/recovery' }]]
    : [['list'], ['html', { open: 'never', outputFolder: 'playwright-report/recovery' }]],
  webServer: [{ ...apiServer, env: { ...apiServer.env, ...RECOVERY_API_ENV } }, webServer],
});
