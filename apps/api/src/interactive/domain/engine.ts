import { z } from 'zod';
import { toSortedSet } from './canonical';
import {
  hashScenarioDefinition,
  type ChoiceDefinition,
  type Effect,
  type Requirement,
  type ScenarioDefinition,
  type SceneDefinition,
} from './scenario-schema';
import { createInitialState, hashState, normalizeState, type InteractiveState } from './state';

/**
 * Pure transition and replay rules. No database, network, filesystem, clock,
 * randomness or framework dependency; inputs are never mutated and the same
 * inputs always produce the same outputs. The pinned scenario is always passed
 * explicitly.
 */

export const EVENT_SCHEMA_VERSION = 1;

export type DomainErrorCode =
  // Transition validation
  | 'UNKNOWN_CHOICE'
  | 'CHOICE_UNAVAILABLE'
  | 'SESSION_TERMINAL'
  | 'KNOWLEDGE_NOT_LEARNED'
  | 'ITEM_NOT_HELD'
  | 'ITEM_ALREADY_CONSUMED'
  | 'PREREQUISITE_NOT_MET'
  // Replay
  | 'REPLAY_MISSING_GENESIS'
  | 'REPLAY_SEQUENCE_GAP'
  | 'REPLAY_DUPLICATE_SEQUENCE'
  | 'REPLAY_UNSUPPORTED_EVENT_VERSION'
  | 'REPLAY_SCENARIO_MISMATCH'
  | 'REPLAY_INVALID_EVENT'
  | 'REPLAY_HASH_MISMATCH'
  | 'STATE_INVALID';

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

// ── Events ──────────────────────────────────────────────────────────────────

export interface DomainEvent {
  /** Position in the session's event log; the genesis event is 0. */
  seq: number;
  /** Session revision after applying this event; equals `seq`. */
  revision: number;
  type: string;
  version: number;
  payload: unknown;
  /** SHA-256 of the canonical state after applying this event. */
  stateHash: string;
}

export const sessionStartedPayload = z
  .object({
    scenarioId: z.string(),
    scenarioVersion: z.number().int(),
    definitionHash: z.string(),
  })
  .strict();
export const choiceMadePayload = z.object({ choiceId: z.string(), fromSceneId: z.string() }).strict();

export type SessionStartedPayload = z.infer<typeof sessionStartedPayload>;
export type ChoiceMadePayload = z.infer<typeof choiceMadePayload>;

// ── Lookups ─────────────────────────────────────────────────────────────────

export function findScene(scenario: ScenarioDefinition, sceneId: string): SceneDefinition {
  const scene = scenario.scenes.find((s) => s.id === sceneId);
  if (!scene) throw new DomainError('STATE_INVALID', `Unknown scene "${sceneId}"`);
  return scene;
}

function assertBound(state: InteractiveState, scenario: ScenarioDefinition): void {
  if (state.scenarioId !== scenario.id || state.scenarioVersion !== scenario.version) {
    throw new DomainError('REPLAY_SCENARIO_MISMATCH', 'State is pinned to a different scenario');
  }
}

/** Who "knows" a fact: the player character via player knowledge, NPCs via NPC knowledge. */
export function speakerKnows(
  state: InteractiveState,
  scenario: ScenarioDefinition,
  speakerId: string,
  factId: string,
): boolean {
  const character = scenario.characters.find((c) => c.id === speakerId);
  if (!character) return false;
  return character.isPlayer
    ? state.playerKnowledge.includes(factId)
    : (state.npcKnowledge[speakerId] ?? []).includes(factId);
}

// ── Requirements ────────────────────────────────────────────────────────────

/** Returns the failure code for the first unmet requirement, or null when all hold. */
export function unmetRequirement(
  state: InteractiveState,
  requirement: Requirement,
): DomainErrorCode | null {
  switch (requirement.kind) {
    case 'playerKnows':
      return state.playerKnowledge.includes(requirement.fact) ? null : 'KNOWLEDGE_NOT_LEARNED';
    case 'hasItem':
      if (state.consumedItems.includes(requirement.item)) return 'ITEM_ALREADY_CONSUMED';
      return state.inventory.includes(requirement.item) ? null : 'ITEM_NOT_HELD';
    case 'flag':
      return state.flags.includes(requirement.flag) ? null : 'PREREQUISITE_NOT_MET';
    case 'notFlag':
      return state.flags.includes(requirement.flag) ? 'PREREQUISITE_NOT_MET' : null;
  }
}

export function requirementsHold(
  state: InteractiveState,
  requirements: readonly Requirement[] | undefined,
): boolean {
  return (requirements ?? []).every((r) => unmetRequirement(state, r) === null);
}

// ── Transition validation ───────────────────────────────────────────────────

export type TransitionCheck =
  { ok: true; choice: ChoiceDefinition } | { ok: false; code: DomainErrorCode };

