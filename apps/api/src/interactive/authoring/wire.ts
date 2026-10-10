import { z } from 'zod';
import type {
  Effect,
  Requirement,
  ScenarioDefinition,
  SceneDefinition,
} from '../domain/scenario-schema';
import { diagnostic, type Diagnostic } from './diagnostics';
import { MAX_CHOICES_PER_SCENE, MAX_FACTS, MAX_FLAGS, MAX_ITEMS, MAX_SCENES } from './limits';

/**
 * Provider wire format. It is a dedicated DTO, NOT the runtime schema
 * serialized as-is: OpenAI strict Structured Outputs needs every field
 * required, `additionalProperties: false` on every object, nullable instead of
 * optional, and no unions at the root. So:
 *  - optional fields become required-nullable (or empty arrays);
 *  - requirements/effects are flat `{ kind, ref }` objects instead of
 *    discriminated unions;
 *  - the dynamic NPC knowledge map becomes an array of entries.
 * Normalization converts it into the runtime shape and rejects duplicates
 * rather than overwriting them. Local strict validation stays authoritative:
 * the JSON schema below constrains shape only (no length/pattern keywords).
 */

export const REQUIREMENT_KINDS = ['playerKnows', 'hasItem', 'flag', 'notFlag'] as const;
export const EFFECT_KINDS = [
  'learnFact',
  'npcLearns',
  'giveItem',
  'consumeItem',
  'setFlag',
] as const;

const text = z.string().max(700);
const wireId = z.string().max(64);

const wireRequirement = z.object({ kind: z.enum(REQUIREMENT_KINDS), ref: wireId }).strict();
const wireEffect = z
  .object({ kind: z.enum(EFFECT_KINDS), ref: wireId, character: wireId.nullable() })
  .strict();
const wireTemplate = z
  .object({
    id: wireId,
    text,
    speakerId: wireId.nullable(),
    factIds: z.array(wireId).max(8),
    when: z.array(wireRequirement).max(8),
  })
  .strict();
const wireChoice = z
  .object({
    id: wireId,
    label: text,
    to: wireId,
    requires: z.array(wireRequirement).max(8),
    effects: z.array(wireEffect).max(12),
  })
  .strict();
const wireScene = z
  .object({
    id: wireId,
    title: text,
    endingId: wireId.nullable(),
    narration: z.array(wireTemplate).max(12),
    choices: z.array(wireChoice).max(MAX_CHOICES_PER_SCENE + 2),
  })
  .strict();

export const wireScenarioSchema = z
  .object({
    id: wireId,
    version: z.number().int(),
    title: text,
    entrySceneId: wireId,
    characters: z
      .array(z.object({ id: wireId, name: text, role: text, isPlayer: z.boolean() }).strict())
      .max(8),
    facts: z.array(z.object({ id: wireId, text }).strict()).max(MAX_FACTS + 8),
    items: z
      .array(z.object({ id: wireId, name: text, oneTime: z.boolean() }).strict())
      .max(MAX_ITEMS + 8),
    flags: z.array(wireId).max(MAX_FLAGS + 8),
    initialPlayerKnowledge: z.array(wireId).max(40),
    initialNpcKnowledge: z
      .array(z.object({ characterId: wireId, factIds: z.array(wireId).max(40) }).strict())
      .max(8),
    initialInventory: z.array(wireId).max(20),
    scenes: z.array(wireScene).max(MAX_SCENES + 8),
    endings: z.array(z.object({ id: wireId, title: text, summary: text }).strict()).max(8),
  })
  .strict();

export type WireScenario = z.infer<typeof wireScenarioSchema>;

// ── JSON Schema for OpenAI Structured Outputs (strict) ──────────────────────

type JsonSchema = Record<string, unknown>;

function obj(properties: Record<string, JsonSchema>): JsonSchema {
  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}
const str: JsonSchema = { type: 'string' };
const nullableStr: JsonSchema = { type: ['string', 'null'] };
const arr = (items: JsonSchema): JsonSchema => ({ type: 'array', items });

const requirementJson = obj({
  kind: { type: 'string', enum: [...REQUIREMENT_KINDS] },
  ref: str,
});
const effectJson = obj({
  kind: { type: 'string', enum: [...EFFECT_KINDS] },
  ref: str,
  character: nullableStr,
});

