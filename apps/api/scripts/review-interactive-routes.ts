import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import path from 'node:path';
import {
  exportRouteReview,
  type RouteReviewBounds,
  type RouteReviewFormat,
} from '../src/interactive/authoring/route-review';
import { loadPlaytestCandidate } from '../src/interactive/playtest/runner';
import { MAX_CANDIDATE_FILE_BYTES } from '../src/interactive/publication/preflight';

/**
 * Exhaustive offline route review.
 *
 *   pnpm --silent review:interactive:routes --candidate <validated-candidate.json> [--format json|markdown]
 *
 * Lists every playable terminal choice sequence of one explicitly supplied,
 * mechanically valid normalized candidate, with the player-visible narration
 * along each route, built on the production engine. It only READS the
 * candidate: no database, provider, network, registry change or file write,
 * and no approval is required, recorded or created. Listing every route helps
 * a person read the prose; it does not establish prose quality or approval.
 *
 * stdout carries exactly one report (JSON by default) or nothing. A bound that
 * is exceeded fails the run; a partial report is never printed as exhaustive.
 *
 * Exit codes: 0 report printed, 1 invalid/unreadable candidate or bound
 * exceeded (nothing on stdout), 2 usage error.
 */

export interface CliIo {
  out: (text: string) => void;
  err: (line: string) => void;
}

export interface CliDeps {
  /** Lower the walk bounds; used by tests to exercise limits without a huge scenario. */
  bounds?: Partial<RouteReviewBounds> | undefined;
}

export const EXIT_CODES = { OK: 0, FAILED: 1, USAGE: 2 } as const;

const USAGE =
  'Usage: pnpm --silent review:interactive:routes --candidate <validated-candidate.json> [--format json|markdown]';

type Args =
  { ok: true; candidate: string; format: RouteReviewFormat } | { ok: false; error: string };

function parseArgs(argv: readonly string[]): Args {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!;
    if (flag !== '--candidate' && flag !== '--format') {
      return { ok: false, error: 'unknown or positional argument' };
    }
    const value = argv[i + 1];
    if (value === undefined || value.length === 0 || value.startsWith('--')) {
      return { ok: false, error: `${flag} needs a value` };
    }
    if (values.has(flag)) return { ok: false, error: `${flag} given more than once` };
    values.set(flag, value);
  }
  const candidate = values.get('--candidate');
  if (!candidate) return { ok: false, error: '--candidate is required' };
  const format = values.get('--format') ?? 'json';
  if (format !== 'json' && format !== 'markdown') {
    return { ok: false, error: '--format must be json or markdown' };
  }
  return { ok: true, candidate, format };
}

type FileRead = { ok: true; text: string } | { ok: false; reason: 'unreadable' | 'too-large' };

/** The read itself is bounded, whatever stat said, and only a regular file is read. */
function readBounded(file: string, maxBytes: number): FileRead {
  let fd: number | undefined;
  try {
    fd = openSync(path.resolve(file), 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { ok: false, reason: 'unreadable' };
    if (stat.size > maxBytes) return { ok: false, reason: 'too-large' };
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    for (;;) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
      if (length > maxBytes) return { ok: false, reason: 'too-large' };
    }
    return { ok: true, text: buffer.subarray(0, length).toString('utf8') };
  } catch {
    return { ok: false, reason: 'unreadable' };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Diagnostics can quote authored text; collapse controls before they reach a terminal. */
function printable(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').trim();
}

function fail(io: CliIo, code: string, message: string, extra: string[] = []): number {
  io.err(`Error [${code}]: ${printable(message)}`);
  for (const line of extra) io.err(line);
  io.err('No report was produced.');
  return EXIT_CODES.FAILED;
}

/** Returns the process exit code. */
export function runCli(argv: readonly string[], io: CliIo, deps: CliDeps = {}): number {
  const args = parseArgs(argv);
  if (!args.ok) {
    io.err(`Error: ${args.error}`);
    io.err(USAGE);
    return EXIT_CODES.USAGE;
  }

  const file = readBounded(args.candidate, MAX_CANDIDATE_FILE_BYTES);
  if (!file.ok) {
    return file.reason === 'too-large'
      ? fail(io, 'CANDIDATE_TOO_LARGE', `candidate exceeds ${MAX_CANDIDATE_FILE_BYTES} bytes`)
      : fail(io, 'CANDIDATE_UNREADABLE', 'candidate file could not be read');
  }

  const candidate = loadPlaytestCandidate(file.text);
  if (!candidate.ok) {
    const shown = candidate.diagnostics
      .slice(0, 10)
      .map((d) => `  - [${printable(d.code)}] ${printable(d.message)}`);
    const more = candidate.diagnostics.length - 10 + candidate.droppedDiagnostics;
    if (more > 0) shown.push(`  - (${more} more diagnostics not shown)`);
    return fail(io, candidate.code, candidate.message, shown);
  }

  const exported = exportRouteReview({
    scenario: candidate.scenario,
    format: args.format,
    bounds: deps.bounds,
  });
  if (!exported.ok) return fail(io, exported.code, exported.detail);

  io.out(exported.text);
  return EXIT_CODES.OK;
}

function main(): void {
  try {
    process.exitCode = runCli(process.argv.slice(2), {
      out: (text) => console.log(text),
      err: (line) => console.error(line),
    });
  } catch (error) {
    // Never print the message: it could contain file paths or content.
    console.error(`Unexpected failure (${error instanceof Error ? error.name : 'unknown'})`);
    process.exitCode = EXIT_CODES.FAILED;
  }
}

if (require.main === module) main();
