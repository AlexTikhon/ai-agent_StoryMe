import { afterEach, describe, expect, it, vi } from 'vitest';
import { isDeveloperDiagnosticsEnabled } from './feature-flags';

describe('isDeveloperDiagnosticsEnabled', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to disabled', () => {
    vi.stubEnv('NEXT_PUBLIC_ENABLE_DEVELOPER_DIAGNOSTICS', '');

    expect(isDeveloperDiagnosticsEnabled()).toBe(false);
  });

  it('requires the explicit value true', () => {
    vi.stubEnv('NEXT_PUBLIC_ENABLE_DEVELOPER_DIAGNOSTICS', 'true');
    expect(isDeveloperDiagnosticsEnabled()).toBe(true);

    vi.stubEnv('NEXT_PUBLIC_ENABLE_DEVELOPER_DIAGNOSTICS', 'TRUE');
    expect(isDeveloperDiagnosticsEnabled()).toBe(false);
  });
});
