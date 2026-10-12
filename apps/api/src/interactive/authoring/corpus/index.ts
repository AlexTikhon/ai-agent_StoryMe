import type { DomainErrorCode } from '../../domain/engine';
import type { ScenarioDefinition } from '../../domain/scenario-schema';
import type { ScenarioBrief } from '../brief';
import { LAST_TRAM_BRIEF, LAST_TRAM_SCENARIO } from '../the-last-tram';
import { CLOCK_BLACKOUT_BRIEF, CLOCK_BLACKOUT_SCENARIO } from './clock-museum-blackout';
import { HARBOUR_LEDGER_BRIEF, HARBOUR_LEDGER_SCENARIO } from './harbour-night-ledger';

/**
 * Versioned offline corpus for the scenario-authoring evaluation: fixed briefs
 * and hand-authored candidates with recorded expectations. It exists so the
 * deterministic validation, repair, reporting and route-review tooling can be
 * exercised against more than one story shape.
 *
 * It is regression coverage, not evidence about any model: every candidate is
 * scripted, nothing here is approved or published, and no entry is reachable
 * from the scenario registry, the catalogue or a presentation pack. Adding an
 * entry never changes production behaviour.
 *
 * The expectations are recorded literals. They are compared with what the
 * production engine actually does, never derived from it, so an edit to a
 * fixture that changes a route, an ending, a hash or a selected narration
 * template fails loudly and has to be re-recorded on purpose.
 */

export const AUTHORING_CORPUS_VERSION = 'interactive-authoring-corpus/v1';

export interface CorpusRoute {
  /** Complete choice sequence from the entry scene to an ending. */
  choices: readonly string[];
  endingId: string;
}

export interface CorpusNarrationProbe {
  /** Choices played from the start; the probe describes the state they reach. */
  after: readonly string[];
  sceneId: string;
  /** Exactly the templates the canonical narration selects there, in order. */
  templateIds: readonly string[];
  /** Fragments the player-visible text must contain / must not contain. */
  includes: readonly string[];
  excludes: readonly string[];
}

export interface CorpusLockedChoice {
  after: readonly string[];
  /** Declared in the scene reached by `after`, yet not offered and refused. */
  choiceId: string;
  code: DomainErrorCode;
}

export interface CorpusExpectations {
  identity: { scenarioId: string; version: number };
  /** `hashBrief(brief)` and `hashScenarioDefinition(scenario)`, recorded. */
  briefHash: string;
  candidateHash: string;
  /** Every playable terminal sequence, in the production walk order. */
  routes: readonly CorpusRoute[];
  narration: readonly CorpusNarrationProbe[];
  lockedChoices: readonly CorpusLockedChoice[];
  /** Gameplay behaviour the entry is there to exercise. */
  exercises: readonly string[];
}

export interface CorpusEntry {
  key: 'last-tram' | 'harbour-ledger' | 'clock-blackout';
  brief: ScenarioBrief;
  scenario: ScenarioDefinition;
  expect: CorpusExpectations;
}

