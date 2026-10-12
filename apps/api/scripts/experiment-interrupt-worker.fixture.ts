import { offlineProviderFor, runExperiment } from '../src/interactive/authoring/experiment';
import { DEFAULT_PIPELINE_LIMITS } from '../src/interactive/authoring/pipeline';
import type { ScenarioDraftProvider } from '../src/interactive/authoring/provider';

/**
 * Child-process fixture for experiment-interrupt.spec.ts. Offline only: no
 * network, no credentials, no real provider.
 *
 * Runs the experiment with scripted fixtures, answers the first brief normally,
 * and tells the parent over IPC when the second brief is waiting for a response
 * that never comes. The parent then terminates this process without any
 * graceful cleanup. Reaching the end of the experiment is a failure of the
 * interruption, reported through a distinctive exit code.
 */

const WAITING_KEY = 'harbour-ledger';
const draftsRoot = process.argv[2];

if (!draftsRoot || !process.send) {
  process.exit(64);
}

// Never outlive the test that owns this process.
process.on('disconnect', () => process.exit(65));

void runExperiment({
  mode: 'offline',
  limits: DEFAULT_PIPELINE_LIMITS,
  draftsRoot,
  providerFor: (entry): ScenarioDraftProvider => {
    if (entry.key !== WAITING_KEY) return offlineProviderFor(entry);
    return {
      name: 'scripted',
      model: null,
      draft: () => {
        process.send?.({ type: 'waiting', key: entry.key });
        return new Promise(() => undefined);
      },
    };
  },
}).then(
  () => process.exit(66),
  () => process.exit(67),
);
