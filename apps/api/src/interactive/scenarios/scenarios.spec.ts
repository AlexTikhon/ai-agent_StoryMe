import { describe, expect, it } from 'vitest';
import { analyzeScenario } from '../domain/scenario-analysis';
import {
  collectStructuralIssues,
  hashScenarioDefinition,
  parseScenarioDefinition,
  ScenarioValidationError,
  type ScenarioDefinition,
} from '../domain/scenario-schema';
import raw from './warsaw-last-delivery.v1.json';
import { getLatestScenario, getScenario, loadScenario, WARSAW_LAST_DELIVERY_V1 } from './index';

function clone(): ScenarioDefinition {
  return JSON.parse(JSON.stringify(raw)) as ScenarioDefinition;
}

function issuesOf(mutate: (s: ScenarioDefinition) => void): string[] {
  const copy = clone();
  mutate(copy);
  try {
    loadScenario(copy);
  } catch (error) {
    if (error instanceof ScenarioValidationError) return error.issues;
    throw error;
  }
  return [];
}

describe('warsaw-last-delivery v1', () => {
  const scenario = WARSAW_LAST_DELIVERY_V1;

  it('has the specified shape', () => {
    expect(scenario).toMatchObject({ id: 'warsaw-last-delivery', version: 1, language: 'en' });
    expect(scenario.characters).toHaveLength(3);
    expect(scenario.scenes.length).toBeGreaterThanOrEqual(6);
    expect(scenario.scenes.length).toBeLessThanOrEqual(8);
    expect(scenario.endings).toHaveLength(2);
    const decisionPoints = scenario.scenes.filter((s) => s.choices.length >= 2);
    expect(decisionPoints.map((s) => s.id)).toEqual(['s-courtyard', 's-door', 's-cellar']);
  });

  it('is fully playable: both endings reachable, no dead ends, no unused choices', () => {
    const analysis = analyzeScenario(scenario);
    expect(analysis.issues).toEqual([]);
    expect(analysis.reachableEndings).toEqual(['ledger-exposed', 'quiet-delivery']);
    expect(analysis.usedChoiceIds).toHaveLength(scenario.scenes.flatMap((s) => s.choices).length);
  });

  it('is served from a registry by exact version and by latest', () => {
    expect(getScenario('warsaw-last-delivery', 1)).toBe(scenario);
    expect(getScenario('warsaw-last-delivery', 2)).toBeUndefined();
    expect(getLatestScenario('warsaw-last-delivery')).toBe(scenario);
    expect(getLatestScenario('nope')).toBeUndefined();
  });

  it('hashes its definition stably and detects any content change', () => {
    const hash = hashScenarioDefinition(scenario);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashScenarioDefinition(parseScenarioDefinition(clone()))).toBe(hash);
    const edited = clone();
    edited['scenes'][0].title = 'Edited';
    expect(hashScenarioDefinition(parseScenarioDefinition(edited))).not.toBe(hash);
  });
});

