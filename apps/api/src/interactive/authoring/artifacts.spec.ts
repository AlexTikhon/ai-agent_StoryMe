import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseScenarioDefinition } from '../domain/scenario-schema';
import { DRAFTS_DIR_NAME, validateDraftsRoot, writeRunArtifacts } from './artifacts';
import { runAuthoring } from './pipeline';
import { MockScenarioDraftProvider } from './provider';
import { ScriptedDraftProvider } from './scripted-provider';
import { LAST_TRAM_BRIEF } from './the-last-tram';

let tmp: string;
let root: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'authoring-artifacts-'));
  root = path.join(tmp, DRAFTS_DIR_NAME);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const NOW = new Date('2026-10-09T12:00:00.000Z');
const opts = (hex = 'aaaa1111') => ({ now: NOW, randomHex: () => hex });

describe('writeRunArtifacts', () => {
  it('writes a complete REVIEW_REQUIRED run into a fresh, status-labelled directory', async () => {
    const result = await runAuthoring({
      rawBrief: LAST_TRAM_BRIEF,
      provider: new MockScenarioDraftProvider(),
    });
    if (result.status !== 'REVIEW_REQUIRED') throw new Error('expected REVIEW_REQUIRED');
    const written = writeRunArtifacts({ result, draftsRoot: root, ...opts() });

    expect(path.basename(written.dir)).toBe(
      '20261009T120000Z-warsaw-last-tram-v1-aaaa1111--review-required',
    );
    expect(readdirSync(written.dir).sort()).toEqual([
      'review-report.md',
      'validated-candidate.json',
      'validation-report.json',
    ]);
    // No half-written leftovers.
    expect(readdirSync(root).some((n) => n.endsWith('.incomplete'))).toBe(false);

    const candidate = JSON.parse(
      readFileSync(path.join(written.dir, 'validated-candidate.json'), 'utf8'),
    );
    expect(parseScenarioDefinition(candidate).id).toBe('warsaw-last-tram');
    const report = JSON.parse(
      readFileSync(path.join(written.dir, 'validation-report.json'), 'utf8'),
    );
    expect(report).toMatchObject({ status: 'REVIEW_REQUIRED', approved: false });
    expect(report.candidate.hash).toBe(result.candidateHash);
  });

  it('writes no candidate file for a rejected run, only a labelled failure report', async () => {
    const result = await runAuthoring({
      rawBrief: LAST_TRAM_BRIEF,
      provider: new ScriptedDraftProvider([
        { candidate: '{"nope": true}' },
        { candidate: 'not json' },
      ]),
    });
    if (result.status !== 'REJECTED') throw new Error('expected REJECTED');
    const written = writeRunArtifacts({ result, draftsRoot: root, ...opts('bbbb2222') });
    expect(path.basename(written.dir)).toMatch(/--rejected$/);
    expect(readdirSync(written.dir)).toEqual(['run-report.json']);
    const text = readFileSync(path.join(written.dir, 'run-report.json'), 'utf8');
    expect(JSON.parse(text)).toMatchObject({ status: 'REJECTED', candidateFile: null });
    expect(text).not.toContain('not json');
  });

  it('writes a stopped run distinguishably', async () => {
    const result = await runAuthoring({
      rawBrief: LAST_TRAM_BRIEF,
      provider: new ScriptedDraftProvider([{ fail: 'refusal' }]),
    });
    if (result.status !== 'STOPPED') throw new Error('expected STOPPED');
    const written = writeRunArtifacts({ result, draftsRoot: root, ...opts('cccc3333') });
    expect(path.basename(written.dir)).toMatch(/--stopped$/);
    expect(
      JSON.parse(readFileSync(path.join(written.dir, 'run-report.json'), 'utf8')),
    ).toMatchObject({
      stopReason: 'REFUSAL',
    });
  });

  it('refuses to overwrite an existing run directory and leaves it untouched', async () => {
    const result = await runAuthoring({
      rawBrief: LAST_TRAM_BRIEF,
      provider: new MockScenarioDraftProvider(),
    });
    if (result.status !== 'REVIEW_REQUIRED') throw new Error('expected REVIEW_REQUIRED');
    const first = writeRunArtifacts({ result, draftsRoot: root, ...opts('dddd4444') });
    const before = readFileSync(path.join(first.dir, 'validated-candidate.json'), 'utf8');
    expect(() => writeRunArtifacts({ result, draftsRoot: root, ...opts('dddd4444') })).toThrow(
      /overwrite/,
    );
    expect(readFileSync(path.join(first.dir, 'validated-candidate.json'), 'utf8')).toBe(before);
    expect(existsSync(`${first.dir.replace('--review-required', '.incomplete')}`)).toBe(false);
  });

  it('leaves a half-written run labelled .incomplete if writing fails midway', async () => {
    const result = await runAuthoring({
      rawBrief: LAST_TRAM_BRIEF,
      provider: new MockScenarioDraftProvider(),
    });
    if (result.status !== 'REVIEW_REQUIRED') throw new Error('expected REVIEW_REQUIRED');
    // Pre-create the work directory so mkdir (non-recursive) fails before any file is written.
    const workDir = path.join(root, '20261009T120000Z-warsaw-last-tram-v1-eeee5555.incomplete');
    writeRunArtifacts({ result, draftsRoot: root, ...opts('ffff6666') });
    expect(() => {
      // simulate a leftover from a crashed run with the same name
      mkdirSync(workDir);
      writeRunArtifacts({ result, draftsRoot: root, ...opts('eeee5555') });
    }).toThrow();
    expect(existsSync(workDir)).toBe(true);
    expect(readdirSync(root).filter((n) => n.endsWith('--review-required'))).toHaveLength(1);
  });
});

describe('validateDraftsRoot', () => {
  const forbidden = [path.join(tmp ?? '', 'src')];

  it('accepts the default root and an explicit scenario-drafts directory', () => {
    const def = path.join('/work', 'api', DRAFTS_DIR_NAME);
    expect(validateDraftsRoot(undefined, def, [])).toEqual({ ok: true, root: path.resolve(def) });
    const custom = path.join('/tmp', 'x', DRAFTS_DIR_NAME);
    expect(validateDraftsRoot(custom, def, [])).toEqual({ ok: true, root: path.resolve(custom) });
  });

  it('rejects other names, source/asset/build locations and public directories', () => {
    const def = path.join('/work', 'api', DRAFTS_DIR_NAME);
    expect(validateDraftsRoot('/work/api/other', def, []).ok).toBe(false);
    expect(
      validateDraftsRoot('/work/api/src/scenario-drafts', def, [path.resolve('/work/api/src')]).ok,
    ).toBe(false);
    expect(validateDraftsRoot('/work/web/public/scenario-drafts', def, forbidden).ok).toBe(false);
    expect(
      validateDraftsRoot('/work/api/assets/scenario-drafts', def, [
        path.resolve('/work/api/assets'),
      ]).ok,
    ).toBe(false);
  });

  it('collapses traversal segments before checking', () => {
    const def = path.join('/work', 'api', DRAFTS_DIR_NAME);
    expect(
      validateDraftsRoot('/work/api/scenario-drafts/../src/scenario-drafts', def, [
        path.resolve('/work/api/src'),
      ]).ok,
    ).toBe(false);
  });
});
