import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeRunArtifacts } from '../src/interactive/authoring/artifacts';
import { runAuthoring } from '../src/interactive/authoring/pipeline';
import { MockScenarioDraftProvider } from '../src/interactive/authoring/provider';
import { LAST_TRAM_BRIEF, LAST_TRAM_SCENARIO } from '../src/interactive/authoring/the-last-tram';
import { hashScenarioDefinition } from '../src/interactive/domain/scenario-schema';
import {
  EDITORIAL_CHECKLIST_ITEMS,
  EDITORIAL_CHECKLIST_VERSION,
} from '../src/interactive/publication/approval';
import { getScenario, listScenarioIds } from '../src/interactive/scenarios';
import { runCli } from './preflight-interactive-publication';

let tmp: string;
let out: string[];
let err: string[];
const io = () => ({ out: (l: string) => out.push(l), err: (l: string) => err.push(l) });
const file = (name: string) => path.join(tmp, name);
const put = (name: string, value: unknown) =>
  writeFileSync(file(name), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
const output = () => out.join('\n');

/** Test-only attestation; never written for a real candidate. */
const approvedFor = (pending: Record<string, unknown>) => ({
  ...pending,
  decision: 'approved',
  reviewer: 'test-reviewer',
  reviewedAt: '2026-01-01T00:00:00Z',
  checklist: {
    version: EDITORIAL_CHECKLIST_VERSION,
    items: Object.fromEntries(EDITORIAL_CHECKLIST_ITEMS.map((i) => [i, true])),
  },
});

async function authoredRun() {
  const result = await runAuthoring({
    rawBrief: LAST_TRAM_BRIEF,
    provider: new MockScenarioDraftProvider(),
  });
  if (result.status !== 'REVIEW_REQUIRED') throw new Error('expected REVIEW_REQUIRED');
  return writeRunArtifacts({ result, draftsRoot: path.join(tmp, 'scenario-drafts') });
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'preflight-cli-'));
  out = [];
  err = [];
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('preflight-interactive-publication', () => {
  it('passes a candidate with a hand-completed matching approval and writes nothing', async () => {
    const run = await authoredRun();
    const template = JSON.parse(readFileSync(path.join(run.dir, 'approval-template.json'), 'utf8'));
    put('approval.json', approvedFor(template)); // simulates the human editing the template

    const fetchSpy = vi.fn(() => {
      throw new Error('network access attempted');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const snapshot = () =>
      [tmp, run.dir].flatMap((d) =>
        readdirSync(d).map((n) => `${d}/${n}:${statSync(path.join(d, n)).mtimeMs}`),
      );
    const before = snapshot();
    const idsBefore = listScenarioIds();

    const code = await runCli(
      [
        '--candidate',
        path.join(run.dir, 'validated-candidate.json'),
        '--approval',
        file('approval.json'),
      ],
      io(),
    );

    expect(code).toBe(0);
    expect(output()).toContain('PUBLICATION_PREFLIGHT_PASSED');
    expect(output()).toContain(
      `warsaw-last-tram@1 hash=${hashScenarioDefinition(LAST_TRAM_SCENARIO)}`,
    );
    expect(output()).toContain('manual source registration');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
    expect(listScenarioIds()).toEqual(idsBefore);
    expect(getScenario('warsaw-last-tram', 1)).toBeUndefined();
  });

  it('fails the untouched pending template the authoring tool produced', async () => {
    const run = await authoredRun();
    const code = await runCli(
      [
        '--candidate',
        path.join(run.dir, 'validated-candidate.json'),
        '--approval',
        path.join(run.dir, 'approval-template.json'),
      ],
      io(),
    );
    expect(code).toBe(1);
    expect(output()).toContain('PUBLICATION_PREFLIGHT_FAILED [APPROVAL_PENDING]');
  });

  it('fails with a stable code for a missing approval file or an omitted flag', async () => {
    put('candidate.json', LAST_TRAM_SCENARIO);
    expect(
      await runCli(['--candidate', file('candidate.json'), '--approval', file('nope.json')], io()),
    ).toBe(1);
    expect(output()).toContain('[APPROVAL_MISSING]');
    out = [];
    expect(await runCli(['--candidate', file('candidate.json')], io())).toBe(1);
    expect(output()).toContain('[APPROVAL_MISSING]');
  });

  it('fails on an unreadable, oversized or non-JSON candidate', async () => {
    put('approval.json', {});
    const cli = (candidate: string) =>
      runCli(['--candidate', file(candidate), '--approval', file('approval.json')], io());
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
  });

  it('fails a mismatched approval and an oversized approval file', async () => {
    put('candidate.json', LAST_TRAM_SCENARIO);
    const edited = structuredClone(LAST_TRAM_SCENARIO);
    edited.title = 'Edited after review';
    put('edited.json', edited);
    put(
      'approval.json',
      approvedFor({
        schemaVersion: 'scenario-approval/v1',
        scenario: { id: 'warsaw-last-tram', version: 1 },
        candidateHash: hashScenarioDefinition(LAST_TRAM_SCENARIO),
      }),
    );
    expect(
      await runCli(['--candidate', file('edited.json'), '--approval', file('approval.json')], io()),
    ).toBe(1);
    expect(output()).toContain('[APPROVAL_HASH_MISMATCH]');
    out = [];
    put('huge.json', 'x'.repeat(40_000));
    expect(
      await runCli(['--candidate', file('candidate.json'), '--approval', file('huge.json')], io()),
    ).toBe(1);
    expect(output()).toContain('[APPROVAL_TOO_LARGE]');
  });

  it('prints bounded diagnostics for a mechanically invalid candidate', async () => {
    const broken = structuredClone(LAST_TRAM_SCENARIO);
    broken.scenes[1]!.choices[0]!.to = 's-missing';
    put('candidate.json', broken);
    put('approval.json', {});
    expect(
      await runCli(
        ['--candidate', file('candidate.json'), '--approval', file('approval.json')],
        io(),
      ),
    ).toBe(1);
    expect(output()).toContain('[CANDIDATE_INVALID]');
    expect(output()).toContain('DEFINITION_INVALID');
    expect(out.length).toBeLessThan(40);
  });

  it('exits 2 on usage errors', async () => {
    const bad = [
      [],
      ['--approval', 'a.json'],
      ['--candidate', 'a', '--candidate', 'b'],
      ['--wat'],
      ['--candidate'],
    ];
    for (const argv of bad) {
      out = [];
      err = [];
      expect(await runCli(argv, io())).toBe(2);
      expect(err.join('\n')).toContain('Usage');
    }
  });
});
