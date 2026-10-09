import { canonicalJson, sha256Hex } from '../domain/canonical';
import {
  DomainError,
  applyChoice,
  availableChoices,
  playChoices,
  verifyReplay,
} from '../domain/engine';
import { buildCanonicalNarration, validateNarration } from '../domain/narration';
import { analyzeScenario, MAX_EXPLORED_STATES } from '../domain/scenario-analysis';
import {
  hashScenarioDefinition,
  parseScenarioDefinition,
  ScenarioValidationError,
  type ScenarioDefinition,
} from '../domain/scenario-schema';
import { createInitialState, hashState } from '../domain/state';
import { getScenario } from '../scenarios';
import type { ScenarioBrief } from './brief';
import {
  boundDiagnostics,
  diagnostic,
  VALIDATION_STAGES,
  type Diagnostic,
  type ValidationStage,
} from './diagnostics';
import {
  MAX_CANDIDATE_CHARS,
  MAX_CHOICES_PER_SCENE,
  MAX_FACTS,
  MAX_FLAGS,
  MAX_ITEMS,
  MAX_NORMALIZED_CANDIDATE_BYTES,
  MAX_SCENES,
  MIN_SCENES,
  REQUIRED_CHARACTERS,
  REQUIRED_DECISION_POINTS,
  REQUIRED_ENDINGS,
} from './limits';
import { normalizeWire, wireScenarioSchema } from './wire';

/**
 * The deterministic validation pipeline. It adds only the authoring-format
 * constraints; everything about rules and playability is delegated to the
 * existing domain code (schema, structural checks, exhaustive play analysis,
 * real transitions, event replay, canonical narration).
 *
 * "Valid" here means MECHANICALLY valid. It never means the prose is
 * consistent, spoiler-free or publishable: `factIds` are assertions supplied by
 * the author, and nothing here can prove free text matches them.
 */

export interface WitnessRoute {
  endingId: string;
  choiceIds: string[];
  sceneIds: string[];
  /** Prefixes replayed with verifyReplay and checked with validateNarration. */
  stepsVerified: number;
}

export interface MechanicalReport {
  stages: Array<{ stage: ValidationStage; passed: true }>;
  analysis: {
    reachableStateCount: number;
    reachableEndings: string[];
    usedChoiceCount: number;
    totalChoiceCount: number;
  };
  witnessRoutes: WitnessRoute[];
  /** Reachable states whose canonical narration was accepted by validateNarration. */
  narrationStatesChecked: number;
}

export type ValidationOutcome =
  | {
      ok: true;
      scenario: ScenarioDefinition;
      candidateHash: string;
      report: MechanicalReport;
    }
  | {
      ok: false;
      stage: ValidationStage;
      diagnostics: Diagnostic[];
      droppedDiagnostics: number;
      /** SHA-256 of the rejected raw output, so a rejected run is traceable without storing it. */
      rawSha256: string | null;
    };

export interface ValidationContext {
  brief: ScenarioBrief;
  /** Registry lookup; injectable so tests can simulate a collision. */
  isPublished?: (id: string, version: number) => boolean;
  /** Injectable to prove cyclic graphs are rejected before exhaustive exploration. */
  analyze?: typeof analyzeScenario;
}

export const isPublishedInRegistry = (id: string, version: number): boolean =>
  getScenario(id, version) !== undefined;

// ── Authoring-specific constraints ──────────────────────────────────────────

const ac = (code: string, message: string) => diagnostic('authoring-constraints', code, message);

/** Returns a scene-id cycle such as ["a","b","a"], or null when the graph is acyclic. */
export function findSceneCycle(scenario: ScenarioDefinition): string[] | null {
  const edges = new Map(scenario.scenes.map((s) => [s.id, s.choices.map((c) => c.to)]));
  const state = new Map<string, 'visiting' | 'done'>();
  const path: string[] = [];

  const visit = (id: string): string[] | null => {
    state.set(id, 'visiting');
    path.push(id);
    for (const next of edges.get(id) ?? []) {
      if (state.get(next) === 'visiting') return [...path.slice(path.indexOf(next)), next];
      if (!state.has(next)) {
        const found = visit(next);
        if (found) return found;
      }
    }
    path.pop();
    state.set(id, 'done');
    return null;
  };

  for (const scene of scenario.scenes) {
    if (!state.has(scene.id)) {
      const found = visit(scene.id);
      if (found) return found;
    }
  }
  return null;
}