const LAST_TRAM: CorpusEntry = {
  key: 'last-tram',
  // The existing fixture, by reference: the corpus never holds a second copy of it.
  brief: LAST_TRAM_BRIEF,
  scenario: LAST_TRAM_SCENARIO,
  expect: {
    identity: { scenarioId: 'warsaw-last-tram', version: 1 },
    briefHash: '9a4e42e8c176847aa23d1be1e2243d81a620843bd440519ffc9ba9610a1a5a79',
    candidateHash: '7eba089e687c9b1567ef480575df62bac5f7f9fce0cfd257ce2a2015aa3c3d1e',
    routes: [
      {
        choices: ['c-ask-driver', 'c-leave-cab', 'c-open-panel', 'c-report-to-depot'],
        endingId: 'report-filed',
      },
      {
        choices: ['c-ask-driver', 'c-leave-cab', 'c-wait-for-terminus', 'c-report-to-depot'],
        endingId: 'report-filed',
      },
      {
        choices: ['c-inspect-carriage', 'c-pocket-receipt', 'c-show-receipt', 'c-report-to-depot'],
        endingId: 'report-filed',
      },
      {
        choices: ['c-inspect-carriage', 'c-pocket-receipt', 'c-show-receipt', 'c-let-hanna-repay'],
        endingId: 'quiet-repayment',
      },
      {
        choices: [
          'c-inspect-carriage',
          'c-pocket-receipt',
          'c-wait-for-terminus',
          'c-report-to-depot',
        ],
        endingId: 'report-filed',
      },
    ],
    narration: [
      {
        after: ['c-ask-driver', 'c-leave-cab', 'c-open-panel'],
        sceneId: 's-terminus',
        templateIds: ['t-terminus-arrive', 't-terminus-panel'],
        includes: ['cash box she found behind the panel'],
        excludes: ['I only meant to borrow'],
      },
      {
        after: ['c-inspect-carriage', 'c-pocket-receipt', 'c-show-receipt'],
        sceneId: 's-terminus',
        templateIds: ['t-terminus-arrive', 't-terminus-receipt'],
        includes: ['I only meant to borrow the money'],
        excludes: ['cash box she found behind the panel'],
      },
      {
        after: ['c-ask-driver', 'c-leave-cab', 'c-open-panel', 'c-report-to-depot'],
        sceneId: 's-ending-report',
        templateIds: ['t-report-base', 't-report-driver', 't-report-recovered'],
        includes: ['dented lid and intact lock'],
        excludes: ['Hanna’s own account'],
      },
      {
        after: [
          'c-inspect-carriage',
          'c-pocket-receipt',
          'c-wait-for-terminus',
          'c-report-to-depot',
        ],
        sceneId: 's-ending-report',
        templateIds: ['t-report-base', 't-report-waited'],
        includes: ['no one has said where it went'],
        excludes: ['dented lid and intact lock'],
      },
      {
        after: ['c-inspect-carriage', 'c-pocket-receipt', 'c-show-receipt', 'c-let-hanna-repay'],
        sceneId: 's-ending-quiet',
        templateIds: ['t-quiet-base', 't-quiet-hanna', 't-quiet-driver'],
        includes: ['back by morning'],
        excludes: [],
      },
    ],
    lockedChoices: [
      { after: ['c-ask-driver', 'c-leave-cab'], choiceId: 'c-show-receipt', code: 'ITEM_NOT_HELD' },
      {
        after: ['c-inspect-carriage', 'c-pocket-receipt'],
        choiceId: 'c-open-panel',
        code: 'ITEM_NOT_HELD',
      },
      {
        after: ['c-ask-driver', 'c-leave-cab', 'c-open-panel'],
        choiceId: 'c-let-hanna-repay',
        code: 'KNOWLEDGE_NOT_LEARNED',
      },
    ],
    exercises: [
      'item-gated choices with a one-time key spent on use',
      'a knowledge-gated ending choice that stays hidden on routes that never learned the fact',
      'flag-conditional narration at the terminus and in both endings',
      'an NPC learning a fact (npcLearns) that it voices only in the ending that follows',
    ],
  },
};

