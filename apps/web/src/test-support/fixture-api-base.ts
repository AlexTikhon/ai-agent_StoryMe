import { afterAll, beforeEach, vi } from 'vitest';

/**
 * The API base URL that tests asserting concrete request URLs compare against.
 *
 * Tests must not inherit this from the outer environment: CI sets
 * NEXT_PUBLIC_API_URL for the build, and a developer shell may set anything.
 * The `API_BASE` constants in lib/api/* are read once, when the module is
 * first imported, so the stub has to be in place before those modules load.
 * Import this file FIRST in a test file that asserts a localhost:4000 URL:
 *
 *   import '@/test-support/fixture-api-base';
 *
 * Production resolution (getApiBase in lib/api/config.ts) is untouched;
 * config.test.ts keeps covering custom URLs, the production failure and the
 * localhost fallback with its own per-test overrides.
 */
export const FIXTURE_API_BASE = 'http://localhost:4000/api';

vi.stubEnv('NEXT_PUBLIC_API_URL', FIXTURE_API_BASE);

// A test file's own afterEach may call vi.unstubAllEnvs(); put the fixture
// back so every test starts from it. Per-test overrides made after this hook
// still win, and afterAll restores whatever the outer environment supplied.
beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_API_URL', FIXTURE_API_BASE);
});

afterAll(() => {
  vi.unstubAllEnvs();
});
