import path from 'node:path';
import { DRAFTS_DIR_NAME, validateDraftsRoot } from '../src/interactive/authoring/artifacts';
import type { CorpusEntry } from '../src/interactive/authoring/corpus';
import {
  EXPERIMENT_USAGE,
  parseExperimentArgs,
} from '../src/interactive/authoring/experiment-config';
import {
  buildExperimentPlan,
  offlineProviderFor,
  runExperiment,
  type ManifestEntry,
} from '../src/interactive/authoring/experiment';
import { OpenAIScenarioDraftProvider } from '../src/interactive/authoring/openai-provider';
import type { ScenarioDraftProvider } from '../src/interactive/authoring/provider';

/**
 * Bounded authoring experiment over the three-entry corpus.
 *
 *   pnpm experiment:interactive:authoring                       # plan (default): JSON only, no side effects
 *   pnpm experiment:interactive:authoring --mode offline        # scripted fixtures: harness verification
 *   pnpm experiment:interactive:authoring --mode openai --allow-paid-calls --model <name>   # PAID
 *
 * Exactly one authoring attempt per corpus brief, sequentially, each with at
 * most one generation plus one content repair. No transport retries, no
 * concurrency, no repetition, no automatic resume. A content REJECTED result is
 * recorded and the next brief still runs; a provider/transport stop,
 * cancellation or artifact-write failure stops before the next brief and the
 * unfinished work is marked honestly in the manifest.
 *
 * Progress is checkpointed atomically in manifest.json (before the first
 * dispatch, around every dispatch, after every recorded entry). A checkpoint
 * that cannot be written stops the experiment before the next dispatch. A
 * killed process leaves the last checkpoint in the .incomplete directory; an
 * entry still marked awaiting_response has unknown usage.
 *
 * A completed experiment is not approval and not evidence of prose quality;
 * offline runs say nothing about any model. Nothing here approves or publishes.
 *
 * Exit codes: 0 experiment COMPLETE (or plan printed), 1 experiment INCOMPLETE
 * or its artifacts could not be recorded, 2 usage/configuration error (refused
 * before any side effect).
 */

const API_ROOT = path.resolve(__dirname, '..');

export const EXIT_CODES = { OK: 0, INCOMPLETE: 1, USAGE: 2 } as const;

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

/** Test seams; production passes none of them. */
export interface CliDeps {
  fetchImpl?: typeof fetch | undefined;
  defaultDraftsRoot?: string | undefined;
  now?: Date | undefined;
  randomHex?: (() => string) | undefined;
}

function describeEntry(entry: ManifestEntry, index: number, total: number): string {
  const head = `[${index}/${total}] ${entry.key}:`;
  if (entry.status === 'unattempted') return `${head} NOT ATTEMPTED`;
  // Unknown usage is never printed as zero.
  const counts =
    entry.usage === 'REPORTED'
      ? `requests ${entry.requests ?? 0}, HTTP attempts ${entry.httpAttempts ?? 0}`
      : entry.usage === 'UNKNOWN'
        ? 'usage unknown'
        : 'no request dispatched';
  const stop = entry.stop
    ? ` [${entry.stop.kind}${entry.stop.reason ? `:${entry.stop.reason}` : ''}]`
    : '';
  const repaired = entry.repaired ? ', repaired' : '';
  return `${head} ${entry.outcome ?? 'UNKNOWN'}${stop} (${counts}${repaired})`;
}

