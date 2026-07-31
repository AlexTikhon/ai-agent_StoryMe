import { describe, expect, it, vi } from 'vitest';
import { MockFailureController, readMockFailureConfig } from './mock-failure';

describe('deterministic mock failure injection', () => {
  it('is disabled by default', async () => {
    const controller = new MockFailureController(readMockFailureConfig({}));
    await expect(controller.before('story')).resolves.toBeUndefined();
  });

  it('fails only the selected image page', async () => {
    const controller = new MockFailureController(
      readMockFailureConfig({
        NODE_ENV: 'test',
        MOCK_FAILURES_ENABLED: 'true',
        MOCK_FAILURE_STAGE: 'image',
        MOCK_FAILURE_PAGE: '2',
      }),
    );
    await expect(controller.before('image', 1)).resolves.toBeUndefined();
    await expect(controller.before('image', 2)).rejects.toThrow('image page 2');
  });

  it('applies a deterministic configured delay', async () => {
    vi.useFakeTimers();
    const controller = new MockFailureController(
      readMockFailureConfig({
        NODE_ENV: 'test',
        MOCK_FAILURES_ENABLED: 'true',
        MOCK_STAGE_DELAY_MS: '25',
      }),
    );
    const pending = controller.before('character');
    await vi.advanceTimersByTimeAsync(25);
    await expect(pending).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it('refuses production activation', () => {
    expect(() =>
      readMockFailureConfig({ NODE_ENV: 'production', MOCK_FAILURES_ENABLED: 'true' }),
    ).toThrow(/forbidden/);
  });
});
