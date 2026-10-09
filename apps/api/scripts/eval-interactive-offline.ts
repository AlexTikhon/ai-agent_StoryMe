import {
  DomainError,
  applyChoice,
  fold,
  playChoices,
  validateTransition,
  verifyReplay,
  type DomainEvent,
} from '../src/interactive/domain/engine';
import { buildCanonicalNarration, validateNarration } from '../src/interactive/domain/narration';
import { createInitialState, hashState } from '../src/interactive/domain/state';
import { WARSAW_LAST_DELIVERY_V1 as scenario } from '../src/interactive/scenarios';
import { WARSAW_ROUTES } from '../src/interactive/scenarios/routes';

/**
 * Offline evaluation of the interactive engine: pure, in-memory fixtures only.
 * No PostgreSQL, Redis, Nest application, API keys or network. It covers the
 * domain rules, replay integrity and the closed narration contract. HTTP
 * idempotency/concurrency are proven by the PostgreSQL integration tests, not here.
 */

export type InteractiveEvalKind = 'valid' | 'adversarial';

export interface InteractiveEvalCase {
  /** Stable identifier; never reused for a different scenario of the case. */
  id: string;
  kind: InteractiveEvalKind;
  /** Expected outcome: "ACCEPTED", "ENDING:<id>" or a stable rejection code. */
  expected: string;
  /** Returns the observed outcome in the same vocabulary as `expected`. */
  run: () => string;
}

