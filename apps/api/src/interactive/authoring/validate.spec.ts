import { describe, expect, it, vi } from 'vitest';
import { analyzeScenario } from '../domain/scenario-analysis';
import { LAST_TRAM_BRIEF, LAST_TRAM_SCENARIO } from './the-last-tram';
import { collectAuthoringIssues, findSceneCycle, validateCandidate } from './validate';
import { scenarioToWire, type WireScenario } from './wire';

const wire = (): WireScenario => structuredClone(scenarioToWire(LAST_TRAM_SCENARIO));
const notPublished = () => false;

function check(mutate: (w: WireScenario) => void, analyze?: typeof analyzeScenario) {
  const w = wire();
  mutate(w);
  return validateCandidate(JSON.stringify(w), {
    brief: LAST_TRAM_BRIEF,
    isPublished: notPublished,
    ...(analyze && { analyze }),
  });
}

function failure(outcome: ReturnType<typeof check>) {
  if (outcome.ok) throw new Error('expected a validation failure');
  return outcome;
}

const scene = (w: WireScenario, id: string) => w.scenes.find((s) => s.id === id)!;
const choice = (w: WireScenario, id: string) =>
  w.scenes.flatMap((s) => s.choices).find((c) => c.id === id)!;

describe('validateCandidate: the bundled original episode', () => {
  it('is mechanically valid, with witness routes to both endings', () => {
    const outcome = check(() => undefined);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.scenario).toEqual(LAST_TRAM_SCENARIO);
    expect(outcome.report.analysis.reachableEndings).toEqual(['quiet-repayment', 'report-filed']);
    expect(outcome.report.witnessRoutes.map((r) => r.endingId)).toEqual([
      'quiet-repayment',
      'report-filed',
    ]);
    for (const route of outcome.report.witnessRoutes) {
      expect(route.stepsVerified).toBe(route.choiceIds.length + 1);
      expect(route.sceneIds).toHaveLength(route.choiceIds.length + 1);
    }
    // The quiet ending needs the receipt route (it is the only one that teaches f-hanna-borrowed).
    const quiet = outcome.report.witnessRoutes.find((r) => r.endingId === 'quiet-repayment')!;
    expect(quiet.choiceIds).toContain('c-show-receipt');
    expect(outcome.report.narrationStatesChecked).toBeGreaterThan(5);
  });

  it('accepts an already-parsed object as well as JSON text, with the same hash', () => {
    const asText = check(() => undefined);
    const asObject = validateCandidate(wire(), {
      brief: LAST_TRAM_BRIEF,
      isPublished: notPublished,
    });
    expect(asText.ok && asObject.ok && asText.candidateHash === asObject.candidateHash).toBe(true);
  });

  it('is not registered as published content', () => {
    const real = validateCandidate(JSON.stringify(wire()), { brief: LAST_TRAM_BRIEF });
    expect(real.ok).toBe(true);
  });
});

describe('validateCandidate: candidate format', () => {
  it('rejects malformed JSON', () => {
    const outcome = validateCandidate('{"id": ', { brief: LAST_TRAM_BRIEF });
    expect(failure(outcome as never).stage).toBe('candidate-format');
    expect(outcome.ok === false && outcome.diagnostics[0]?.code).toBe('NOT_JSON');
  });

  it('rejects oversized output without parsing it', () => {
    const outcome = validateCandidate('x'.repeat(70_000), { brief: LAST_TRAM_BRIEF });
    expect(outcome.ok === false && outcome.diagnostics[0]?.code).toBe('RESPONSE_TOO_LARGE');
  });

  it('rejects unknown fields and unknown effect or requirement kinds', () => {
    const unknownField = check((w) => ((w as unknown as Record<string, unknown>)['script'] = 'x'));
    expect(failure(unknownField).stage).toBe('candidate-format');

    const unknownEffect = check((w) => {
      (choice(w, 'c-ask-driver').effects[0] as { kind: string }).kind = 'teleport';
    });
    expect(failure(unknownEffect).stage).toBe('candidate-format');

    const unknownRequirement = check((w) => {
      (choice(w, 'c-open-panel').requires[0] as { kind: string }).kind = 'always';
    });
    expect(failure(unknownRequirement).stage).toBe('candidate-format');
  });

  it('rejects duplicate NPC knowledge entries instead of overwriting them', () => {
    const outcome = check((w) => {
      w.initialNpcKnowledge.push({ characterId: 'hanna', factIds: [] });
    });
    expect(failure(outcome).diagnostics.map((d) => d.code)).toContain('DUPLICATE_ENTRY');
  });

  it('rejects duplicate ids inside id lists', () => {
    const outcome = check((w) => {
      w.initialPlayerKnowledge.push('f-box-missing');
    });
    expect(failure(outcome).diagnostics.map((d) => d.code)).toContain('DUPLICATE_ENTRY');
  });

  it('rejects a character on a non-npcLearns effect and a missing npcLearns character', () => {
    const extra = check((w) => {
      choice(w, 'c-ask-driver').effects[0]!.character = 'wiktor';
    });
    expect(failure(extra).diagnostics.map((d) => d.code)).toContain('EFFECT_CHARACTER');
    const missing = check((w) => {
      const npc = choice(w, 'c-show-receipt').effects.find((e) => e.kind === 'npcLearns')!;
      npc.character = null;
    });
    expect(failure(missing).diagnostics.map((d) => d.code)).toContain('EFFECT_CHARACTER');
  });
});

