import { boundedInt, parseFlags } from './cli-config';
import {
  DEFAULT_DEADLINE_MS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  HARD_MAX_DEADLINE_MS,
  HARD_MAX_OUTPUT_TOKENS,
  HARD_MAX_REQUEST_TIMEOUT_MS,
  MIN_DEADLINE_MS,
  MIN_MAX_OUTPUT_TOKENS,
  MIN_REQUEST_TIMEOUT_MS,
} from './limits';
import type { PipelineLimits } from './pipeline';

/**
 * Pure CLI/env parsing for the authoring experiment runner. The default mode is
 * `plan`, which has no side effects. `openai` needs ALL of: `--mode openai`,
 * `--allow-paid-calls`, an explicit model and an API key; an API key in the
 * environment never selects a mode and is not even read outside `openai`.
 * Malformed numbers are rejected rather than clamped, and error text never
 * echoes credentials or argument values.
 */

export type ExperimentCliMode = 'plan' | 'offline' | 'openai';

export interface ExperimentConfig {
  mode: ExperimentCliMode;
  draftsRoot: string | undefined;
  limits: PipelineLimits;
  /** plan (informational) and openai only. */
  model: string | null;
  /** openai only; null otherwise, whatever the environment holds. */
  apiKey: string | null;
}

export type ExperimentParse = { ok: true; config: ExperimentConfig } | { ok: false; error: string };

const VALUE_FLAGS: ReadonlySet<string> = new Set([
  'mode',
  'drafts-root',
  'model',
  'max-output-tokens',
  'request-timeout-ms',
  'deadline-ms',
]);
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(['allow-paid-calls']);

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export const EXPERIMENT_USAGE = [
  'Usage: experiment:interactive:authoring [--mode <plan|offline|openai>] [options]',
  '  --mode plan                  (default) print the versioned plan; no provider, network or writes',
  '  --mode offline               run the corpus with scripted fixtures (harness verification only)',
  '  --mode openai                PAID: needs --allow-paid-calls, --model <name> and OPENAI_API_KEY',
  '  --model <name>               explicit model (plan: informational; also INTERACTIVE_AUTHORING_MODEL)',
  '  --drafts-root <dir>          alternative drafts directory (must be named "scenario-drafts")',
  '  --max-output-tokens <n>      per-request output token cap',
  '  --request-timeout-ms <n>     per-request timeout',
  '  --deadline-ms <n>            per-brief execution deadline',
].join('\n');

export function parseExperimentArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): ExperimentParse {
  const flags = parseFlags(argv, VALUE_FLAGS, BOOLEAN_FLAGS);
  if (typeof flags === 'string') return { ok: false, error: flags };
  const str = (name: string): string | undefined => {
    const v = flags.get(name);
    return typeof v === 'string' ? v : undefined;
  };

  const rawMode = str('mode') ?? 'plan';
  if (rawMode !== 'plan' && rawMode !== 'offline' && rawMode !== 'openai') {
    return { ok: false, error: '--mode must be "plan", "offline" or "openai"' };
  }
  const mode: ExperimentCliMode = rawMode;
  const paid = flags.get('allow-paid-calls') === true;
  if (mode !== 'openai' && paid) {
    return { ok: false, error: '--allow-paid-calls is only valid with --mode openai' };
  }

  const limits: PipelineLimits = { maxOutputTokens: 0, requestTimeoutMs: 0, deadlineMs: 0 };
  const numeric = [
    [
      'maxOutputTokens',
      '--max-output-tokens',
      str('max-output-tokens') ?? env['INTERACTIVE_AUTHORING_MAX_OUTPUT_TOKENS'],
      DEFAULT_MAX_OUTPUT_TOKENS,
      MIN_MAX_OUTPUT_TOKENS,
      HARD_MAX_OUTPUT_TOKENS,
    ],
    [
      'requestTimeoutMs',
      '--request-timeout-ms',
      str('request-timeout-ms') ?? env['INTERACTIVE_AUTHORING_REQUEST_TIMEOUT_MS'],
      DEFAULT_REQUEST_TIMEOUT_MS,
      MIN_REQUEST_TIMEOUT_MS,
      HARD_MAX_REQUEST_TIMEOUT_MS,
    ],
    [
      'deadlineMs',
      '--deadline-ms',
      str('deadline-ms') ?? env['INTERACTIVE_AUTHORING_DEADLINE_MS'],
      DEFAULT_DEADLINE_MS,
      MIN_DEADLINE_MS,
      HARD_MAX_DEADLINE_MS,
    ],
  ] as const;
  for (const [key, label, raw, fallback, min, max] of numeric) {
    const value = boundedInt(label, raw, fallback, min, max);
    if (typeof value === 'string') return { ok: false, error: value };
    limits[key] = value;
  }

  let model: string | null = null;
  let apiKey: string | null = null;
  if (mode === 'offline') {
    if (str('model') !== undefined) {
      return { ok: false, error: '--model is not valid in offline mode (scripted fixtures)' };
    }
  } else {
    const requested = str('model') ?? env['INTERACTIVE_AUTHORING_MODEL'];
    if (requested !== undefined && requested.trim() !== '') {
      if (!MODEL_PATTERN.test(requested.trim())) {
        return { ok: false, error: '--model is malformed' };
      }
      model = requested.trim();
    }
  }

  if (mode === 'openai') {
    if (!paid) {
      return {
        ok: false,
        error: 'openai mode makes paid API calls: pass --allow-paid-calls to confirm',
      };
    }
    if (model === null) {
      return {
        ok: false,
        error: 'openai mode requires an explicit --model (or INTERACTIVE_AUTHORING_MODEL)',
      };
    }
    apiKey = (env['OPENAI_API_KEY'] ?? '').trim();
    if (apiKey === '') return { ok: false, error: 'openai mode requires OPENAI_API_KEY' };
  }

  return { ok: true, config: { mode, draftsRoot: str('drafts-root'), limits, model, apiKey } };
}