export const WIRE_JSON_SCHEMA: JsonSchema = obj({
  id: str,
  version: { type: 'integer' },
  title: str,
  entrySceneId: str,
  characters: arr(obj({ id: str, name: str, role: str, isPlayer: { type: 'boolean' } })),
  facts: arr(obj({ id: str, text: str })),
  items: arr(obj({ id: str, name: str, oneTime: { type: 'boolean' } })),
  flags: arr(str),
  initialPlayerKnowledge: arr(str),
  initialNpcKnowledge: arr(obj({ characterId: str, factIds: arr(str) })),
  initialInventory: arr(str),
  scenes: arr(
    obj({
      id: str,
      title: str,
      endingId: nullableStr,
      narration: arr(
        obj({
          id: str,
          text: str,
          speakerId: nullableStr,
          factIds: arr(str),
          when: arr(requirementJson),
        }),
      ),
      choices: arr(
        obj({
          id: str,
          label: str,
          to: str,
          requires: arr(requirementJson),
          effects: arr(effectJson),
        }),
      ),
    }),
  ),
  endings: arr(obj({ id: str, title: str, summary: str })),
});

export const WIRE_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: { name: 'scenario_candidate', strict: true, schema: WIRE_JSON_SCHEMA },
} as const;

// ── Wire → runtime ──────────────────────────────────────────────────────────

export type NormalizeResult =
  { ok: true; candidate: Record<string, unknown> } | { ok: false; diagnostics: Diagnostic[] };

const fmt = (code: string, message: string) => diagnostic('candidate-format', code, message);

function duplicatesOf(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const v of values) (seen.has(v) ? dup : seen).add(v);
  return [...dup];
}

/**
 * Converts a schema-valid wire DTO into the runtime object shape (still
 * untrusted: parseScenarioDefinition decides). Duplicate knowledge entries and
 * duplicate ids inside id lists are rejected here because the conversion would
 * otherwise silently overwrite or de-duplicate them.
 */
export function normalizeWire(wire: WireScenario): NormalizeResult {
  const problems: Diagnostic[] = [];
  const noDuplicates = (where: string, ids: readonly string[]) => {
    for (const id of duplicatesOf(ids)) {
      problems.push(fmt('DUPLICATE_ENTRY', `${where}: duplicate entry "${id}"`));
    }
  };

  noDuplicates('initialPlayerKnowledge', wire.initialPlayerKnowledge);
  noDuplicates('initialInventory', wire.initialInventory);
  noDuplicates(
    'initialNpcKnowledge characterId',
    wire.initialNpcKnowledge.map((e) => e.characterId),
  );
  for (const entry of wire.initialNpcKnowledge) {
    noDuplicates(`initialNpcKnowledge "${entry.characterId}"`, entry.factIds);
  }

  const requirement = (where: string, r: { kind: string; ref: string }): Requirement | null => {
    switch (r.kind) {
      case 'playerKnows':
        return { kind: 'playerKnows', fact: r.ref };
      case 'hasItem':
        return { kind: 'hasItem', item: r.ref };
      case 'flag':
        return { kind: 'flag', flag: r.ref };
      case 'notFlag':
        return { kind: 'notFlag', flag: r.ref };
      default:
        problems.push(fmt('UNKNOWN_REQUIREMENT', `${where}: unknown requirement kind`));
        return null;
    }
  };
  const effect = (
    where: string,
    e: { kind: string; ref: string; character: string | null },
  ): Effect | null => {
    if (e.kind === 'npcLearns') {
      if (e.character === null) {
        problems.push(fmt('EFFECT_CHARACTER', `${where}: npcLearns requires a character`));
        return null;
      }
      return { kind: 'npcLearns', character: e.character, fact: e.ref };
    }
    if (e.character !== null) {
      problems.push(fmt('EFFECT_CHARACTER', `${where}: only npcLearns may name a character`));
      return null;
    }
    switch (e.kind) {
      case 'learnFact':
        return { kind: 'learnFact', fact: e.ref };
      case 'giveItem':
        return { kind: 'giveItem', item: e.ref };
      case 'consumeItem':
        return { kind: 'consumeItem', item: e.ref };
      case 'setFlag':
        return { kind: 'setFlag', flag: e.ref };
      default:
        problems.push(fmt('UNKNOWN_EFFECT', `${where}: unknown effect kind`));
        return null;
    }
  };
  const compact = <T>(items: Array<T | null>): T[] => items.filter((i): i is T => i !== null);

  const scenes = wire.scenes.map((scene) => {
    const out: Record<string, unknown> = {
      id: scene.id,
      title: scene.title,
      narration: scene.narration.map((t) => {
        noDuplicates(`template "${t.id}" factIds`, t.factIds);
        const template: Record<string, unknown> = { id: t.id, text: t.text };
        if (t.speakerId !== null) template['speakerId'] = t.speakerId;
        if (t.factIds.length > 0) template['factIds'] = [...t.factIds];
        if (t.when.length > 0) {
          template['when'] = compact(t.when.map((r) => requirement(`template "${t.id}"`, r)));
        }
        return template;
      }),
      choices: scene.choices.map((c) => {
        const choice: Record<string, unknown> = { id: c.id, label: c.label, to: c.to };
        if (c.requires.length > 0) {
          choice['requires'] = compact(c.requires.map((r) => requirement(`choice "${c.id}"`, r)));
        }
        choice['effects'] = compact(c.effects.map((e) => effect(`choice "${c.id}"`, e)));
        return choice;
      }),
    };
    if (scene.endingId !== null) out['endingId'] = scene.endingId;
    return out;
  });

  if (problems.length > 0) return { ok: false, diagnostics: problems };

  const npcKnowledge: Record<string, string[]> = {};
  for (const entry of wire.initialNpcKnowledge)
    npcKnowledge[entry.characterId] = [...entry.factIds];

  return {
    ok: true,
    candidate: {
      id: wire.id,
      version: wire.version,
      language: 'en',
      title: wire.title,
      entrySceneId: wire.entrySceneId,
      characters: wire.characters.map((c) => ({ ...c })),
      facts: wire.facts.map((f) => ({ ...f })),
      items: wire.items.map((i) => ({ ...i })),
      flags: [...wire.flags],
      initial: {
        playerKnowledge: [...wire.initialPlayerKnowledge],
        npcKnowledge,
        inventory: [...wire.initialInventory],
      },
      scenes,
      endings: wire.endings.map((e) => ({ ...e })),
    },
  };
}

