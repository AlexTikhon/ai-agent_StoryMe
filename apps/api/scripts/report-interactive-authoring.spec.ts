import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  invalidCandidate,
  mutateReport,
  reportFileNameFor,
  reportText,
  runScripted,
  validCandidate,
} from '../src/common/test-utils/authoring-run-fixtures';
import { writeRunArtifacts } from '../src/interactive/authoring/artifacts';
import type { AuthoringResult } from '../src/interactive/authoring/pipeline';
import { LAST_TRAM_SCENARIO } from '../src/interactive/authoring/the-last-tram';
import { EXIT_CODES, MAX_REPORT_FILE_BYTES, MAX_REPORTS, runCli } from './report-interactive-authoring';

let tmp: string;
let out: string[];
let err: string[];
let fetchSpy: ReturnType<typeof vi.fn>;
let counter = 0;

const io = () => ({ out: (l: string) => out.push(l), err: (l: string) => err.push(l) });
const stdout = () => out.join('\n');
const stderr = () => err.join('\n');
const json = () => JSON.parse(out[0]!) as Record<string, any>;

/** A report file exactly as the artifact writer lays it out. */
function artifact(result: AuthoringResult): string {
  const run = writeRunArtifacts({
    result: result as Parameters<typeof writeRunArtifacts>[0]['result'],
    draftsRoot: path.join(tmp, 'scenario-drafts'),
    randomHex: () => (counter++).toString(16).padStart(8, '0'),
  });
  return path.join(run.dir, reportFileNameFor(result));
}

/** A loose report file with a chosen (allowed) name in its own directory. */
function loose(name: string, text: string): string {
  const dir = path.join(tmp, `loose-${counter++}`);
  mkdirSync(dir);
  const file = path.join(dir, name);
  writeFileSync(file, text);
  return file;
}

function digest(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else result[path.relative(root, full)] = createHash('sha256').update(readFileSync(full)).digest('hex');
    }
  };
  walk(root);
  return result;
}

