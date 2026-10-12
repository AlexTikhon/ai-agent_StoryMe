import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LAST_TRAM_SCENARIO } from '../src/interactive/authoring/the-last-tram';
import { hashScenarioDefinition } from '../src/interactive/domain/scenario-schema';
import { SCENARIO_APPROVALS } from '../src/interactive/scenarios/approvals';
import { getScenario, listScenarioIds } from '../src/interactive/scenarios';
import { EXIT_CODES, runCli } from './review-interactive-routes';

let tmp: string;
let out: string[];
let err: string[];
const io = () => ({ out: (l: string) => out.push(l), err: (l: string) => err.push(l) });
const file = (name: string) => path.join(tmp, name);
const put = (name: string, value: unknown) =>
  writeFileSync(file(name), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
const digest = (name: string) =>
  createHash('sha256')
    .update(readFileSync(file(name)))
    .digest('hex');

function snapshot(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .map((entry) => `${entry.name}:${statSync(path.join(dir, entry.name)).size}`)
    .sort();
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'route-review-cli-'));
  out = [];
  err = [];
  put('candidate.json', LAST_TRAM_SCENARIO);
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('review-interactive-routes: success', () => {
  it('prints one deterministic JSON report for an unapproved, unregistered candidate', () => {
    const code = runCli(['--candidate', file('candidate.json'), '--format', 'json'], io());
    expect(code).toBe(EXIT_CODES.OK);
    expect(err).toEqual([]);
    expect(out).toHaveLength(1);
    const report = JSON.parse(out[0]!);
    expect(report.schemaVersion).toBe('interactive-route-review/v1');
    expect(report.status).toBe('REVIEW_REQUIRED');
    expect(report.approved).toBe(false);
    expect(report.publication).toBe('NOT_PUBLISHED');
    expect(report.candidate.hash).toBe(hashScenarioDefinition(LAST_TRAM_SCENARIO));
    expect(report.counts.routes).toBe(5);
    expect(report.routes).toHaveLength(5);
    expect(getScenario('warsaw-last-tram', 1)).toBeUndefined();
  });

  it('defaults to JSON and produces identical bytes on every run', () => {
    expect(runCli(['--candidate', file('candidate.json')], io())).toBe(0);
    const first = out[0];
    out = [];
    expect(runCli(['--candidate', file('candidate.json'), '--format', 'json'], io())).toBe(0);
    expect(out[0]).toBe(first);
  });

  it('is independent of how the candidate file is formatted', () => {
    runCli(['--candidate', file('candidate.json')], io());
    const expected = out[0];
    out = [];
    put('minified.json', JSON.stringify(LAST_TRAM_SCENARIO));
    put('crlf.json', JSON.stringify(LAST_TRAM_SCENARIO, null, 4).replace(/\n/g, '\r\n'));
    for (const name of ['minified.json', 'crlf.json']) {
      expect(runCli(['--candidate', file(name)], io())).toBe(0);
    }
    expect(out).toEqual([expected, expected]);
  });

  it('prints Markdown only when asked for it', () => {
    expect(runCli(['--candidate', file('candidate.json'), '--format', 'markdown'], io())).toBe(0);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('# Route review: The Last Tram');
    expect(out[0]).toContain('NOT approved');
    expect(out[0]!.match(/^### Route \d+/gm)).toHaveLength(5);
    expect(() => JSON.parse(out[0]!)).toThrow();
  });

  it('writes nothing and leaves candidate bytes, registry and approvals unchanged', () => {
    const before = { bytes: digest('candidate.json'), files: snapshot(tmp) };
    const ids = listScenarioIds();
    const approvals = JSON.stringify(SCENARIO_APPROVALS);
    for (const format of ['json', 'markdown']) {
      expect(runCli(['--candidate', file('candidate.json'), '--format', format], io())).toBe(0);
    }
    expect(digest('candidate.json')).toBe(before.bytes);
    expect(snapshot(tmp)).toEqual(before.files);
    expect(listScenarioIds()).toEqual(ids);
    expect(JSON.stringify(SCENARIO_APPROVALS)).toBe(approvals);
  });

  it('keeps authored markup and control characters inert in both formats', () => {
    const hostile = structuredClone(LAST_TRAM_SCENARIO);
    const esc = '\x1b';
    hostile.scenes[0]!.narration[0]!.text = `<script>x</script> **b** ${esc}[2J${esc}]0;owned\x07 ${String.fromCharCode(0x202e)}rtl ${String.fromCharCode(0x9b)}31m`;
    hostile.endings[0]!.summary = `# not a heading ${String.fromCharCode(0x2028)}- not a list`;
    put('hostile.json', hostile);
    const unsafe = new RegExp(
      `[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(11)}-${String.fromCharCode(31)}${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}${String.fromCharCode(0x202a)}-${String.fromCharCode(0x202e)}]`,
    );
    for (const format of ['json', 'markdown']) {
      out = [];
      expect(runCli(['--candidate', file('hostile.json'), '--format', format], io())).toBe(0);
      expect(out[0]).not.toMatch(unsafe);
    }
    expect(out[0]).toContain('> \\# not a heading');
    expect(out[0]).toContain('> \\- not a list');
    expect(out[0]).toContain('\\<script\\>');
  });
});

describe('review-interactive-routes: failures print no report', () => {
  const expectNoOutput = (code: number, expected: number) => {
    expect(code).toBe(expected);
    expect(out).toEqual([]);
  };

  it('exits 2 on usage errors', () => {
    const cases: string[][] = [
      [],
      ['--candidate'],
      ['--candidate', file('candidate.json'), '--format', 'yaml'],
      ['--candidate', file('candidate.json'), '--format'],
      ['--candidate', file('candidate.json'), '--candidate', file('candidate.json')],
      ['--candidate', file('candidate.json'), '--format', 'json', '--format', 'json'],
      ['--candidate', file('candidate.json'), '--write', 'out.json'],
      [file('candidate.json')],
    ];
    for (const argv of cases) {
      out = [];
      err = [];
      expectNoOutput(runCli(argv, io()), EXIT_CODES.USAGE);
      expect(err.join('\n')).toContain('Usage: pnpm --silent review:interactive:routes');
    }
  });

  it('exits 1 for an unreadable, oversized, non-JSON or mechanically invalid candidate', () => {
    put('big.json', 'x'.repeat(250_000));
    put('bad.json', '{oops');
    const broken = structuredClone(LAST_TRAM_SCENARIO);
    broken.scenes[1]!.choices[0]!.to = 's-missing';
    put('broken.json', broken);
    const tooFew = structuredClone(LAST_TRAM_SCENARIO);
    tooFew.scenes
      .find((s) => s.id === 's-terminus')!
      .choices.push({
        id: 'c-extra-one',
        label: 'One more way to file it',
        to: 's-ending-report',
        effects: [],
      });
    tooFew.scenes
      .find((s) => s.id === 's-terminus')!
      .choices.push({
        id: 'c-extra-two',
        label: 'Yet another way to file it',
        to: 's-ending-report',
        effects: [],
      });
    put('too-many-choices.json', tooFew);

    const expectedCodes: Array<[string, string]> = [
      ['absent.json', 'CANDIDATE_UNREADABLE'],
      ['big.json', 'CANDIDATE_TOO_LARGE'],
      ['bad.json', 'CANDIDATE_NOT_JSON'],
      ['broken.json', 'CANDIDATE_INVALID'],
      ['too-many-choices.json', 'CANDIDATE_INVALID'],
    ];
    for (const [name, code] of expectedCodes) {
      out = [];
      err = [];
      expectNoOutput(runCli(['--candidate', file(name)], io()), EXIT_CODES.FAILED);
      expect(err.join('\n')).toContain(`[${code}]`);
      expect(err.join('\n')).not.toContain(tmp);
    }
  });

  it('refuses a directory as a candidate', () => {
    expectNoOutput(runCli(['--candidate', tmp], io()), EXIT_CODES.FAILED);
    expect(err.join('\n')).toContain('[CANDIDATE_UNREADABLE]');
  });

  it('exits 1 with the bound named when a bound is exceeded', () => {
    const cases: Array<[Parameters<typeof runCli>[2], string]> = [
      [{ bounds: { maxRoutes: 2 } }, 'ROUTE_LIMIT'],
      [{ bounds: { maxDepth: 2 } }, 'DEPTH_LIMIT'],
      [{ bounds: { maxTransitions: 4 } }, 'TRANSITION_LIMIT'],
      [{ bounds: { maxOutputChars: 1_000 } }, 'OUTPUT_LIMIT'],
    ];
    for (const format of ['json', 'markdown']) {
      for (const [deps, code] of cases) {
        out = [];
        err = [];
        expectNoOutput(
          runCli(['--candidate', file('candidate.json'), '--format', format], io(), deps),
          EXIT_CODES.FAILED,
        );
        expect(err.join('\n')).toContain(`[${code}]`);
      }
    }
  });
});

describe('review-interactive-routes: wiring', () => {
  const readJson = (rel: string) =>
    JSON.parse(readFileSync(path.join(__dirname, '..', rel), 'utf8')) as {
      scripts: Record<string, string>;
    };

  it('is reachable from the repository root and the API package', () => {
    expect(readJson('package.json').scripts['review:interactive:routes']).toContain(
      'scripts/review-interactive-routes.ts',
    );
    expect(readJson('../../package.json').scripts['review:interactive:routes']).toBe(
      'pnpm --dir apps/api --silent review:interactive:routes',
    );
  });

  it('starts no work, reads no file and sets no exit code when imported', async () => {
    vi.resetModules();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitCode = process.exitCode;
    try {
      const mod = await import('./review-interactive-routes');
      expect(typeof mod.runCli).toBe('function');
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(exitCode);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
    // Re-loading the whole domain graph can exceed the default 5 s under a parallel full run.
  }, 30_000);
});