export interface InteractiveEvalResult {
  id: string;
  kind: InteractiveEvalKind;
  expected: string;
  actual: string;
  passed: boolean;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Runs `fn`, turning a DomainError into its stable code. */
function outcome(fn: () => string): string {
  try {
    return fn();
  } catch (error) {
    return error instanceof DomainError ? error.code : `UNEXPECTED:${String(error)}`;
  }
}

/** Plays a route and, at every step, replays the log and checks narration. */
function playAndVerify(route: readonly string[]): string {
  const played = playChoices(scenario, route);
  for (let i = 1; i <= played.events.length; i += 1) {
    const prefix = playChoices(scenario, route.slice(0, i - 1));
    verifyReplay(played.events.slice(0, i), prefix.state, scenario);
    const narration = validateNarration(
      buildCanonicalNarration(scenario, prefix.state),
      scenario,
      prefix.state,
    );
    if (!narration.ok) return narration.code;
  }
  return played.state.endingId ? `ENDING:${played.state.endingId}` : 'ACCEPTED';
}

function narrationOutcome(
  stateRoute: readonly string[],
  mutate: (n: ReturnType<typeof buildCanonicalNarration>) => unknown,
): string {
  const { state } = playChoices(scenario, stateRoute);
  const result = validateNarration(
    mutate(buildCanonicalNarration(scenario, state)),
    scenario,
    state,
  );
  return result.ok ? 'ACCEPTED' : result.code;
}

function replayOutcome(mutate: (events: DomainEvent[]) => DomainEvent[]): string {
  const { events } = playChoices(scenario, WARSAW_ROUTES.exposed);
  return outcome(() => {
    fold(mutate(clone(events)), scenario);
    return 'ACCEPTED';
  });
}

const cellarViaStamp = WARSAW_ROUTES.quietViaStamp.slice(0, 3);
const cellarViaFlat = WARSAW_ROUTES.exposed.slice(0, 4);

export function buildInteractiveEvalCases(): InteractiveEvalCase[] {
  return [
    // ── Valid: complete routes replay exactly and narrate correctly ─────────
    {
      id: 'valid.route.exposed',
      kind: 'valid',
      expected: 'ENDING:ledger-exposed',
      run: () => outcome(() => playAndVerify(WARSAW_ROUTES.exposed)),
    },
    {
      id: 'valid.route.quiet-via-flat',
      kind: 'valid',
      expected: 'ENDING:quiet-delivery',
      run: () => outcome(() => playAndVerify(WARSAW_ROUTES.quietViaFlat)),
    },
    {
      id: 'valid.route.quiet-via-stamp',
      kind: 'valid',
      expected: 'ENDING:quiet-delivery',
      run: () => outcome(() => playAndVerify(WARSAW_ROUTES.quietViaStamp)),
    },
    {
      id: 'valid.route.quiet-at-door',
      kind: 'valid',
      expected: 'ENDING:quiet-delivery',
      run: () => outcome(() => playAndVerify(WARSAW_ROUTES.quietAtDoor)),
    },
    {
      id: 'valid.hash.key-order-independent',
      kind: 'valid',
      expected: 'ACCEPTED',
      run: () => {
        const state = createInitialState(scenario);
        const reversed = JSON.parse(
          JSON.stringify(Object.fromEntries(Object.entries(state).reverse())),
        );
        return hashState(reversed) === hashState(state) ? 'ACCEPTED' : 'HASH_UNSTABLE';
      },
    },
    {
      id: 'valid.narration.mock-rendering',
      kind: 'valid',
      expected: 'ACCEPTED',
      run: () => narrationOutcome(cellarViaFlat, (n) => n),
    },

    // ── Adversarial: transitions ────────────────────────────────────────────
    {
      id: 'adv.transition.unknown-choice',
      kind: 'adversarial',
      expected: 'UNKNOWN_CHOICE',
      run: () =>
        outcome(() => applyChoice(createInitialState(scenario), 'c-invented', scenario).event.type),
    },
    {
      id: 'adv.transition.future-branch-choice',
      kind: 'adversarial',
      expected: 'UNKNOWN_CHOICE',
      run: () =>
        outcome(
          () => applyChoice(createInitialState(scenario), 'c-confront-ines', scenario).event.type,
        ),
    },
    {
      id: 'adv.transition.locked-branch',
      kind: 'adversarial',
      expected: 'ITEM_NOT_HELD',
      run: () => {
        const state = playChoices(scenario, ['c-read-mailboxes', 'c-climb-from-mailboxes']).state;
        const check = validateTransition(state, 'c-use-card', scenario);
        return check.ok ? 'ACCEPTED' : check.code;
      },
    },
    {
      id: 'adv.transition.secret-not-learned',
      kind: 'adversarial',
      expected: 'KNOWLEDGE_NOT_LEARNED',
      run: () => {
        const state = playChoices(scenario, cellarViaStamp).state;
        const check = validateTransition(state, 'c-confront-ines', scenario);
        return check.ok ? 'ACCEPTED' : check.code;
      },
    },
    {
      id: 'adv.transition.consumed-item-reuse',
      kind: 'adversarial',
      expected: 'ITEM_ALREADY_CONSUMED',
      run: () => {
        const inFlat = playChoices(scenario, WARSAW_ROUTES.exposed.slice(0, 3)).state;
        const rewound = { ...inFlat, sceneId: 's-door' };
        const check = validateTransition(rewound, 'c-use-card', scenario);
        return check.ok ? 'ACCEPTED' : check.code;
      },
    },
    {
      id: 'adv.transition.choice-after-ending',
      kind: 'adversarial',
      expected: 'SESSION_TERMINAL',
      run: () => {
        const ended = playChoices(scenario, WARSAW_ROUTES.exposed).state;
        const check = validateTransition(ended, 'c-ask-caretaker', scenario);
        return check.ok ? 'ACCEPTED' : check.code;
      },
    },

    // ── Adversarial: replay ─────────────────────────────────────────────────
    {
      id: 'adv.replay.missing-genesis',
      kind: 'adversarial',
      expected: 'REPLAY_MISSING_GENESIS',
      run: () => replayOutcome((events) => events.slice(1)),
    },
    {
      id: 'adv.replay.sequence-gap',
      kind: 'adversarial',
      expected: 'REPLAY_SEQUENCE_GAP',
      run: () => replayOutcome((events) => events.filter((e) => e.seq !== 2)),
    },
    {
      id: 'adv.replay.duplicate-event',
      kind: 'adversarial',
      expected: 'REPLAY_DUPLICATE_SEQUENCE',
      run: () =>
        replayOutcome((events) => [events[0]!, events[1]!, events[1]!, ...events.slice(2)]),
    },
    {
      id: 'adv.replay.unsupported-version',
      kind: 'adversarial',
      expected: 'REPLAY_UNSUPPORTED_EVENT_VERSION',
      run: () =>
        replayOutcome((events) => {
          events[2]!.version = 2;
          return events;
        }),
    },
    {
      id: 'adv.replay.scenario-version-mismatch',
      kind: 'adversarial',
      expected: 'REPLAY_SCENARIO_MISMATCH',
      run: () =>
        replayOutcome((events) => {
          (events[0]!.payload as Record<string, unknown>)['scenarioVersion'] = 2;
          return events;
        }),
    },
    {
      id: 'adv.replay.tampered-state-hash',
      kind: 'adversarial',
      expected: 'REPLAY_HASH_MISMATCH',
      run: () =>
        replayOutcome((events) => {
          events[3]!.stateHash = '0'.repeat(64);
          return events;
        }),
    },
    {
      id: 'adv.replay.stored-state-drift',
      kind: 'adversarial',
      expected: 'REPLAY_HASH_MISMATCH',
      run: () => {
        const { events, state } = playChoices(scenario, WARSAW_ROUTES.exposed);
        return outcome(() => {
          verifyReplay(
            events,
            { ...state, inventory: [...state.inventory, 'entry-card'] },
            scenario,
          );
          return 'ACCEPTED';
        });
      },
    },

    // ── Adversarial: narration contract ─────────────────────────────────────
    {
      id: 'adv.narration.unknown-template',
      kind: 'adversarial',
      expected: 'NARRATION_UNKNOWN_TEMPLATE',
      run: () => narrationOutcome(cellarViaFlat, (n) => ({ ...n, templateIds: ['t-invented'] })),
    },
    {
      id: 'adv.narration.unknown-speaker',
      kind: 'adversarial',
      expected: 'NARRATION_UNKNOWN_SPEAKER',
      run: () =>
        narrationOutcome(cellarViaFlat, (n) => ({
          ...n,
          utterances: [{ speakerId: 'stranger', factId: 'f-gone-two-days' }],
        })),
    },
    {
      id: 'adv.narration.unknown-fact',
      kind: 'adversarial',
      expected: 'NARRATION_UNKNOWN_FACT',
      run: () =>
        narrationOutcome(cellarViaFlat, (n) => ({
          ...n,
          utterances: [{ speakerId: 'ines', factId: 'f-invented' }],
        })),
    },
    {
      id: 'adv.narration.speaker-lacks-knowledge',
      kind: 'adversarial',
      expected: 'NARRATION_KNOWLEDGE_UNAVAILABLE',
      run: () =>
        narrationOutcome(cellarViaStamp, (n) => ({
          ...n,
          utterances: [{ speakerId: 'mara', factId: 'f-ines-altered-ledger' }],
        })),
    },
    {
      id: 'adv.narration.wrong-scene',
      kind: 'adversarial',
      expected: 'NARRATION_BINDING_MISMATCH',
      run: () => narrationOutcome(cellarViaFlat, (n) => ({ ...n, sceneId: 's-door' })),
    },
    {
      id: 'adv.narration.wrong-version',
      kind: 'adversarial',
      expected: 'NARRATION_BINDING_MISMATCH',
      run: () => narrationOutcome(cellarViaFlat, (n) => ({ ...n, scenarioVersion: 2 })),
    },
    {
      id: 'adv.narration.wrong-template-selection',
      kind: 'adversarial',
      expected: 'NARRATION_TEMPLATE_MISMATCH',
      run: () => narrationOutcome(cellarViaFlat, (n) => ({ ...n, templateIds: ['t-door-intro'] })),
    },
    {
      id: 'adv.narration.altered-text',
      kind: 'adversarial',
      expected: 'NARRATION_TEXT_MISMATCH',
      run: () =>
        narrationOutcome(cellarViaFlat, (n) => ({
          ...n,
          text: `${n.text} Tomasz was never here.`,
        })),
    },
    {
      id: 'adv.narration.oversized',
      kind: 'adversarial',
      expected: 'NARRATION_MALFORMED',
      run: () => narrationOutcome(cellarViaFlat, (n) => ({ ...n, text: 'x'.repeat(100_000) })),
    },
    {
      id: 'adv.narration.malformed',
      kind: 'adversarial',
      expected: 'NARRATION_MALFORMED',
      run: () => narrationOutcome(cellarViaFlat, () => ({ text: 42 })),
    },
  ];
}

export function evaluateInteractiveCases(
  cases: readonly InteractiveEvalCase[],
): InteractiveEvalResult[] {
  return cases.map((c) => {
    const actual = outcome(c.run);
    return { id: c.id, kind: c.kind, expected: c.expected, actual, passed: actual === c.expected };
  });
}

export function runInteractiveOfflineEvaluation(): InteractiveEvalResult[] {
  return evaluateInteractiveCases(buildInteractiveEvalCases());
}

/** Nonzero when any case produced an unexpected outcome (or no case ran at all). */
export function exitCodeFor(results: readonly InteractiveEvalResult[]): number {
  return results.length > 0 && results.every((r) => r.passed) ? 0 : 1;
}

function main(): void {
  const results = runInteractiveOfflineEvaluation();
  const failed = results.filter((r) => !r.passed);
  const count = (kind: InteractiveEvalKind) => results.filter((r) => r.kind === kind).length;
  console.log('Interactive engine offline evaluation');
  console.log('');
  console.log(`Scenario: ${scenario.id}@${scenario.version}`);
  console.log(
    `Cases: ${results.length} (valid ${count('valid')}, adversarial ${count('adversarial')})`,
  );
  console.log(`Passed: ${results.length - failed.length}`);
  console.log(`Failed: ${failed.length}`);
  console.log('Services required: none');
  console.log('External API calls: 0');
  console.log('API keys required: 0');
  console.log('');
  for (const result of results) {
    const detail = result.passed ? '' : ` [expected ${result.expected}, got ${result.actual}]`;
    console.log(
      `${result.passed ? 'PASS' : 'FAIL'} ${result.kind.padEnd(11)} ${result.id} -> ${result.expected}${detail}`,
    );
  }
  process.exitCode = exitCodeFor(results);
}

if (require.main === module) main();
