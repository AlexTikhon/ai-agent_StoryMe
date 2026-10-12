import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { replaceFileAtomically } from '../src/interactive/authoring/atomic-replace';
import { writeRunArtifacts } from '../src/interactive/authoring/artifacts';
import { AUTHORING_CORPUS, type CorpusEntry } from '../src/interactive/authoring/corpus';
import { runExperiment } from '../src/interactive/authoring/experiment';
import type { PipelineLimits } from '../src/interactive/authoring/pipeline';
import type { ScenarioDraftProvider } from '../src/interactive/authoring/provider';
import { ScriptedDraftProvider, type ScriptStep } from '../src/interactive/authoring/scripted-provider';
import { scenarioToWire } from '../src/interactive/authoring/wire';

/**
 * Test-only: experiment bundles produced by the REAL runner with scripted
 * providers (no network, no credentials). Intermediate checkpoints are real
 * too: the work directory is copied at the exact moment the runner is waiting
 * on the provider (`awaiting_response`) or has just durably recorded a result
 * (`recording`), so the copy is byte-for-byte what a terminated process would
 * have left behind.
 */

export const FAST_LIMITS: PipelineLimits = {
  maxOutputTokens: 4000,
  requestTimeoutMs: 20,
  deadlineMs: 5000,
};

export const FIXTURE_MODEL = 'inspect-fixture-model';

export interface Bundle {
  /** The experiment directory (holds manifest.json). */
  dir: string;
  manifestPath: string;
}

const valid = (entry: CorpusEntry): string => JSON.stringify(scenarioToWire(entry.scenario));

function allValid(): Record<CorpusEntry['key'], ScriptStep[]> {
  return Object.fromEntries(
    AUTHORING_CORPUS.map((entry) => [entry.key, [{ candidate: valid(entry), httpAttempts: 0 }]]),
  ) as Record<CorpusEntry['key'], ScriptStep[]>;
}

let sequence = 0;

function runOptions(root: string) {
  const draftsRoot = path.join(root, 'scenario-drafts');
  return {
    draftsRoot,
    limits: FAST_LIMITS,
    now: new Date(Date.UTC(2026, 9, 12, 10, 0, 0)),
    randomHex: () => (sequence++).toString(16).padStart(8, '0'),
  };
}

function providers(
  scripts: Record<CorpusEntry['key'], ScriptStep[]>,
  identity?: { name: 'openai'; model: string },
) {
  const byKey = new Map(
    AUTHORING_CORPUS.map((entry) => {
      const scripted = new ScriptedDraftProvider(scripts[entry.key]);
      // Reports the way the real adapter's runs do (provider and model in provenance).
      const provider: ScenarioDraftProvider = identity
        ? { name: identity.name, model: identity.model, draft: (r) => scripted.draft(r) }
        : scripted;
      return [entry.key, provider] as const;
    }),
  );
  return (entry: CorpusEntry): ScenarioDraftProvider => byKey.get(entry.key)!;
}

function bundleAt(dir: string): Bundle {
  return { dir, manifestPath: path.join(dir, 'manifest.json') };
}

function onlyDirectory(parent: string): string {
  const names = readdirSync(parent);
  if (names.length !== 1) throw new Error('expected exactly one experiment directory');
  return path.join(parent, names[0]!);
}

/** All three briefs completed offline: a finished `--complete` bundle. */
export async function completeBundle(root: string): Promise<Bundle> {
  const options = runOptions(root);
  const result = await runExperiment({
    mode: 'offline',
    providerFor: providers(allValid()),
    ...options,
  });
  if (!result.ok) throw new Error(`experiment did not finish: ${result.code}`);
  return bundleAt(result.dir);
}

/** The second brief ends in a provider NETWORK stop; the third is never attempted. */
export async function providerStoppedBundle(root: string): Promise<Bundle> {
  const options = runOptions(root);
  const scripts = allValid();
  scripts['harbour-ledger'] = [{ fail: 'network' }];
  const result = await runExperiment({
    mode: 'openai',
    model: FIXTURE_MODEL,
    providerFor: providers(scripts, { name: 'openai', model: FIXTURE_MODEL }),
    ...options,
  });
  if (!result.ok) throw new Error(`experiment did not finish: ${result.code}`);
  return bundleAt(result.dir);
}

/**
 * The directory exactly as it is while the second brief is waiting on its
 * provider: first entry recorded, second `awaiting_response` with UNKNOWN usage.
 */
export async function awaitingResponseBundle(root: string): Promise<Bundle> {
  const options = runOptions(root);
  const copy = path.join(root, 'frozen-awaiting-response');
  const inner = providers(allValid());
  const result = await runExperiment({
    mode: 'offline',
    providerFor: (entry) => {
      const provider = inner(entry);
      if (entry.key !== 'harbour-ledger') return provider;
      return {
        name: provider.name,
        model: provider.model,
        draft: (request) => {
          if (!existsSync(copy)) cpSync(onlyDirectory(options.draftsRoot), copy, { recursive: true });
          return provider.draft(request);
        },
      };
    },
    ...options,
  });
  if (!result.ok) throw new Error(`experiment did not finish: ${result.code}`);
  return bundleAt(copy);
}

