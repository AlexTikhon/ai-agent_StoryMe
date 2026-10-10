import { sha256Hex } from '../domain/canonical';
import {
  DomainError,
  applyChoice,
  startSession,
  verifyReplay,
  type DomainEvent,
} from '../domain/engine';
import { buildCanonicalNarration, validateNarration } from '../domain/narration';
import type { ScenarioDefinition } from '../domain/scenario-schema';
import type { InteractiveState } from '../domain/state';
import type { Diagnostic, ValidationStage } from '../authoring/diagnostics';
import { validateNormalizedScenario, type MechanicalReport } from '../authoring/validate';
import { MAX_CANDIDATE_FILE_BYTES } from '../publication/preflight';
import { buildPublicView, type PublicSessionView } from '../public-view';

/**
 * Offline draft playtest. A thin, read-only driver over the production engine:
 * every transition, replay check, narration check and player-facing projection
 * is the same code a real session uses (`applyChoice`, `verifyReplay`,
 * `validateNarration`, `buildPublicView`). No transition rule is reproduced
 * here. It needs no database, queue, provider, framework or filesystem, and it
 * approves, registers and publishes nothing: playing every route is not review.
 */

export { MAX_CANDIDATE_FILE_BYTES };

/** Scenarios are DAGs of at most 8 scenes, so a real route is far shorter. */
export const MAX_ROUTE_STEPS = 32;
export const MAX_ROUTE_ARG_CHARS = 2048;
export const MAX_CHOICE_ID_CHARS = 64;
/** Total lines an interactive session may read, rejected ones included. */
export const MAX_INPUT_LINES = 100;
export const MAX_TRANSCRIPT_CHARS = 200_000;

const CHOICE_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

export type PlaytestStatus = 'COMPLETED' | 'INCOMPLETE' | 'CANCELLED' | 'FAILED';

export type PlaytestFailureCode =
  | 'CHOICE_NOT_AVAILABLE'
  | 'SESSION_ENDED'
  | 'ROUTE_TOO_LONG'
  | 'ROUTE_MALFORMED'
  | 'NARRATION_REJECTED'
  | 'REPLAY_MISMATCH'
  | 'DEAD_END'
  | 'INPUT_LIMIT'
  | 'TRANSCRIPT_LIMIT'
  | 'INTERNAL';

export interface PlaytestResult {
  status: PlaytestStatus;
  failureCode: PlaytestFailureCode | null;
  /** Fixed, safe human sentence; never contains authored text or engine internals. */
  detail: string;
  endingId: string | null;
  /** Choice ids that were accepted, in order. */
  route: string[];
  /** Interactive lines that were refused without changing anything. */
  rejectedInputs: number;
  events: DomainEvent[];
  state: InteractiveState;
}

// ── Candidate loading ───────────────────────────────────────────────────────

export type CandidateLoad =
  | {
      ok: true;
      scenario: ScenarioDefinition;
      /** Canonical hash (`hashScenarioDefinition`), independent of file formatting. */
      candidateHash: string;
      report: MechanicalReport;
    }
  | {
      ok: false;
      code: 'CANDIDATE_TOO_LARGE' | 'CANDIDATE_NOT_JSON' | 'CANDIDATE_INVALID';
      message: string;
      stage: ValidationStage | null;
      diagnostics: Diagnostic[];
      droppedDiagnostics: number;
    };

/**
 * Parses the TEXT of a normalized runtime candidate (validated-candidate.json,
 * not the provider wire format) and re-runs every mechanical check. Approval is
 * not required; mechanical validity is.
 */
