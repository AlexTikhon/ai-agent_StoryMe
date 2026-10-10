import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { createLineSource } from '../src/interactive/playtest/line-source';
import {
  MAX_CANDIDATE_FILE_BYTES,
  formatBanner,
  loadPlaytestCandidate,
  parseRoute,
  runInteractivePlaytest,
  runScriptedPlaytest,
  type CandidateLoad,
  type PlaytestResult,
} from '../src/interactive/playtest/runner';

/**
 * Offline draft playtest.
 *
 *   pnpm playtest:interactive --candidate <validated-candidate.json>                  # interactive
 *   pnpm playtest:interactive --candidate <validated-candidate.json> --choices a,b,c  # scripted
 *
 * Plays a mechanically valid normalized candidate on the production engine
 * (startSession, applyChoice, verifyReplay, canonical narration validation and
 * the public projection) so a person can read and play it BEFORE approving it.
 * It only READS the candidate file: no database, Redis, Nest, provider or
 * network, and it never writes, approves, registers or publishes anything.
 * Playing every route is not editorial approval.
 *
 * Exit codes: 0 COMPLETED (an ending was reached), 1 FAILED (invalid candidate,
 * rejected/unknown/locked choice, command after an ending, oversized route or
 * limit hit), 2 usage error, 3 INCOMPLETE (route or input ended before an
 * ending), 4 CANCELLED (quit with q, or SIGINT).
 */

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface CliDeps {
  /** Interactive input; defaults to process.stdin, which is only touched in interactive mode. */
  stdin?: Readable | undefined;
  signal?: AbortSignal | undefined;
}

export const EXIT_CODES = {
  COMPLETED: 0,
  FAILED: 1,
  USAGE: 2,
  INCOMPLETE: 3,
  CANCELLED: 4,
} as const;

const USAGE =
  'Usage: pnpm playtest:interactive --candidate <validated-candidate.json> [--choices <choice-id,choice-id,...>]';

type Args = { ok: true; candidate: string; choices: string | null } | { ok: false; error: string };

function parseArgs(argv: readonly string[]): Args {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!;
    if (flag !== '--candidate' && flag !== '--choices') {
      return { ok: false, error: `unknown argument "${flag.slice(0, 40)}"` };
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--') || value.length === 0) {
      return { ok: false, error: `${flag} needs a value` };
    }
    if (values.has(flag)) return { ok: false, error: `${flag} given more than once` };
    values.set(flag, value);
  }
  const candidate = values.get('--candidate');
  if (!candidate) return { ok: false, error: '--candidate is required' };
  return { ok: true, candidate, choices: values.get('--choices') ?? null };
}

type FileRead = { ok: true; text: string } | { ok: false; reason: 'unreadable' | 'too-large' };

/** Size is checked before reading, so an oversized file is never loaded. */
function readBounded(file: string, maxBytes: number): FileRead {
  try {
    const resolved = path.resolve(file);
    const stat = statSync(resolved);
    if (!stat.isFile()) return { ok: false, reason: 'unreadable' };
    if (stat.size > maxBytes) return { ok: false, reason: 'too-large' };
    return { ok: true, text: readFileSync(resolved, 'utf8') };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}

function failed(io: CliIo, code: string, message: string, extra: string[] = []): number {
  io.out(`Result: PLAYTEST_FAILED [${code}]`);
  io.out(message);
  for (const line of extra) io.out(line);
  return EXIT_CODES.FAILED;
}

function reportCandidateFailure(load: Extract<CandidateLoad, { ok: false }>, io: CliIo): number {
  const shown = load.diagnostics.slice(0, 10).map((d) => `  - [${d.code}] ${d.message}`);
  const more = load.diagnostics.length - 10 + load.droppedDiagnostics;
  if (more > 0) shown.push(`  - (${more} more diagnostics not shown)`);
  return failed(io, load.code, load.message, shown);
}

function report(result: PlaytestResult, io: CliIo): number {
  const route = result.route.length > 0 ? result.route.join(', ') : '(no choices taken)';
  switch (result.status) {
    case 'COMPLETED':
      io.out('');
      io.out(`Result: PLAYTEST_COMPLETED ending=${result.endingId}`);
      io.out(`Route: ${route}`);
      io.out('Playtest only: nothing was approved, registered or published.');
      return EXIT_CODES.COMPLETED;
    case 'INCOMPLETE':
      io.out('');
      io.out('Result: PLAYTEST_INCOMPLETE (no ending was reached)');
      io.out(result.detail);
      io.out(`Route: ${route}`);
      return EXIT_CODES.INCOMPLETE;
    case 'CANCELLED':
      io.out('');
      io.out('Result: PLAYTEST_CANCELLED');
      io.out(`Route: ${route}`);
      return EXIT_CODES.CANCELLED;
    case 'FAILED':
      io.out('');
      return failed(io, result.failureCode ?? 'INTERNAL', result.detail, [`Route: ${route}`]);
  }
}

/** Returns the process exit code. */
export async function runCli(
  argv: readonly string[],
  io: CliIo,
  deps: CliDeps = {},
): Promise<number> {
  const args = parseArgs(argv);
  if (!args.ok) {
    io.err(`Error: ${args.error}`);
    io.err(USAGE);
    return EXIT_CODES.USAGE;
  }

  const file = readBounded(args.candidate, MAX_CANDIDATE_FILE_BYTES);
  if (!file.ok) {
    return file.reason === 'too-large'
      ? failed(io, 'CANDIDATE_TOO_LARGE', `candidate exceeds ${MAX_CANDIDATE_FILE_BYTES} bytes`)
      : failed(io, 'CANDIDATE_UNREADABLE', 'candidate file could not be read');
  }
  const candidate = loadPlaytestCandidate(file.text);
  if (!candidate.ok) return reportCandidateFailure(candidate, io);

  for (const line of formatBanner(candidate)) io.out(line);

  if (args.choices !== null) {
    const route = parseRoute(args.choices);
    if (!route.ok) return failed(io, route.code, route.message);
    return report(
      runScriptedPlaytest({
        scenario: candidate.scenario,
        choiceIds: route.choiceIds,
        out: io.out,
        signal: deps.signal,
      }),
      io,
    );
  }

  const input = createLineSource(deps.stdin ?? process.stdin, deps.signal);
  try {
    return report(
      await runInteractivePlaytest({
        scenario: candidate.scenario,
        input,
        out: io.out,
        signal: deps.signal,
      }),
      io,
    );
  } finally {
    input.close();
  }
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.once('SIGINT', onSigint);
  try {
    process.exitCode = await runCli(
      process.argv.slice(2),
      { out: (l) => console.log(l), err: (l) => console.error(l) },
      { signal: controller.signal },
    );
  } catch (error) {
    // Never print the message: it could contain file paths or content.
    console.error(`Unexpected failure (${error instanceof Error ? error.name : 'unknown'})`);
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}

if (require.main === module) void main();
