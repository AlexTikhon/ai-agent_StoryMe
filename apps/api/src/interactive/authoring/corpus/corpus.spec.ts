import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FAST_LIMITS,
  fakeClock,
  reportFileNameFor,
  reportText,
} from '../../../common/test-utils/authoring-run-fixtures';
import {
  DomainError,
  applyChoice,
  availableChoices,
  playChoices,
  startSession,
  verifyReplay,
} from '../../domain/engine';
import { buildCanonicalNarration, validateNarration } from '../../domain/narration';
import { hashScenarioDefinition, type ScenarioDefinition } from '../../domain/scenario-schema';
import type { InteractiveState } from '../../domain/state';
import { listPresentationPacks, getPresentationPack } from '../../presentation/presentation';
import { CATALOGUE_METADATA } from '../../scenarios/catalogue-metadata';
import { getScenario, getScenarioCatalogue, listScenarioIds } from '../../scenarios';
import { hashBrief, parseBrief, type ScenarioBrief } from '../brief';
import { runAuthoring, type AuthoringResult } from '../pipeline';
import { buildRouteReview } from '../route-review';
import { buildComparisonReport } from '../run-report-aggregate';
import { parseRunReport, type RunObservation } from '../run-report-input';
import { ScriptedDraftProvider, type ScriptStep } from '../scripted-provider';
import { LAST_TRAM_BRIEF, LAST_TRAM_SCENARIO } from '../the-last-tram';
import {
  collectAuthoringIssues,
  countDecisionPoints,
  findSceneCycle,
  isPublishedInRegistry,
  validateCandidate,
} from '../validate';
import { scenarioToWire } from '../wire';
import { AUTHORING_CORPUS, AUTHORING_CORPUS_VERSION, type CorpusEntry } from './index';

afterEach(() => vi.unstubAllGlobals());

const [LAST_TRAM, HARBOUR, BLACKOUT] = AUTHORING_CORPUS as readonly [
  CorpusEntry,
  CorpusEntry,
  CorpusEntry,
];
const NEW_ENTRIES: readonly CorpusEntry[] = [HARBOUR, BLACKOUT];

// ── Helpers ─────────────────────────────────────────────────────────────────

const wireText = (scenario: ScenarioDefinition): string => JSON.stringify(scenarioToWire(scenario));

/** Same candidate with its first choice pointing at a scene that does not exist. */
function brokenReferenceText(scenario: ScenarioDefinition): string {
  const wire = structuredClone(scenarioToWire(scenario));
  wire.scenes.flatMap((scene) => scene.choices)[0]!.to = 's-missing';
  return JSON.stringify(wire);
}

async function run(brief: ScenarioBrief, steps: readonly ScriptStep[]) {
  const provider = new ScriptedDraftProvider(steps);
  const result = await runAuthoring({
    rawBrief: brief,
    provider,
    limits: FAST_LIMITS,
    now: fakeClock(),
  });
  return { result, provider };
}

function terminalRoutes(
  scenario: ScenarioDefinition,
): Array<{ choices: string[]; endingId: string }> {
  const routes: Array<{ choices: string[]; endingId: string }> = [];
  const walk = (state: InteractiveState, route: string[]): void => {
    if (state.endingId !== null) {
      routes.push({ choices: route, endingId: state.endingId });
      return;
    }
    const choices = availableChoices(state, scenario);
    expect(choices.length).toBeGreaterThan(0);
    for (const choice of choices) {
      walk(applyChoice(state, choice.id, scenario).state, [...route, choice.id]);
    }
  };
  walk(startSession(scenario).state, []);
  return routes;
}

/** Every reachable (state, route) pair of the production engine, depth first. */
function everyReachableState(
  scenario: ScenarioDefinition,
): Array<{ state: InteractiveState; route: string[] }> {
  const out: Array<{ state: InteractiveState; route: string[] }> = [];
  const walk = (state: InteractiveState, route: string[]): void => {
    out.push({ state, route });
    for (const choice of availableChoices(state, scenario)) {
      walk(applyChoice(state, choice.id, scenario).state, [...route, choice.id]);
    }
  };
  walk(startSession(scenario).state, []);
  return out;
}