// ── Runtime → wire (used by the deterministic mock and by tests) ────────────

function requirementToWire(r: Requirement): { kind: Requirement['kind']; ref: string } {
  switch (r.kind) {
    case 'playerKnows':
      return { kind: r.kind, ref: r.fact };
    case 'hasItem':
      return { kind: r.kind, ref: r.item };
    case 'flag':
    case 'notFlag':
      return { kind: r.kind, ref: r.flag };
  }
}

function effectToWire(e: Effect): {
  kind: Effect['kind'];
  ref: string;
  character: string | null;
} {
  switch (e.kind) {
    case 'learnFact':
      return { kind: e.kind, ref: e.fact, character: null };
    case 'npcLearns':
      return { kind: e.kind, ref: e.fact, character: e.character };
    case 'giveItem':
    case 'consumeItem':
      return { kind: e.kind, ref: e.item, character: null };
    case 'setFlag':
      return { kind: e.kind, ref: e.flag, character: null };
  }
}

export function scenarioToWire(def: ScenarioDefinition): WireScenario {
  const sceneToWire = (scene: SceneDefinition) => ({
    id: scene.id,
    title: scene.title,
    endingId: scene.endingId ?? null,
    narration: scene.narration.map((t) => ({
      id: t.id,
      text: t.text,
      speakerId: t.speakerId ?? null,
      factIds: [...(t.factIds ?? [])],
      when: (t.when ?? []).map(requirementToWire),
    })),
    choices: scene.choices.map((c) => ({
      id: c.id,
      label: c.label,
      to: c.to,
      requires: (c.requires ?? []).map(requirementToWire),
      effects: c.effects.map(effectToWire),
    })),
  });
  return {
    id: def.id,
    version: def.version,
    title: def.title,
    entrySceneId: def.entrySceneId,
    characters: def.characters.map((c) => ({ ...c })),
    facts: def.facts.map((f) => ({ ...f })),
    items: def.items.map((i) => ({ ...i })),
    flags: [...def.flags],
    initialPlayerKnowledge: [...def.initial.playerKnowledge],
    initialNpcKnowledge: Object.entries(def.initial.npcKnowledge).map(([characterId, factIds]) => ({
      characterId,
      factIds: [...factIds],
    })),
    initialInventory: [...def.initial.inventory],
    scenes: def.scenes.map(sceneToWire),
    endings: def.endings.map((e) => ({ ...e })),
  };
}
