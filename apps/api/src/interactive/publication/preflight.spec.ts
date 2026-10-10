import { describe, expect, it, vi } from 'vitest';
import { LAST_TRAM_SCENARIO } from '../authoring/the-last-tram';
import { scenarioToWire } from '../authoring/wire';
import { hashScenarioDefinition, type ScenarioDefinition } from '../domain/scenario-schema';
import { listScenarioIds, WARSAW_LAST_DELIVERY_V1 } from '../scenarios';
import {
  EDITORIAL_CHECKLIST_ITEMS,
  EDITORIAL_CHECKLIST_VERSION,
  buildPendingApproval,
} from './approval';
import { MAX_CANDIDATE_FILE_BYTES, runPublicationPreflight } from './preflight';

const NOW = new Date('2026-10-10T12:00:00.000Z');
const hashOf = (s: ScenarioDefinition) => hashScenarioDefinition(s);

/** Test-only attestations; the real Last Tram candidate stays pending. */
function approvalFor(scenario: ScenarioDefinition, overrides: Record<string, unknown> = {}) {
  return {
    ...buildPendingApproval({
      id: scenario.id,
      version: scenario.version,
      candidateHash: hashOf(scenario),
    }),
    decision: 'approved',
    reviewer: 'test-reviewer',
    reviewedAt: '2026-10-09T10:00:00Z',
    checklist: {
      version: EDITORIAL_CHECKLIST_VERSION,
      items: Object.fromEntries(EDITORIAL_CHECKLIST_ITEMS.map((i) => [i, true])),
    },
    ...overrides,
  };
}

const text = (v: unknown, indent?: number) => JSON.stringify(v, null, indent);
const run = (
  candidate: unknown,
  approval: unknown | null,
  extra: Partial<Parameters<typeof runPublicationPreflight>[0]> = {},
) =>
  runPublicationPreflight({
    candidateText: typeof candidate === 'string' ? candidate : text(candidate, 2),
    approvalText:
      approval === null ? null : typeof approval === 'string' ? approval : text(approval, 2),
    now: NOW,
    ...extra,
  });

const codeOf = (r: ReturnType<typeof run>) =>
  r.status === 'PUBLICATION_PREFLIGHT_PASSED' ? null : r.code;