function featuresOf(scenario: ScenarioDefinition) {
  const choices = scenario.scenes.flatMap((s) => s.choices);
  const requirementKinds = choices.flatMap((c) => (c.requires ?? []).map((r) => r.kind));
  const effectKinds = choices.flatMap((c) => c.effects.map((e) => e.kind));
  const incoming = new Map<string, number>();
  for (const choice of choices) incoming.set(choice.to, (incoming.get(choice.to) ?? 0) + 1);
  const endingScenes = new Set(scenario.scenes.filter((s) => s.endingId).map((s) => s.id));
  return {
    knowledgeGatedChoices: choices.filter((c) =>
      (c.requires ?? []).some((r) => r.kind === 'playerKnows'),
    ).length,
    itemGatedChoices: choices.filter((c) => (c.requires ?? []).some((r) => r.kind === 'hasItem'))
      .length,
    npcLearnsEffects: effectKinds.filter((k) => k === 'npcLearns').length,
    consumedItemIds: new Set(
      choices.flatMap((c) => c.effects.flatMap((e) => (e.kind === 'consumeItem' ? [e.item] : []))),
    ),
    oneTimeItems: scenario.items.filter((i) => i.oneTime).length,
    requirementKinds: new Set(requirementKinds),
    reconvergingScenes: [...incoming.entries()].filter(([id, n]) => n >= 2 && !endingScenes.has(id))
      .length,
    reconvergingEndings: [...incoming.entries()].filter(([id, n]) => n >= 2 && endingScenes.has(id))
      .length,
  };
}

const SRC_ROOT = path.resolve(__dirname, '../../..');

function sourceTexts(relativeDir: string): string[] {
  const root = path.join(SRC_ROOT, relativeDir);
  const texts: string[] = [];
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) visit(full);
      else if (/\.(ts|json)$/.test(name) && !/\.spec\.ts$/.test(name)) {
        texts.push(readFileSync(full, 'utf8'));
      }
    }
  };
  visit(root);
  return texts;
}

// ── Corpus shape ────────────────────────────────────────────────────────────

describe('authoring evaluation corpus: catalogue of entries', () => {
  it('is versioned and holds Last Tram plus two new fixtures in a fixed order', () => {
    expect(AUTHORING_CORPUS_VERSION).toBe('interactive-authoring-corpus/v1');
    expect(AUTHORING_CORPUS.map((e) => e.key)).toEqual([
      'last-tram',
      'harbour-ledger',
      'clock-blackout',
    ]);
  });

  it('reuses the existing Last Tram fixture by reference, not by copy', () => {
    expect(LAST_TRAM.brief).toBe(LAST_TRAM_BRIEF);
    expect(LAST_TRAM.scenario).toBe(LAST_TRAM_SCENARIO);
  });

  it('gives every entry a distinct identity, cast, ending set and brief hash', () => {
    const idOf = (e: CorpusEntry) => `${e.scenario.id}@${e.scenario.version}`;
    expect(new Set(AUTHORING_CORPUS.map(idOf)).size).toBe(3);
    expect(new Set(AUTHORING_CORPUS.map((e) => hashBrief(e.brief))).size).toBe(3);
    expect(new Set(AUTHORING_CORPUS.map((e) => hashScenarioDefinition(e.scenario))).size).toBe(3);

    const disjoint = (pick: (e: CorpusEntry) => string[]) => {
      const all = AUTHORING_CORPUS.flatMap(pick);
      expect(new Set(all).size).toBe(all.length);
    };
    disjoint((e) => e.scenario.characters.map((c) => c.id));
    disjoint((e) => e.scenario.characters.map((c) => c.name));
    disjoint((e) => e.scenario.endings.map((x) => x.id));
    disjoint((e) => e.scenario.scenes.map((s) => s.id));
    disjoint((e) => e.scenario.scenes.map((s) => s.title));
    disjoint((e) => e.scenario.scenes.flatMap((s) => s.choices.map((c) => c.id)));
    disjoint((e) => e.scenario.scenes.flatMap((s) => s.narration.map((t) => t.id)));
    disjoint((e) => e.scenario.facts.map((f) => f.id));
    disjoint((e) => e.scenario.scenes.flatMap((s) => s.narration.map((t) => t.text)));
    disjoint((e) => [e.brief.premise]);
  });

  it('records the gameplay each entry exercises, and the new ones really exercise it', () => {
    for (const entry of AUTHORING_CORPUS) {
      expect(entry.expect.exercises.length).toBeGreaterThanOrEqual(2);
    }
    const harbour = featuresOf(HARBOUR.scenario);
    expect(harbour.knowledgeGatedChoices).toBeGreaterThanOrEqual(3);
    expect(harbour.npcLearnsEffects).toBeGreaterThanOrEqual(1);
    expect(HARBOUR.scenario.items).toEqual([]);

    const blackout = featuresOf(BLACKOUT.scenario);
    expect(blackout.oneTimeItems).toBeGreaterThanOrEqual(2);
    expect(blackout.consumedItemIds.size).toBeGreaterThanOrEqual(2);
    expect(blackout.itemGatedChoices).toBeGreaterThanOrEqual(3);
    expect(blackout.reconvergingScenes).toBeGreaterThanOrEqual(1);
    expect(blackout.reconvergingEndings).toBeGreaterThanOrEqual(1);
    const conditional = BLACKOUT.scenario.scenes.flatMap((s) =>
      s.narration.filter((t) => (t.when ?? []).length > 0),
    );
    expect(conditional.length).toBeGreaterThanOrEqual(5);
  });

  it('is not just Last Tram under new names: gameplay structure differs', () => {
    const shape = (e: CorpusEntry) => {
      const f = featuresOf(e.scenario);
      return JSON.stringify({
        scenes: e.scenario.scenes.length,
        facts: e.scenario.facts.length,
        items: e.scenario.items.length,
        flags: e.scenario.flags.length,
        routes: e.expect.routes.length,
        gated: f.knowledgeGatedChoices,
        itemGated: f.itemGatedChoices,
        consumed: f.consumedItemIds.size,
        reconverging: f.reconvergingScenes,
        reconvergingEndings: f.reconvergingEndings,
        kinds: [...f.requirementKinds].sort(),
      });
    };
    expect(new Set(AUTHORING_CORPUS.map(shape)).size).toBe(3);
  });
});