function fail(code: DomainErrorCode): TransitionCheck {
  return { ok: false, code };
}

export function validateTransition(
  state: InteractiveState,
  choiceId: string,
  scenario: ScenarioDefinition,
): TransitionCheck {
  assertBound(state, scenario);
  if (state.endingId !== null) return fail('SESSION_TERMINAL');
  const scene = findScene(scenario, state.sceneId);
  // Choices of other scenes are "unknown" here so nothing about future branches leaks.
  const choice = scene.choices.find((c) => c.id === choiceId);
  if (!choice) return fail('UNKNOWN_CHOICE');

  for (const requirement of choice.requires ?? []) {
    const code = unmetRequirement(state, requirement);
    if (code) return fail(code);
  }
  for (const effect of choice.effects) {
    if (effect.kind === 'consumeItem') {
      if (state.consumedItems.includes(effect.item)) return fail('ITEM_ALREADY_CONSUMED');
      if (!state.inventory.includes(effect.item)) return fail('ITEM_NOT_HELD');
    }
    // A one-time item that was used up can never be handed out again.
    if (effect.kind === 'giveItem' && state.consumedItems.includes(effect.item)) {
      return fail('ITEM_ALREADY_CONSUMED');
    }
  }
  return { ok: true, choice };
}

/** Choices the player may take right now; everything else stays hidden. */
export function availableChoices(
  state: InteractiveState,
  scenario: ScenarioDefinition,
): ChoiceDefinition[] {
  if (state.endingId !== null) return [];
  return findScene(scenario, state.sceneId).choices.filter(
    (choice) => validateTransition(state, choice.id, scenario).ok,
  );
}

// ── Reducer ─────────────────────────────────────────────────────────────────

function applyEffects(state: InteractiveState, effects: readonly Effect[]): InteractiveState {
  let playerKnowledge = state.playerKnowledge;
  let inventory = state.inventory;
  let consumedItems = state.consumedItems;
  let flags = state.flags;
  const npcKnowledge: Record<string, string[]> = {};
  for (const [id, known] of Object.entries(state.npcKnowledge)) npcKnowledge[id] = [...known];

  for (const effect of effects) {
    switch (effect.kind) {
      case 'learnFact':
        playerKnowledge = [...playerKnowledge, effect.fact];
        break;
      case 'npcLearns':
        npcKnowledge[effect.character] = [...(npcKnowledge[effect.character] ?? []), effect.fact];
        break;
      case 'giveItem':
        inventory = [...inventory, effect.item];
        break;
      case 'consumeItem':
        inventory = inventory.filter((item) => item !== effect.item);
        consumedItems = [...consumedItems, effect.item];
        break;
      case 'setFlag':
        flags = [...flags, effect.flag];
        break;
    }
  }
  return {
    ...state,
    playerKnowledge: toSortedSet(playerKnowledge),
    npcKnowledge,
    inventory: toSortedSet(inventory),
    consumedItems: toSortedSet(consumedItems),
    flags: toSortedSet(flags),
  };
}

function assertSupportedVersion(event: DomainEvent): void {
  if (event.version !== EVENT_SCHEMA_VERSION) {
    throw new DomainError(
      'REPLAY_UNSUPPORTED_EVENT_VERSION',
      `Unsupported event version ${event.version} for seq ${event.seq}`,
    );
  }
}

/**
 * Applies one trusted event. `null` state means "no session yet": only the
 * genesis event is accepted there, and only there.
 */
export function reduce(
  state: InteractiveState | null,
  event: DomainEvent,
  scenario: ScenarioDefinition,
): InteractiveState {
  assertSupportedVersion(event);
  if (event.revision !== event.seq) {
    throw new DomainError('REPLAY_INVALID_EVENT', `Event ${event.seq} has mismatched revision`);
  }

  if (event.type === 'SessionStarted') {
    if (state !== null || event.seq !== 0) {
      throw new DomainError('REPLAY_INVALID_EVENT', 'SessionStarted is only valid as event 0');
    }
    const payload = sessionStartedPayload.safeParse(event.payload);
    if (!payload.success)
      throw new DomainError('REPLAY_INVALID_EVENT', 'Malformed genesis payload');
    if (
      payload.data.scenarioId !== scenario.id ||
      payload.data.scenarioVersion !== scenario.version ||
      payload.data.definitionHash !== hashScenarioDefinition(scenario)
    ) {
      throw new DomainError(
        'REPLAY_SCENARIO_MISMATCH',
        'Genesis is pinned to a different scenario',
      );
    }
    return createInitialState(scenario);
  }

  if (event.type === 'ChoiceMade') {
    if (state === null) {
      throw new DomainError('REPLAY_MISSING_GENESIS', 'ChoiceMade requires an existing session');
    }
    assertBound(state, scenario);
    if (event.seq !== state.revision + 1) {
      throw new DomainError('REPLAY_SEQUENCE_GAP', `Expected seq ${state.revision + 1}`);
    }
    const payload = choiceMadePayload.safeParse(event.payload);
    if (!payload.success) throw new DomainError('REPLAY_INVALID_EVENT', 'Malformed choice payload');
    if (payload.data.fromSceneId !== state.sceneId) {
      throw new DomainError('REPLAY_INVALID_EVENT', 'Choice was not made from the current scene');
    }
    const check = validateTransition(state, payload.data.choiceId, scenario);
    if (!check.ok) throw new DomainError(check.code);

    const target = findScene(scenario, check.choice.to);
    const next = applyEffects(state, check.choice.effects);
    return normalizeState({
      ...next,
      revision: event.revision,
      sceneId: target.id,
      history: [...state.history, check.choice.id],
      endingId: target.endingId ?? null,
    });
  }

  throw new DomainError('REPLAY_INVALID_EVENT', `Unknown event type "${event.type}"`);
}

