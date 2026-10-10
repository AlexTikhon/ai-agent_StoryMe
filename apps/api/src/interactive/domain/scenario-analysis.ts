import { applyChoice, availableChoices, speakerKnows } from './engine';
import { selectTemplates } from './narration';
import type { ScenarioDefinition } from './scenario-schema';
import { createInitialState, hashState, type InteractiveState } from './state';

/**
 * Exhaustive, bounded exploration of every state a player can actually reach
 * using the real transition rules. It proves what static graph checks cannot:
 * prerequisites are satisfiable, no reachable state is a dead end, every
 * ending and every choice is usable, and the scenario never narrates a fact
 * for a speaker who has not learned it.
 */

export const MAX_EXPLORED_STATES = 5_000;

export interface ScenarioAnalysis {
  reachableStateCount: number;
  reachableEndings: string[];
  usedChoiceIds: string[];
  issues: string[];
}

export function analyzeScenario(scenario: ScenarioDefinition): ScenarioAnalysis {
  const issues: string[] = [];
  const seen = new Set<string>();
  const endings = new Set<string>();
  const usedChoices = new Set<string>();
  const queue: InteractiveState[] = [createInitialState(scenario)];
  seen.add(hashState(queue[0]!));

  while (queue.length > 0) {
    const state = queue.shift()!;

    const templates = selectTemplates(scenario, state);
    if (templates.length === 0) {
      issues.push(`scene "${state.sceneId}" has no narration for a reachable state`);
    }
    for (const template of templates) {
      for (const factId of template.factIds ?? []) {
        if (!speakerKnows(state, scenario, template.speakerId!, factId)) {
          issues.push(
            `template "${template.id}": "${template.speakerId}" voices "${factId}" without knowing it`,
          );
        }
      }
    }

    if (state.endingId !== null) {
      endings.add(state.endingId);
      continue;
    }
    const choices = availableChoices(state, scenario);
    if (choices.length === 0) {
      issues.push(`dead end: no available choice in scene "${state.sceneId}"`);
      continue;
    }
    for (const choice of choices) {
      usedChoices.add(choice.id);
      const next = applyChoice(state, choice.id, scenario).state;
      const key = hashState(next);
      if (seen.has(key)) continue;
      if (seen.size >= MAX_EXPLORED_STATES) {
        issues.push(`state space exceeds ${MAX_EXPLORED_STATES} states`);
        return finish();
      }
      seen.add(key);
      queue.push(next);
    }
  }
  return finish();

  function finish(): ScenarioAnalysis {
    for (const ending of scenario.endings) {
      if (!endings.has(ending.id)) issues.push(`ending "${ending.id}" is not reachable by play`);
    }
    for (const choice of scenario.scenes.flatMap((s) => s.choices)) {
      if (!usedChoices.has(choice.id)) issues.push(`choice "${choice.id}" is never available`);
    }
    return {
      reachableStateCount: seen.size,
      reachableEndings: [...endings].sort(),
      usedChoiceIds: [...usedChoices].sort(),
      issues: [...new Set(issues)],
    };
  }
}