describe('validateCandidate: identity', () => {
  it('rejects provider output that changes the candidate id or version', () => {
    expect(failure(check((w) => (w.id = 'warsaw-other'))).stage).toBe('identity');
    expect(failure(check((w) => (w.version = 2))).stage).toBe('identity');
  });

  it('rejects changed characters or endings', () => {
    const characters = check((w) => (w.characters[0]!.isPlayer = false));
    expect(failure(characters).diagnostics.map((d) => d.code)).toContain(
      'BRIEF_CHARACTERS_MISMATCH',
    );
    const endings = check((w) => (w.endings[0]!.id = 'something-else'));
    expect(failure(endings).diagnostics.map((d) => d.code)).toContain('BRIEF_ENDINGS_MISMATCH');
  });

  it('refuses an identity already published in the registry', () => {
    const outcome = validateCandidate(JSON.stringify(wire()), {
      brief: LAST_TRAM_BRIEF,
      isPublished: () => true,
    });
    expect(outcome.ok === false && outcome.diagnostics.map((d) => d.code)).toContain(
      'IDENTITY_ALREADY_PUBLISHED',
    );
  });
});

describe('validateCandidate: existing strict definition checks', () => {
  it('rejects duplicate ids', () => {
    const outcome = check((w) => {
      w.scenes[1]!.id = w.scenes[0]!.id;
    });
    expect(failure(outcome).stage).toBe('definition');
  });

  it('rejects unresolved references', () => {
    const outcome = check((w) => {
      choice(w, 'c-leave-cab').to = 's-missing';
    });
    const failed = failure(outcome);
    expect(failed.stage).toBe('definition');
    expect(failed.diagnostics.some((d) => d.message.includes('s-missing'))).toBe(true);
  });

  it('rejects malformed identifiers', () => {
    expect(failure(check((w) => (w.facts[0]!.id = 'Not Kebab'))).stage).toBe('definition');
  });
});

describe('validateCandidate: authoring constraints', () => {
  it('requires exactly three decision points', () => {
    const outcome = check((w) => {
      // Give the single-choice cab scene a second option: four decision points.
      scene(w, 's-cab').choices.push({
        id: 'c-extra',
        label: 'Linger in the cab',
        to: 's-midline',
        requires: [],
        effects: [],
      });
    });
    const failed = failure(outcome);
    expect(failed.stage).toBe('authoring-constraints');
    expect(failed.diagnostics.map((d) => d.code)).toContain('DECISION_POINTS');
  });

  it('rejects a cyclic scene graph BEFORE exhaustive exploration', () => {
    const analyze = vi.fn(analyzeScenario);
    const outcome = check((w) => {
      scene(w, 's-terminus').choices.push({
        id: 'c-ride-again',
        label: 'Ride the loop once more',
        to: 's-boarding',
        requires: [],
        effects: [],
      });
    }, analyze);
    const failed = failure(outcome);
    expect(failed.stage).toBe('authoring-constraints');
    expect(failed.diagnostics.map((d) => d.code)).toContain('SCENE_GRAPH_CYCLE');
    expect(analyze).not.toHaveBeenCalled();
  });

  it('finds cycles, including a self-loop, and reports none for the episode', () => {
    expect(findSceneCycle(LAST_TRAM_SCENARIO)).toBeNull();
    const looped = structuredClone(LAST_TRAM_SCENARIO);
    looped.scenes[1]!.choices[0]!.to = looped.scenes[1]!.id;
    expect(findSceneCycle(looped)).toEqual(['s-cab', 's-cab']);
    expect(collectAuthoringIssues(LAST_TRAM_SCENARIO)).toEqual([]);
  });

  it('rejects more facts than the authoring format allows', () => {
    const outcome = check((w) => {
      for (let i = 0; i < 14; i += 1) w.facts.push({ id: `f-pad-${i}`, text: 'x'.repeat(160) });
    });
    expect(failure(outcome).diagnostics.map((d) => d.code)).toContain('FACT_COUNT');
  });
});

