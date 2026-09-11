import { describe, expect, it } from 'vitest';
import {
  assertAuthorizedOperations,
  executionPolicy,
  revalidateExecution,
} from './generation-execution-policy';
import { buildGenerationEstimate } from './generation-estimate';

const providers = {
  story: { providerName: 'openai', modelName: 'gpt-4o-mini' },
  character: { providerName: 'mock' },
  image: { providerName: 'mock' },
};
describe('worker budget authorization', () => {
  it('never converts spare mock work into permission for a lost paid artifact or HTTP retry', () => {
    const policy = executionPolicy(providers, {});
    const estimate = buildGenerationEstimate({
      ...policy,
      kind: 'retry',
      pageCount: 4,
      reuse: { storyCalls: 1 },
    });
    expect(estimate.maximumProviderCalls).toBe(8);
    expect(() =>
      assertAuthorizedOperations({ policy, estimate }, [
        { provider: 'openai', operation: 'story' },
      ]),
    ).toThrow('BUDGET');
    const initial = buildGenerationEstimate({ ...policy, kind: 'initial', pageCount: 4 });
    expect(() =>
      assertAuthorizedOperations({ policy, estimate: initial }, [
        { provider: 'openai', operation: 'story', httpAttempts: 2 },
      ]),
    ).toThrow('BUDGET');
  });
  it('rejects missing reuse instead of upgrading a zero-cost retry', () => {
    const policy = executionPolicy(providers, { OPENAI_STORY_ESTIMATED_COST_USD: '0.02' });
    const estimate = buildGenerationEstimate({
      ...policy,
      kind: 'retry',
      pageCount: 4,
      reuse: { storyCalls: 1, characterProfileCalls: 1, imageCalls: 7 },
    });
    expect(() => revalidateExecution(policy, 4, {}, { policy, estimate })).toThrow('hard limit');
  });
  it('fails explicitly on model/config deployment drift', () => {
    const policy = executionPolicy(providers, {});
    const estimate = buildGenerationEstimate({ ...policy, kind: 'initial', pageCount: 4 });
    const changed = executionPolicy(
      { ...providers, story: { ...providers.story, modelName: 'different' } },
      {},
    );
    expect(() => revalidateExecution(changed, 4, {}, { policy, estimate })).toThrow('CONFIG_DRIFT');
  });
});
