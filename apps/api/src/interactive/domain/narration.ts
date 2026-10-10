import { z } from 'zod';
import { requirementsHold, speakerKnows, findScene } from './engine';
import type { NarrationTemplate, ScenarioDefinition } from './scenario-schema';
import { hashState, type InteractiveState } from './state';

/**
 * Closed narration contract. A narrator may only choose approved template ids
 * for the current scene; the text must equal the trusted rendering of those
 * templates for the supplied state. This guarantees (and only guarantees):
 *   - identity: the narration belongs to this scenario version, scene and state;
 *   - closed vocabulary: only approved templates, speakers and facts appear;
 *   - speaker knowledge: nobody voices a fact they have not learned;
 *   - verbatim text: the prose is exactly the approved template text.
 * It does NOT attempt to detect contradictions in arbitrary free text.
 */

export const MAX_NARRATION_TEXT_LENGTH = 2400;
export const MAX_NARRATION_ITEMS = 12;

export interface Utterance {
  speakerId: string;
  factId: string;
}

export interface NarrationOutput {
  scenarioId: string;
  scenarioVersion: number;
  sceneId: string;
  /** Hash of the state this narration describes. */
  stateHash: string;
  templateIds: string[];
  utterances: Utterance[];
  text: string;
}

const identifier = z.string().min(1).max(64);
export const narrationOutputSchema = z
  .object({
    scenarioId: identifier,
    scenarioVersion: z.number().int(),
    sceneId: identifier,
    stateHash: z.string().length(64),
    templateIds: z.array(identifier).min(1).max(MAX_NARRATION_ITEMS),
    utterances: z
      .array(z.object({ speakerId: identifier, factId: identifier }).strict())
      .max(MAX_NARRATION_ITEMS),
    text: z.string().min(1).max(MAX_NARRATION_TEXT_LENGTH),
  })
  .strict();

export type NarrationRejectionCode =
  | 'NARRATION_MALFORMED'
  | 'NARRATION_BINDING_MISMATCH'
  | 'NARRATION_UNKNOWN_TEMPLATE'
  | 'NARRATION_UNKNOWN_SPEAKER'
  | 'NARRATION_UNKNOWN_FACT'
  | 'NARRATION_KNOWLEDGE_UNAVAILABLE'
  | 'NARRATION_TEMPLATE_MISMATCH'
  | 'NARRATION_UTTERANCE_MISMATCH'
  | 'NARRATION_TEXT_MISMATCH';

export type NarrationValidation =
  { ok: true; narration: NarrationOutput } | { ok: false; code: NarrationRejectionCode };

/** Templates of the current scene whose conditions hold, in declaration order. */
export function selectTemplates(
  scenario: ScenarioDefinition,
  state: InteractiveState,
): NarrationTemplate[] {
  return findScene(scenario, state.sceneId).narration.filter((template) =>
    requirementsHold(state, template.when),
  );
}

export function renderTemplates(templates: readonly NarrationTemplate[]): string {
  return templates.map((t) => t.text).join(' ');
}

function utterancesOf(templates: readonly NarrationTemplate[]): Utterance[] {
  return templates.flatMap((t) =>
    (t.factIds ?? []).map((factId) => ({ speakerId: t.speakerId!, factId })),
  );
}

/** The one narration the trusted rendering accepts for this state. */
export function buildCanonicalNarration(
  scenario: ScenarioDefinition,
  state: InteractiveState,
): NarrationOutput {
  const templates = selectTemplates(scenario, state);
  return {
    scenarioId: scenario.id,
    scenarioVersion: scenario.version,
    sceneId: state.sceneId,
    stateHash: hashState(state),
    templateIds: templates.map((t) => t.id),
    utterances: utterancesOf(templates),
    text: renderTemplates(templates),
  };
}

/** Validates untrusted narrator output against the trusted rendering for `state`. */
export function validateNarration(
  output: unknown,
  scenario: ScenarioDefinition,
  state: InteractiveState,
): NarrationValidation {
  const reject = (code: NarrationRejectionCode): NarrationValidation => ({ ok: false, code });

  const parsed = narrationOutputSchema.safeParse(output);
  if (!parsed.success) return reject('NARRATION_MALFORMED');
  const narration = parsed.data;

  if (
    narration.scenarioId !== scenario.id ||
    narration.scenarioVersion !== scenario.version ||
    narration.sceneId !== state.sceneId ||
    narration.stateHash !== hashState(state)
  ) {
    return reject('NARRATION_BINDING_MISMATCH');
  }

  const knownTemplates = new Set(scenario.scenes.flatMap((s) => s.narration.map((t) => t.id)));
  if (narration.templateIds.some((id) => !knownTemplates.has(id))) {
    return reject('NARRATION_UNKNOWN_TEMPLATE');
  }
  const characters = new Set(scenario.characters.map((c) => c.id));
  if (narration.utterances.some((u) => !characters.has(u.speakerId))) {
    return reject('NARRATION_UNKNOWN_SPEAKER');
  }
  const facts = new Set(scenario.facts.map((f) => f.id));
  if (narration.utterances.some((u) => !facts.has(u.factId))) {
    return reject('NARRATION_UNKNOWN_FACT');
  }
  if (narration.utterances.some((u) => !speakerKnows(state, scenario, u.speakerId, u.factId))) {
    return reject('NARRATION_KNOWLEDGE_UNAVAILABLE');
  }

  const expected = selectTemplates(scenario, state);
  const sameTemplates =
    expected.length === narration.templateIds.length &&
    expected.every((t, i) => t.id === narration.templateIds[i]);
  if (!sameTemplates) return reject('NARRATION_TEMPLATE_MISMATCH');

  const expectedUtterances = utterancesOf(expected);
  const sameUtterances =
    expectedUtterances.length === narration.utterances.length &&
    expectedUtterances.every(
      (u, i) =>
        u.speakerId === narration.utterances[i]!.speakerId &&
        u.factId === narration.utterances[i]!.factId,
    );
  if (!sameUtterances) return reject('NARRATION_UTTERANCE_MISMATCH');

  if (narration.text !== renderTemplates(expected)) return reject('NARRATION_TEXT_MISMATCH');
  return { ok: true, narration };
}
