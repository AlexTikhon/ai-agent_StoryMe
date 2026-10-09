import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  DRAFTS_DIR_NAME,
  validateDraftsRoot,
  writeRunArtifacts,
} from '../src/interactive/authoring/artifacts';
import { parseCliArgs, USAGE, type CliConfig } from '../src/interactive/authoring/cli-config';
import { OpenAIScenarioDraftProvider } from '../src/interactive/authoring/openai-provider';
import { runAuthoring, type AuthoringResult } from '../src/interactive/authoring/pipeline';
import {
  MockScenarioDraftProvider,
  type ScenarioDraftProvider,
} from '../src/interactive/authoring/provider';
import { LAST_TRAM_BRIEF } from '../src/interactive/authoring/the-last-tram';

/**
 * Scenario-authoring CLI: fictional brief -> candidate -> deterministic
 * validation -> (at most one) repair -> local review artifacts.
 *
 *   pnpm author:interactive --mode mock
 *   pnpm author:interactive --mode openai --allow-paid-calls --model <name> --brief the-last-tram
 *
 * Mock mode needs no keys or network. A successful run is REVIEW_REQUIRED: a
 * mechanically valid candidate awaiting editorial review, never an approval.
 * This tool has no publish command; nothing it writes is registered or served.
 */

const MAX_BRIEF_FILE_BYTES = 16 * 1024;
const API_ROOT = path.resolve(__dirname, '..');

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

function loadBrief(config: CliConfig): { ok: true; brief: unknown } | { ok: false; error: string } {
  if (config.briefSource.kind === 'builtin') return { ok: true, brief: LAST_TRAM_BRIEF };
  const file = path.resolve(config.briefSource.path);
  try {
    if (statSync(file).size > MAX_BRIEF_FILE_BYTES) {
      return { ok: false, error: `brief file exceeds ${MAX_BRIEF_FILE_BYTES} bytes` };
    }
    return { ok: true, brief: JSON.parse(readFileSync(file, 'utf8')) as unknown };
  } catch {
    return { ok: false, error: 'brief file could not be read as JSON' };
  }
}

function summarize(result: AuthoringResult, io: CliIo): void {
  switch (result.status) {
    case 'REVIEW_REQUIRED':
      io.out('Result: REVIEW_REQUIRED (mechanically valid; NOT approved, NOT published)');
      io.out(
        `Candidate: ${result.scenario.id}@${result.scenario.version} hash=${result.candidateHash}`,
      );
      io.out(`Repaired: ${result.repaired ? 'yes' : 'no'}`);
      break;
    case 'REJECTED':
      io.out(`Result: REJECTED at stage "${result.stage}" (repair: ${result.repair})`);
      break;
    case 'STOPPED':
      io.out(
        `Result: STOPPED (${result.reason}) during ${result.phase}; no content repair attempted`,
      );
      break;
    case 'BRIEF_REJECTED':
      io.out(`Result: BRIEF_REJECTED (${result.code}); no provider call was made`);
      break;
  }
  if (result.status === 'REJECTED') {
    for (const d of result.diagnostics.slice(0, 10)) io.out(`  - [${d.code}] ${d.message}`);
    if (result.diagnostics.length > 10 || result.droppedDiagnostics > 0) {
      io.out('  - (more diagnostics in run-report.json)');
    }
  }
  if (result.status === 'BRIEF_REJECTED') {
    for (const issue of result.issues.slice(0, 10)) io.out(`  - ${issue}`);
  }
  if (result.status !== 'BRIEF_REJECTED') {
    io.out(
      `Requests: ${result.provenance.requests.length}, HTTP attempts: ${result.provenance.totalHttpAttempts}`,
    );
  }
}

/** Returns the process exit code: 0 review-required, 1 rejected/stopped, 2 usage or brief error. */
export async function runCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  io: CliIo,
  signal?: AbortSignal,
): Promise<number> {
  const parsed = parseCliArgs(argv, env);
  if (!parsed.ok) {
    io.err(`Error: ${parsed.error}`);
    io.err(USAGE);
    return 2;
  }
  const { config } = parsed;

  const root = validateDraftsRoot(config.draftsRoot, path.join(API_ROOT, DRAFTS_DIR_NAME), [
    path.join(API_ROOT, 'src'),
    path.join(API_ROOT, 'assets'),
    path.join(API_ROOT, 'dist'),
    path.join(API_ROOT, 'prisma'),
    path.join(API_ROOT, '..', 'web'),
  ]);
  if (!root.ok) {
    io.err(`Error: ${root.error}`);
    return 2;
  }
  const brief = loadBrief(config);
  if (!brief.ok) {
    io.err(`Error: ${brief.error}`);
    return 2;
  }

  let provider: ScenarioDraftProvider;
  if (config.mode === 'openai') {
    provider = new OpenAIScenarioDraftProvider({ apiKey: config.apiKey!, model: config.model! });
  } else {
    provider = new MockScenarioDraftProvider();
  }

  io.out('Interactive scenario authoring');
  io.out(
    config.mode === 'mock'
      ? 'Mode: mock (offline, deterministic, no network)'
      : `Mode: openai (PAID calls enabled explicitly) model=${config.model}`,
  );
  io.out(`Call budget: at most 2 requests / 2 HTTP attempts (1 generation + 1 repair)`);

  const result = await runAuthoring({
    rawBrief: brief.brief,
    provider,
    limits: config.limits,
    signal,
  });
  summarize(result, io);

  if (result.status === 'BRIEF_REJECTED') return 2;
  const written = writeRunArtifacts({ result, draftsRoot: root.root });
  io.out(`Artifacts: ${written.dir}`);
  io.out(`Files: ${written.files.join(', ')}`);
  if (result.status === 'REVIEW_REQUIRED') {
    io.out('Next: a human must read review-report.md. Publication is a separate manual step.');
    return 0;
  }
  return 1;
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
    process.exitCode = 1;
  }
}

if (require.main === module) void main();