const HARBOUR_LEDGER: CorpusEntry = {
  key: 'harbour-ledger',
  brief: HARBOUR_LEDGER_BRIEF,
  scenario: HARBOUR_LEDGER_SCENARIO,
  expect: {
    identity: { scenarioId: 'harbour-night-ledger', version: 1 },
    briefHash: '2625b4bef92441a4f0c7ba4b477dfd2da1d815360d8969a077928a119edd1343',
    candidateHash: '55fd94443a10d9eb8794e1cd7c61710b8ba63d46b1ba04baeb9a4e3dadcc5c85',
    routes: [
      {
        choices: [
          'c-read-ledger',
          'c-carry-ledger-to-quay',
          'c-press-bram',
          'c-walk-to-cold-room',
          'c-name-the-page',
        ],
        endingId: 'page-returned',
      },
      {
        choices: [
          'c-read-ledger',
          'c-carry-ledger-to-quay',
          'c-press-bram',
          'c-walk-to-cold-room',
          'c-seal-the-ledger',
        ],
        endingId: 'ledger-sealed',
      },
      {
        choices: [
          'c-read-ledger',
          'c-carry-ledger-to-quay',
          'c-small-talk',
          'c-head-to-cold-room',
          'c-offer-quiet-word',
        ],
        endingId: 'page-returned',
      },
      {
        choices: [
          'c-read-ledger',
          'c-carry-ledger-to-quay',
          'c-small-talk',
          'c-head-to-cold-room',
          'c-seal-the-ledger',
        ],
        endingId: 'ledger-sealed',
      },
      {
        choices: ['c-go-to-quay', 'c-small-talk', 'c-head-to-cold-room', 'c-offer-quiet-word'],
        endingId: 'page-returned',
      },
      {
        choices: ['c-go-to-quay', 'c-small-talk', 'c-head-to-cold-room', 'c-seal-the-ledger'],
        endingId: 'ledger-sealed',
      },
    ],
    narration: [
      {
        after: ['c-go-to-quay'],
        sceneId: 's-quay',
        templateIds: ['t-quay-base', 't-quay-guarded'],
        includes: ['the hall is not his business'],
        excludes: ['The torn edge is frozen'],
      },
      {
        after: ['c-read-ledger', 'c-carry-ledger-to-quay'],
        sceneId: 's-quay',
        templateIds: ['t-quay-base', 't-quay-frost'],
        includes: ['The torn edge is frozen'],
        excludes: ['the hall is not his business'],
      },
      {
        after: ['c-read-ledger', 'c-carry-ledger-to-quay', 'c-press-bram'],
        sceneId: 's-bram-names-her',
        templateIds: ['t-names-base', 't-names-bram'],
        includes: ['carry that ledger into the cold room'],
        excludes: ['jumpy'],
      },
      {
        after: ['c-read-ledger', 'c-carry-ledger-to-quay', 'c-small-talk'],
        sceneId: 's-bram-shrugs',
        templateIds: ['t-shrugs-base', 't-shrugs-bram', 't-shrugs-held-back'],
        includes: ['keeps the frost on the ledger to herself'],
        excludes: [],
      },
      {
        after: ['c-go-to-quay', 'c-small-talk'],
        sceneId: 's-bram-shrugs',
        templateIds: ['t-shrugs-base', 't-shrugs-bram'],
        includes: ['jumpy'],
        excludes: ['keeps the frost on the ledger to herself'],
      },
      {
        after: ['c-read-ledger', 'c-carry-ledger-to-quay', 'c-press-bram', 'c-walk-to-cold-room'],
        sceneId: 's-cold-room',
        templateIds: ['t-cold-base', 't-cold-ines-evidence'],
        includes: ['carry the ledger in here'],
        excludes: ['Everyone thinks I cheated them'],
      },
      {
        after: ['c-go-to-quay', 'c-small-talk', 'c-head-to-cold-room'],
        sceneId: 's-cold-room',
        templateIds: ['t-cold-base', 't-cold-solveig-afraid'],
        includes: ['Everyone thinks I cheated them'],
        excludes: ['carry the ledger in here'],
      },
      {
        after: [
          'c-read-ledger',
          'c-carry-ledger-to-quay',
          'c-press-bram',
          'c-walk-to-cold-room',
          'c-name-the-page',
        ],
        sceneId: 's-ending-returned',
        templateIds: ['t-returned-base', 't-returned-evidence'],
        includes: ['a third of what it was worth'],
        excludes: ['exactly what a cheat would do'],
      },
      {
        after: ['c-go-to-quay', 'c-small-talk', 'c-head-to-cold-room', 'c-offer-quiet-word'],
        sceneId: 's-ending-returned',
        templateIds: ['t-returned-base', 't-returned-empathy'],
        includes: ['exactly what a cheat would do'],
        excludes: ['a third of what it was worth'],
      },
      {
        after: [
          'c-read-ledger',
          'c-carry-ledger-to-quay',
          'c-press-bram',
          'c-walk-to-cold-room',
          'c-seal-the-ledger',
        ],
        sceneId: 's-ending-sealed',
        templateIds: ['t-sealed-base', 't-sealed-frost'],
        includes: ['the torn edge was frozen'],
        excludes: ['the book shows only a gap'],
      },
      {
        after: ['c-go-to-quay', 'c-small-talk', 'c-head-to-cold-room', 'c-seal-the-ledger'],
        sceneId: 's-ending-sealed',
        templateIds: ['t-sealed-base', 't-sealed-unknown'],
        includes: ['the book shows only a gap'],
        excludes: ['the torn edge was frozen'],
      },
    ],
    lockedChoices: [
      { after: ['c-go-to-quay'], choiceId: 'c-press-bram', code: 'KNOWLEDGE_NOT_LEARNED' },
      {
        after: ['c-read-ledger', 'c-carry-ledger-to-quay', 'c-press-bram', 'c-walk-to-cold-room'],
        choiceId: 'c-offer-quiet-word',
        code: 'KNOWLEDGE_NOT_LEARNED',
      },
      {
        after: ['c-read-ledger', 'c-carry-ledger-to-quay', 'c-small-talk', 'c-head-to-cold-room'],
        choiceId: 'c-name-the-page',
        code: 'KNOWLEDGE_NOT_LEARNED',
      },
      {
        after: ['c-go-to-quay', 'c-small-talk', 'c-head-to-cold-room'],
        choiceId: 'c-name-the-page',
        code: 'KNOWLEDGE_NOT_LEARNED',
      },
    ],
    exercises: [
      'three choices gated on what the player has learned (playerKnows), so the options differ by route',
      'what the player tells an NPC changes what that NPC can voice (npcLearns plus speaker knowledge)',
      'the same NPC speaks differently depending on what the player already knows',
      'two different gated choices reconverge on one ending that narrates how it was reached',
    ],
  },
};

