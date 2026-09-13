import { describe, expect, it } from 'vitest';
import {
  assertAuthorizedOperations,
  buildExecutionAuthorization,
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

  it('separates logical identities from actual dispatch attempts', () => {
    const policy = executionPolicy(providers, {
      OPENAI_MAX_RETRIES: '1',
      REAL_GENERATION_MAX_PROVIDER_CALLS_PER_RUN: '2',
    });
    const estimate = buildGenerationEstimate({ ...policy, kind: 'initial', pageCount: 4 });
    const authorization = buildExecutionAuthorization(policy, estimate);
    expect(() =>
      assertAuthorizedOperations(authorization, [
        {
          provider: 'openai',
          operation: 'story',
          operationId: 'run:story:singleton',
          state: 'reserved_unsent',
        },
      ]),
    ).not.toThrow();
    expect(() =>
      assertAuthorizedOperations(authorization, [
        {
          provider: 'openai',
          operation: 'story',
          operationId: 'run:story:singleton',
          state: 'dispatch_intent',
          httpAttempts: 2,
        },
      ]),
    ).not.toThrow();
    expect(() =>
      assertAuthorizedOperations(authorization, [
        {
          provider: 'openai',
          operation: 'story',
          operationId: 'run:story:singleton',
          state: 'dispatch_intent',
          httpAttempts: 3,
        },
      ]),
    ).toThrow('BUDGET');
  });

  it('treats a legacy missing counter conservatively, unlike explicit reserved_unsent', () => {
    const policy = executionPolicy(providers, {
      REAL_GENERATION_MAX_PROVIDER_CALLS_PER_RUN: '1',
    });
    const estimate = buildGenerationEstimate({ ...policy, kind: 'initial', pageCount: 4 });
    const authorization = buildExecutionAuthorization(policy, estimate);
    expect(() =>
      assertAuthorizedOperations(authorization, [
        { provider: 'openai', operation: 'story', operationId: 'story', state: 'legacy' },
        {
          provider: 'openai',
          operation: 'story',
          operationId: 'story',
          state: 'reserved_unsent',
        },
      ]),
    ).not.toThrow();
  });

  it('rejects five attempts for one story operation plus one repair even when the category aggregate fits', () => {
    const policy = executionPolicy(providers, {
      OPENAI_MAX_RETRIES: '2',
      STORY_REPAIR_ENABLED: 'true',
      REAL_GENERATION_MAX_PROVIDER_CALLS_PER_RUN: '10',
    });
    const estimate = buildGenerationEstimate({ ...policy, kind: 'initial', pageCount: 4 });
    const authorization = buildExecutionAuthorization(policy, estimate);
    expect(() =>
      assertAuthorizedOperations(authorization, [
        {
          provider: 'openai',
          operation: 'story',
          operationId: 'story:one',
          httpAttempts: 5,
        },
        {
          provider: 'openai',
          operation: 'story_repair',
          operationId: 'repair:one',
          httpAttempts: 1,
        },
      ]),
    ).toThrow('BUDGET');
  });

  it('aggregates repeated deliveries of one stable operation independently', () => {
    const policy = executionPolicy(providers, {
      OPENAI_MAX_RETRIES: '2',
      REAL_GENERATION_MAX_PROVIDER_CALLS_PER_RUN: '10',
    });
    const authorization = buildExecutionAuthorization(
      policy,
      buildGenerationEstimate({ ...policy, kind: 'initial', pageCount: 4 }),
    );
    expect(() =>
      assertAuthorizedOperations(authorization, [
        { provider: 'openai', operation: 'story', operationId: 'same', httpAttempts: 2 },
        { provider: 'openai', operation: 'story', operationId: 'same', httpAttempts: 2 },
      ]),
    ).toThrow('BUDGET');
  });

  it('does not count known-unsent reservations as dispatch exposure but counts unknown outcomes', () => {
    const policy = executionPolicy(providers, {
      OPENAI_MAX_RETRIES: '0',
      REAL_GENERATION_MAX_PROVIDER_CALLS_PER_RUN: '1',
    });
    const authorization = buildExecutionAuthorization(
      policy,
      buildGenerationEstimate({ ...policy, kind: 'initial', pageCount: 4 }),
    );
    expect(() =>
      assertAuthorizedOperations(authorization, [
        { provider: 'openai', operation: 'story', operationId: 'same', state: 'reserved_unsent' },
        { provider: 'openai', operation: 'story', operationId: 'same', state: 'unknown' },
      ]),
    ).not.toThrow();
  });
});
