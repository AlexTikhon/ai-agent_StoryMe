import { beforeEach, describe, expect, it } from 'vitest';
import { operationalMetrics } from './operational-metrics';

describe('operationalMetrics', () => {
  beforeEach(() => operationalMetrics.resetForTests());

  it('exposes every low-cardinality production signal even before traffic', () => {
    const output = operationalMetrics.render();
    for (const name of [
      'storyme_queue_wait_ms',
      'storyme_worker_processing_ms',
      'storyme_outbox_lag_ms',
      'storyme_recovery_outcomes_total',
      'storyme_unknown_dispatches_total',
      'storyme_quota_wait_ms',
      'storyme_redis_failures_total',
      'storyme_provider_errors_total',
      'storyme_publication_conflicts_total',
    ])
      expect(output).toContain(name);
  });

  it('records aggregate labels without accepting IDs as metric arguments', () => {
    operationalMetrics.observe('storyme_queue_wait_ms', 25, { queue: 'generation' });
    operationalMetrics.observe('storyme_queue_wait_ms', 75, { queue: 'generation' });
    expect(operationalMetrics.render()).toContain(
      'storyme_queue_wait_ms_sum{queue="generation"} 100',
    );
  });
});
