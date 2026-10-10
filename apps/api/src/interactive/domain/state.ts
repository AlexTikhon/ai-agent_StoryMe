import { z } from 'zod';
import { canonicalHash, toSortedSet } from './canonical';
import type { ScenarioDefinition } from './scenario-schema';

/**
 * Session state: everything that can change while a session runs. World
 * definitions (characters, facts, scenes, ...) live in the immutable
 * ScenarioDefinition; this holds only who knows what, who holds what, and where
 * the session is.
 *
 * Arrays named as sets (knowledge, inventory, consumedItems, flags) are kept
 * sorted and de-duplicated. `history` is an ordered list and is NOT sorted.
 */
export const STATE_SCHEMA_VERSION = 1;

const identifier = z.string().min(1).max(64);

export const interactiveStateSchema = z
  .object({
    schemaVersion: z.literal(STATE_SCHEMA_VERSION),
    scenarioId: identifier,
    scenarioVersion: z.number().int().min(1),
    revision: z.number().int().min(0),
    sceneId: identifier,
    /** Facts the player has learned. */
    playerKnowledge: z.array(identifier).max(100),
    /** Facts each NPC knows, keyed by character id. */
    npcKnowledge: z.record(identifier, z.array(identifier).max(100)),
    /** Items currently held. */
    inventory: z.array(identifier).max(100),
    /** One-time items already used up; never regained. */
    consumedItems: z.array(identifier).max(100),
    /** Internal narrative consequence markers; never shown to the client. */
    flags: z.array(identifier).max(100),
    /** Ordered ids of the choices taken so far. */
    history: z.array(identifier).max(200),
    /** Set once the session reached a terminal scene. */
    endingId: identifier.nullable(),
  })
  .strict();

export type InteractiveState = z.infer<typeof interactiveStateSchema>;

/** Canonical form: set-like arrays sorted and de-duplicated, NPC keys ordered. */
export function normalizeState(state: InteractiveState): InteractiveState {
  const npcKnowledge: Record<string, string[]> = {};
  for (const key of Object.keys(state.npcKnowledge).sort()) {
    npcKnowledge[key] = toSortedSet(state.npcKnowledge[key] ?? []);
  }
  return {
    schemaVersion: state.schemaVersion,
    scenarioId: state.scenarioId,
    scenarioVersion: state.scenarioVersion,
    revision: state.revision,
    sceneId: state.sceneId,
    playerKnowledge: toSortedSet(state.playerKnowledge),
    npcKnowledge,
    inventory: toSortedSet(state.inventory),
    consumedItems: toSortedSet(state.consumedItems),
    flags: toSortedSet(state.flags),
    history: [...state.history],
    endingId: state.endingId,
  };
}

/** SHA-256 of the canonical state; independent of object-key or set-insertion order. */
export function hashState(state: InteractiveState): string {
  return canonicalHash(normalizeState(state));
}

/** Validates untrusted JSON (e.g. a database column) as a canonical state. */
export function parseState(raw: unknown): InteractiveState {
  const state = interactiveStateSchema.parse(raw);
  return normalizeState(state);
}

export function createInitialState(scenario: ScenarioDefinition): InteractiveState {
  const npcKnowledge: Record<string, string[]> = {};
  for (const character of scenario.characters) {
    if (!character.isPlayer) {
      npcKnowledge[character.id] = [...(scenario.initial.npcKnowledge[character.id] ?? [])];
    }
  }
  return normalizeState({
    schemaVersion: STATE_SCHEMA_VERSION,
    scenarioId: scenario.id,
    scenarioVersion: scenario.version,
    revision: 0,
    sceneId: scenario.entrySceneId,
    playerKnowledge: [...scenario.initial.playerKnowledge],
    npcKnowledge,
    inventory: [...scenario.initial.inventory],
    consumedItems: [],
    flags: [],
    history: [],
    endingId: null,
  });
}
