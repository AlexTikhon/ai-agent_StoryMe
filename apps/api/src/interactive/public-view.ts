import { z } from 'zod';
import { availableChoices, findScene } from './domain/engine';
import type { NarrationOutput } from './domain/narration';
import type { ScenarioDefinition } from './domain/scenario-schema';
import type { InteractiveState } from './domain/state';

/**
 * The only shape ever returned to clients (and the shape persisted on each
 * event). It is built from an explicit allow-list: NPC knowledge, internal
 * flags, event payloads, state hashes, future scenes and narration validation
 * evidence are never copied into it.
 */
export const publicSessionViewSchema = z
  .object({
    sessionId: z.string(),
    revision: z.number().int().min(0),
    scenarioId: z.string(),
    scenarioVersion: z.number().int(),
    scene: z.object({ id: z.string(), title: z.string() }).strict(),
    narration: z.string(),
    choices: z.array(z.object({ id: z.string(), label: z.string() }).strict()),
    player: z
      .object({
        knowledge: z.array(z.object({ id: z.string(), text: z.string() }).strict()),
        inventory: z.array(z.object({ id: z.string(), name: z.string() }).strict()),
      })
      .strict(),
    status: z.enum(['in_progress', 'ended']),
    ending: z
      .object({ id: z.string(), title: z.string(), summary: z.string() })
      .strict()
      .nullable(),
  })
  .strict();

export type PublicSessionView = z.infer<typeof publicSessionViewSchema>;

export function buildPublicView(input: {
  sessionId: string;
  scenario: ScenarioDefinition;
  state: InteractiveState;
  narration: NarrationOutput;
}): PublicSessionView {
  const { sessionId, scenario, state, narration } = input;
  const scene = findScene(scenario, state.sceneId);
  const ending = state.endingId
    ? (scenario.endings.find((e) => e.id === state.endingId) ?? null)
    : null;
  return {
    sessionId,
    revision: state.revision,
    scenarioId: scenario.id,
    scenarioVersion: scenario.version,
    scene: { id: scene.id, title: scene.title },
    narration: narration.text,
    choices: availableChoices(state, scenario).map((c) => ({ id: c.id, label: c.label })),
    player: {
      knowledge: scenario.facts
        .filter((f) => state.playerKnowledge.includes(f.id))
        .map((f) => ({ id: f.id, text: f.text })),
      inventory: scenario.items
        .filter((i) => state.inventory.includes(i.id))
        .map((i) => ({ id: i.id, name: i.name })),
    },
    status: ending ? 'ended' : 'in_progress',
    ending: ending ? { id: ending.id, title: ending.title, summary: ending.summary } : null,
  };
}