describe('scenario validation', () => {
  it('rejects unknown fields and executable-looking content (closed vocabulary)', () => {
    expect(
      issuesOf((s) => ((s as Record<string, unknown>)['script'] = 'process.exit(1)')).length,
    ).toBeGreaterThan(0);
    expect(
      issuesOf((s) =>
        s['scenes'][0].choices[0].effects.push({ kind: 'eval', code: '1+1' } as never),
      ).length,
    ).toBeGreaterThan(0);
    expect(
      issuesOf(
        (s) => (s['scenes'][0].choices[0].requires = [{ kind: 'expr', expr: 'true' } as never]),
      ).length,
    ).toBeGreaterThan(0);
  });

  it('rejects malformed identifiers', () => {
    expect(issuesOf((s) => (s['scenes'][0].id = 'Bad Id')).length).toBeGreaterThan(0);
  });

  it('rejects dangling scene, fact, item, flag and ending references', () => {
    expect(issuesOf((s) => (s['scenes'][0].choices[0].to = 'nowhere'))).toContain(
      'choice "c-ask-caretaker": unknown target scene "nowhere"',
    );
    expect(
      issuesOf(
        (s) => (s['scenes'][0].choices[0].requires = [{ kind: 'playerKnows', fact: 'f-x' }]),
      ),
    ).toContain('choice "c-ask-caretaker": unknown fact "f-x"');
    expect(
      issuesOf((s) => s['scenes'][0].choices[0].effects.push({ kind: 'giveItem', item: 'i-x' })),
    ).toContain('choice "c-ask-caretaker": unknown item "i-x"');
    expect(
      issuesOf((s) => s['scenes'][0].choices[0].effects.push({ kind: 'setFlag', flag: 'f-x' })),
    ).toContain('choice "c-ask-caretaker": unknown flag "f-x"');
    expect(issuesOf((s) => (s['scenes'][6].endingId = 'nope'))).toContain(
      'scene "s-end-quiet": unknown ending "nope"',
    );
  });

  it('rejects an unknown entry scene, duplicate ids and a missing player character', () => {
    expect(issuesOf((s) => (s['entrySceneId'] = 'ghost'))).toContain('unknown entry scene "ghost"');
    expect(issuesOf((s) => s['scenes'].push({ ...s['scenes'][0] }))).toContain(
      'duplicate scene id "s-courtyard"',
    );
    expect(issuesOf((s) => (s['characters'][0].isPlayer = false))).toContain(
      'exactly one character must be the player character',
    );
  });

  it('rejects terminal scenes with choices and non-terminal scenes without', () => {
    expect(
      issuesOf((s) => (s['scenes'][7].choices = [{ ...s['scenes'][1].choices[0] }])),
    ).toContain('terminal scene "s-end-exposed" must have no choices');
    expect(issuesOf((s) => (s['scenes'][1].choices = []))).toContain(
      'non-terminal scene "s-caretaker" has no choices',
    );
  });

  it('rejects unreachable scenes and scenes that cannot reach an ending', () => {
    expect(
      issuesOf((s) =>
        s['scenes'].push({ ...s['scenes'][7]!, id: 's-orphan', endingId: 'quiet-delivery' }),
      ),
    ).toContain('scene "s-orphan" is unreachable from the entry scene');
    expect(issuesOf((s) => (s['scenes'][1].choices[0].to = 's-caretaker'))).toContain(
      'scene "s-caretaker" cannot reach any ending',
    );
  });

  it('rejects consuming an item that is not one-time', () => {
    expect(
      issuesOf((s) =>
        s['scenes'][0].choices[0].effects.push({ kind: 'consumeItem', item: 'ledger-page' }),
      ),
    ).toContain('choice "c-ask-caretaker": cannot consume non-one-time item "ledger-page"');
  });

  it('rejects scenarios whose prerequisites can never be met (play analysis)', () => {
    // Nothing ever grants the card, so c-use-card is unusable and its scene unreachable by play.
    const issues = issuesOf((s) => {
      s['scenes'][0].choices[0].effects = s['scenes'][0].choices[0].effects.filter(
        (e) => e.kind !== 'giveItem',
      );
    });
    expect(issues).toContain('choice "c-use-card" is never available');
  });

  it('rejects narration where a speaker voices a fact they cannot know', () => {
    const issues = issuesOf((s) => {
      s['initial'].npcKnowledge.ines = ['f-ines-altered-ledger', 'f-tomasz-in-cellar'];
    });
    expect(issues.join('\n')).toContain('"ines" voices "f-gone-two-days" without knowing it');
  });

  it('rejects a reachable dead end (no available choice)', () => {
    const issues = issuesOf((s) => {
      s['scenes'][3].choices = s['scenes'][3].choices.filter((c) => c.id === 'c-use-card');
    });
    expect(issues.join('\n')).toContain('dead end: no available choice in scene "s-door"');
  });

  it('keeps the exported definition typed (not an unchecked JSON cast)', () => {
    const typed: ScenarioDefinition = parseScenarioDefinition(clone());
    expect(collectStructuralIssues(typed)).toEqual([]);
  });
});
