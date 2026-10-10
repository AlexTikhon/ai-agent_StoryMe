import { z } from 'zod';
import { canonicalHash } from './canonical';

/**
 * Immutable scenario/world definition. Everything here is declarative data:
 * requirements and effects are closed discriminated unions, never expressions
 * or scripts. A definition is validated at load time and never mutated.
 */

const identifier = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,62}$/, 'must be a lowercase kebab-case identifier (max 63 chars)');
const shortText = z.string().min(1).max(160);
const narrationText = z.string().min(1).max(600);

const requirementSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('playerKnows'), fact: identifier }).strict(),
  z.object({ kind: z.literal('hasItem'), item: identifier }).strict(),
  z.object({ kind: z.literal('flag'), flag: identifier }).strict(),
  z.object({ kind: z.literal('notFlag'), flag: identifier }).strict(),
]);

const effectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('learnFact'), fact: identifier }).strict(),
  z.object({ kind: z.literal('npcLearns'), character: identifier, fact: identifier }).strict(),
  z.object({ kind: z.literal('giveItem'), item: identifier }).strict(),
  z.object({ kind: z.literal('consumeItem'), item: identifier }).strict(),
  z.object({ kind: z.literal('setFlag'), flag: identifier }).strict(),
]);

const characterSchema = z
  .object({
    id: identifier,
    name: shortText,
    role: shortText,
    isPlayer: z.boolean(),
  })
  .strict();

const factSchema = z.object({ id: identifier, text: shortText }).strict();
const itemSchema = z
  .object({
    id: identifier,
    name: shortText,
    /** A one-time item can be consumed exactly once and never regained. */
    oneTime: z.boolean(),
  })
  .strict();

const templateSchema = z
  .object({
    id: identifier,
    text: narrationText,
    /** Character voicing this template, if any. */
    speakerId: identifier.optional(),
    /** Facts the speaker asserts; the speaker must know every one of them. */
    factIds: z.array(identifier).max(4).optional(),
    /** Template is used only while every requirement holds. */
    when: z.array(requirementSchema).max(4).optional(),
  })
  .strict();

const choiceSchema = z
  .object({
    id: identifier,
    label: shortText,
    to: identifier,
    requires: z.array(requirementSchema).max(6).optional(),
    effects: z.array(effectSchema).max(8),
  })
  .strict();

const sceneSchema = z
  .object({
    id: identifier,
    title: shortText,
    narration: z.array(templateSchema).min(1).max(8),
    choices: z.array(choiceSchema).max(4),
    /** Set on terminal scenes only. */
    endingId: identifier.optional(),
  })
  .strict();

const endingSchema = z
  .object({ id: identifier, title: shortText, summary: narrationText })
  .strict();

export const scenarioDefinitionSchema = z
  .object({
    id: identifier,
    version: z.number().int().min(1).max(1000),
    language: z.literal('en'),
    title: shortText,
    entrySceneId: identifier,
    characters: z.array(characterSchema).min(1).max(8),
    facts: z.array(factSchema).max(40),
    items: z.array(itemSchema).max(20),
    flags: z.array(identifier).max(40),
    initial: z
      .object({
        playerKnowledge: z.array(identifier),
        npcKnowledge: z.record(identifier, z.array(identifier)),
        inventory: z.array(identifier),
      })
      .strict(),
    scenes: z.array(sceneSchema).min(2).max(24),
    endings: z.array(endingSchema).min(1).max(8),
  })
  .strict();

export type Requirement = z.infer<typeof requirementSchema>;
export type Effect = z.infer<typeof effectSchema>;
export type CharacterDefinition = z.infer<typeof characterSchema>;
export type FactDefinition = z.infer<typeof factSchema>;
export type ItemDefinition = z.infer<typeof itemSchema>;
export type NarrationTemplate = z.infer<typeof templateSchema>;
export type ChoiceDefinition = z.infer<typeof choiceSchema>;
export type SceneDefinition = z.infer<typeof sceneSchema>;
export type EndingDefinition = z.infer<typeof endingSchema>;
export type ScenarioDefinition = z.infer<typeof scenarioDefinitionSchema>;