const canSymlink = (() => {
  const probe = mkdtempSync(path.join(tmpdir(), 'report-symlink-probe-'));
  try {
    writeFileSync(path.join(probe, 'a'), 'x');
    symlinkSync(path.join(probe, 'a'), path.join(probe, 'b'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

async function mixed() {
  return {
    first: artifact(await runScripted([{ candidate: validCandidate(), usage: { inputTokens: 10, outputTokens: 5 } }], { stepMs: 3 })),
    repaired: artifact(
      await runScripted([{ candidate: invalidCandidate() }, { candidate: validCandidate() }], { stepMs: 4 }),
    ),
    rejected: artifact(
      await runScripted([{ candidate: invalidCandidate() }, { candidate: invalidCandidate() }], { stepMs: 5 }),
    ),
    stopped: artifact(await runScripted([{ fail: 'timeout' }], { stepMs: 6 })),
  };
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'report-cli-'));
  out = [];
  err = [];
  fetchSpy = vi.fn(() => {
    throw new Error('network must not be used');
  });
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('report-interactive-authoring: valid reports', () => {
  it('prints one versioned JSON report and exits 0', async () => {
    const files = await mixed();
    const code = runCli(
      ['--report', files.first, '--report', files.repaired, '--report', files.rejected, '--report', files.stopped, '--format', 'json'],
      io(),
    );
    expect(code).toBe(EXIT_CODES.OK);
    expect(err).toEqual([]);
    expect(out).toHaveLength(1);
    const report = json();
    expect(report.schema).toBe('interactive-authoring-run-comparison/v1');
    expect(report.evidenceLabel).toBe('OBSERVATIONS_FROM_SUPPLIED_ARTIFACTS');
    expect(report.inputs).toEqual({ reports: 4, groups: 1 });
    expect(report.groups[0].outcomes).toEqual({ reviewRequired: 2, rejected: 1, stopped: 1 });
    expect(report.groups[0].firstPass).toMatchObject({ evaluated: 3, passed: 1, notEvaluated: 1 });
    expect(report.groups[0].repair).toMatchObject({ attempted: 2, evaluated: 2, succeeded: 1 });
  });

  it('defaults the format to json', async () => {
    const files = await mixed();
    expect(runCli(['--report', files.first], io())).toBe(0);
    expect(json().schema).toBe('interactive-authoring-run-comparison/v1');
  });

  it('exits 0 even when every supplied run failed authoring', async () => {
    const files = await mixed();
    const code = runCli(['--report', files.rejected, '--report', files.stopped], io());
    expect(code).toBe(0);
    expect(json().groups[0].outcomes).toEqual({ reviewRequired: 0, rejected: 1, stopped: 1 });
    expect(json().groups[0].finalValidity).toMatchObject({ evaluated: 1, valid: 0, rate: 0 });
  });

  it('gives identical output for any argument order', async () => {
    const files = await mixed();
    const run = (order: string[]) => {
      out = [];
      runCli(order.flatMap((f) => ['--report', f]), io());
      return stdout();
    };
    const forward = run([files.first, files.repaired, files.rejected, files.stopped]);
    expect(run([files.stopped, files.rejected, files.first, files.repaired])).toBe(forward);
    expect(run([files.first, files.repaired, files.rejected, files.stopped])).toBe(forward);
  });

  it('does not mutate or add any artifact, and does no network I/O', async () => {
    const files = await mixed();
    const before = digest(tmp);
    runCli(Object.values(files).flatMap((f) => ['--report', f]), io());
    expect(digest(tmp)).toEqual(before);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('emits no source path, directory name, candidate title or run time', async () => {
    const files = await mixed();
    runCli(Object.values(files).flatMap((f) => ['--report', f]), io());
    const text = stdout();
    expect(text).not.toContain(tmp);
    expect(text).not.toContain('scenario-drafts');
    expect(text).not.toContain('--review-required');
    expect(text).not.toContain(LAST_TRAM_SCENARIO.title);
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('accepts exactly the maximum number of reports', async () => {
    const base = reportText(await runScripted([{ candidate: validCandidate() }]));
    const files = Array.from({ length: MAX_REPORTS }, (_, i) =>
      loose(
        'validation-report.json',
        mutateReport(base, (r) => {
          r.provenance.startedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
        }),
      ),
    );
    expect(runCli(files.flatMap((f) => ['--report', f]), io())).toBe(0);
    expect(json().inputs.reports).toBe(MAX_REPORTS);
  });
});

describe('report-interactive-authoring: usage errors (exit 2)', () => {
  it.each([
    ['no arguments', []],
    ['a positional argument', ['report.json']],
    ['an unknown flag', ['--report', 'a', '--dir', 'b']],
    ['a flag without a value', ['--report']],
    ['a flag followed by a flag', ['--report', '--format', 'json']],
    ['an unsupported format', ['--report', 'a', '--format', 'csv']],
    ['a repeated format', ['--report', 'a', '--format', 'json', '--format', 'json']],
  ])('rejects %s', (_name, argv) => {
    expect(runCli(argv as string[], io())).toBe(EXIT_CODES.USAGE);
    expect(out).toEqual([]);
    expect(stderr()).toContain('Usage: pnpm report:interactive:authoring');
  });

  it('rejects more reports than the bound before reading any file', () => {
    const argv = Array.from({ length: MAX_REPORTS + 1 }, (_, i) => ['--report', `nope-${i}.json`]).flat();
    expect(runCli(argv, io())).toBe(EXIT_CODES.USAGE);
    expect(stderr()).toContain(`at most ${MAX_REPORTS}`);
    expect(out).toEqual([]);
  });
});

describe('report-interactive-authoring: invalid input (exit 1, never dropped)', () => {
  const expectInvalid = (code: number, ...lines: string[]) => {
    expect(code).toBe(EXIT_CODES.INVALID_INPUT);
    expect(out).toEqual([]);
    for (const line of lines) expect(stderr()).toContain(line);
  };

  it('emits no partial comparison when one of several reports is invalid', async () => {
    const files = await mixed();
    const broken = loose('run-report.json', '{"status": ');
    const code = runCli(['--report', files.first, '--report', broken, '--report', files.stopped], io());
    expectInvalid(code, 'report #2: MALFORMED_JSON');
    expect(stderr()).toContain('1 of 3 supplied reports');
    expect(stderr()).not.toContain(tmp);
  });

  it('rejects an unreadable path and a directory', async () => {
    const files = await mixed();
    expectInvalid(
      runCli(['--report', path.join(tmp, 'missing', 'run-report.json'), '--report', path.dirname(files.first)], io()),
      'report #1: REPORT_UNREADABLE',
      'report #2: UNSUPPORTED_FILE_NAME',
    );
  });

  it('refuses anything that is not a validation or run report, without reading it', async () => {
    const candidate = loose('validated-candidate.json', JSON.stringify(LAST_TRAM_SCENARIO));
    const markdown = loose('review-report.md', '# prose');
    expectInvalid(
      runCli(['--report', candidate, '--report', markdown], io()),
      'report #1: UNSUPPORTED_FILE_NAME',
      'report #2: UNSUPPORTED_FILE_NAME',
    );
    expect(stderr()).not.toContain(LAST_TRAM_SCENARIO.title);
  });

  it('rejects an oversized report', () => {
    const big = loose('run-report.json', ' '.repeat(MAX_REPORT_FILE_BYTES + 1));
    expectInvalid(runCli(['--report', big], io()), 'report #1: REPORT_TOO_LARGE');
  });

  it('rejects the same file given twice, including a different spelling of its path', async () => {
    const files = await mixed();
    const respelled = path.join(path.dirname(files.first), '..', path.basename(path.dirname(files.first)), path.basename(files.first));
    expectInvalid(
      runCli(['--report', files.first, '--report', files.first, '--report', respelled], io()),
      'report #2: DUPLICATE_REPORT',
      'report #3: DUPLICATE_REPORT',
    );
  });

  it.skipIf(!canSymlink)('rejects a symbolic link to a file that is also supplied', async () => {
    const files = await mixed();
    const link = path.join(tmp, 'link-dir');
    mkdirSync(link);
    symlinkSync(files.first, path.join(link, 'run-report.json'));
    expectInvalid(
      runCli(['--report', files.first, '--report', path.join(link, 'run-report.json')], io()),
      'report #2:',
    );
  });

  it('rejects a byte-identical copy so one run cannot be counted twice', async () => {
    const files = await mixed();
    const copy = path.join(tmp, 'copy-dir');
    mkdirSync(copy);
    copyFileSync(files.stopped, path.join(copy, 'run-report.json'));
    expectInvalid(
      runCli(['--report', files.stopped, '--report', path.join(copy, 'run-report.json')], io()),
      'report #2: DUPLICATE_CONTENT',
    );
  });

  it('rejects a report of the wrong kind for its file name', async () => {
    const files = await mixed();
    const wrong = loose('run-report.json', readFileSync(files.first, 'utf8'));
    expectInvalid(runCli(['--report', wrong], io()), 'report #1: KIND_MISMATCH');
  });

  it('rejects schema violations and names only the schema path', async () => {
    const files = await mixed();
    const bad = loose(
      'validation-report.json',
      mutateReport(readFileSync(files.first, 'utf8'), (r) => (r.provenance.provider = 'sk-SECRET')),
    );
    expectInvalid(runCli(['--report', bad], io()), 'report #1: SCHEMA_INVALID (provenance.provider)');
    expect(stderr()).not.toContain('sk-SECRET');
  });

  it('rejects inconsistent telemetry', async () => {
    const files = await mixed();
    const bad = loose(
      'validation-report.json',
      mutateReport(readFileSync(files.first, 'utf8'), (r) => (r.provenance.totalHttpAttempts = 9)),
    );
    expectInvalid(
      runCli(['--report', bad], io()),
      'report #1: INCONSISTENT_TELEMETRY (http-attempts-sum)',
    );
  });
});

describe('report-interactive-authoring: budget-inconsistent reports', () => {
  it.each([
    [
      'a skipped repair although both budgets remained',
      'run-report.json',
      () => runScripted([{ candidate: invalidCandidate(), httpAttempts: 2 }]),
      (r: Record<string, any>) => {
        r.provenance.requests[0].httpAttempts = 1;
        r.provenance.totalHttpAttempts = 1;
      },
      'repair-disposition',
    ],
    [
      'a repair dispatched after generation exhausted the HTTP budget',
      'validation-report.json',
      () => runScripted([{ candidate: invalidCandidate() }, { candidate: validCandidate(), httpAttempts: 0 }]),
      (r: Record<string, any>) => {
        r.provenance.requests[0].httpAttempts = 2;
        r.provenance.totalHttpAttempts = 2;
      },
      'repair-budget',
    ],
  ])('exits 1 without partial JSON for %s', async (_name, fileName, make, mutate, detail) => {
    const files = await mixed();
    const source = await make();
    const bad = loose(fileName, mutateReport(reportText(source), mutate));
    const before = digest(tmp);

    const code = runCli(['--report', files.first, '--report', bad, '--report', files.stopped], io());

    expect(code).toBe(EXIT_CODES.INVALID_INPUT);
    expect(out).toEqual([]);
    expect(stderr()).toContain(`report #2: INCONSISTENT_TELEMETRY (${detail})`);
    expect(stderr()).toContain('1 of 3 supplied reports');
    const sensitive = [tmp, 'scenario-drafts', LAST_TRAM_SCENARIO.title, JSON.parse(reportText(source)).provenance.briefHash];
    for (const value of sensitive) expect(stderr()).not.toContain(value);
    expect(digest(tmp)).toEqual(before);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('report-interactive-authoring: module import', () => {
  it('starts no work, reads no file and sets no exit code when imported', async () => {
    vi.resetModules();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitCode = process.exitCode;
    const mod = await import('./report-interactive-authoring');
    expect(typeof mod.runCli).toBe('function');
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(exitCode);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
