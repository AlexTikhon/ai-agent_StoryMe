import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { buildComparisonReport } from '../src/interactive/authoring/run-report-aggregate';
import {
  parseRunReport,
  REPORT_FILE_NAMES,
  type ReportFileName,
  type RunObservation,
} from '../src/interactive/authoring/run-report-input';

/**
 * Offline comparison of saved scenario-authoring runs.
 *
 *   pnpm report:interactive:authoring --report <file> --report <file> [--format json]
 *
 * Each --report is an explicit `validation-report.json` (REVIEW_REQUIRED) or
 * `run-report.json` (REJECTED / STOPPED) written by `pnpm author:interactive`.
 * Nothing is discovered: no directory scan, no candidate or prose file, no
 * provider, database, API key or network, and no file is written or changed.
 * The output is a set of observations about the supplied artifacts. Mechanical
 * validity is not editorial approval; this tool approves and publishes nothing.
 *
 * Exit codes: 0 valid report (even when every supplied run failed authoring),
 * 1 invalid or unreadable input (no partial report is printed), 2 usage error.
 */

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export const EXIT_CODES = { OK: 0, INVALID_INPUT: 1, USAGE: 2 } as const;

export const MAX_REPORTS = 100;
export const MAX_REPORT_FILE_BYTES = 256 * 1024;

const USAGE =
  'Usage: pnpm report:interactive:authoring --report <validation-report.json|run-report.json> [--report <file> ...] [--format json]';

type Args = { ok: true; reports: string[] } | { ok: false; error: string };

function parseArgs(argv: readonly string[]): Args {
  const reports: string[] = [];
  let format: string | undefined;
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!;
    if (flag !== '--report' && flag !== '--format') {
      return { ok: false, error: 'unknown or positional argument' };
    }
    const value = argv[i + 1];
    if (value === undefined || value.length === 0 || value.startsWith('--')) {
      return { ok: false, error: `${flag} needs a value` };
    }
    if (flag === '--report') {
      reports.push(value);
    } else {
      if (format !== undefined) return { ok: false, error: '--format given more than once' };
      format = value;
    }
  }
  if (format !== undefined && format !== 'json') {
    return { ok: false, error: 'only --format json is supported' };
  }
  if (reports.length === 0) return { ok: false, error: 'at least one --report is required' };
  if (reports.length > MAX_REPORTS) {
    return { ok: false, error: `at most ${MAX_REPORTS} reports may be compared` };
  }
  return { ok: true, reports };
}

// ── Bounded file input ──────────────────────────────────────────────────────

type FileFailure = 'UNSUPPORTED_FILE_NAME' | 'REPORT_UNREADABLE' | 'REPORT_TOO_LARGE';

type FileRead =
  | { ok: true; fileName: ReportFileName; realPath: string; text: string; sha256: string }
  | { ok: false; code: FileFailure };

const isReportFileName = (name: string): name is ReportFileName =>
  (REPORT_FILE_NAMES as readonly string[]).includes(name);

/**
 * Only the two report file names are ever opened, so a candidate, review
 * markdown or approval file cannot be read by mistake (also checked after
 * symlink resolution). The read itself is bounded, whatever stat said.
 */
function readReport(file: string): FileRead {
  const requested = path.basename(path.resolve(file));
  if (!isReportFileName(requested)) return { ok: false, code: 'UNSUPPORTED_FILE_NAME' };

  let fd: number | undefined;
  try {
    const realPath = realpathSync.native(path.resolve(file));
    const fileName = path.basename(realPath);
    if (!isReportFileName(fileName)) return { ok: false, code: 'UNSUPPORTED_FILE_NAME' };
    fd = openSync(realPath, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { ok: false, code: 'REPORT_UNREADABLE' };
    if (stat.size > MAX_REPORT_FILE_BYTES) return { ok: false, code: 'REPORT_TOO_LARGE' };

    const buffer = Buffer.alloc(MAX_REPORT_FILE_BYTES + 1);
    let length = 0;
    for (;;) {
      const read = readSync(fd, buffer, length, buffer.length - length, length);
      if (read === 0) break;
      length += read;
      if (length > MAX_REPORT_FILE_BYTES) return { ok: false, code: 'REPORT_TOO_LARGE' };
    }
    const bytes = buffer.subarray(0, length);
    return {
      ok: true,
      fileName,
      realPath,
      text: bytes.toString('utf8').replace(/^﻿/, ''),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } catch {
    return { ok: false, code: 'REPORT_UNREADABLE' };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// ── Command ─────────────────────────────────────────────────────────────────

interface InputProblem {
  index: number;
  code: string;
  detail?: string;
}

/** Returns the process exit code. */
export function runCli(argv: readonly string[], io: CliIo): number {
  const args = parseArgs(argv);
  if (!args.ok) {
    io.err(`Error: ${args.error}`);
    io.err(USAGE);
    return EXIT_CODES.USAGE;
  }

  const problems: InputProblem[] = [];
  const observations: RunObservation[] = [];
  const seenPaths = new Set<string>();
  const seenContent = new Set<string>();

  args.reports.forEach((file, i) => {
    const index = i + 1;
    const read = readReport(file);
    if (!read.ok) {
      problems.push({ index, code: read.code });
      return;
    }
    // Identity is the resolved real file (case-insensitive on Windows), then the exact bytes.
    const pathKey = process.platform === 'win32' ? read.realPath.toLowerCase() : read.realPath;
    if (seenPaths.has(pathKey)) {
      problems.push({ index, code: 'DUPLICATE_REPORT' });
      return;
    }
    seenPaths.add(pathKey);
    if (seenContent.has(read.sha256)) {
      problems.push({ index, code: 'DUPLICATE_CONTENT' });
      return;
    }
    seenContent.add(read.sha256);

    const parsed = parseRunReport(read.fileName, read.text);
    if (!parsed.ok) {
      problems.push({
        index,
        code: parsed.code,
        ...(parsed.code === 'MALFORMED_JSON' ? {} : { detail: parsed.detail }),
      });
      return;
    }
    observations.push(parsed.observation);
  });

  if (problems.length > 0) {
    // No partial report: an invalid input must never silently leave the denominator.
    io.err(
      `Error: ${problems.length} of ${args.reports.length} supplied reports are invalid; no comparison was produced.`,
    );
    for (const p of problems) {
      io.err(`  report #${p.index}: ${p.code}${p.detail ? ` (${p.detail})` : ''}`);
    }
    return EXIT_CODES.INVALID_INPUT;
  }

  io.out(JSON.stringify(buildComparisonReport(observations), null, 2));
  return EXIT_CODES.OK;
}

function main(): void {
  try {
    process.exitCode = runCli(process.argv.slice(2), {
      out: (l) => console.log(l),
      err: (l) => console.error(l),
    });
  } catch (error) {
    // Never print the message: it could contain file paths or content.
    console.error(`Unexpected failure (${error instanceof Error ? error.name : 'unknown'})`);
    process.exitCode = EXIT_CODES.INVALID_INPUT;
  }
}

if (require.main === module) main();