describe('validateCandidate: existing exhaustive play analysis', () => {
  it('rejects an unreachable ending and a choice that is never available', () => {
    const outcome = check((w) => {
      // Holding both the key and the receipt is impossible: the routes are exclusive.
      choice(w, 'c-let-hanna-repay').requires.push(
        { kind: 'hasItem', ref: 'service-key' },
        { kind: 'hasItem', ref: 'torn-receipt' },
      );
    });
    const failed = failure(outcome);
    expect(failed.stage).toBe('play-analysis');
    const messages = failed.diagnostics.map((d) => d.message).join('\n');
    expect(messages).toContain('"quiet-repayment" is not reachable by play');
    expect(messages).toContain('choice "c-let-hanna-repay" is never available');
  });

  it('rejects a usable-choice violation on its own', () => {
    const outcome = check((w) => {
      choice(w, 'c-wait-for-terminus').requires.push(
        { kind: 'notFlag', ref: 'asked-driver' },
        { kind: 'notFlag', ref: 'searched-carriage' },
      );
    });
    const failed = failure(outcome);
    expect(failed.stage).toBe('play-analysis');
    expect(failed.diagnostics.map((d) => d.message)).toContain(
      'choice "c-wait-for-terminus" is never available',
    );
  });

  it('rejects a reachable dead end', () => {
    const outcome = check((w) => {
      choice(w, 'c-show-receipt').requires.push({ kind: 'playerKnows', ref: 'f-box-under-panel' });
      choice(w, 'c-wait-for-terminus').requires.push({ kind: 'notFlag', ref: 'searched-carriage' });
    });
    const failed = failure(outcome);
    expect(failed.stage).toBe('play-analysis');
    expect(failed.diagnostics.map((d) => d.message)).toContain(
      'dead end: no available choice in scene "s-midline"',
    );
  });

  it('rejects declared speaker knowledge violations', () => {
    const outcome = check((w) => {
      scene(w, 's-cab').narration.find((t) => t.id === 't-cab-saw-hanna')!.speakerId = 'hanna';
    });
    const failed = failure(outcome);
    expect(failed.stage).toBe('play-analysis');
    expect(failed.diagnostics[0]?.message).toContain('"hanna" voices "f-driver-saw-hanna"');
  });
});

describe('validateCandidate: witness routes and canonical narration', () => {
  it('rejects candidates whose canonical narration cannot be accepted at runtime', () => {
    const outcome = check((w) => {
      // Five 600-character templates render to > 2400 characters, which the runtime
      // narration contract refuses; static analysis does not look at rendered length.
      const entry = scene(w, 's-boarding');
      entry.narration = Array.from({ length: 5 }, (_, i) => ({
        id: `t-long-${i}`,
        text: 'a'.repeat(600),
        speakerId: null,
        factIds: [],
        when: [],
      }));
    });
    const failed = failure(outcome);
    expect(failed.stage).toBe('witness-routes');
    expect(failed.diagnostics.map((d) => d.code)).toContain('NARRATION_MALFORMED');
  });

  it('bounds the number and length of diagnostics', () => {
    const outcome = check((w) => {
      for (const [i, s] of w.scenes.entries()) {
        for (let j = 0; s.choices.length < 5; j += 1) {
          s.choices.push({
            id: `c-pad-${i}-${j}`,
            label: 'x',
            to: `s-nowhere-${i}-${j}-${'z'.repeat(300)}`,
            requires: [],
            effects: [],
          });
        }
      }
    });
    const failed = failure(outcome);
    expect(failed.diagnostics).toHaveLength(25);
    expect(failed.droppedDiagnostics).toBeGreaterThan(0);
    expect(failed.diagnostics.every((d) => d.message.length <= 240)).toBe(true);
  });
});
