import { describe, expect, it } from 'vitest';
import { prepareGeneration } from './generation-preparation';
import type { GenerationExecutionContext } from './generation-execution-context';

const ctx: GenerationExecutionContext = {
  runId: 'run-1',
  bookId: 'book-1',
  fencingVersion: 1,
  inputHash: 'hash-1',
  inputSnapshot: {
    childName: 'Mia',
    childAge: 7,
    theme: 'space',
    language: 'pl',
    pageCount: 4,
    educationalMessage: 'Ask for help',
    childPhoto: {
      assetKey: 'private/photo-key',
      contentType: 'image/png',
      sha256: 'photo-r1',
      sizeBytes: 123,
    },
  },
};

describe('prepareGeneration', () => {
  it('resolves immutable input, provider identity and the existing call budget once', () => {
    const prepared = prepareGeneration(
      ctx,
      {
        story: { providerName: 'mock', generateStory: async () => Promise.reject() },
        image: { providerName: 'mock', generateImage: async () => Promise.reject() },
        character: { providerName: 'mock', buildProfile: async () => Promise.reject() },
      },
      { STORY_REPAIR_ENABLED: 'false', MAX_PAID_PROVIDER_CALLS_PER_RUN: '20' },
    );

    expect(prepared.input).toEqual(ctx.inputSnapshot);
    expect(prepared.targetPageCount).toBe(4);
    expect(prepared.storyRepairEnabled).toBe(false);
    expect(prepared.aiModelVersions).toEqual({ story: 'mock', image: 'mock' });
    expect(prepared.providerTelemetry.snapshot()).toMatchObject({ maxPaidCalls: 20 });
  });
});