/**
 * The directory at the moment the first result and its reported counts are
 * durable but no artifact has been written yet (`recording`, no references).
 */
export async function recordingBundle(root: string): Promise<Bundle> {
  const options = runOptions(root);
  const copy = path.join(root, 'frozen-recording');
  const result = await runExperiment({
    mode: 'offline',
    providerFor: providers(allValid()),
    writeRun: (runOptionsArg) => {
      if (!existsSync(copy)) cpSync(onlyDirectory(options.draftsRoot), copy, { recursive: true });
      return writeRunArtifacts(runOptionsArg);
    },
    ...options,
  });
  if (!result.ok) throw new Error(`experiment did not finish: ${result.code}`);
  return bundleAt(copy);
}

/** A fresh, writable copy of a bundle (tests tamper with copies, never with the original). */
export function cloneBundle(bundle: Bundle, into: string): Bundle {
  mkdirSync(path.dirname(into), { recursive: true });
  cpSync(bundle.dir, into, { recursive: true });
  return bundleAt(into);
}

/** The accepted candidate with its first choice pointing at a scene that does not exist. */
const invalid = (entry: CorpusEntry): string => {
  const wire = structuredClone(scenarioToWire(entry.scenario));
  wire.scenes.flatMap((s) => s.choices)[0]!.to = 's-missing';
  return JSON.stringify(wire);
};

const corpusEntry = (key: CorpusEntry['key']): CorpusEntry =>
  AUTHORING_CORPUS.find((entry) => entry.key === key)!;

/**
 * Real-runner scenarios. The halting ones stop the SECOND brief
 * (`harbour-ledger`) with a STOPPED authoring result.
 */
export type FixtureRun =
  | 'success'
  | 'repaired'
  | 'rejection'
  | 'generation-provider-stop'
  | 'repair-provider-stop'
  | 'cancellation';

export const HALTING_RUNS = [
  'generation-provider-stop',
  'repair-provider-stop',
  'cancellation',
] as const satisfies readonly FixtureRun[];

export interface RunCapture {
  /** The finished directory (`--complete` or `--partial`). */
  final: Bundle;
  /** Every manifest text the runner handed to its atomic writer, in order (last is FINAL). */
  checkpoints: string[];
  /**
   * The work directory copied at the moment the STOPPED result is durable and no
   * artifact has been written for it (`recording`); null when nothing halted.
   */
  haltedRecording: Bundle | null;
}

/** Runs the real runner with scripted providers and captures what it persisted. */
export async function runFixture(root: string, run: FixtureRun): Promise<RunCapture> {
  const options = runOptions(root);
  const scripts = allValid();
  const harbour = corpusEntry('harbour-ledger');
  const tram = corpusEntry('last-tram');
  switch (run) {
    case 'success':
      break;
    case 'repaired':
      scripts['last-tram'] = [{ candidate: invalid(tram) }, { candidate: valid(tram) }];
      break;
    case 'rejection':
      scripts['harbour-ledger'] = [{ candidate: invalid(harbour) }, { candidate: invalid(harbour) }];
      break;
    case 'generation-provider-stop':
      scripts['harbour-ledger'] = [{ fail: 'network' }];
      break;
    case 'repair-provider-stop':
      scripts['harbour-ledger'] = [{ candidate: invalid(harbour) }, { fail: 'network' }];
      break;
    case 'cancellation':
      scripts['harbour-ledger'] = [{ hang: true }];
      break;
  }

  const openai = (HALTING_RUNS as readonly FixtureRun[]).includes(run);
  const inner = providers(scripts, openai ? { name: 'openai', model: FIXTURE_MODEL } : undefined);
  const controller = new AbortController();
  const providerFor = (entry: CorpusEntry): ScenarioDraftProvider => {
    const provider = inner(entry);
    if (run !== 'cancellation' || entry.key !== 'harbour-ledger') return provider;
    return {
      name: provider.name,
      model: provider.model,
      draft: (request) => {
        const pending = provider.draft(request);
        queueMicrotask(() => controller.abort());
        return pending;
      },
    };
  };

  const checkpoints: string[] = [];
  const copy = path.join(root, 'frozen-halted-recording');
  const result = await runExperiment({
    mode: openai ? 'openai' : 'offline',
    ...(openai && { model: FIXTURE_MODEL }),
    providerFor,
    signal: controller.signal,
    writeManifest: (file, text) => {
      checkpoints.push(text);
      replaceFileAtomically(file, text);
    },
    writeRun: (runOptionsArg) => {
      if (runOptionsArg.result.status === 'STOPPED' && !existsSync(copy)) {
        cpSync(onlyDirectory(options.draftsRoot), copy, { recursive: true });
      }
      return writeRunArtifacts(runOptionsArg);
    },
    ...options,
  });
  if (!result.ok) throw new Error(`experiment did not finish: ${result.code}`);
  return {
    final: bundleAt(result.dir),
    checkpoints,
    haltedRecording: existsSync(copy) ? bundleAt(copy) : null,
  };
}