// ── Trusted event construction ──────────────────────────────────────────────

export interface AppliedEvent {
  event: DomainEvent;
  state: InteractiveState;
}

/** Builds the genesis event (seq 0, revision 0) and its resulting state. */
export function startSession(scenario: ScenarioDefinition): AppliedEvent {
  const payload: SessionStartedPayload = {
    scenarioId: scenario.id,
    scenarioVersion: scenario.version,
    definitionHash: hashScenarioDefinition(scenario),
  };
  const draft = {
    seq: 0,
    revision: 0,
    type: 'SessionStarted',
    version: EVENT_SCHEMA_VERSION,
    payload,
    stateHash: '',
  };
  const state = reduce(null, draft, scenario);
  return { event: { ...draft, stateHash: hashState(state) }, state };
}

/** Validates a choice and builds the next event; throws DomainError when it is not allowed. */
export function applyChoice(
  state: InteractiveState,
  choiceId: string,
  scenario: ScenarioDefinition,
): AppliedEvent {
  const check = validateTransition(state, choiceId, scenario);
  if (!check.ok) throw new DomainError(check.code);
  const payload: ChoiceMadePayload = { choiceId, fromSceneId: state.sceneId };
  const draft = {
    seq: state.revision + 1,
    revision: state.revision + 1,
    type: 'ChoiceMade',
    version: EVENT_SCHEMA_VERSION,
    payload,
    stateHash: '',
  };
  const next = reduce(state, draft, scenario);
  return { event: { ...draft, stateHash: hashState(next) }, state: next };
}

// ── Replay ──────────────────────────────────────────────────────────────────

/**
 * Rebuilds a session from its complete event log. Every event's recorded
 * stateHash must equal the hash of the state this replay computes; any gap,
 * duplicate, missing genesis, unsupported version, scenario mismatch or hash
 * drift throws.
 */
export function fold(
  events: readonly DomainEvent[],
  scenario: ScenarioDefinition,
): InteractiveState {
  const first = events[0];
  if (!first || first.type !== 'SessionStarted' || first.seq !== 0) {
    throw new DomainError(
      'REPLAY_MISSING_GENESIS',
      'Event log must begin with SessionStarted seq 0',
    );
  }
  let state: InteractiveState | null = null;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.seq !== index) {
      const duplicate = index > 0 && events.slice(0, index).some((e) => e.seq === event.seq);
      throw new DomainError(
        duplicate ? 'REPLAY_DUPLICATE_SEQUENCE' : 'REPLAY_SEQUENCE_GAP',
        `Expected seq ${index} but found ${event.seq}`,
      );
    }
    state = reduce(state, event, scenario);
    if (hashState(state) !== event.stateHash) {
      throw new DomainError('REPLAY_HASH_MISMATCH', `State hash mismatch at seq ${event.seq}`);
    }
  }
  return state!;
}

/** Replays `events` and requires the result to equal `stored` and the final event hash. */
export function verifyReplay(
  events: readonly DomainEvent[],
  stored: InteractiveState,
  scenario: ScenarioDefinition,
): InteractiveState {
  const replayed = fold(events, scenario);
  const finalEvent = events[events.length - 1]!;
  if (hashState(stored) !== hashState(replayed) || hashState(stored) !== finalEvent.stateHash) {
    throw new DomainError('REPLAY_HASH_MISMATCH', 'Stored state diverges from replay');
  }
  return replayed;
}

/** Scripted play from genesis: applies `choiceIds` in order; throws on the first invalid one. */
export function playChoices(
  scenario: ScenarioDefinition,
  choiceIds: readonly string[],
): { events: DomainEvent[]; state: InteractiveState } {
  const genesis = startSession(scenario);
  const events = [genesis.event];
  let state = genesis.state;
  for (const choiceId of choiceIds) {
    const applied = applyChoice(state, choiceId, scenario);
    events.push(applied.event);
    state = applied.state;
  }
  return { events, state };
}