/** Returns the process exit code. */
export async function runCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  io: CliIo,
  signal?: AbortSignal,
  deps: CliDeps = {},
): Promise<number> {
  const parsed = parseExperimentArgs(argv, env);
  if (!parsed.ok) {
    io.err(`Error: ${parsed.error}`);
    io.err(EXPERIMENT_USAGE);
    return EXIT_CODES.USAGE;
  }
  const { config } = parsed;

  const defaultRoot = deps.defaultDraftsRoot ?? path.join(API_ROOT, DRAFTS_DIR_NAME);
  const root = validateDraftsRoot(config.draftsRoot, defaultRoot, [
    path.join(API_ROOT, 'src'),
    path.join(API_ROOT, 'assets'),
    path.join(API_ROOT, 'dist'),
    path.join(API_ROOT, 'prisma'),
    path.join(API_ROOT, '..', 'web'),
  ]);
  if (!root.ok) {
    io.err(`Error: ${root.error}`);
    return EXIT_CODES.USAGE;
  }

  if (config.mode === 'plan') {
    io.out(
      JSON.stringify(buildExperimentPlan({ limits: config.limits, model: config.model }), null, 2),
    );
    return EXIT_CODES.OK;
  }

  const plan = buildExperimentPlan({ limits: config.limits, model: config.model });
  let providerFor: (entry: CorpusEntry) => ScenarioDraftProvider;
  if (config.mode === 'openai') {
    // One stateless adapter; the pipeline owns the whole call budget.
    const provider = new OpenAIScenarioDraftProvider({
      apiKey: config.apiKey!,
      model: config.model!,
      ...(deps.fetchImpl && { fetchImpl: deps.fetchImpl }),
    });
    providerFor = () => provider;
  } else {
    providerFor = offlineProviderFor;
  }

  io.out('Interactive authoring experiment');
  io.out(
    config.mode === 'offline'
      ? 'Mode: offline (scripted fixtures: HARNESS VERIFICATION ONLY, not model performance)'
      : `Mode: openai (PAID calls enabled explicitly) model=${config.model}`,
  );
  io.out(
    `Corpus: ${plan.versions.corpus}, ${plan.budget.briefs} briefs; prompt ${plan.versions.prompt}; schema ${plan.versions.wireSchema}`,
  );
  io.out(
    `Budget (maximum): ${plan.budget.maxRequests} requests, ${plan.budget.maxHttpAttempts} HTTP attempts, ` +
      `${plan.budget.maxOutputTokens} output tokens (caps), ${plan.budget.maxRuntimeMs} ms; no retries, no concurrency`,
  );

  let printed = 0;
  const result = await runExperiment({
    mode: config.mode,
    providerFor,
    limits: config.limits,
    draftsRoot: root.root,
    model: config.model,
    signal,
    now: deps.now,
    randomHex: deps.randomHex,
    onEntry: (entry) => {
      printed += 1;
      io.out(describeEntry(entry, printed, plan.budget.briefs));
    },
  });

  if (!result.ok && result.code === 'EXPERIMENT_DIR_UNAVAILABLE') {
    io.err('Error: a fresh experiment directory could not be created; no provider call was made.');
    return EXIT_CODES.INCOMPLETE;
  }

  const { manifest } = result;
  const c = manifest.completeness;
  io.out(
    `Completeness: ${c.status} (${c.completed} completed, ${c.stopped} stopped, ${c.unattempted} unattempted)` +
      (c.reasons.length > 0 ? ` reasons: ${c.reasons.join(', ')}` : ''),
  );
  const { coverage } = manifest.observed;
  io.out(
    `Observed: ${manifest.observed.requests} requests, ${manifest.observed.httpAttempts} HTTP attempts` +
      (coverage.status === 'PARTIAL'
        ? ` (PARTIAL: ${coverage.unknown} entr${coverage.unknown === 1 ? 'y' : 'ies'} with unknown usage; budget not determined)`
        : ''),
  );
  io.out(`Experiment: ${result.dir}`);
  if (!result.ok) {
    io.err(
      result.code === 'CHECKPOINT_WRITE_FAILED'
        ? 'Error: the initial progress checkpoint could not be written; no provider call was made. ' +
            'The directory above is left .incomplete.'
        : `Error: the manifest could not be recorded (${result.code}); the directory above is left .incomplete.`,
    );
    return EXIT_CODES.INCOMPLETE;
  }
  io.out(`Manifest: ${path.join(result.dir, 'manifest.json')}`);
  io.out(
    'Not approval and not evidence of prose quality: approval templates remain PENDING and nothing is published.',
  );
  return c.status === 'COMPLETE' ? EXIT_CODES.OK : EXIT_CODES.INCOMPLETE;
}

async function main(): Promise<void> {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  try {
    process.exitCode = await runCli(
      process.argv.slice(2),
      process.env,
      { out: (l) => console.log(l), err: (l) => console.error(l) },
      controller.signal,
    );
  } catch (error) {
    // Never print the message: it could contain provider or path details.
    console.error(`Unexpected failure (${error instanceof Error ? error.name : 'unknown'})`);
    process.exitCode = EXIT_CODES.INCOMPLETE;
  }
}

if (require.main === module) void main();