export function loadPlaytestCandidate(text: string): CandidateLoad {
  const failure = (
    code: 'CANDIDATE_TOO_LARGE' | 'CANDIDATE_NOT_JSON' | 'CANDIDATE_INVALID',
    message: string,
  ): CandidateLoad => ({
    ok: false,
    code,
    message,
    stage: null,
    diagnostics: [],
    droppedDiagnostics: 0,
  });
  if (Buffer.byteLength(text, 'utf8') > MAX_CANDIDATE_FILE_BYTES) {
    return failure('CANDIDATE_TOO_LARGE', `candidate exceeds ${MAX_CANDIDATE_FILE_BYTES} bytes`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return failure('CANDIDATE_NOT_JSON', 'candidate is not valid JSON');
  }
  const outcome = validateNormalizedScenario(raw, sha256Hex(text));
  if (!outcome.ok) {
    return {
      ok: false,
      code: 'CANDIDATE_INVALID',
      message: `candidate failed mechanical validation at stage "${outcome.stage}"`,
      stage: outcome.stage,
      diagnostics: outcome.diagnostics,
      droppedDiagnostics: outcome.droppedDiagnostics,
    };
  }
  return {
    ok: true,
    scenario: outcome.scenario,
    candidateHash: outcome.candidateHash,
    report: outcome.report,
  };
}

/** Always printed first: identity, hash and what a playtest does NOT do. */
export function formatBanner(candidate: Extract<CandidateLoad, { ok: true }>): string[] {
  const { scenario, candidateHash, report } = candidate;
  return [
    'LOCAL PLAYTEST (offline, read-only)',
    'Playing a route does not approve the prose, record an approval, register the scenario or publish anything.',
    `Candidate: ${scenario.id}@${scenario.version} "${clean(scenario.title)}"`,
    `Candidate hash: ${candidateHash}`,
    `Mechanical validation: passed (${report.analysis.reachableStateCount} reachable states, ` +
      `${report.witnessRoutes.length} witness routes, ${report.narrationStatesChecked} narration states)`,
  ];
}

// ── Route parsing ───────────────────────────────────────────────────────────

export type RouteParse =
  | { ok: true; choiceIds: string[] }
  | { ok: false; code: 'ROUTE_TOO_LONG' | 'ROUTE_MALFORMED'; message: string };

export function parseRoute(raw: string): RouteParse {
  if (raw.length > MAX_ROUTE_ARG_CHARS) {
    return { ok: false, code: 'ROUTE_TOO_LONG', message: 'route argument is too long' };
  }
  const parts = raw.split(',').map((part) => part.trim());
  if (parts.length > MAX_ROUTE_STEPS) {
    return {
      ok: false,
      code: 'ROUTE_TOO_LONG',
      message: `route has more than ${MAX_ROUTE_STEPS} choices`,
    };
  }
  if (!parts.every(isChoiceId)) {
    return {
      ok: false,
      code: 'ROUTE_MALFORMED',
      message: `route must be comma-separated choice ids (letters, digits, . _ : -, at most ${MAX_CHOICE_ID_CHARS} characters each)`,
    };
  }
  return { ok: true, choiceIds: parts };
}

function isChoiceId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_CHOICE_ID_CHARS && CHOICE_ID_PATTERN.test(value);
}

// ── Input contract (interactive mode) ───────────────────────────────────────

export type LineRead =
  { kind: 'line'; text: string } | { kind: 'oversized' } | { kind: 'eof' } | { kind: 'cancelled' };

export interface LineSource {
  next(): Promise<LineRead>;
  close(): void;
}

// ── Output helpers ──────────────────────────────────────────────────────────

/** Authored text may contain terminal escapes; collapse every control character. */
function clean(text: string): string {
  return text.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim();
}

class PlaytestStop extends Error {
  constructor(
    readonly code: PlaytestFailureCode,
    readonly detail: string,
  ) {
    super(code);
  }
}

/** Counts characters and refuses to print past the transcript bound. */
function boundedOut(write: (line: string) => void, maxChars: number): (line: string) => void {
  let total = 0;
  return (line) => {
    total += line.length + 1;
    if (total > maxChars) {
      throw new PlaytestStop('TRANSCRIPT_LIMIT', 'transcript output limit reached');
    }
    write(line);
  };
}