export function countDecisionPoints(scenario: ScenarioDefinition): number {
  return scenario.scenes.filter((s) => s.choices.length >= 2).length;
}

export function collectAuthoringIssues(scenario: ScenarioDefinition): Diagnostic[] {
  const issues: Diagnostic[] = [];
  const range = (code: string, label: string, n: number, min: number, max: number) => {
    if (n < min || n > max) {
      issues.push(ac(code, `${label}: ${n} (allowed ${min === max ? min : `${min}-${max}`})`));
    }
  };
  range('SCENE_COUNT', 'scenes', scenario.scenes.length, MIN_SCENES, MAX_SCENES);
  range('ENDING_COUNT', 'endings', scenario.endings.length, REQUIRED_ENDINGS, REQUIRED_ENDINGS);
  range(
    'CHARACTER_COUNT',
    'characters',
    scenario.characters.length,
    REQUIRED_CHARACTERS,
    REQUIRED_CHARACTERS,
  );
  range(
    'PLAYER_COUNT',
    'player characters',
    scenario.characters.filter((c) => c.isPlayer).length,
    1,
    1,
  );
  range(
    'DECISION_POINTS',
    'decision points (scenes with 2+ choices)',
    countDecisionPoints(scenario),
    REQUIRED_DECISION_POINTS,
    REQUIRED_DECISION_POINTS,
  );
  range('FACT_COUNT', 'facts', scenario.facts.length, 0, MAX_FACTS);
  range('ITEM_COUNT', 'items', scenario.items.length, 0, MAX_ITEMS);
  range('FLAG_COUNT', 'flags', scenario.flags.length, 0, MAX_FLAGS);
  for (const scene of scenario.scenes) {
    if (scene.choices.length > MAX_CHOICES_PER_SCENE) {
      issues.push(
        ac(
          'CHOICES_PER_SCENE',
          `scene "${scene.id}" has ${scene.choices.length} choices (max ${MAX_CHOICES_PER_SCENE})`,
        ),
      );
    }
  }

  const cycle = findSceneCycle(scenario);
  if (cycle) issues.push(ac('SCENE_GRAPH_CYCLE', `scene graph is cyclic: ${cycle.join(' -> ')}`));

  const bytes = Buffer.byteLength(canonicalJson(scenario), 'utf8');
  if (bytes > MAX_NORMALIZED_CANDIDATE_BYTES) {
    issues.push(
      ac('CANDIDATE_SIZE', `candidate is ${bytes} bytes (max ${MAX_NORMALIZED_CANDIDATE_BYTES})`),
    );
  }
  return issues;
}

// ── Witness routes ──────────────────────────────────────────────────────────

const wr = (code: string, message: string) => diagnostic('witness-routes', code, message);

interface WitnessSearch {
  routes: Map<string, string[]>;
  narrationStatesChecked: number;
  issues: Diagnostic[];
}

/**
 * Breadth-first search with the real transition rules (availableChoices /
 * applyChoice) for the shortest route to every ending. Every reachable state's
 * canonical narration is also validated, so over-long or malformed rendering is
 * caught even off the witness routes. Bounded by MAX_EXPLORED_STATES.
 */
