import { describe, expect, it } from 'vitest';
import { effectiveGenerationCheckpoint } from './generation-checkpoint';

describe('effectiveGenerationCheckpoint', () => {
  it('retains unadopted source content and artifacts across a second takeover', () => {
    const checkpoint = effectiveGenerationCheckpoint({
      version: 2,
      inputHash: 'input-1',
      compatibilityFingerprint: 'contract-1',
      runId: 'worker-b',
      fencingVersion: 2,
      content: { characterProfile: { name: 'Mia' } },
      artifacts: {
        page_1: { key: 'books/b/worker-b/2/page-1', sha256: 'copied-1' },
        page_2: { key: 'books/b/worker-b/2/page-2', sha256: 'copied-2' },
        page_3: { key: 'books/b/worker-b/2/page-3', sha256: 'copied-3' },
      },
      sourceCheckpoint: {
        version: 1,
        inputHash: 'input-1',
        compatibilityFingerprint: 'contract-1',
        runId: 'worker-a',
        fencingVersion: 1,
        content: { storyPlan: { title: 'Accepted story' }, bookPreview: { pages: [] } },
        artifacts: {
          page_1: { key: 'books/b/worker-a/1/page-1', sha256: 'old-1' },
          page_2: { key: 'books/b/worker-a/1/page-2', sha256: 'old-2' },
          page_3: { key: 'books/b/worker-a/1/page-3', sha256: 'old-3' },
          page_4: { key: 'books/b/worker-a/1/page-4', sha256: 'old-4' },
        },
      },
    });

    expect(checkpoint?.content).toMatchObject({
      characterProfile: { name: 'Mia' },
      storyPlan: { title: 'Accepted story' },
    });
    expect(checkpoint?.artifacts.page_1?.key).toContain('worker-b/2');
    expect(checkpoint?.artifacts.page_4?.key).toContain('worker-a/1');
  });

  it('never adopts an incompatible source checkpoint', () => {
    const checkpoint = effectiveGenerationCheckpoint({
      version: 2,
      inputHash: 'new-input',
      compatibilityFingerprint: 'new-contract',
      runId: 'worker-c',
      fencingVersion: 3,
      content: {},
      artifacts: {},
      sourceCheckpoint: {
        version: 1,
        inputHash: 'old-input',
        compatibilityFingerprint: 'old-contract',
        runId: 'worker-a',
        fencingVersion: 1,
        content: { storyPlan: { title: 'Wrong story' } },
        artifacts: { page_1: { key: 'old', sha256: 'old' } },
      },
    });

    expect(checkpoint?.content).toEqual({});
    expect(checkpoint?.artifacts).toEqual({});
  });
});