describe('runPublicationPreflight', () => {
  it('passes a matching approval after full mechanical revalidation of the runtime artifact', () => {
    const result = run(LAST_TRAM_SCENARIO, approvalFor(LAST_TRAM_SCENARIO));
    expect(result).toMatchObject({
      status: 'PUBLICATION_PREFLIGHT_PASSED',
      scenario: { id: 'warsaw-last-tram', version: 1 },
      candidateHash: hashOf(LAST_TRAM_SCENARIO),
    });
    if (result.status !== 'PUBLICATION_PREFLIGHT_PASSED') return;
    // The report is recomputed, not copied from a stored validation report.
    expect(result.report.witnessRoutes.map((r) => r.endingId).sort()).toEqual(
      LAST_TRAM_SCENARIO.endings.map((e) => e.id).sort(),
    );
    expect(result.report.stages.every((s) => s.passed)).toBe(true);
  });

  it('keeps the canonical hash across formatting-only changes', () => {
    const reordered = JSON.parse(text(LAST_TRAM_SCENARIO));
    const shuffled = Object.fromEntries(Object.entries(reordered).reverse());
    const approval = approvalFor(LAST_TRAM_SCENARIO);
    for (const candidate of [
      text(LAST_TRAM_SCENARIO),
      text(LAST_TRAM_SCENARIO, 4),
      text(shuffled, 1),
    ]) {
      expect(run(candidate, approval).status).toBe('PUBLICATION_PREFLIGHT_PASSED');
    }
  });

  it('requires an approval record', () => {
    expect(codeOf(run(LAST_TRAM_SCENARIO, null))).toBe('APPROVAL_MISSING');
  });

  it('fails pending and rejected approvals', () => {
    const pending = buildPendingApproval({
      id: LAST_TRAM_SCENARIO.id,
      version: 1,
      candidateHash: hashOf(LAST_TRAM_SCENARIO),
    });
    expect(codeOf(run(LAST_TRAM_SCENARIO, pending))).toBe('APPROVAL_PENDING');
    expect(
      codeOf(run(LAST_TRAM_SCENARIO, approvalFor(LAST_TRAM_SCENARIO, { decision: 'rejected' }))),
    ).toBe('APPROVAL_REJECTED');
  });

  it('fails a wrong identity, hash, record version or checklist version', () => {
    expect(
      codeOf(
        run(
          LAST_TRAM_SCENARIO,
          approvalFor(LAST_TRAM_SCENARIO, { scenario: { id: 'x', version: 1 } }),
        ),
      ),
    ).toBe('APPROVAL_IDENTITY_MISMATCH');
    expect(
      codeOf(
        run(LAST_TRAM_SCENARIO, approvalFor(LAST_TRAM_SCENARIO, { candidateHash: 'a'.repeat(64) })),
      ),
    ).toBe('APPROVAL_HASH_MISMATCH');
    expect(
      codeOf(
        run(
          LAST_TRAM_SCENARIO,
          approvalFor(LAST_TRAM_SCENARIO, { schemaVersion: 'scenario-approval/v9' }),
        ),
      ),
    ).toBe('APPROVAL_UNSUPPORTED_VERSION');
    const record = approvalFor(LAST_TRAM_SCENARIO);
    expect(
      codeOf(
        run(LAST_TRAM_SCENARIO, {
          ...record,
          checklist: { ...record.checklist, version: 'editorial-checklist/v2' },
        }),
      ),
    ).toBe('APPROVAL_UNSUPPORTED_VERSION');
  });

  it('invalidates an existing approval when prose or effects are edited', () => {
    const approval = approvalFor(LAST_TRAM_SCENARIO);

    const prose = structuredClone(LAST_TRAM_SCENARIO);
    prose.scenes[0]!.narration[0]!.text += ' One more sentence.';
    expect(codeOf(run(prose, approval))).toBe('APPROVAL_HASH_MISMATCH');

    const effects = structuredClone(LAST_TRAM_SCENARIO);
    effects.scenes[0]!.choices[0]!.effects.push({ kind: 'setFlag', flag: 'waited-quietly' });
    expect(codeOf(run(effects, approval))).toBe('APPROVAL_HASH_MISMATCH');
  });

  it('still fails mechanically invalid content even with a matching approval', () => {
    const broken = structuredClone(LAST_TRAM_SCENARIO);
    broken.scenes[1]!.choices[0]!.to = 's-missing';
    const result = run(broken, approvalFor(broken));
    expect(codeOf(result)).toBe('CANDIDATE_INVALID');
    if (result.status === 'PUBLICATION_PREFLIGHT_FAILED') {
      expect(result.stage).toBe('definition');
      expect(result.diagnostics.length).toBeGreaterThan(0);
    }
  });

  it('does not accept the provider wire format as a runtime artifact', () => {
    const result = run(scenarioToWire(LAST_TRAM_SCENARIO), approvalFor(LAST_TRAM_SCENARIO));
    expect(codeOf(result)).toBe('CANDIDATE_INVALID');
  });

  it('rejects unknown fields in the runtime candidate (schema is not loosened)', () => {
    const extra = { ...structuredClone(LAST_TRAM_SCENARIO), approved: true };
    expect(codeOf(run(extra, approvalFor(LAST_TRAM_SCENARIO)))).toBe('CANDIDATE_INVALID');
  });

  it('runs the real analysis rather than trusting a stored report', () => {
    const analyze = vi.fn(() => ({
      issues: ['forced failure'],
      reachableStateCount: 0,
      reachableEndings: [],
      usedChoiceIds: [],
    })) as never;
    const result = run(LAST_TRAM_SCENARIO, approvalFor(LAST_TRAM_SCENARIO), { analyze });
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(codeOf(result)).toBe('CANDIDATE_INVALID');
    if (result.status === 'PUBLICATION_PREFLIGHT_FAILED')
      expect(result.stage).toBe('play-analysis');
  });

  it('refuses an identity that is already published, so a version cannot be overwritten', () => {
    const collide = { ...structuredClone(LAST_TRAM_SCENARIO) };
    const approval = approvalFor(collide);
    expect(codeOf(run(collide, approval, { isPublished: () => true }))).toBe(
      'IDENTITY_ALREADY_PUBLISHED',
    );
    // Default lookup is the real registry: an id/version it already holds cannot be preflighted.
    const clash = { ...structuredClone(LAST_TRAM_SCENARIO), id: WARSAW_LAST_DELIVERY_V1.id };
    expect(codeOf(run(clash, approvalFor(clash)))).toBe('IDENTITY_ALREADY_PUBLISHED');
  });

  it('bounds input and reports non-JSON candidates and approvals with stable codes', () => {
    expect(codeOf(run('x'.repeat(MAX_CANDIDATE_FILE_BYTES + 1), null))).toBe('CANDIDATE_TOO_LARGE');
    expect(codeOf(run('{not json', null))).toBe('CANDIDATE_NOT_JSON');
    expect(codeOf(run(LAST_TRAM_SCENARIO, '{not json'))).toBe('APPROVAL_NOT_JSON');
    expect(codeOf(run(LAST_TRAM_SCENARIO, 'x'.repeat(20_000)))).toBe('APPROVAL_TOO_LARGE');
  });

  it('bounds diagnostics', () => {
    const broken = structuredClone(LAST_TRAM_SCENARIO);
    broken.scenes = broken.scenes.map((s) => ({
      ...s,
      choices: s.choices.map((c) => ({ ...c, to: `nowhere-${c.id}-${'x'.repeat(500)}` })),
    }));
    const result = run(broken, approvalFor(broken));
    expect(result.status).toBe('PUBLICATION_PREFLIGHT_FAILED');
    if (result.status === 'PUBLICATION_PREFLIGHT_FAILED') {
      expect(result.diagnostics.length).toBeLessThanOrEqual(25);
      expect(result.diagnostics.every((d) => d.message.length <= 240)).toBe(true);
    }
  });

  it('is a pure check: no registry change, no network', () => {
    const before = listScenarioIds();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      run(LAST_TRAM_SCENARIO, approvalFor(LAST_TRAM_SCENARIO));
    } finally {
      vi.unstubAllGlobals();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(listScenarioIds()).toEqual(before);
    expect(before).toEqual(['warsaw-last-delivery']);
  });
});