export function searchWitnessRoutes(scenario: ScenarioDefinition): WitnessSearch {
  const issues: Diagnostic[] = [];
  const routes = new Map<string, string[]>();
  const initial = createInitialState(scenario);
  const seen = new Set<string>([hashState(initial)]);
  const queue: Array<{ state: typeof initial; route: string[] }> = [{ state: initial, route: [] }];
  let narrationStatesChecked = 0;

  while (queue.length > 0) {
    const { state, route } = queue.shift()!;

    const narration = validateNarration(buildCanonicalNarration(scenario, state), scenario, state);
    if (narration.ok) narrationStatesChecked += 1;
    else {
      issues.push(wr(narration.code, `scene "${state.sceneId}": canonical narration rejected`));
    }

    if (state.endingId !== null) {
      if (!routes.has(state.endingId)) routes.set(state.endingId, route);
      continue;
    }
    for (const choice of availableChoices(state, scenario)) {
      let next;
      try {
        next = applyChoice(state, choice.id, scenario).state;
      } catch (error) {
        issues.push(
          wr(
            error instanceof DomainError ? error.code : 'TRANSITION_FAILED',
            `choice "${choice.id}" failed to apply`,
          ),
        );
        continue;
      }
      const key = hashState(next);
      if (seen.has(key)) continue;
      if (seen.size >= MAX_EXPLORED_STATES) {
        issues.push(wr('STATE_SPACE', `state space exceeds ${MAX_EXPLORED_STATES} states`));
        return { routes, narrationStatesChecked, issues };
      }
      seen.add(key);
      queue.push({ state: next, route: [...route, choice.id] });
    }
  }
  return { routes, narrationStatesChecked, issues };
}

/** Replays every prefix of a route and checks canonical narration at each step. */
function verifyRoute(
  scenario: ScenarioDefinition,
  endingId: string,
  route: readonly string[],
  issues: Diagnostic[],
): WitnessRoute {
  const sceneIds: string[] = [];
  let stepsVerified = 0;
  try {
    for (let k = 0; k <= route.length; k += 1) {
      const prefix = playChoices(scenario, route.slice(0, k));
      verifyReplay(prefix.events, prefix.state, scenario);
      const narration = validateNarration(
        buildCanonicalNarration(scenario, prefix.state),
        scenario,
        prefix.state,
      );
      if (!narration.ok) {
        issues.push(wr(narration.code, `route to "${endingId}": narration rejected at step ${k}`));
        break;
      }
      sceneIds.push(prefix.state.sceneId);
      stepsVerified += 1;
      if (k === route.length && prefix.state.endingId !== endingId) {
        issues.push(wr('ROUTE_ENDING_MISMATCH', `route to "${endingId}" ended elsewhere`));
      }
    }
  } catch (error) {
    issues.push(
      wr(
        error instanceof DomainError ? error.code : 'ROUTE_REPLAY_FAILED',
        `route to "${endingId}": replay failed`,
      ),
    );
  }
  return { endingId, choiceIds: [...route], sceneIds, stepsVerified };
}

// ── Pipeline ────────────────────────────────────────────────────────────────

function fail(
  stage: ValidationStage,
  issues: readonly Diagnostic[],
  rawSha256: string | null,
): ValidationOutcome {
  const bounded = boundDiagnostics(issues);
  return {
    ok: false,
    stage,
    diagnostics: bounded.diagnostics,
    droppedDiagnostics: bounded.dropped,
    rawSha256,
  };
}

const cf = (code: string, message: string) => diagnostic('candidate-format', code, message);
const idn = (code: string, message: string) => diagnostic('identity', code, message);

function describeSet(items: readonly string[]): string {
  return [...items].sort().join(',');
}

