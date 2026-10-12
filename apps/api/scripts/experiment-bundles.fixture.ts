import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
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
