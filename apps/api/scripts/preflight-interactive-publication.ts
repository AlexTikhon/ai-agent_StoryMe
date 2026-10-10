import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  MAX_APPROVAL_FILE_BYTES,
  MAX_CANDIDATE_FILE_BYTES,
  runPublicationPreflight,
  type PreflightResult,
} from '../src/interactive/publication/preflight';

/**
 * Read-only publication preflight.
 *
 *   pnpm preflight:interactive --candidate <validated-candidate.json> --approval <approval.json>
 *
 * Re-runs every mechanical check on the candidate, recomputes its canonical
 * hash, rejects an already-published id/version and verifies that a
 * human-authored approval record attests to exactly this candidate. It only
 * READS the two files: it never copies, registers, approves or publishes
 * anything, calls no provider and touches no database.
 *
 * Exit codes: 0 PUBLICATION_PREFLIGHT_PASSED, 1 PUBLICATION_PREFLIGHT_FAILED,
 * 2 usage error.
 */

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

const USAGE =
  'Usage: pnpm preflight:interactive --candidate <candidate.json> --approval <approval.json>';

type Args = { ok: true; candidate: string; approval: string | null } | { ok: false; error: string };

function parseArgs(argv: readonly string[]): Args {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!;
    if (flag !== '--candidate' && flag !== '--approval') {
      return { ok: false, error: `unknown argument "${flag.slice(0, 40)}"` };
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--') || value.length === 0) {
      return { ok: false, error: `${flag} needs a file path` };
    }
    if (values.has(flag)) return { ok: false, error: `${flag} given more than once` };
    values.set(flag, value);
  }
  const candidate = values.get('--candidate');
  if (!candidate) return { ok: false, error: '--candidate is required' };
  return { ok: true, candidate, approval: values.get('--approval') ?? null };
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

function report(result: PreflightResult, io: CliIo): number {
  if (result.status === 'PUBLICATION_PREFLIGHT_PASSED') {
    io.out('Result: PUBLICATION_PREFLIGHT_PASSED');
    io.out(
      `Candidate: ${result.scenario.id}@${result.scenario.version} hash=${result.candidateHash}`,
    );
    io.out(
      `Revalidated: ${result.report.analysis.reachableStateCount} reachable states, ` +
        `${result.report.witnessRoutes.length} witness routes, ` +
        `${result.report.narrationStatesChecked} narration states`,
    );
    io.out(
      'Ready for deliberate manual source registration. Nothing was copied, registered, approved or published.',
    );
    return 0;
  }
  io.out(`Result: PUBLICATION_PREFLIGHT_FAILED [${result.code}]`);
  io.out(result.message);
  for (const d of result.diagnostics.slice(0, 10)) io.out(`  - [${d.code}] ${d.message}`);
  const more = result.diagnostics.length - 10 + result.droppedDiagnostics;
  if (more > 0) io.out(`  - (${more} more diagnostics not shown)`);
  return 1;
}

function fileFailure(
  code:
    | 'CANDIDATE_UNREADABLE'
    | 'CANDIDATE_TOO_LARGE'
    | 'APPROVAL_MISSING'
    | 'APPROVAL_UNREADABLE'
    | 'APPROVAL_TOO_LARGE',
  message: string,
): PreflightResult {
  return {
    status: 'PUBLICATION_PREFLIGHT_FAILED',
    code,
    message,
    stage: null,
    diagnostics: [],
    droppedDiagnostics: 0,
  };
}

/** Returns the process exit code. */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const args = parseArgs(argv);
  if (!args.ok) {
    io.err(`Error: ${args.error}`);
    io.err(USAGE);
    return 2;
  }

  const candidate = readBounded(args.candidate, MAX_CANDIDATE_FILE_BYTES);
  if (!candidate.ok) {
    return report(
      candidate.reason === 'too-large'
        ? fileFailure('CANDIDATE_TOO_LARGE', `candidate exceeds ${MAX_CANDIDATE_FILE_BYTES} bytes`)
        : fileFailure('CANDIDATE_UNREADABLE', 'candidate file could not be read'),
      io,
    );
  }

  let approvalText: string | null = null;
  if (args.approval !== null) {
    const approval = readBounded(args.approval, MAX_APPROVAL_FILE_BYTES);
    if (approval.ok) approvalText = approval.text;
    else if (approval.reason === 'too-large') {
      return report(
        fileFailure('APPROVAL_TOO_LARGE', `approval exceeds ${MAX_APPROVAL_FILE_BYTES} bytes`),
        io,
      );
    }
    // An unreadable or absent file is the same as no approval: approvalText stays null.
  }

  io.out('Interactive publication preflight (read-only)');
  return report(runPublicationPreflight({ candidateText: candidate.text, approvalText }), io);
}

async function main(): Promise<void> {
  try {
    process.exitCode = await runCli(process.argv.slice(2), {
      out: (l) => console.log(l),
      err: (l) => console.error(l),
    });
  } catch (error) {
    // Never print the message: it could contain file paths or content.
    console.error(`Unexpected failure (${error instanceof Error ? error.name : 'unknown'})`);
    process.exitCode = 1;
  }
}

if (require.main === module) void main();
