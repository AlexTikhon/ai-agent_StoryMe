import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeRunArtifacts } from '../src/interactive/authoring/artifacts';
import { runAuthoring } from '../src/interactive/authoring/pipeline';
import { MockScenarioDraftProvider } from '../src/interactive/authoring/provider';
import { LAST_TRAM_BRIEF, LAST_TRAM_SCENARIO } from '../src/interactive/authoring/the-last-tram';
import { hashScenarioDefinition } from '../src/interactive/domain/scenario-schema';
import { SCENARIO_APPROVALS } from '../src/interactive/scenarios/approvals';
import { getScenario, listScenarioIds } from '../src/interactive/scenarios';
import { runCli } from './playtest-interactive-scenario';

const REPORT_ROUTE = 'c-ask-driver,c-leave-cab,c-wait-for-terminus,c-report-to-depot';
const QUIET_ROUTE = 'c-inspect-carriage,c-pocket-receipt,c-show-receipt,c-let-hanna-repay';

let tmp: string;
let out: string[];
let err: string[];
const io = () => ({ out: (l: string) => out.push(l), err: (l: string) => err.push(l) });
const output = () => out.join('\n');
const file = (name: string) => path.join(tmp, name);
const put = (name: string, value: unknown) =>
  writeFileSync(file(name), typeof value === 'string' ? value : JSON.stringify(value, null, 2));

async function authoredRun() {
  const result = await runAuthoring({
    rawBrief: LAST_TRAM_BRIEF,
    provider: new MockScenarioDraftProvider(),
  });
  if (result.status !== 'REVIEW_REQUIRED') throw new Error('expected REVIEW_REQUIRED');
  return writeRunArtifacts({ result, draftsRoot: path.join(tmp, 'scenario-drafts') });
}

function snapshot(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory()
      ? snapshot(full)
      : [`${full}:${statSync(full).size}:${statSync(full).mtimeMs}`];
  });
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'playtest-cli-'));
  out = [];
  err = [];
  put('candidate.json', LAST_TRAM_SCENARIO);
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('playtest-interactive-scenario: scripted mode', () => {
  it.each([
    ['report-filed', REPORT_ROUTE],
    ['quiet-repayment', QUIET_ROUTE],
  ])('completes the %s route with exit 0', async (endingId, route) => {
    const code = await runCli(['--candidate', file('candidate.json'), '--choices', route], io());
    expect(code).toBe(0);
    expect(output()).toContain('LOCAL PLAYTEST');
    expect(output()).toContain('does not approve');
    expect(output()).toContain(`warsaw-last-tram@1 "${LAST_TRAM_SCENARIO.title}"`);
    expect(output()).toContain(hashScenarioDefinition(LAST_TRAM_SCENARIO));
    expect(output()).toContain(`Result: PLAYTEST_COMPLETED ending=${endingId}`);
  });

  it('exits 3 and does not claim completion for an incomplete route', async () => {
    const code = await runCli(
      ['--candidate', file('candidate.json'), '--choices', 'c-ask-driver'],
      io(),
    );
    expect(code).toBe(3);
    expect(output()).toContain('Result: PLAYTEST_INCOMPLETE');
    expect(output()).not.toContain('PLAYTEST_COMPLETED');
  });

  it('exits 1 for a locked, unknown, post-ending or oversized route', async () => {
    const run = async (route: string) => {
      out = [];
      return runCli(['--candidate', file('candidate.json'), '--choices', route], io());
    };
    expect(await run('c-open-panel')).toBe(1);
    expect(output()).toContain('PLAYTEST_FAILED [CHOICE_NOT_AVAILABLE]');
    expect(await run('c-ask-driver,c-leave-cab,c-wait-for-terminus,c-let-hanna-repay')).toBe(1);
    expect(output()).toContain('[CHOICE_NOT_AVAILABLE]');
    expect(await run(`${REPORT_ROUTE},c-ask-driver`)).toBe(1);
    expect(output()).toContain('[SESSION_ENDED]');
    expect(await run(Array.from({ length: 40 }, () => 'a').join(','))).toBe(1);
    expect(output()).toContain('[ROUTE_TOO_LONG]');
    expect(await run('c-ask-driver,,x')).toBe(1);
    expect(output()).toContain('[ROUTE_MALFORMED]');
  });

  it('exits 1 for an unreadable, oversized, non-JSON or mechanically invalid candidate', async () => {
    const cli = (name: string) => runCli(['--candidate', file(name), '--choices', 'a'], io());
    expect(await cli('absent.json')).toBe(1);
    expect(output()).toContain('[CANDIDATE_UNREADABLE]');
    out = [];
    put('big.json', 'x'.repeat(250_000));
    expect(await cli('big.json')).toBe(1);
    expect(output()).toContain('[CANDIDATE_TOO_LARGE]');
    out = [];
    put('bad.json', '{oops');
    expect(await cli('bad.json')).toBe(1);
    expect(output()).toContain('[CANDIDATE_NOT_JSON]');
    out = [];
    const broken = structuredClone(LAST_TRAM_SCENARIO);
    broken.scenes[1]!.choices[0]!.to = 's-missing';
    put('broken.json', broken);
    expect(await cli('broken.json')).toBe(1);
    expect(output()).toContain('[CANDIDATE_INVALID]');
    expect(output()).toContain('DEFINITION_INVALID');
    expect(output()).not.toContain('PLAYTEST_COMPLETED');
    expect(out.length).toBeLessThan(30);
  });

  it('exits 2 on usage errors', async () => {
    const bad = [
      [],
      ['--choices', 'a'],
      ['--candidate', 'a', '--candidate', 'b'],
      ['--candidate', 'a', '--choices', 'x', '--choices', 'y'],
      ['--wat'],
      ['--candidate'],
      ['--candidate', 'a', '--choices'],
      ['--candidate', 'a', '--choices', ''],
    ];
    for (const argv of bad) {
      out = [];
      err = [];
      expect(await runCli(argv, io())).toBe(2);
      expect(err.join('\n')).toContain('Usage');
    }
  });

  it('plays witness routes of a freshly authored mock artifact', async () => {
    const run = await authoredRun();
    const candidate = path.join(run.dir, 'validated-candidate.json');
    const validation = JSON.parse(
      readFileSync(path.join(run.dir, 'validation-report.json'), 'utf8'),
    );
    expect(validation).toBeTruthy();
    for (const route of [REPORT_ROUTE, QUIET_ROUTE]) {
      out = [];
      expect(await runCli(['--candidate', candidate, '--choices', route], io())).toBe(0);
    }
  });
});

