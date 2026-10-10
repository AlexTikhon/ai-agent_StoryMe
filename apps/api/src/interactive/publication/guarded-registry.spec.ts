import { describe, expect, it } from 'vitest';
import { LAST_TRAM_SCENARIO } from '../authoring/the-last-tram';
import { hashScenarioDefinition, type ScenarioDefinition } from '../domain/scenario-schema';
import { LEGACY_PUBLISHED_BASELINE } from '../scenarios/legacy-baseline';
import { SCENARIO_APPROVALS } from '../scenarios/approvals';
import {
  WARSAW_LAST_DELIVERY_V1,
  getLatestScenario,
  getScenario,
  getScenarioCatalogue,
  listScenarioIds,
} from '../scenarios';
import {
  EDITORIAL_CHECKLIST_ITEMS,
  EDITORIAL_CHECKLIST_VERSION,
  buildPendingApproval,
} from './approval';
import { createGuardedScenarioRegistry, PublicationGuardError } from './guarded-registry';

const NOW = new Date('2026-10-10T12:00:00.000Z');
const meta = (scenario: ScenarioDefinition) => ({
  scenarioId: scenario.id,
  version: scenario.version,
  title: `Title ${scenario.id}`,
  synopsis: 'A spoiler-free synopsis.',
});

/** Test-only attestation for a fixture; the real Last Tram is never approved. */
function approvalFor(scenario: ScenarioDefinition, overrides: Record<string, unknown> = {}) {
  return {
    ...buildPendingApproval({
      id: scenario.id,
      version: scenario.version,
      candidateHash: hashScenarioDefinition(scenario),
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

const compose = (
  definitions: ScenarioDefinition[],
  approvals: unknown[],
  legacyBaseline = LEGACY_PUBLISHED_BASELINE,
) =>
  createGuardedScenarioRegistry({
    definitions,
    metadata: definitions.map(meta),
    approvals,
    legacyBaseline,
    now: NOW,
  });

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof PublicationGuardError) return error.code;
    throw error;
  }
  return null;
};

describe('createGuardedScenarioRegistry', () => {
  it('registers an entry that has a matching approval', () => {
    const registry = compose([LAST_TRAM_SCENARIO], [approvalFor(LAST_TRAM_SCENARIO)]);
    expect(registry.get('warsaw-last-tram', 1)).toBe(LAST_TRAM_SCENARIO);
    expect(registry.catalogue().map((e) => e.scenarioId)).toEqual(['warsaw-last-tram']);
  });

  it('refuses an unapproved production entry (no approval at all)', () => {
    expect(codeOf(() => compose([LAST_TRAM_SCENARIO], []))).toBe('APPROVAL_MISSING');
  });

  it('refuses pending and rejected approvals', () => {
    const pending = buildPendingApproval({
      id: LAST_TRAM_SCENARIO.id,
      version: 1,
      candidateHash: hashScenarioDefinition(LAST_TRAM_SCENARIO),
    });
    expect(codeOf(() => compose([LAST_TRAM_SCENARIO], [pending]))).toBe('APPROVAL_PENDING');
    expect(
      codeOf(() =>
        compose([LAST_TRAM_SCENARIO], [approvalFor(LAST_TRAM_SCENARIO, { decision: 'rejected' })]),
      ),
    ).toBe('APPROVAL_REJECTED');
  });

  it('refuses an edited definition whose approval was for the earlier text', () => {
    const edited = structuredClone(LAST_TRAM_SCENARIO);
    edited.scenes[0]!.narration[0]!.text += ' (edited after approval)';
    expect(codeOf(() => compose([edited], [approvalFor(LAST_TRAM_SCENARIO)]))).toBe(
      'APPROVAL_HASH_MISMATCH',
    );
  });

  it('refuses a new version approved only under another version', () => {
    const v2 = { ...structuredClone(LAST_TRAM_SCENARIO), version: 2 };
    expect(codeOf(() => compose([v2], [approvalFor(LAST_TRAM_SCENARIO)]))).toBe('APPROVAL_MISSING');
  });

  it('refuses malformed and duplicated approval records', () => {
    expect(codeOf(() => compose([LAST_TRAM_SCENARIO], [{ nope: true }]))).toBe(
      'APPROVAL_MALFORMED',
    );
    const one = approvalFor(LAST_TRAM_SCENARIO);
    expect(codeOf(() => compose([LAST_TRAM_SCENARIO], [one, { ...one }]))).toBe(
      'APPROVAL_DUPLICATE',
    );
  });

  describe('legacy baseline', () => {
    it('pins warsaw-last-delivery@1 to its current canonical hash, labelled existing content', () => {
      expect(LEGACY_PUBLISHED_BASELINE).toEqual([
        {
          id: 'warsaw-last-delivery',
          version: 1,
          candidateHash: hashScenarioDefinition(WARSAW_LAST_DELIVERY_V1),
          reason: 'EXISTING_PUBLISHED_CONTENT',
        },
      ]);
    });

    it('lets the exact legacy definition register without an approval record', () => {
      const registry = compose([WARSAW_LAST_DELIVERY_V1], []);
      expect(registry.get('warsaw-last-delivery', 1)).toBe(WARSAW_LAST_DELIVERY_V1);
    });

    it('refuses a modified copy of the legacy definition, even with a matching approval', () => {
      const modified = structuredClone(WARSAW_LAST_DELIVERY_V1);
      modified.title = `${modified.title} (modified)`;
      expect(codeOf(() => compose([modified], []))).toBe('LEGACY_BASELINE_HASH_MISMATCH');
      expect(codeOf(() => compose([modified], [approvalFor(modified)]))).toBe(
        'LEGACY_BASELINE_HASH_MISMATCH',
      );
    });

    it('does not extend to another scenario or a new version', () => {
      const other = { ...structuredClone(WARSAW_LAST_DELIVERY_V1), id: 'warsaw-other' };
      expect(codeOf(() => compose([other], []))).toBe('APPROVAL_MISSING');
      const v2 = { ...structuredClone(WARSAW_LAST_DELIVERY_V1), version: 2 };
      expect(codeOf(() => compose([v2], []))).toBe('APPROVAL_MISSING');
    });

    it('does not depend on the baseline when an injected one is empty', () => {
      expect(codeOf(() => compose([WARSAW_LAST_DELIVERY_V1], [], []))).toBe('APPROVAL_MISSING');
    });
  });

  describe('the real published registry', () => {
    it('holds only the legacy content; The Last Tram is unregistered, unlisted and has no approval', () => {
      expect(listScenarioIds()).toEqual(['warsaw-last-delivery']);
      expect(getScenarioCatalogue().map((e) => e.scenarioId)).toEqual(['warsaw-last-delivery']);
      expect(getScenario('warsaw-last-tram', 1)).toBeUndefined();
      expect(getLatestScenario('warsaw-last-tram')).toBeUndefined();
      expect(SCENARIO_APPROVALS).toEqual([]);
    });
  });
});
