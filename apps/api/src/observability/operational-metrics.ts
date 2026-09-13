type MetricName =
  | 'storyme_queue_wait_ms'
  | 'storyme_worker_processing_ms'
  | 'storyme_outbox_lag_ms'
  | 'storyme_recovery_outcomes_total'
  | 'storyme_unknown_dispatches_total'
  | 'storyme_quota_wait_ms'
  | 'storyme_redis_failures_total'
  | 'storyme_provider_errors_total'
  | 'storyme_publication_conflicts_total';

const COUNTERS = new Set<MetricName>([
  'storyme_recovery_outcomes_total',
  'storyme_unknown_dispatches_total',
  'storyme_redis_failures_total',
  'storyme_provider_errors_total',
  'storyme_publication_conflicts_total',
]);

const NAMES: MetricName[] = [
  'storyme_queue_wait_ms',
  'storyme_worker_processing_ms',
  'storyme_outbox_lag_ms',
  'storyme_recovery_outcomes_total',
  'storyme_unknown_dispatches_total',
  'storyme_quota_wait_ms',
  'storyme_redis_failures_total',
  'storyme_provider_errors_total',
  'storyme_publication_conflicts_total',
];

interface Sample {
  count: number;
  sum: number;
  labels: Readonly<Record<string, string>>;
}

const samples = new Map<string, Sample>();

function normalizedLabels(labels: Readonly<Record<string, string>>): string {
  return Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)}`)
    .join(',');
}

function record(name: MetricName, value: number, labels: Readonly<Record<string, string>>): void {
  if (!Number.isFinite(value) || value < 0) return;
  const labelKey = normalizedLabels(labels);
  const key = `${name}|${labelKey}`;
  const current = samples.get(key) ?? { count: 0, sum: 0, labels: { ...labels } };
  current.count += 1;
  current.sum += value;
  samples.set(key, current);
}

export const operationalMetrics = {
  increment(name: MetricName, labels: Readonly<Record<string, string>> = {}): void {
    record(name, 1, labels);
  },
  observe(name: MetricName, value: number, labels: Readonly<Record<string, string>> = {}): void {
    record(name, value, labels);
  },
  render(): string {
    const lines: string[] = [];
    for (const name of NAMES) {
      const matching = [...samples.entries()].filter(([key]) => key.startsWith(`${name}|`));
      lines.push(`# TYPE ${name} ${COUNTERS.has(name) ? 'counter' : 'summary'}`);
      if (matching.length === 0) {
        lines.push(
          COUNTERS.has(name) ? `${name} 0` : `${name}_count 0`,
          ...(COUNTERS.has(name) ? [] : [`${name}_sum 0`]),
        );
        continue;
      }
      for (const [, sample] of matching) {
        const labels = Object.entries(sample.labels)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, value]) => `${key}="${value.replace(/["\\\n\r]/g, '_')}"`)
          .join(',');
        const suffix = labels ? `{${labels}}` : '';
        if (COUNTERS.has(name)) lines.push(`${name}${suffix} ${sample.sum}`);
        else
          lines.push(
            `${name}_count${suffix} ${sample.count}`,
            `${name}_sum${suffix} ${sample.sum}`,
          );
      }
    }
    return `${lines.join('\n')}\n`;
  },
  resetForTests(): void {
    samples.clear();
  },
};
