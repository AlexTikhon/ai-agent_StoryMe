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
 * Pure CLI/env parsing. Provider choice is always explicit. OpenAI mode needs
 * ALL of: --mode openai, --allow-paid-calls, an explicitly configured model and
 * an API key; the presence of OPENAI_API_KEY alone never selects it. Malformed
 * numbers are rejected rather than silently clamped. Error text never echoes
 * credentials or argument values that could contain them.
 */

export const BUILTIN_BRIEFS = ['the-last-tram'] as const;
export type BuiltinBrief = (typeof BUILTIN_BRIEFS)[number];

export type BriefSource = { kind: 'builtin'; name: BuiltinBrief } | { kind: 'file'; path: string };

export interface CliConfig {
  mode: 'mock' | 'openai';
  briefSource: BriefSource;
  draftsRoot: string | undefined;
  limits: PipelineLimits;
  /** openai only */
  model: string | null;
  apiKey: string | null;
}

export type CliParse = { ok: true; config: CliConfig } | { ok: false; error: string };

const VALUE_FLAGS = new Set([
  'mode',
  'brief',
  'brief-file',
  'drafts-root',
  'model',
  'max-output-tokens',
  'request-timeout-ms',
  'deadline-ms',
]);
const BOOLEAN_FLAGS = new Set(['allow-paid-calls']);

export const USAGE = [
  'Usage: author:interactive --mode <mock|openai> [options]',
  '  --brief the-last-tram        built-in fictional brief (default in mock mode)',
  '  --brief-file <path>          brief JSON file (max 16 KB)',
  '  --drafts-root <dir>          alternative drafts directory (must be named "scenario-drafts")',
  '  --max-output-tokens <n>      per-request output token cap',
  '  --request-timeout-ms <n>     per-request timeout',
  '  --deadline-ms <n>            overall execution deadline',
  'OpenAI mode (PAID): --mode openai --allow-paid-calls --model <name> and OPENAI_API_KEY',
  '  (model may also come from INTERACTIVE_AUTHORING_MODEL; an explicit brief is required)',
].join('\n');

function parseFlags(argv: readonly string[]): Map<string, string | true> | string {
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) return 'unexpected positional argument';
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    if (flags.has(name)) return `duplicate flag --${name}`;
    if (BOOLEAN_FLAGS.has(name)) {
      if (eq !== -1) return `--${name} does not take a value`;
      flags.set(name, true);
    } else if (VALUE_FLAGS.has(name)) {
      const value = eq !== -1 ? arg.slice(eq + 1) : argv[(i += 1)];
      if (value === undefined || value === '' || value.startsWith('--')) {
        return `--${name} requires a value`;
      }
      flags.set(name, value);
    } else {
      return `unknown flag --${name}`;
    }
  }
  return flags;
}

function boundedInt(
  name: string,
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number | string {
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d{1,9}$/.test(raw)) return `${name} must be an integer`;
  const n = Number(raw);
  return n < min || n > max ? `${name} must be between ${min} and ${max}` : n;
}

export function parseCliArgs(argv: readonly string[], env: NodeJS.ProcessEnv): CliParse {
  const flags = parseFlags(argv);
  if (typeof flags === 'string') return { ok: false, error: flags };
  const str = (name: string): string | undefined => {
    const v = flags.get(name);
    return typeof v === 'string' ? v : undefined;
  };

  const mode = str('mode');
  if (mode !== 'mock' && mode !== 'openai') {
    return { ok: false, error: '--mode must be "mock" or "openai"' };
  }
  const paid = flags.get('allow-paid-calls') === true;
  if (mode === 'mock' && paid) {
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

  const briefName = str('brief');
  const briefFile = str('brief-file');
  if (briefName !== undefined && briefFile !== undefined) {
    return { ok: false, error: 'use either --brief or --brief-file, not both' };
  }
  let briefSource: BriefSource;
  if (briefFile !== undefined) briefSource = { kind: 'file', path: briefFile };
  else if (briefName !== undefined) {
    if (!(BUILTIN_BRIEFS as readonly string[]).includes(briefName)) {
      return {
        ok: false,
        error: `unknown built-in brief (available: ${BUILTIN_BRIEFS.join(', ')})`,
      };
    }
    briefSource = { kind: 'builtin', name: briefName as BuiltinBrief };
  } else if (mode === 'mock') {
    briefSource = { kind: 'builtin', name: 'the-last-tram' };
  } else {
    return { ok: false, error: 'openai mode requires an explicit --brief or --brief-file' };
  }

  let model: string | null = null;
  let apiKey: string | null = null;
  if (mode === 'openai') {
    if (!paid) {
      return {
        ok: false,
        error: 'openai mode makes paid API calls: pass --allow-paid-calls to confirm',
      };
    }
    model = (str('model') ?? env['INTERACTIVE_AUTHORING_MODEL'] ?? '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(model)) {
      return {
        ok: false,
        error: 'openai mode requires an explicit --model (or INTERACTIVE_AUTHORING_MODEL)',
      };
    }
    apiKey = (env['OPENAI_API_KEY'] ?? '').trim();
    if (apiKey === '') return { ok: false, error: 'openai mode requires OPENAI_API_KEY' };
  }

  return {
    ok: true,
    config: { mode, briefSource, draftsRoot: str('drafts-root'), limits, model, apiKey },
  };
}