export class ScenarioValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid scenario definition: ${issues.join('; ')}`);
    this.name = 'ScenarioValidationError';
  }
}

function duplicates(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const id of ids) (seen.has(id) ? dup : seen).add(id);
  return [...dup];
}

/** Structural checks spanning more than one field: references, unique ids, graph shape. */
export function collectStructuralIssues(def: ScenarioDefinition): string[] {
  const issues: string[] = [];
  const unique = (label: string, ids: string[]) => {
    for (const id of duplicates(ids)) issues.push(`duplicate ${label} id "${id}"`);
  };
  unique(
    'character',
    def.characters.map((c) => c.id),
  );
  unique(
    'fact',
    def.facts.map((f) => f.id),
  );
  unique(
    'item',
    def.items.map((i) => i.id),
  );
  unique('flag', def.flags);
  unique(
    'scene',
    def.scenes.map((s) => s.id),
  );
  unique(
    'ending',
    def.endings.map((e) => e.id),
  );
  unique(
    'template',
    def.scenes.flatMap((s) => s.narration.map((t) => t.id)),
  );
  unique(
    'choice',
    def.scenes.flatMap((s) => s.choices.map((c) => c.id)),
  );

  const characters = new Map(def.characters.map((c) => [c.id, c]));
  const facts = new Set(def.facts.map((f) => f.id));
  const items = new Map(def.items.map((i) => [i.id, i]));
  const flags = new Set(def.flags);
  const scenes = new Map(def.scenes.map((s) => [s.id, s]));
  const endings = new Set(def.endings.map((e) => e.id));

  if (def.characters.filter((c) => c.isPlayer).length !== 1) {
    issues.push('exactly one character must be the player character');
  }

  const checkRequirement = (where: string, r: Requirement) => {
    if (r.kind === 'playerKnows' && !facts.has(r.fact)) {
      issues.push(`${where}: unknown fact "${r.fact}"`);
    }
    if (r.kind === 'hasItem' && !items.has(r.item)) {
      issues.push(`${where}: unknown item "${r.item}"`);
    }
    if ((r.kind === 'flag' || r.kind === 'notFlag') && !flags.has(r.flag)) {
      issues.push(`${where}: unknown flag "${r.flag}"`);
    }
  };
  const checkEffect = (where: string, e: Effect) => {
    if (e.kind === 'learnFact' && !facts.has(e.fact)) {
      issues.push(`${where}: unknown fact "${e.fact}"`);
    }
    if (e.kind === 'npcLearns') {
      const character = characters.get(e.character);
      if (!character || character.isPlayer) issues.push(`${where}: "${e.character}" is not an NPC`);
      if (!facts.has(e.fact)) issues.push(`${where}: unknown fact "${e.fact}"`);
    }
    if (e.kind === 'giveItem' && !items.has(e.item)) {
      issues.push(`${where}: unknown item "${e.item}"`);
    }
    if (e.kind === 'consumeItem') {
      const item = items.get(e.item);
      if (!item) issues.push(`${where}: unknown item "${e.item}"`);
      else if (!item.oneTime) issues.push(`${where}: cannot consume non-one-time item "${e.item}"`);
    }
    if (e.kind === 'setFlag' && !flags.has(e.flag)) {
      issues.push(`${where}: unknown flag "${e.flag}"`);
    }
  };

  for (const fact of def.initial.playerKnowledge) {
    if (!facts.has(fact)) issues.push(`initial: unknown player fact "${fact}"`);
  }
  for (const [characterId, known] of Object.entries(def.initial.npcKnowledge)) {
    const character = characters.get(characterId);
    if (!character || character.isPlayer) issues.push(`initial: "${characterId}" is not an NPC`);
    for (const fact of known) {
      if (!facts.has(fact)) issues.push(`initial: unknown fact "${fact}" for "${characterId}"`);
    }
  }
  for (const item of def.initial.inventory) {
    if (!items.has(item)) issues.push(`initial: unknown item "${item}"`);
  }

  if (!scenes.has(def.entrySceneId)) issues.push(`unknown entry scene "${def.entrySceneId}"`);

  const referencedEndings = new Set<string>();
  for (const scene of def.scenes) {
    for (const template of scene.narration) {
      const where = `template "${template.id}"`;
      template.when?.forEach((r) => checkRequirement(where, r));
      if (template.factIds?.length && !template.speakerId) {
        issues.push(`${where}: facts require a speaker`);
      }
      if (template.speakerId && !characters.has(template.speakerId)) {
        issues.push(`${where}: unknown speaker "${template.speakerId}"`);
      }
      for (const fact of template.factIds ?? []) {
        if (!facts.has(fact)) issues.push(`${where}: unknown fact "${fact}"`);
      }
    }
    if (scene.endingId !== undefined) {
      referencedEndings.add(scene.endingId);
      if (!endings.has(scene.endingId)) {
        issues.push(`scene "${scene.id}": unknown ending "${scene.endingId}"`);
      }
      if (scene.choices.length > 0) {
        issues.push(`terminal scene "${scene.id}" must have no choices`);
      }
    } else if (scene.choices.length === 0) {
      issues.push(`non-terminal scene "${scene.id}" has no choices`);
    }
    for (const choice of scene.choices) {
      const where = `choice "${choice.id}"`;
      if (!scenes.has(choice.to)) issues.push(`${where}: unknown target scene "${choice.to}"`);
      choice.requires?.forEach((r) => checkRequirement(where, r));
      choice.effects.forEach((e) => checkEffect(where, e));
    }
  }
  for (const ending of endings) {
    if (!referencedEndings.has(ending)) {
      issues.push(`ending "${ending}" is not used by a terminal scene`);
    }
  }

  // Graph reachability from the entry scene; every scene must also reach an ending.
  if (scenes.has(def.entrySceneId)) {
    const reachable = new Set<string>([def.entrySceneId]);
    const queue = [def.entrySceneId];
    while (queue.length > 0) {
      for (const choice of scenes.get(queue.shift()!)?.choices ?? []) {
        if (scenes.has(choice.to) && !reachable.has(choice.to)) {
          reachable.add(choice.to);
          queue.push(choice.to);
        }
      }
    }
    for (const scene of def.scenes) {
      if (!reachable.has(scene.id)) {
        issues.push(`scene "${scene.id}" is unreachable from the entry scene`);
      }
    }
    const reachesEnding = new Set(
      def.scenes.filter((s) => s.endingId !== undefined).map((s) => s.id),
    );
    let grew = true;
    while (grew) {
      grew = false;
      for (const scene of def.scenes) {
        if (!reachesEnding.has(scene.id) && scene.choices.some((c) => reachesEnding.has(c.to))) {
          reachesEnding.add(scene.id);
          grew = true;
        }
      }
    }
    for (const scene of def.scenes) {
      if (!reachesEnding.has(scene.id)) {
        issues.push(`scene "${scene.id}" cannot reach any ending`);
      }
    }
  }
  return issues;
}

/** Parses untrusted JSON into a typed definition; no unchecked casts. */
export function parseScenarioDefinition(raw: unknown): ScenarioDefinition {
  const parsed = scenarioDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ScenarioValidationError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  const issues = collectStructuralIssues(parsed.data);
  if (issues.length > 0) throw new ScenarioValidationError(issues);
  return parsed.data;
}

/** Content hash of a definition; pinned in the genesis event so silent edits are detectable. */
export function hashScenarioDefinition(def: ScenarioDefinition): string {
  return canonicalHash(def);
}
