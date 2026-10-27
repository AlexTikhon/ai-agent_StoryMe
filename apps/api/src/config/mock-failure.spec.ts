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

  it('keeps failing every matching call when no match number is configured', async () => {
    const config = readMockFailureConfig({
      NODE_ENV: 'test',
      MOCK_FAILURES_ENABLED: 'true',
      MOCK_FAILURE_STAGE: 'image',
      MOCK_FAILURE_PAGE: '2',
    });
    expect(config.failureOnMatch).toBeUndefined();
    const controller = new MockFailureController(config);
    for (let call = 0; call < 3; call++) {
      await expect(controller.before('image', 2)).rejects.toThrow('image page 2');
    }
  });

  it('ignores a match number while injection is disabled', async () => {
    const controller = new MockFailureController(
      readMockFailureConfig({
        MOCK_FAILURE_STAGE: 'image',
        MOCK_FAILURE_PAGE: '2',
        MOCK_FAILURE_ON_MATCH: '1',
      }),
    );
    await expect(controller.before('image', 2)).resolves.toBeUndefined();
  });

  it('fails only the configured matching invocation, once', async () => {
    const controller = new MockFailureController(
      readMockFailureConfig({
        NODE_ENV: 'test',
        MOCK_FAILURES_ENABLED: 'true',
        MOCK_FAILURE_STAGE: 'image',
        MOCK_FAILURE_PAGE: '2',
        MOCK_FAILURE_ON_MATCH: '2',
      }),
    );
    await expect(controller.before('image', 2)).resolves.toBeUndefined();
    await expect(controller.before('image', 2)).rejects.toThrow(
      'image page 2 on matching invocation 2',
    );
    await expect(controller.before('image', 2)).resolves.toBeUndefined();
    await expect(controller.before('image', 2)).resolves.toBeUndefined();
  });

  it('does not count other stages or pages toward the match number', async () => {
    const controller = new MockFailureController(
      readMockFailureConfig({
        NODE_ENV: 'test',
        MOCK_FAILURES_ENABLED: 'true',
        MOCK_FAILURE_STAGE: 'image',
        MOCK_FAILURE_PAGE: '2',
        MOCK_FAILURE_ON_MATCH: '2',
      }),
    );
    await expect(controller.before('image', 2)).resolves.toBeUndefined();
    await expect(controller.before('story')).resolves.toBeUndefined();
    await expect(controller.before('character')).resolves.toBeUndefined();
    // A character sheet has no page number; covers and other pages differ.
    await expect(controller.before('image')).resolves.toBeUndefined();
    await expect(controller.before('image', 1)).resolves.toBeUndefined();
    await expect(controller.before('image', 3)).resolves.toBeUndefined();
    await expect(controller.before('image', 2)).rejects.toThrow('matching invocation 2');
  });

  it('numbers concurrent matching calls in call order, so exactly one fails', async () => {
    vi.useFakeTimers();
    try {
      const controller = new MockFailureController(
        readMockFailureConfig({
          NODE_ENV: 'test',
          MOCK_FAILURES_ENABLED: 'true',
          MOCK_FAILURE_STAGE: 'image',
          MOCK_FAILURE_PAGE: '2',
          MOCK_FAILURE_ON_MATCH: '2',
          MOCK_STAGE_DELAY_MS: '25',
        }),
      );
      // All three are in flight together across the configured delay.
      const settled = Promise.allSettled([
        controller.before('image', 2),
        controller.before('image', 2),
        controller.before('image', 2),
      ]);
      await vi.advanceTimersByTimeAsync(25);
      const results = await settled;
      expect(results.map((result) => result.status)).toEqual([
        'fulfilled',
        'rejected',
        'fulfilled',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the match count per controller instance', async () => {
    const env = {
      NODE_ENV: 'test',
      MOCK_FAILURES_ENABLED: 'true',
      MOCK_FAILURE_STAGE: 'image',
      MOCK_FAILURE_ON_MATCH: '1',
    } as const;
    const first = new MockFailureController(readMockFailureConfig(env));
    const second = new MockFailureController(readMockFailureConfig(env));
    await expect(first.before('image', 1)).rejects.toThrow('matching invocation 1');
    await expect(second.before('image', 1)).rejects.toThrow('matching invocation 1');
    await expect(first.before('image', 1)).resolves.toBeUndefined();
  });

  it.each(['0', '-1', '1.5', 'two', ''])(
    'rejects a non-positive-integer match number %j instead of failing every call',
    (value) => {
      expect(() =>
        readMockFailureConfig({
          NODE_ENV: 'test',
          MOCK_FAILURES_ENABLED: 'true',
          MOCK_FAILURE_STAGE: 'image',
          MOCK_FAILURE_ON_MATCH: value,
        }),
      ).toThrow(/MOCK_FAILURE_ON_MATCH/);
    },
  );

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

  it('refuses production activation even with a match number', () => {
    expect(() =>
      readMockFailureConfig({
        NODE_ENV: 'production',
        MOCK_FAILURES_ENABLED: 'true',
        MOCK_FAILURE_STAGE: 'image',
        MOCK_FAILURE_ON_MATCH: '2',
      }),
    ).toThrow(/forbidden/);
  });
});