export function validateCandidate(raw: unknown, context: ValidationContext): ValidationOutcome {
  const isPublished = context.isPublished ?? isPublishedInRegistry;
  const analyze = context.analyze ?? analyzeScenario;
  const { brief } = context;

  // 1. Bounded text → JSON → wire DTO → normalized runtime candidate.
  let text: string | undefined;
  let value: unknown;
  if (typeof raw === 'string') {
    text = raw;
  } else {
    try {
      text = JSON.stringify(raw);
    } catch {
      text = undefined;
    }
  }
  const rawSha256 = text === undefined ? null : sha256Hex(text);
  if (text === undefined)
    return fail('candidate-format', [cf('NOT_JSON', 'output is not JSON')], null);
  if (text.length > MAX_CANDIDATE_CHARS) {
    return fail(
      'candidate-format',
      [cf('RESPONSE_TOO_LARGE', `output exceeds ${MAX_CANDIDATE_CHARS} characters`)],
      rawSha256,
    );
  }
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return fail('candidate-format', [cf('NOT_JSON', 'output is not valid JSON')], rawSha256);
    }
  } else {
    value = raw;
  }

  const wire = wireScenarioSchema.safeParse(value);
  if (!wire.success) {
    return fail(
      'candidate-format',
      wire.error.issues.map((i) =>
        cf('WIRE_SCHEMA', `${i.path.join('.') || '(root)'}: ${i.message}`),
      ),
      rawSha256,
    );
  }
  const normalized = normalizeWire(wire.data);
  if (!normalized.ok) return fail('candidate-format', normalized.diagnostics, rawSha256);

  // 2. Identity comes from the brief; the provider may not change it.
  const identity: Diagnostic[] = [];
  if (wire.data.id !== brief.scenarioId) {
    identity.push(idn('IDENTITY_MISMATCH', 'candidate id differs from the brief'));
  }
  if (wire.data.version !== brief.version) {
    identity.push(idn('IDENTITY_MISMATCH', 'candidate version differs from the brief'));
  }
  if (isPublished(brief.scenarioId, brief.version)) {
    identity.push(
      idn('IDENTITY_ALREADY_PUBLISHED', 'brief identity is already in the scenario registry'),
    );
  }
  const characterKey = (cs: ReadonlyArray<{ id: string; isPlayer: boolean }>) =>
    describeSet(cs.map((c) => `${c.id}:${c.isPlayer}`));
  if (characterKey(wire.data.characters) !== characterKey(brief.characters)) {
    identity.push(
      idn('BRIEF_CHARACTERS_MISMATCH', 'character ids/player flag differ from the brief'),
    );
  }
  if (
    describeSet(wire.data.endings.map((e) => e.id)) !== describeSet(brief.endings.map((e) => e.id))
  ) {
    identity.push(idn('BRIEF_ENDINGS_MISMATCH', 'ending ids differ from the brief'));
  }
  if (identity.length > 0) return fail('identity', identity, rawSha256);

  // 3. Strict runtime schema + existing structural checks.
  let scenario: ScenarioDefinition;
  try {
    scenario = parseScenarioDefinition(normalized.candidate);
  } catch (error) {
    const issues =
      error instanceof ScenarioValidationError ? error.issues : ['candidate failed validation'];
    return fail(
      'definition',
      issues.map((m) => diagnostic('definition', 'DEFINITION_INVALID', m)),
      rawSha256,
    );
  }

  // 4. Authoring format (counts, DAG, size) — before any exhaustive exploration.
  const authoring = collectAuthoringIssues(scenario);
  if (authoring.length > 0) return fail('authoring-constraints', authoring, rawSha256);

  // 5. Existing exhaustive play analysis.
  const analysis = analyze(scenario);
  if (analysis.issues.length > 0) {
    return fail(
      'play-analysis',
      analysis.issues.map((m) => diagnostic('play-analysis', 'PLAY_ANALYSIS', m)),
      rawSha256,
    );
  }

  // 6. Witness routes to both endings, replayed with canonical narration checks.
  const search = searchWitnessRoutes(scenario);
  const routeIssues = [...search.issues];
  for (const ending of scenario.endings) {
    if (!search.routes.has(ending.id)) {
      routeIssues.push(wr('NO_WITNESS_ROUTE', `no route reaches ending "${ending.id}"`));
    }
  }
  const witnessRoutes = [...search.routes.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([endingId, route]) => verifyRoute(scenario, endingId, route, routeIssues));
  if (routeIssues.length > 0) return fail('witness-routes', routeIssues, rawSha256);

  return {
    ok: true,
    scenario,
    candidateHash: hashScenarioDefinition(scenario),
    report: {
      stages: VALIDATION_STAGES.map((stage) => ({ stage, passed: true as const })),
      analysis: {
        reachableStateCount: analysis.reachableStateCount,
        reachableEndings: analysis.reachableEndings,
        usedChoiceCount: analysis.usedChoiceIds.length,
        totalChoiceCount: scenario.scenes.reduce((n, s) => n + s.choices.length, 0),
      },
      witnessRoutes,
      narrationStatesChecked: search.narrationStatesChecked,
    },
  };
}