function formatView(view: PublicSessionView): string[] {
  const lines = ['', `== ${clean(view.scene.title)} ==`, clean(view.narration)];
  lines.push('Clues:');
  if (view.player.knowledge.length === 0) lines.push('  (none)');
  for (const fact of view.player.knowledge) lines.push(`  - ${clean(fact.text)}`);
  lines.push('Inventory:');
  if (view.player.inventory.length === 0) lines.push('  (none)');
  for (const item of view.player.inventory) lines.push(`  - ${clean(item.name)}`);
  if (view.ending) {
    lines.push(`*** ENDING: ${clean(view.ending.title)} ***`, clean(view.ending.summary));
  } else {
    lines.push('Choices:');
    view.choices.forEach((choice, index) => lines.push(`  ${index + 1}. ${clean(choice.label)}`));
  }
  return lines;
}

// ── Playthrough: the engine, driven one validated step at a time ────────────

type Advance = { ok: true } | { ok: false; code: 'CHOICE_NOT_AVAILABLE' | 'SESSION_ENDED' };

class Playthrough {
  events: DomainEvent[];
  state: InteractiveState;
  view: PublicSessionView;
  route: string[] = [];

  constructor(private readonly scenario: ScenarioDefinition) {
    const genesis = startSession(scenario);
    this.events = [genesis.event];
    this.state = genesis.state;
    this.view = this.project(genesis.state);
  }

  get ended(): boolean {
    return this.state.endingId !== null;
  }

  /** Canonical narration, validated by the production contract, through the public projection. */
  private project(state: InteractiveState): PublicSessionView {
    const narration = buildCanonicalNarration(this.scenario, state);
    if (!validateNarration(narration, this.scenario, state).ok) {
      throw new PlaytestStop('NARRATION_REJECTED', 'canonical narration failed validation');
    }
    return buildPublicView({
      sessionId: 'local-playtest',
      scenario: this.scenario,
      state,
      narration,
    });
  }

  /**
   * Applies one choice. A refusal changes nothing and reveals only that the
   * choice is unavailable (never which requirement blocks it).
   */
  advance(choiceId: string): Advance {
    let applied;
    try {
      applied = applyChoice(this.state, choiceId, this.scenario);
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      return {
        ok: false,
        code: error.code === 'SESSION_TERMINAL' ? 'SESSION_ENDED' : 'CHOICE_NOT_AVAILABLE',
      };
    }
    const events = [...this.events, applied.event];
    try {
      verifyReplay(events, applied.state, this.scenario);
    } catch {
      throw new PlaytestStop('REPLAY_MISMATCH', 'replay of the event log diverged from the state');
    }
    const view = this.project(applied.state);
    this.events = events;
    this.state = applied.state;
    this.view = view;
    this.route = [...this.route, choiceId];
    return { ok: true };
  }

  result(
    status: PlaytestStatus,
    detail: string,
    failureCode: PlaytestFailureCode | null = null,
    rejectedInputs = 0,
  ): PlaytestResult {
    return {
      status,
      failureCode,
      detail,
      endingId: this.state.endingId,
      route: [...this.route],
      rejectedInputs,
      events: [...this.events],
      state: this.state,
    };
  }
}

function stopResult(run: Playthrough, stop: PlaytestStop, rejected: number): PlaytestResult {
  return run.result('FAILED', stop.detail, stop.code, rejected);
}

// ── Scripted mode ───────────────────────────────────────────────────────────

export interface ScriptedOptions {
  scenario: ScenarioDefinition;
  choiceIds: readonly string[];
  out: (line: string) => void;
  signal?: AbortSignal | undefined;
  maxTranscriptChars?: number | undefined;
}

