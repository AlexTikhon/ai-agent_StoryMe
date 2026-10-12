import {
  INSPECTION_SCHEMA,
  inspectExperiment,
} from '../src/interactive/authoring/experiment-inspection';

/**
 * Read-only inspection of one saved authoring-experiment checkpoint.
 *
 *   pnpm --silent inspect:interactive:experiment --manifest <manifest.json>
 *
 * Validates the experiment-manifest/v2 file (strict schema, entry identities,
 * status/outcome/usage combinations, checkpoint state versus completeness, halt
 * information, observed totals) and the artifacts it explicitly references
 * (inside the experiment directory only; run reports are re-parsed and compared
 * with the manifest), then prints one allowlisted JSON document. It never
 * resumes, retries, repairs, deletes or writes anything, and it needs no
 * provider, credentials, network or database.
 *
 * What it does not establish: an IN_PROGRESS checkpoint is the last saved state,
 * not proof that a process is (or is not) active or that a request failed;
 * unknown usage stays unknown; a valid inspection is neither billing evidence
 * nor editorial approval.
 *
 * Output is JSON only. A result that is not a complete, valid inspection is
 * never printed as one: invalid input prints `status: "INVALID"` with stable
 * issue codes and nothing else, so a consumer cannot mistake it for a summary.
 *
 * Exit codes: 0 valid inspection (including a valid incomplete checkpoint),
 * 1 unreadable, unsupported or inconsistent input/artifacts, 2 usage error.
 */

export interface CliIo {
  out: (text: string) => void;
  err: (line: string) => void;
}

export const EXIT_CODES = { OK: 0, INVALID: 1, USAGE: 2 } as const;

const USAGE = 'Usage: pnpm --silent inspect:interactive:experiment --manifest <manifest.json>';

type Args = { ok: true; manifest: string } | { ok: false; error: string };

function parseArgs(argv: readonly string[]): Args {
  let manifest: string | undefined;
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] !== '--manifest') return { ok: false, error: 'unknown or positional argument' };
    const value = argv[i + 1];
    if (value === undefined || value.length === 0 || value.startsWith('--')) {
      return { ok: false, error: '--manifest needs a value' };
    }
    if (manifest !== undefined) return { ok: false, error: '--manifest given more than once' };
    manifest = value;
  }
  if (manifest === undefined) return { ok: false, error: '--manifest is required' };
  return { ok: true, manifest };
}

/** Returns the process exit code. */
export function runCli(argv: readonly string[], io: CliIo): number {
  const args = parseArgs(argv);
  if (!args.ok) {
    io.err(`Error: ${args.error}`);
    io.err(USAGE);
    return EXIT_CODES.USAGE;
  }

  const outcome = inspectExperiment(args.manifest);
  if (!outcome.ok) {
    io.out(
      JSON.stringify(
        { schema: INSPECTION_SCHEMA, status: 'INVALID', issues: outcome.issues },
        null,
        2,
      ),
    );
    io.err('Inspection failed: no inspection was produced. See the issue codes on stdout.');
    return EXIT_CODES.INVALID;
  }
  io.out(JSON.stringify(outcome.inspection, null, 2));
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
    process.exitCode = EXIT_CODES.INVALID;
  }
}

if (require.main === module) main();
