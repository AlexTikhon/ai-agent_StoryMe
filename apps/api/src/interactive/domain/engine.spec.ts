import { describe, expect, it } from 'vitest';
import { WARSAW_LAST_DELIVERY_V1 as scenario } from '../scenarios';
import { WARSAW_ROUTES } from '../scenarios/routes';
import { canonicalJson } from './canonical';
import {
  DomainError,
  applyChoice,
  availableChoices,
  fold,
  playChoices,
  reduce,
  startSession,
  validateTransition,
  verifyReplay,
  type DomainEvent,
} from './engine';
import { createInitialState, hashState, type InteractiveState } from './state';

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
  }
  return value;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  return 'NO_ERROR';
}

describe('canonical serialization and hashing', () => {
  it('sorts object keys and is independent of construction order', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: null } })).toBe(
      '{"a":{"c":null,"d":[2,1]},"b":1}',
    );
    const a = createInitialState(scenario);
    const reordered: InteractiveState = JSON.parse(
      JSON.stringify(Object.fromEntries(Object.entries(a).reverse())),
    );
    expect(hashState(reordered)).toBe(hashState(a));
  });

  it('treats set-like arrays as sets but history as ordered', () => {
    const state = createInitialState(scenario);
    const shuffled = {
      ...state,
      playerKnowledge: ['f-gone-two-days', 'f-parcel-unmarked', 'f-parcel-unmarked'],
    };
    const sorted = { ...state, playerKnowledge: ['f-gone-two-days', 'f-parcel-unmarked'] };
    expect(hashState(shuffled)).toBe(hashState(sorted));
    expect(hashState({ ...state, history: ['a', 'b'] })).not.toBe(
      hashState({ ...state, history: ['b', 'a'] }),
    );
  });

  it('refuses values with no canonical form', () => {
    expect(() => canonicalJson({ a: undefined })).toThrow();
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
  });
});