export function runScriptedPlaytest(options: ScriptedOptions): PlaytestResult {
  const { scenario, choiceIds, signal } = options;
  const run = new Playthrough(scenario);
  const emit = boundedOut(options.out, options.maxTranscriptChars ?? MAX_TRANSCRIPT_CHARS);
  try {
    if (choiceIds.length > MAX_ROUTE_STEPS) {
      return run.result(
        'FAILED',
        `route has more than ${MAX_ROUTE_STEPS} choices`,
        'ROUTE_TOO_LONG',
      );
    }
    if (!choiceIds.every(isChoiceId)) {
      return run.result('FAILED', 'route contains a malformed choice id', 'ROUTE_MALFORMED');
    }
    for (const line of formatView(run.view)) emit(line);
    for (const [index, choiceId] of choiceIds.entries()) {
      if (signal?.aborted) return run.result('CANCELLED', 'playtest was cancelled');
      const step = index + 1;
      const label = run.view.choices.find((c) => c.id === choiceId)?.label;
      const advanced = run.advance(choiceId);
      if (!advanced.ok) {
        return run.result(
          'FAILED',
          advanced.code === 'SESSION_ENDED'
            ? `step ${step}: the story already ended, so "${choiceId}" was not applied`
            : `step ${step}: choice "${choiceId}" is not available here`,
          advanced.code,
        );
      }
      emit('');
      emit(`> ${clean(label ?? choiceId)}`);
      for (const line of formatView(run.view)) emit(line);
    }
    return run.ended
      ? run.result('COMPLETED', `reached ending "${run.state.endingId}"`)
      : run.result('INCOMPLETE', 'the route stopped before reaching an ending');
  } catch (error) {
    if (error instanceof PlaytestStop) return stopResult(run, error, 0);
    return run.result('FAILED', 'unexpected playtest failure', 'INTERNAL');
  }
}

// ── Interactive mode ────────────────────────────────────────────────────────

export interface InteractiveOptions {
  scenario: ScenarioDefinition;
  input: LineSource;
  out: (line: string) => void;
  signal?: AbortSignal | undefined;
  maxTranscriptChars?: number | undefined;
}

export async function runInteractivePlaytest(options: InteractiveOptions): Promise<PlaytestResult> {
  const { scenario, input, signal } = options;
  const run = new Playthrough(scenario);
  const emit = boundedOut(options.out, options.maxTranscriptChars ?? MAX_TRANSCRIPT_CHARS);
  let rejected = 0;
  try {
    for (const line of formatView(run.view)) emit(line);
    // Every pass reads exactly one line, so MAX_INPUT_LINES bounds the loop.
    for (let linesRead = 0; ; linesRead += 1) {
      if (run.ended)
        return run.result('COMPLETED', `reached ending "${run.state.endingId}"`, null, rejected);
      const count = run.view.choices.length;
      if (count === 0) {
        return run.result('FAILED', 'the story has no available choices', 'DEAD_END', rejected);
      }
      if (signal?.aborted) return run.result('CANCELLED', 'playtest was cancelled', null, rejected);
      if (linesRead >= MAX_INPUT_LINES) {
        return run.result('FAILED', 'too many input lines', 'INPUT_LIMIT', rejected);
      }
      emit('');
      emit(`Choose 1-${count}, or q to quit:`);

      const read = await input.next();
      if (read.kind === 'cancelled') {
        return run.result('CANCELLED', 'playtest was cancelled', null, rejected);
      }
      if (read.kind === 'eof') {
        return run.result('INCOMPLETE', 'input ended before an ending was reached', null, rejected);
      }
      const text = read.kind === 'line' ? read.text.trim() : null;
      if (text !== null && /^(q|quit)$/i.test(text)) {
        return run.result('CANCELLED', 'playtest was cancelled', null, rejected);
      }
      const picked = text !== null && /^[1-9][0-9]?$/.test(text) ? Number(text) : 0;
      const choice = picked >= 1 && picked <= count ? run.view.choices[picked - 1] : undefined;
      const advanced = choice ? run.advance(choice.id) : null;
      if (!choice || !advanced || !advanced.ok) {
        rejected += 1;
        emit(`Not a valid choice. Enter a number from 1 to ${count}, or q to quit.`);
        continue;
      }
      emit('');
      emit(`> ${clean(choice.label)}`);
      for (const line of formatView(run.view)) emit(line);
    }
  } catch (error) {
    if (error instanceof PlaytestStop) return stopResult(run, error, rejected);
    return run.result('FAILED', 'unexpected playtest failure', 'INTERNAL', rejected);
  }
}