const CLOCK_BLACKOUT: CorpusEntry = {
  key: 'clock-blackout',
  brief: CLOCK_BLACKOUT_BRIEF,
  scenario: CLOCK_BLACKOUT_SCENARIO,
  expect: {
    identity: { scenarioId: 'clock-museum-blackout', version: 1 },
    briefHash: 'b8baa34e6b1e78a239057490d37190dbdabab9d4f80304226322b3125d77ae95',
    candidateHash: '6a372a7f20abe022fe639b7561a1f39764b0535a034291748bdb1afa219251e0',
    routes: [
      {
        choices: [
          'c-open-workshop',
          'c-carry-fuse-to-regulator',
          'c-fit-fuse',
          'c-note-damage-and-lock-up',
        ],
        endingId: 'regulator-preserved',
      },
      {
        choices: [
          'c-open-workshop',
          'c-carry-fuse-to-regulator',
          'c-leave-case-shut',
          'c-note-damage-and-lock-up',
        ],
        endingId: 'regulator-preserved',
      },
      {
        choices: [
          'c-cross-gallery',
          'c-reach-the-regulator',
          'c-unlock-glass-case',
          'c-start-pendulum',
        ],
        endingId: 'regulator-restarted',
      },
      {
        choices: [
          'c-cross-gallery',
          'c-reach-the-regulator',
          'c-unlock-glass-case',
          'c-note-damage-and-lock-up',
        ],
        endingId: 'regulator-preserved',
      },
      {
        choices: [
          'c-cross-gallery',
          'c-reach-the-regulator',
          'c-leave-case-shut',
          'c-open-case-and-start',
        ],
        endingId: 'regulator-restarted',
      },
      {
        choices: [
          'c-cross-gallery',
          'c-reach-the-regulator',
          'c-leave-case-shut',
          'c-note-damage-and-lock-up',
        ],
        endingId: 'regulator-preserved',
      },
    ],
    narration: [
      {
        after: [],
        sceneId: 's-lobby',
        templateIds: ['t-lobby-base', 't-lobby-jonas', 't-lobby-mira'],
        includes: ['Generator has an hour in it'],
        excludes: [],
      },
      {
        after: ['c-open-workshop', 'c-carry-fuse-to-regulator'],
        sceneId: 's-regulator-room',
        templateIds: ['t-regulator-base', 't-regulator-cecily', 't-regulator-fuse'],
        includes: ['is gone for good'],
        excludes: ['still in Mira’s pocket'],
      },
      {
        after: ['c-cross-gallery', 'c-reach-the-regulator'],
        sceneId: 's-regulator-room',
        templateIds: ['t-regulator-base', 't-regulator-cecily', 't-regulator-key'],
        includes: ['still in Mira’s pocket'],
        excludes: ['is gone for good'],
      },
      {
        after: ['c-open-workshop', 'c-carry-fuse-to-regulator', 'c-fit-fuse'],
        sceneId: 's-clock-face',
        templateIds: ['t-clockface-base', 't-clockface-lit'],
        includes: ['Lights are back'],
        excludes: ['unspent'],
      },
      {
        after: ['c-cross-gallery', 'c-reach-the-regulator', 'c-unlock-glass-case'],
        sceneId: 's-clock-face',
        templateIds: ['t-clockface-base', 't-clockface-dark', 't-clockface-open'],
        includes: ['stands open at Mira’s elbow'],
        excludes: ['unspent'],
      },
      {
        after: ['c-cross-gallery', 'c-reach-the-regulator', 'c-leave-case-shut'],
        sceneId: 's-clock-face',
        templateIds: [
          't-clockface-base',
          't-clockface-dark',
          't-clockface-shut',
          't-clockface-key',
        ],
        includes: ['still in her pocket, unspent'],
        excludes: [],
      },
      {
        after: ['c-open-workshop', 'c-carry-fuse-to-regulator', 'c-leave-case-shut'],
        sceneId: 's-clock-face',
        templateIds: ['t-clockface-base', 't-clockface-dark', 't-clockface-shut'],
        includes: ['still shut'],
        excludes: ['unspent'],
      },
      {
        after: [
          'c-cross-gallery',
          'c-reach-the-regulator',
          'c-unlock-glass-case',
          'c-start-pendulum',
        ],
        sceneId: 's-ending-restarted',
        templateIds: ['t-restarted-base', 't-restarted-early'],
        includes: ['only a fingertip'],
        excludes: ['gives way to it only now'],
      },
      {
        after: [
          'c-cross-gallery',
          'c-reach-the-regulator',
          'c-leave-case-shut',
          'c-open-case-and-start',
        ],
        sceneId: 's-ending-restarted',
        templateIds: ['t-restarted-base', 't-restarted-late'],
        includes: ['gives way to it only now'],
        excludes: ['only a fingertip'],
      },
      {
        after: [
          'c-open-workshop',
          'c-carry-fuse-to-regulator',
          'c-fit-fuse',
          'c-note-damage-and-lock-up',
        ],
        sceneId: 's-ending-preserved',
        templateIds: ['t-preserved-base', 't-preserved-lit'],
        includes: ['lights are on at last'],
        excludes: ['bring their own lamps'],
      },
      {
        after: [
          'c-cross-gallery',
          'c-reach-the-regulator',
          'c-leave-case-shut',
          'c-note-damage-and-lock-up',
        ],
        sceneId: 's-ending-preserved',
        templateIds: [
          't-preserved-base',
          't-preserved-dark',
          't-preserved-shut',
          't-preserved-key',
        ],
        includes: ['back on its hook, unspent'],
        excludes: ['lights are on at last'],
      },
    ],
    lockedChoices: [
      {
        after: ['c-open-workshop', 'c-carry-fuse-to-regulator'],
        choiceId: 'c-unlock-glass-case',
        code: 'ITEM_ALREADY_CONSUMED',
      },
      {
        after: ['c-cross-gallery', 'c-reach-the-regulator'],
        choiceId: 'c-fit-fuse',
        code: 'ITEM_NOT_HELD',
      },
      {
        after: ['c-cross-gallery', 'c-reach-the-regulator', 'c-unlock-glass-case'],
        choiceId: 'c-open-case-and-start',
        code: 'ITEM_ALREADY_CONSUMED',
      },
      {
        after: ['c-open-workshop', 'c-carry-fuse-to-regulator', 'c-fit-fuse'],
        choiceId: 'c-open-case-and-start',
        code: 'ITEM_ALREADY_CONSUMED',
      },
      {
        after: ['c-open-workshop', 'c-carry-fuse-to-regulator', 'c-fit-fuse'],
        choiceId: 'c-start-pendulum',
        code: 'PREREQUISITE_NOT_MET',
      },
      {
        after: ['c-cross-gallery', 'c-reach-the-regulator', 'c-leave-case-shut'],
        choiceId: 'c-start-pendulum',
        code: 'PREREQUISITE_NOT_MET',
      },
    ],
    exercises: [
      'a one-time key that can be spent on only one of two jobs, so spending it closes the other',
      'a spent key or fuse that can neither be required nor handed out again on any later choice',
      'choices that are locked by an item that was never held, and by one that was consumed',
      'four routes that reconverge on one scene and two on one ending, with narration that records what was spent and what was kept',
    ],
  },
};

/** Fixed order: Last Tram first, then the two corpus fixtures. */
export const AUTHORING_CORPUS: readonly CorpusEntry[] = [LAST_TRAM, HARBOUR_LEDGER, CLOCK_BLACKOUT];