describe('genesis and event construction', () => {
  it('starts at seq 0 / revision 0 and records the pinned scenario', () => {
    const { event, state } = startSession(scenario);
    expect(event).toMatchObject({
      seq: 0,
      revision: 0,
      type: 'SessionStarted',
      version: 1,
      payload: { scenarioId: 'warsaw-last-delivery', scenarioVersion: 1 },
    });
    expect(event.stateHash).toBe(hashState(state));
    expect(state).toMatchObject({ revision: 0, sceneId: 's-courtyard', endingId: null });
  });

  it('numbers accepted choices 1, 2, ...', () => {
    const { events } = playChoices(scenario, WARSAW_ROUTES.exposed);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(events.map((e) => e.revision)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe('transition rules', () => {
  it('separates player knowledge, NPC knowledge, inventory and consumed items', () => {
    const start = createInitialState(scenario);
    expect(start.playerKnowledge).toEqual(['f-parcel-unmarked']);
    expect(start.npcKnowledge['ines']).toContain('f-ines-altered-ledger');
    expect(start.npcKnowledge['tomasz']).toContain('f-parcel-holds-ledger');
    expect(start.npcKnowledge['mara']).toBeUndefined();
    expect(start.inventory).toEqual(['parcel']);
    expect(start.consumedItems).toEqual([]);
  });

  it('gives choices observable consequences and retains them across reconvergence', () => {
    const viaCaretaker = playChoices(scenario, ['c-ask-caretaker', 'c-climb-from-caretaker']).state;
    const viaMailbox = playChoices(scenario, ['c-read-mailboxes', 'c-climb-from-mailboxes']).state;
    expect(viaCaretaker.sceneId).toBe('s-door');
    expect(viaMailbox.sceneId).toBe('s-door');
    // Same scene, different retained consequences.
    expect(viaCaretaker.inventory).toContain('entry-card');
    expect(viaCaretaker.playerKnowledge).toContain('f-gone-two-days');
    expect(viaMailbox.inventory).toContain('ledger-page');
    expect(viaMailbox.playerKnowledge).toContain('f-ledger-stamp');
    expect(hashState(viaCaretaker)).not.toBe(hashState(viaMailbox));
    // And they stay in state through the next scene.
    const cellar = playChoices(scenario, WARSAW_ROUTES.quietViaStamp).state;
    expect(cellar.history).toEqual(WARSAW_ROUTES.quietViaStamp);
    expect(cellar.playerKnowledge).toContain('f-ledger-stamp');
  });

  it('locks a branch until its prerequisites hold', () => {
    const viaMailbox = playChoices(scenario, ['c-read-mailboxes', 'c-climb-from-mailboxes']).state;
    expect(validateTransition(viaMailbox, 'c-use-card', scenario)).toEqual({
      ok: false,
      code: 'ITEM_NOT_HELD',
    });
    expect(availableChoices(viaMailbox, scenario).map((c) => c.id)).toEqual([
      'c-follow-stamp',
      'c-leave-parcel',
    ]);
    const viaCaretaker = playChoices(scenario, ['c-ask-caretaker', 'c-climb-from-caretaker']).state;
    expect(availableChoices(viaCaretaker, scenario).map((c) => c.id)).toEqual([
      'c-use-card',
      'c-leave-parcel',
    ]);
  });

  it('blocks using a secret the player has not learned', () => {
    // The mailbox route reaches the cellar without ever learning the ledger was altered.
    const cellar = playChoices(scenario, WARSAW_ROUTES.quietViaStamp.slice(0, 3)).state;
    expect(cellar.sceneId).toBe('s-cellar');
    expect(cellar.playerKnowledge).not.toContain('f-ines-altered-ledger');
    // ...even though Ines and Tomasz both know it.
    expect(cellar.npcKnowledge['ines']).toContain('f-ines-altered-ledger');
    expect(validateTransition(cellar, 'c-confront-ines', scenario)).toEqual({
      ok: false,
      code: 'KNOWLEDGE_NOT_LEARNED',
    });
    expect(codeOf(() => applyChoice(cellar, 'c-confront-ines', scenario))).toBe(
      'KNOWLEDGE_NOT_LEARNED',
    );
  });

  it('consumes a one-time item exactly once', () => {
    const atDoor = playChoices(scenario, ['c-ask-caretaker', 'c-climb-from-caretaker']).state;
    const inFlat = applyChoice(atDoor, 'c-use-card', scenario).state;
    expect(inFlat.inventory).not.toContain('entry-card');
    expect(inFlat.consumedItems).toContain('entry-card');
    // Rewinding the scene but keeping the consumed record: reuse is rejected.
    const replayAttempt: InteractiveState = { ...inFlat, sceneId: 's-door' };
    expect(validateTransition(replayAttempt, 'c-use-card', scenario)).toEqual({
      ok: false,
      code: 'ITEM_ALREADY_CONSUMED',
    });
    // Even a forged state that still lists the card as held cannot consume it again.
    const forged: InteractiveState = {
      ...replayAttempt,
      inventory: [...replayAttempt.inventory, 'entry-card'],
    };
    expect(validateTransition(forged, 'c-use-card', scenario)).toEqual({
      ok: false,
      code: 'ITEM_ALREADY_CONSUMED',
    });
    // A consumed one-time item can never be handed out again.
    const regrant = { ...replayAttempt, sceneId: 's-courtyard' };
    expect(validateTransition(regrant, 'c-ask-caretaker', scenario)).toEqual({
      ok: false,
      code: 'ITEM_ALREADY_CONSUMED',
    });
  });

  it('rejects unknown choices, choices from other scenes, and choices after an ending', () => {
    const start = createInitialState(scenario);
    expect(validateTransition(start, 'c-nope', scenario)).toEqual({
      ok: false,
      code: 'UNKNOWN_CHOICE',
    });
    // A real choice of a future scene is indistinguishable from an unknown one.
    expect(validateTransition(start, 'c-confront-ines', scenario)).toEqual({
      ok: false,
      code: 'UNKNOWN_CHOICE',
    });
    const ended = playChoices(scenario, WARSAW_ROUTES.exposed).state;
    expect(ended).toMatchObject({ endingId: 'ledger-exposed', sceneId: 's-end-exposed' });
    expect(validateTransition(ended, 'c-ask-caretaker', scenario)).toEqual({
      ok: false,
      code: 'SESSION_TERMINAL',
    });
    expect(availableChoices(ended, scenario)).toEqual([]);
  });

  it('reaches both endings', () => {
    const endings = Object.values(WARSAW_ROUTES).map(
      (r) => playChoices(scenario, r).state.endingId,
    );
    expect(new Set(endings)).toEqual(new Set(['ledger-exposed', 'quiet-delivery']));
  });

  it('refuses a state pinned to a different scenario version', () => {
    const start = createInitialState(scenario);
    expect(
      codeOf(() =>
        validateTransition({ ...start, scenarioVersion: 2 }, 'c-ask-caretaker', scenario),
      ),
    ).toBe('REPLAY_SCENARIO_MISMATCH');
  });
});

describe('purity', () => {
  it('never mutates its inputs and is deterministic', () => {
    const { events, state } = playChoices(scenario, ['c-ask-caretaker', 'c-climb-from-caretaker']);
    const frozenState = deepFreeze(clone(state));
    const frozenEvents = deepFreeze(clone(events));
    const frozenScenario = deepFreeze(clone(scenario));

    const first = applyChoice(frozenState, 'c-use-card', frozenScenario);
    const second = applyChoice(frozenState, 'c-use-card', frozenScenario);
    expect(first).toEqual(second);
    expect(first.state).not.toBe(frozenState);
    expect(availableChoices(frozenState, frozenScenario)).toHaveLength(2);
    expect(fold(frozenEvents, frozenScenario)).toEqual(state);
    expect(reduce(frozenState, first.event, frozenScenario)).toEqual(first.state);
    expect(frozenState).toEqual(state);
  });
});

describe('replay', () => {
  const route = playChoices(scenario, WARSAW_ROUTES.exposed);

  it('rebuilds the exact state after every accepted choice', () => {
    for (let i = 1; i <= route.events.length; i += 1) {
      const prefix = playChoices(scenario, WARSAW_ROUTES.exposed.slice(0, i - 1));
      expect(fold(route.events.slice(0, i), scenario)).toEqual(prefix.state);
      expect(verifyReplay(route.events.slice(0, i), prefix.state, scenario)).toEqual(prefix.state);
    }
  });

  it('chains hashes: each event hashes the state after it', () => {
    let state: InteractiveState | null = null;
    for (const event of route.events) {
      state = reduce(state, event, scenario);
      expect(event.stateHash).toBe(hashState(state));
    }
    expect(route.events.at(-1)!.stateHash).toBe(hashState(route.state));
  });

  it('rejects a missing genesis', () => {
    expect(codeOf(() => fold([], scenario))).toBe('REPLAY_MISSING_GENESIS');
    expect(codeOf(() => fold(route.events.slice(1), scenario))).toBe('REPLAY_MISSING_GENESIS');
  });

  it('rejects sequence gaps and duplicates', () => {
    const [genesis, one, two] = route.events as [DomainEvent, DomainEvent, DomainEvent];
    expect(codeOf(() => fold([genesis, two], scenario))).toBe('REPLAY_SEQUENCE_GAP');
    expect(codeOf(() => fold([genesis, one, one], scenario))).toBe('REPLAY_DUPLICATE_SEQUENCE');
    expect(codeOf(() => fold([genesis, genesis], scenario))).toBe('REPLAY_DUPLICATE_SEQUENCE');
    expect(codeOf(() => fold([genesis, two, one], scenario))).toBe('REPLAY_SEQUENCE_GAP');
  });

  it('rejects unsupported event versions', () => {
    const events = clone(route.events);
    events[2]!.version = 2;
    expect(codeOf(() => fold(events, scenario))).toBe('REPLAY_UNSUPPORTED_EVENT_VERSION');
  });

  it('rejects scenario/version mismatches', () => {
    const wrongVersion = clone(route.events);
    (wrongVersion[0]!.payload as Record<string, unknown>)['scenarioVersion'] = 2;
    expect(codeOf(() => fold(wrongVersion, scenario))).toBe('REPLAY_SCENARIO_MISMATCH');

    const wrongId = clone(route.events);
    (wrongId[0]!.payload as Record<string, unknown>)['scenarioId'] = 'other';
    expect(codeOf(() => fold(wrongId, scenario))).toBe('REPLAY_SCENARIO_MISMATCH');

    // Same id and version but different content (a silently edited definition).
    const edited = clone(scenario);
    edited.scenes[0]!.title = 'Edited title';
    expect(codeOf(() => fold(route.events, edited))).toBe('REPLAY_SCENARIO_MISMATCH');
  });

  it('rejects tampered hashes, payloads and impossible events', () => {
    const tamperedHash = clone(route.events);
    tamperedHash[3]!.stateHash = 'f'.repeat(64);
    expect(codeOf(() => fold(tamperedHash, scenario))).toBe('REPLAY_HASH_MISMATCH');

    const impossible = clone(route.events);
    (impossible[4]!.payload as Record<string, unknown>)['choiceId'] = 'c-leave-parcel';
    expect(codeOf(() => fold(impossible, scenario))).toBe('UNKNOWN_CHOICE');

    const unknownType = clone(route.events);
    unknownType[1]!.type = 'Teleported';
    expect(codeOf(() => fold(unknownType, scenario))).toBe('REPLAY_INVALID_EVENT');

    const secondGenesis = clone(route.events);
    secondGenesis[1] = { ...secondGenesis[0]!, seq: 1, revision: 1 };
    expect(codeOf(() => fold(secondGenesis, scenario))).toBe('REPLAY_INVALID_EVENT');
  });

  it('requires the stored state to equal the replay', () => {
    const drifted = { ...route.state, flags: [...route.state.flags, 'asked-caretaker'] };
    expect(
      codeOf(() => verifyReplay(route.events, { ...route.state, history: [] }, scenario)),
    ).toBe('REPLAY_HASH_MISMATCH');
    expect(drifted.flags).not.toEqual(route.state.flags);
    expect(verifyReplay(route.events, route.state, scenario)).toEqual(route.state);
  });
});