// ── Mechanical validity ─────────────────────────────────────────────────────

describe.each(AUTHORING_CORPUS.map((e) => [e.key, e] as const))(
  'corpus entry %s',
  (_key, entry) => {
    const { brief, scenario, expect: expected } = entry;

    it('has a valid brief whose identity matches the scenario and the recorded hash', () => {
      const parsed = parseBrief(brief);
      expect(parsed.ok).toBe(true);
      expect(scenario.id).toBe(brief.scenarioId);
      expect(scenario.version).toBe(brief.version);
      expect(expected.identity).toEqual({ scenarioId: brief.scenarioId, version: brief.version });
      expect(hashBrief(brief)).toBe(expected.briefHash);
      expect(hashScenarioDefinition(scenario)).toBe(expected.candidateHash);
    });

    it('meets the authoring constraints exactly', () => {
      expect(collectAuthoringIssues(scenario)).toEqual([]);
      expect(scenario.scenes.length).toBeGreaterThanOrEqual(6);
      expect(scenario.scenes.length).toBeLessThanOrEqual(8);
      expect(countDecisionPoints(scenario)).toBe(3);
      expect(scenario.characters).toHaveLength(3);
      expect(scenario.characters.filter((c) => c.isPlayer)).toHaveLength(1);
      expect(scenario.endings).toHaveLength(2);
      expect(findSceneCycle(scenario)).toBeNull();
      expect(brief.characters.map((c) => `${c.id}:${c.isPlayer}`).sort()).toEqual(
        scenario.characters.map((c) => `${c.id}:${c.isPlayer}`).sort(),
      );
      expect(brief.endings.map((e) => e.id).sort()).toEqual(
        scenario.endings.map((e) => e.id).sort(),
      );
    });

    it('passes every validation stage and normalizes to the fixture itself', () => {
      const outcome = validateCandidate(wireText(scenario), { brief });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.scenario).toEqual(scenario);
      expect(outcome.candidateHash).toBe(expected.candidateHash);
      expect(outcome.report.analysis.reachableEndings).toEqual(
        scenario.endings.map((e) => e.id).sort(),
      );
      expect(outcome.report.analysis.usedChoiceCount).toBe(
        outcome.report.analysis.totalChoiceCount,
      );
    });
  },
);