describe('playtest-interactive-scenario: interactive mode', () => {
  const play = async (lines: string, extra?: { signal?: AbortSignal; end?: boolean }) => {
    const stdin = new PassThrough();
    const done = runCli(['--candidate', file('candidate.json')], io(), {
      stdin,
      signal: extra?.signal,
    });
    stdin.write(lines);
    if (extra?.end !== false) stdin.end();
    return { code: await done, stdin };
  };

  it('completes a numbered route and releases the input stream', async () => {
    const { code, stdin } = await play('1\n1\n2\n1\n');
    expect(code).toBe(0);
    expect(output()).toContain('Result: PLAYTEST_COMPLETED ending=report-filed');
    expect(stdin.listenerCount('data')).toBe(0);
    expect(stdin.isPaused()).toBe(true);
  });

  it('exits 4 on quit and 3 on EOF, neither claiming completion', async () => {
    expect((await play('1\nq\n')).code).toBe(4);
    expect(output()).toContain('Result: PLAYTEST_CANCELLED');
    out = [];
    expect((await play('1\n')).code).toBe(3);
    expect(output()).toContain('Result: PLAYTEST_INCOMPLETE');
    expect(output()).not.toContain('PLAYTEST_COMPLETED');
  });

  it('exits 4 when interrupted while waiting for input, without hanging', async () => {
    const controller = new AbortController();
    const stdin = new PassThrough();
    const done = runCli(['--candidate', file('candidate.json')], io(), {
      stdin,
      signal: controller.signal,
    });
    stdin.write('1\n');
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    expect(await done).toBe(4);
    expect(output()).toContain('Result: PLAYTEST_CANCELLED');
    expect(stdin.listenerCount('data')).toBe(0);
  });

  it('survives garbage input without changing the outcome', async () => {
    const { code } = await play(`zzz\n${'9'.repeat(1000)}\n\n0\n1\n1\n2\n1\n`);
    expect(code).toBe(0);
  });
});

describe('playtest-interactive-scenario: boundaries', () => {
  it('writes nothing, calls no provider and changes no approval or registry state', async () => {
    const run = await authoredRun();
    const fetchSpy = vi.fn(() => {
      throw new Error('network access attempted');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const before = snapshot(tmp);
    const ids = listScenarioIds();
    const approvals = JSON.stringify(SCENARIO_APPROVALS);
    const template = readFileSync(path.join(run.dir, 'approval-template.json'), 'utf8');

    for (const route of [REPORT_ROUTE, QUIET_ROUTE, 'c-ask-driver', 'c-open-panel']) {
      await runCli(
        ['--candidate', path.join(run.dir, 'validated-candidate.json'), '--choices', route],
        io(),
      );
    }
    await runCli(['--candidate', path.join(run.dir, 'validated-candidate.json')], io(), {
      stdin: Object.assign(new PassThrough(), {}),
      signal: AbortSignal.abort(),
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(snapshot(tmp)).toEqual(before);
    expect(listScenarioIds()).toEqual(ids);
    expect(JSON.stringify(SCENARIO_APPROVALS)).toBe(approvals);
    expect(getScenario('warsaw-last-tram', 1)).toBeUndefined();
    expect(readFileSync(path.join(run.dir, 'approval-template.json'), 'utf8')).toBe(template);
    expect(JSON.parse(template).decision).toBe('pending');
    expect(existsSync(path.join(tmp, 'public'))).toBe(false);
  });

  it('importing the module starts no terminal interaction', () => {
    expect(process.listenerCount('SIGINT')).toBe(0);
    expect(typeof runCli).toBe('function');
  });
});
