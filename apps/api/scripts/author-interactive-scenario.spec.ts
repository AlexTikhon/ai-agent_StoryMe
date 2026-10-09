import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LAST_TRAM_BRIEF, LAST_TRAM_SCENARIO } from '../src/interactive/authoring/the-last-tram';
import { getScenario, listScenarioIds } from '../src/interactive/scenarios';
import { runCli } from './author-interactive-scenario';

let tmp: string;
let draftsRoot: string;
let out: string[];
let err: string[];
const io = () => ({ out: (l: string) => out.push(l), err: (l: string) => err.push(l) });

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'authoring-cli-'));
  draftsRoot = path.join(tmp, 'scenario-drafts');
  out = [];
  err = [];
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('author-interactive-scenario (mock mode, end to end)', () => {
  it('produces a complete REVIEW_REQUIRED artifact set without keys or network', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('network access attempted');
    });
    vi.stubGlobal('fetch', fetchSpy);

    const code = await runCli(['--mode', 'mock', '--drafts-root', draftsRoot], {}, io());
    expect(code).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();

    const runs = readdirSync(draftsRoot);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatch(/^\d{8}T\d{6}Z-warsaw-last-tram-v1-[0-9a-f]{8}--review-required$/);
    const dir = path.join(draftsRoot, runs[0]!);
    expect(readdirSync(dir).sort()).toEqual([
      'review-report.md',
      'validated-candidate.json',
      'validation-report.json',
    ]);

    const candidate = JSON.parse(readFileSync(path.join(dir, 'validated-candidate.json'), 'utf8'));
    expect(candidate).toEqual(LAST_TRAM_SCENARIO);
    const report = JSON.parse(readFileSync(path.join(dir, 'validation-report.json'), 'utf8'));
    expect(report).toMatchObject({
      status: 'REVIEW_REQUIRED',
      approved: false,
      publication: 'NOT_PUBLISHED',
    });
    expect(readFileSync(path.join(dir, 'review-report.md'), 'utf8')).toContain('NOT approved');
    expect(out.join('\n')).toContain('REVIEW_REQUIRED (mechanically valid; NOT approved');
    expect(out.join('\n')).toContain('Mode: mock');
  });

  it('reproduces the same candidate hash on repeat runs, each in its own fresh directory', async () => {
    expect(await runCli(['--mode', 'mock', '--drafts-root', draftsRoot], {}, io())).toBe(0);
    expect(await runCli(['--mode', 'mock', '--drafts-root', draftsRoot], {}, io())).toBe(0);
    const runs = readdirSync(draftsRoot);
    expect(runs).toHaveLength(2);
    const hashes = runs.map(
      (r) =>
        JSON.parse(readFileSync(path.join(draftsRoot, r, 'validation-report.json'), 'utf8'))
          .candidate.hash as string,
    );
    expect(hashes[0]).toBe(hashes[1]);
  });

  it('does not register or serve the candidate', async () => {
    await runCli(['--mode', 'mock', '--drafts-root', draftsRoot], {}, io());
    expect(listScenarioIds()).toEqual(['warsaw-last-delivery']);
    expect(getScenario('warsaw-last-tram', 1)).toBeUndefined();
  });

  it('refuses a brief whose identity is already published, writing nothing', async () => {
    const briefFile = path.join(tmp, 'brief.json');
    writeFileSync(
      briefFile,
      JSON.stringify({ ...LAST_TRAM_BRIEF, scenarioId: 'warsaw-last-delivery' }),
    );
    const code = await runCli(
      ['--mode', 'mock', '--brief-file', briefFile, '--drafts-root', draftsRoot],
      {},
      io(),
    );
    expect(code).toBe(2);
    expect(out.join('\n')).toContain('IDENTITY_ALREADY_PUBLISHED');
    expect(existsSync(draftsRoot)).toBe(false);
  });

  it('records a mock run for a different brief as a rejected (not review-required) run', async () => {
    const briefFile = path.join(tmp, 'other-brief.json');
    writeFileSync(
      briefFile,
      JSON.stringify({ ...LAST_TRAM_BRIEF, scenarioId: 'warsaw-other-night' }),
    );
    const code = await runCli(
      ['--mode', 'mock', '--brief-file', briefFile, '--drafts-root', draftsRoot],
      {},
      io(),
    );
    expect(code).toBe(1);
    const runs = readdirSync(draftsRoot);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatch(/--rejected$/);
    expect(readdirSync(path.join(draftsRoot, runs[0]!))).toEqual(['run-report.json']);
  });

  it('rejects unsafe drafts roots and unreadable briefs before doing any work', async () => {
    expect(
      await runCli(['--mode', 'mock', '--drafts-root', path.join(tmp, 'elsewhere')], {}, io()),
    ).toBe(2);
    expect(
      await runCli(
        [
          '--mode',
          'mock',
          '--drafts-root',
          path.resolve(__dirname, '..', 'src', 'scenario-drafts'),
        ],
        {},
        io(),
      ),
    ).toBe(2);
    expect(
      await runCli(
        [
          '--mode',
          'mock',
          '--brief-file',
          path.join(tmp, 'missing.json'),
          '--drafts-root',
          draftsRoot,
        ],
        {},
        io(),
      ),
    ).toBe(2);
    expect(existsSync(draftsRoot)).toBe(false);
  });
});

describe('author-interactive-scenario (openai mode is opt-in only)', () => {
  const SECRET = 'sk-cli-test-secret-9999';

  it('never calls the network without the explicit paid-call flag, model and brief', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('network access attempted');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const env = { OPENAI_API_KEY: SECRET };
    const cases = [
      ['--mode', 'openai', '--brief', 'the-last-tram', '--model', 'm'],
      ['--mode', 'openai', '--brief', 'the-last-tram', '--allow-paid-calls'],
      ['--mode', 'openai', '--allow-paid-calls', '--model', 'm'],
      [],
    ];
    for (const argv of cases) {
      expect(await runCli([...argv, '--drafts-root', draftsRoot], env, io())).toBe(2);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect([...out, ...err].join('\n')).not.toContain(SECRET);
    expect(existsSync(draftsRoot)).toBe(false);
  });
});