// ── Actual play against recorded expectations ───────────────────────────────

describe.each(AUTHORING_CORPUS.map((e) => [e.key, e] as const))('corpus play %s', (_key, entry) => {
  const { scenario, expect: expected } = entry;

  it('has exactly the recorded terminal choice sequences and endings, in walk order', () => {
    expect(terminalRoutes(scenario)).toEqual(
      expected.routes.map((r) => ({ choices: [...r.choices], endingId: r.endingId })),
    );
    const sequences = expected.routes.map((r) => r.choices.join('>'));
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(new Set(expected.routes.map((r) => r.endingId))).toEqual(
      new Set(scenario.endings.map((e) => e.id)),
    );
  });

  it('replays every route with the production engine and accepts its canonical narration', () => {
    for (const route of expected.routes) {
      for (let k = 0; k <= route.choices.length; k += 1) {
        const prefix = playChoices(scenario, route.choices.slice(0, k));
        expect(() => verifyReplay(prefix.events, prefix.state, scenario)).not.toThrow();
        const narration = buildCanonicalNarration(scenario, prefix.state);
        expect(validateNarration(narration, scenario, prefix.state).ok).toBe(true);
      }
      expect(playChoices(scenario, route.choices).state.endingId).toBe(route.endingId);
    }
  });

  it('selects the recorded narration on different paths', () => {
    expect(expected.narration.length).toBeGreaterThanOrEqual(4);
    for (const probe of expected.narration) {
      const { state } = playChoices(scenario, probe.after);
      expect(state.sceneId).toBe(probe.sceneId);
      const narration = buildCanonicalNarration(scenario, state);
      expect(narration.templateIds).toEqual([...probe.templateIds]);
      for (const fragment of probe.includes) expect(narration.text).toContain(fragment);
      for (const fragment of probe.excludes) expect(narration.text).not.toContain(fragment);
    }
  });

  it('never offers a locked choice and the engine refuses it for the recorded reason', () => {
    expect(expected.lockedChoices.length).toBeGreaterThanOrEqual(2);
    for (const locked of expected.lockedChoices) {
      const { state } = playChoices(scenario, locked.after);
      const offered = availableChoices(state, scenario).map((c) => c.id);
      expect(offered).not.toContain(locked.choiceId);
      // The choice exists in this very scene, so it is the requirement that hides it.
      const declared = scenario.scenes
        .find((s) => s.id === state.sceneId)!
        .choices.map((c) => c.id);
      expect(declared).toContain(locked.choiceId);
      let thrown: unknown;
      try {
        applyChoice(state, locked.choiceId, scenario);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(DomainError);
      expect((thrown as DomainError).code).toBe(locked.code);
    }
  });

  it('never lets a consumed one-time item be required, regained or consumed again', () => {
    let consumedSeen = 0;
    for (const { state } of everyReachableState(scenario)) {
      expect(state.inventory.filter((item) => state.consumedItems.includes(item))).toEqual([]);
      consumedSeen += state.consumedItems.length;
      if (state.endingId !== null) continue;
      const offered = new Set(availableChoices(state, scenario).map((c) => c.id));
      for (const choice of scenario.scenes.find((s) => s.id === state.sceneId)!.choices) {
        const touchesConsumed =
          (choice.requires ?? []).some(
            (r) => r.kind === 'hasItem' && state.consumedItems.includes(r.item),
          ) ||
          choice.effects.some(
            (e) =>
              (e.kind === 'consumeItem' || e.kind === 'giveItem') &&
              state.consumedItems.includes(e.item),
          );
        if (!touchesConsumed) continue;
        expect(offered.has(choice.id)).toBe(false);
        expect(() => applyChoice(state, choice.id, scenario)).toThrow(DomainError);
      }
    }
    expect(consumedSeen > 0).toBe(scenario.items.length > 0);
  });
});

// ── Real pipeline with the scripted provider ────────────────────────────────

describe('authoring corpus through the real pipeline', () => {
  it.each(AUTHORING_CORPUS.map((e) => [e.key, e] as const))(
    'accepts %s on the first pass with one request and its recorded identity',
    async (_key, entry) => {
      const { result, provider } = await run(entry.brief, [
        { candidate: wireText(entry.scenario) },
      ]);
      expect(result.status).toBe('REVIEW_REQUIRED');
      if (result.status !== 'REVIEW_REQUIRED') return;
      expect(result.approved).toBe(false);
      expect(result.repaired).toBe(false);
      expect(result.candidateHash).toBe(entry.expect.candidateHash);
      expect(result.scenario).toEqual(entry.scenario);
      expect(result.provenance.briefHash).toBe(entry.expect.briefHash);
      expect(result.provenance.provider).toBe('scripted');
      expect(result.provenance.requests).toHaveLength(1);
      expect(provider.requests).toHaveLength(1);
      expect(provider.requests[0]!.kind).toBe('generate');
    },
  );

  it.each(AUTHORING_CORPUS.map((e) => [e.key, e] as const))(
    'repairs %s once after a broken reference, keeping the brief and using exactly two requests',
    async (_key, entry) => {
      const broken = brokenReferenceText(entry.scenario);
      expect(validateCandidate(broken, { brief: entry.brief })).toMatchObject({
        ok: false,
        stage: 'definition',
      });

      const { result, provider } = await run(entry.brief, [
        { candidate: broken },
        { candidate: wireText(entry.scenario) },
      ]);
      expect(result.status).toBe('REVIEW_REQUIRED');
      if (result.status !== 'REVIEW_REQUIRED') return;
      expect(result.repaired).toBe(true);
      expect(result.candidateHash).toBe(entry.expect.candidateHash);
      expect(result.provenance.requests.map((r) => [r.phase, r.validation])).toEqual([
        ['generate', 'failed:definition'],
        ['repair', 'passed'],
      ]);
      expect(result.provenance.briefHash).toBe(entry.expect.briefHash);
      expect(result.brief).toEqual(entry.brief);
      expect(provider.requests.map((r) => r.kind)).toEqual(['generate', 'repair']);
      for (const request of provider.requests) expect(request.brief).toEqual(entry.brief);
      // The repair request carries the first candidate's deterministic diagnostics, and only those.
      const carried = provider.requests[1]!.previous?.diagnostics ?? [];
      expect(carried.length).toBeGreaterThan(0);
      expect(new Set(carried.map((d) => d.stage))).toEqual(new Set(['definition']));
      expect(provider.requests[0]!.previous).toBeUndefined();
    },
  );

  it('refuses every candidate paired with another entry’s brief, at the identity stage', async () => {
    for (const candidateOf of AUTHORING_CORPUS) {
      for (const briefOf of AUTHORING_CORPUS) {
        if (candidateOf === briefOf) continue;
        const text = wireText(candidateOf.scenario);
        const { result, provider } = await run(briefOf.brief, [
          { candidate: text },
          { candidate: text },
        ]);
        expect(result.status).toBe('REJECTED');
        if (result.status !== 'REJECTED') continue;
        expect(result.stage).toBe('identity');
        expect(result.diagnostics.map((d) => d.code)).toContain('IDENTITY_MISMATCH');
        expect(result.repair).toBe('attempted');
        expect(result.provenance.briefHash).toBe(briefOf.expect.briefHash);
        expect(result.provenance.candidateHash).toBeNull();
        expect(provider.requests).toHaveLength(2);
        expect('scenario' in result).toBe(false);
      }
    }
  });

  it('refuses a wrong-brief candidate at the validator without any pipeline help', () => {
    for (const candidateOf of NEW_ENTRIES) {
      for (const briefOf of AUTHORING_CORPUS) {
        if (candidateOf === briefOf) continue;
        const outcome = validateCandidate(wireText(candidateOf.scenario), { brief: briefOf.brief });
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) expect(outcome.stage).toBe('identity');
      }
    }
  });

  it('is deterministic: identical runs give byte-identical reports and hashes', async () => {
    const once = async () => {
      const texts: string[] = [];
      for (const entry of AUTHORING_CORPUS) {
        const first = await run(entry.brief, [{ candidate: wireText(entry.scenario) }]);
        const repaired = await run(entry.brief, [
          { candidate: brokenReferenceText(entry.scenario) },
          { candidate: wireText(entry.scenario) },
        ]);
        texts.push(reportText(first.result), reportText(repaired.result));
      }
      return texts;
    };
    expect(await once()).toEqual(await once());
  });

  it('never touches the global fetch', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('network access attempted');
    });
    vi.stubGlobal('fetch', fetchSpy);
    for (const entry of AUTHORING_CORPUS) {
      const { result } = await run(entry.brief, [{ candidate: wireText(entry.scenario) }]);
      expect(result.status).toBe('REVIEW_REQUIRED');
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── Existing tooling cross-checks ───────────────────────────────────────────

async function observationOf(result: AuthoringResult): Promise<RunObservation> {
  const parsed = parseRunReport(reportFileNameFor(result), reportText(result));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error('report did not parse');
  return parsed.observation;
}

describe('authoring corpus through report builders and comparison', () => {
  it('produces reports that parse, keep the brief hash and match the run', async () => {
    for (const entry of AUTHORING_CORPUS) {
      const first = await run(entry.brief, [{ candidate: wireText(entry.scenario) }]);
      const firstObservation = await observationOf(first.result);
      expect(firstObservation).toMatchObject({
        status: 'REVIEW_REQUIRED',
        repaired: false,
        rejectedStage: null,
        group: { provider: 'scripted', model: null, briefHash: entry.expect.briefHash },
      });
      expect(firstObservation.requests).toHaveLength(1);

      const repaired = await run(entry.brief, [
        { candidate: brokenReferenceText(entry.scenario) },
        { candidate: wireText(entry.scenario) },
      ]);
      const repairedObservation = await observationOf(repaired.result);
      expect(repairedObservation).toMatchObject({
        status: 'REVIEW_REQUIRED',
        repaired: true,
        group: { briefHash: entry.expect.briefHash },
      });
      expect(repairedObservation.requests.map((r) => r.phase)).toEqual(['generate', 'repair']);
      expect(repairedObservation.totalHttpAttempts).toBe(2);
    }
  });

  it('keeps entries with different brief hashes in separate comparison groups', async () => {
    const observations: RunObservation[] = [];
    for (const entry of AUTHORING_CORPUS) {
      const first = await run(entry.brief, [{ candidate: wireText(entry.scenario) }]);
      const repaired = await run(entry.brief, [
        { candidate: brokenReferenceText(entry.scenario) },
        { candidate: wireText(entry.scenario) },
      ]);
      observations.push(await observationOf(first.result), await observationOf(repaired.result));
    }
    const report = buildComparisonReport(observations);
    expect(report.inputs).toEqual({ reports: 6, groups: 3 });
    expect(new Set(report.groups.map((g) => g.key.briefHash))).toEqual(
      new Set(AUTHORING_CORPUS.map((e) => e.expect.briefHash)),
    );
    for (const group of report.groups) {
      expect(group.evidenceClass).toBe('OFFLINE_SCRIPTED');
      expect(group.samples).toBe(2);
      expect(group.outcomes).toEqual({ reviewRequired: 2, rejected: 0, stopped: 0 });
      expect(group.firstPass).toMatchObject({
        evaluated: 2,
        passed: 1,
        notEvaluated: 0,
        rate: 0.5,
      });
      expect(group.repair).toMatchObject({ attempted: 1, evaluated: 1, succeeded: 1 });
      expect(group.finalValidity).toMatchObject({ evaluated: 2, valid: 2, rate: 1 });
      expect(group.providerRequests).toBe(3);
    }
    // Order independence: reversing the input gives byte-identical output.
    expect(JSON.stringify(buildComparisonReport([...observations].reverse()))).toBe(
      JSON.stringify(report),
    );
  });

  it('files a wrong-brief refusal under the brief it was run with, never the candidate’s', async () => {
    const text = wireText(HARBOUR.scenario);
    const wrong = await run(BLACKOUT.brief, [{ candidate: text }, { candidate: text }]);
    const observation = await observationOf(wrong.result);
    expect(observation).toMatchObject({
      status: 'REJECTED',
      rejectedStage: 'identity',
      repairDisposition: 'attempted',
      group: { briefHash: BLACKOUT.expect.briefHash },
    });

    const right = await run(BLACKOUT.brief, [{ candidate: wireText(BLACKOUT.scenario) }]);
    const report = buildComparisonReport([observation, await observationOf(right.result)]);
    expect(report.inputs.groups).toBe(1);
    expect(report.groups[0]!.key.briefHash).toBe(BLACKOUT.expect.briefHash);
    expect(report.groups[0]!.outcomes).toEqual({ reviewRequired: 1, rejected: 1, stopped: 0 });
    expect(report.groups[0]!.rejectionStages.identity).toBe(1);
  });
});

describe('authoring corpus through exhaustive route review', () => {
  it.each(AUTHORING_CORPUS.map((e) => [e.key, e] as const))(
    'lists every distinct terminal sequence of %s without merging any',
    (_key, entry) => {
      const review = buildRouteReview({ scenario: entry.scenario });
      expect(review.ok).toBe(true);
      if (!review.ok) return;
      const { report } = review;
      expect(report).toMatchObject({
        status: 'REVIEW_REQUIRED',
        approved: false,
        publication: 'NOT_PUBLISHED',
        exhaustive: true,
        candidate: {
          id: entry.scenario.id,
          version: entry.scenario.version,
          hash: entry.expect.candidateHash,
        },
      });
      expect(report.routes.map((r) => r.choices.map((c) => c.id))).toEqual(
        entry.expect.routes.map((r) => [...r.choices]),
      );
      expect(report.routes.map((r) => r.ending.id)).toEqual(
        entry.expect.routes.map((r) => r.endingId),
      );
      expect(report.counts.routes).toBe(entry.expect.routes.length);
      expect(report.counts.endingsReached).toBe(2);
      for (const ending of report.endings) {
        expect(ending.routeCount).toBe(
          entry.expect.routes.filter((r) => r.endingId === ending.id).length,
        );
      }
      for (const route of report.routes) {
        expect(route.chapters).toHaveLength(route.choices.length + 1);
      }
    },
  );

  it('keeps routes that reconverge on one ending separate in the new fixtures', () => {
    for (const entry of NEW_ENTRIES) {
      const review = buildRouteReview({ scenario: entry.scenario });
      if (!review.ok) throw new Error('route review failed');
      expect(Math.max(...review.report.endings.map((e) => e.routeCount))).toBeGreaterThanOrEqual(3);
      // Two routes that end on the same ending show different player-visible text.
      for (const ending of review.report.endings) {
        const texts = ending.routeIndexes.map((index) => {
          const route = review.report.routes[index - 1]!;
          return route.chapters[route.chapters.length - 1]!.narration;
        });
        expect(new Set(texts).size).toBeGreaterThan(1);
      }
    }
  });
});

// ── Isolation from published content ────────────────────────────────────────

describe('authoring corpus stays out of published content', () => {
  const ids = AUTHORING_CORPUS.map((e) => e.scenario.id);

  it('is absent from the registry, catalogue and presentation packs', () => {
    for (const entry of AUTHORING_CORPUS) {
      expect(getScenario(entry.scenario.id, entry.scenario.version)).toBeUndefined();
      expect(isPublishedInRegistry(entry.scenario.id, entry.scenario.version)).toBe(false);
      expect(getPresentationPack(entry.scenario.id, entry.scenario.version)).toBeUndefined();
    }
    for (const id of ids) {
      expect(listScenarioIds()).not.toContain(id);
      expect(getScenarioCatalogue().map((c) => c.scenarioId)).not.toContain(id);
      expect(CATALOGUE_METADATA.map((m) => m.scenarioId)).not.toContain(id);
      expect(listPresentationPacks().map((p) => p.scenarioId)).not.toContain(id);
    }
  });

  it('is not named anywhere in the registry, catalogue or presentation sources', () => {
    const published = [
      ...sourceTexts('interactive/scenarios'),
      ...sourceTexts('interactive/presentation'),
    ].join('\n');
    expect(published.length).toBeGreaterThan(0);
    for (const entry of AUTHORING_CORPUS) {
      expect(published).not.toContain(entry.scenario.id);
      for (const scene of entry.scenario.scenes) expect(published).not.toContain(`"${scene.id}"`);
    }
  });

  it('leaves the mock provider on Last Tram only', async () => {
    const { MockScenarioDraftProvider } = await import('../provider');
    const response = await new MockScenarioDraftProvider().draft({
      kind: 'generate',
      brief: HARBOUR.brief,
      maxOutputTokens: 4000,
      timeoutMs: 1000,
    });
    expect(JSON.parse(response.candidate as string).id).toBe(LAST_TRAM_SCENARIO.id);
  });
});
