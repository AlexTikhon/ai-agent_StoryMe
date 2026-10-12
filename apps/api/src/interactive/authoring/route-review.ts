import {
  DomainError,
  applyChoice,
  startSession,
  verifyReplay,
  type DomainEvent,
} from '../domain/engine';
import { buildCanonicalNarration, validateNarration } from '../domain/narration';
import { hashScenarioDefinition, type ScenarioDefinition } from '../domain/scenario-schema';
import type { InteractiveState } from '../domain/state';
import { buildPublicView, type PublicSessionView } from '../public-view';
import { NOT_PROVEN } from './review';

/**
 * Exhaustive route review: every playable terminal choice sequence of one
 * mechanically valid candidate, with the player-visible text along it. A
 * read-only editorial artifact, derived entirely from production code:
 * `availableChoices` (through the public projection), `applyChoice`,
 * `verifyReplay`, `validateNarration` and `buildPublicView`. No transition or
 * narration-selection rule is reproduced here.
 *
 * It is not a public API and not a session transcript: full state, NPC
 * knowledge, internal flags, template ids and raw events are never copied
 * into it. Listing every route helps a person read the prose; it does not
 * establish prose quality and approves, registers and publishes nothing.
 */

export const ROUTE_REVIEW_SCHEMA_VERSION = 'interactive-route-review/v1';

export interface RouteReviewBounds {
  /** Terminal routes the review may list. */
  maxRoutes: number;
  /** Choices on one route. */
  maxDepth: number;
  /** `applyChoice` calls across the whole walk. */
  maxTransitions: number;
  /** Characters of authored text collected, and of the rendered artifact. */
  maxOutputChars: number;
}

export const DEFAULT_ROUTE_REVIEW_BOUNDS: Readonly<RouteReviewBounds> = {
  maxRoutes: 100,
  maxDepth: 32,
  maxTransitions: 1_000,
  maxOutputChars: 500_000,
};

export type RouteReviewFailureCode =
  | 'INVALID_BOUNDS'
  | 'ROUTE_LIMIT'
  | 'DEPTH_LIMIT'
  | 'TRANSITION_LIMIT'
  | 'OUTPUT_LIMIT'
  | 'DEAD_END'
  | 'NARRATION_REJECTED'
  | 'REPLAY_MISMATCH'
  | 'INTERNAL';

export interface RouteReviewChoice {
  id: string;
  label: string;
}

export interface RouteReviewChapter {
  sceneId: string;
  sceneTitle: string;
  /** Exactly what the player reads in this scene on this route. */
  narration: string;
  /** The choice taken from this scene; null on the terminal scene. */
  choice: RouteReviewChoice | null;
}

export interface RouteReviewRoute {
  /** 1-based position in the deterministic walk order. */
  index: number;
  choices: RouteReviewChoice[];
  chapters: RouteReviewChapter[];
  ending: { id: string; title: string; summary: string };
}

export interface RouteReview {
  schemaVersion: typeof ROUTE_REVIEW_SCHEMA_VERSION;
  status: 'REVIEW_REQUIRED';
  approved: false;
  editorialStatus: 'UNREVIEWED';
  publication: 'NOT_PUBLISHED';
  /** Every playable terminal choice sequence is listed; a bound failure never yields a report. */
  exhaustive: true;
  candidate: { id: string; version: number; title: string; hash: string };
  counts: {
    routes: number;
    endingsDeclared: number;
    endingsReached: number;
    transitionsExplored: number;
    maxRouteLength: number;
  };
  endings: Array<{
    id: string;
    title: string;
    summary: string;
    routeCount: number;
    routeIndexes: number[];
  }>;
  routes: RouteReviewRoute[];
  notProven: string[];
}

export type RouteReviewResult =
  { ok: true; report: RouteReview } | { ok: false; code: RouteReviewFailureCode; detail: string };

export const ROUTE_REVIEW_NOTES = [
  'Exhaustive route coverage helps a person read every playable path. It does not establish prose quality and grants no approval.',
  'Routes are not de-duplicated: different choice sequences stay separate even when they reach the same state or ending.',
  'This is an editorial artifact, not a public API response or a historical session transcript.',
] as const;

// ── Bounds ──────────────────────────────────────────────────────────────────

function resolveBounds(
  overrides: Partial<RouteReviewBounds> | undefined,
): RouteReviewBounds | null {
  const bounds = { ...DEFAULT_ROUTE_REVIEW_BOUNDS, ...(overrides ?? {}) };
  const valid = Object.values(bounds).every((value) => Number.isSafeInteger(value) && value > 0);
  return valid ? bounds : null;
}

class RouteReviewStop extends Error {
  constructor(
    readonly code: RouteReviewFailureCode,
    readonly detail: string,
  ) {
    super(code);
  }
}

// ── Walk ────────────────────────────────────────────────────────────────────

export function buildRouteReview(input: {
  scenario: ScenarioDefinition;
  bounds?: Partial<RouteReviewBounds> | undefined;
}): RouteReviewResult {
  const { scenario } = input;
  const bounds = resolveBounds(input.bounds);
  if (!bounds) {
    return { ok: false, code: 'INVALID_BOUNDS', detail: 'bounds must be positive integers' };
  }

  const routes: RouteReviewRoute[] = [];
  let transitions = 0;
  let textChars = 0;

  /** Canonical narration, accepted by the production contract, through the public projection. */
  const project = (state: InteractiveState): PublicSessionView => {
    const narration = buildCanonicalNarration(scenario, state);
    if (!validateNarration(narration, scenario, state).ok) {
      throw new RouteReviewStop('NARRATION_REJECTED', 'canonical narration failed validation');
    }
    return buildPublicView({ sessionId: 'route-review', scenario, state, narration });
  };

  const walk = (
    state: InteractiveState,
    events: readonly DomainEvent[],
    choices: readonly RouteReviewChoice[],
    chapters: readonly RouteReviewChapter[],
  ): void => {
    const view = project(state);
    const scene = {
      sceneId: view.scene.id,
      sceneTitle: view.scene.title,
      narration: view.narration,
    };

    if (state.endingId !== null) {
      if (!view.ending) {
        throw new RouteReviewStop('INTERNAL', 'terminal state has no declared ending');
      }
      if (routes.length >= bounds.maxRoutes) {
        throw new RouteReviewStop('ROUTE_LIMIT', `more than ${bounds.maxRoutes} routes`);
      }
      const route: RouteReviewRoute = {
        index: routes.length + 1,
        choices: [...choices],
        chapters: [...chapters, { ...scene, choice: null }],
        ending: { id: view.ending.id, title: view.ending.title, summary: view.ending.summary },
      };
      textChars += routeTextLength(route);
      if (textChars > bounds.maxOutputChars) {
        throw new RouteReviewStop('OUTPUT_LIMIT', `more than ${bounds.maxOutputChars} characters`);
      }
      routes.push(route);
      return;
    }

    if (view.choices.length === 0) {
      throw new RouteReviewStop('DEAD_END', 'a reachable state has no available choice');
    }
    if (choices.length >= bounds.maxDepth) {
      throw new RouteReviewStop('DEPTH_LIMIT', `a route is longer than ${bounds.maxDepth} choices`);
    }
    for (const choice of view.choices) {
      if (transitions >= bounds.maxTransitions) {
        throw new RouteReviewStop(
          'TRANSITION_LIMIT',
          `more than ${bounds.maxTransitions} transitions`,
        );
      }
      transitions += 1;

      let applied;
      try {
        applied = applyChoice(state, choice.id, scenario);
      } catch (error) {
        if (error instanceof DomainError) {
          throw new RouteReviewStop('INTERNAL', 'an offered choice was refused by the engine');
        }
        throw error;
      }
      const nextEvents = [...events, applied.event];
      try {
        verifyReplay(nextEvents, applied.state, scenario);
      } catch {
        throw new RouteReviewStop('REPLAY_MISMATCH', 'replay of the event log diverged');
      }
      const taken: RouteReviewChoice = { id: choice.id, label: choice.label };
      walk(
        applied.state,
        nextEvents,
        [...choices, taken],
        [...chapters, { ...scene, choice: taken }],
      );
    }
  };

  try {
    const genesis = startSession(scenario);
    walk(genesis.state, [genesis.event], [], []);
  } catch (error) {
    if (error instanceof RouteReviewStop) {
      return { ok: false, code: error.code, detail: error.detail };
    }
    return { ok: false, code: 'INTERNAL', detail: 'unexpected route review failure' };
  }

  const endings = scenario.endings.map((ending) => {
    const reached = routes.filter((route) => route.ending.id === ending.id);
    return {
      id: ending.id,
      title: ending.title,
      summary: ending.summary,
      routeCount: reached.length,
      routeIndexes: reached.map((route) => route.index),
    };
  });

  return {
    ok: true,
    report: {
      schemaVersion: ROUTE_REVIEW_SCHEMA_VERSION,
      status: 'REVIEW_REQUIRED',
      approved: false,
      editorialStatus: 'UNREVIEWED',
      publication: 'NOT_PUBLISHED',
      exhaustive: true,
      candidate: {
        id: scenario.id,
        version: scenario.version,
        title: scenario.title,
        hash: hashScenarioDefinition(scenario),
      },
      counts: {
        routes: routes.length,
        endingsDeclared: scenario.endings.length,
        endingsReached: endings.filter((ending) => ending.routeCount > 0).length,
        transitionsExplored: transitions,
        maxRouteLength: routes.reduce((max, route) => Math.max(max, route.choices.length), 0),
      },
      endings,
      routes,
      notProven: [...ROUTE_REVIEW_NOTES, ...NOT_PROVEN],
    },
  };
}

function routeTextLength(route: RouteReviewRoute): number {
  const chapters = route.chapters.reduce(
    (sum, chapter) =>
      sum +
      chapter.sceneTitle.length +
      chapter.narration.length +
      (chapter.choice ? chapter.choice.label.length : 0),
    0,
  );
  return chapters + route.ending.title.length + route.ending.summary.length;
}

// ── Terminal / Markdown safety ──────────────────────────────────────────────

const REPLACEMENT = String.fromCharCode(0xfffd);

/** Invisible format characters that can reorder or hide text. ZWJ (U+200D) stays: emoji use it. */
const INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x200b, 0x200c],
  [0x200e, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];

function isNewline(code: number): boolean {
  return code === 0x0a || code === 0x0d || code === 0x85 || code === 0x2028 || code === 0x2029;
}

function isUnsafeControl(code: number): boolean {
  if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  return INVISIBLE_RANGES.some(([from, to]) => code >= from && code <= to);
}

/** Splits authored text into display lines with every terminal control neutralized. */
function displayLines(text: string): string[] {
  const lines: string[] = [];
  let current = '';
  let previousWasCr = false;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code === 0x0a && previousWasCr) {
      previousWasCr = false;
      continue;
    }
    previousWasCr = code === 0x0d;
    if (isNewline(code)) {
      lines.push(current);
      current = '';
    } else if (code === 0x09) {
      current += ' ';
    } else if (isUnsafeControl(code)) {
      current += REPLACEMENT;
    } else {
      current += ch;
    }
  }
  lines.push(current);
  return lines.map((line) => line.trim());
}

const MARKDOWN_SPECIAL = /[\\`*_{}[\]()#+!|<>~&$^@:]/g;

/** One authored line, escaped so that Markdown and HTML show it literally. */
function escapeMarkdownLine(line: string): string {
  return line
    .replace(MARKDOWN_SPECIAL, '\\$&')
    .replace(/(^|[^A-Za-z0-9])(www)\./gi, '$1$2\\.')
    .replace(/^(\d{1,9})([.)])/, '$1\\$2')
    .replace(/^[-=]/, '\\$&');
}

/** Single-line authored text for headings and list items. */
function inlineText(text: string): string {
  return displayLines(text)
    .filter((line) => line.length > 0)
    .map(escapeMarkdownLine)
    .join(' ');
}

/** Multi-line authored text as a block quote; every line is quoted so none starts a block. */
function quote(text: string): string[] {
  return displayLines(text).map((line) =>
    line.length > 0 ? `> ${escapeMarkdownLine(line)}` : '>',
  );
}

const code = (value: string): string => `\`${value}\``;

export function renderRouteReviewMarkdown(report: RouteReview): string {
  const { candidate, counts } = report;
  const out: string[] = [];
  const push = (...lines: string[]) => out.push(...lines);

  push(
    `# Route review: ${inlineText(candidate.title)} (${code(candidate.id)} v${candidate.version})`,
    '',
    '> **STATUS: REVIEW_REQUIRED. approved: false. NOT_PUBLISHED.**',
    '> This candidate is mechanically valid, NOT approved and NOT published.',
    '> Listing every route helps a person read the prose; it does not establish prose quality.',
    '',
    '## Identity',
    '',
    `- Candidate: ${code(candidate.id)}, version ${candidate.version}`,
    `- Candidate hash: ${code(candidate.hash)}`,
    `- Report schema: ${code(report.schemaVersion)}`,
    `- Editorial status: ${report.editorialStatus}`,
    `- Approved: ${String(report.approved)}`,
    `- Publication: ${report.publication}`,
    '',
    '## Summary',
    '',
    `- Routes: ${counts.routes} (every playable choice sequence; paths are not de-duplicated)`,
    `- Endings reached: ${counts.endingsReached} of ${counts.endingsDeclared} declared`,
    `- Longest route: ${counts.maxRouteLength} choices`,
    `- Transitions explored: ${counts.transitionsExplored}`,
    '',
    '## Endings',
    '',
  );
  for (const ending of report.endings) {
    push(
      `### Ending ${code(ending.id)}: ${inlineText(ending.title)}`,
      '',
      ending.routeIndexes.length > 0
        ? `Reached by ${ending.routeCount} route(s): ${ending.routeIndexes.join(', ')}`
        : 'Reached by no route.',
      '',
      ...quote(ending.summary),
      '',
    );
  }

  push('## Routes', '');
  for (const route of report.routes) {
    push(
      `### Route ${route.index} (ending ${code(route.ending.id)})`,
      '',
      'Choices in order:',
      '',
      ...route.choices.map(
        (choice, i) => `${i + 1}. ${code(choice.id)}: ${inlineText(choice.label)}`,
      ),
      '',
    );
    route.chapters.forEach((chapter, i) => {
      push(
        `#### Chapter ${i + 1}: ${inlineText(chapter.sceneTitle)} (${code(chapter.sceneId)})`,
        '',
        ...quote(chapter.narration),
        '',
        chapter.choice
          ? `Choice taken: ${code(chapter.choice.id)}: ${inlineText(chapter.choice.label)}`
          : 'The story ends here.',
        '',
      );
    });
    push(
      `#### Ending: ${inlineText(route.ending.title)} (${code(route.ending.id)})`,
      '',
      ...quote(route.ending.summary),
      '',
    );
  }

  push(
    '## What this report does not prove',
    '',
    ...report.notProven.map((note) => `- ${note}`),
    '',
  );
  return out.join('\n');
}

/** Deterministic JSON. Characters a terminal may act on are written as \\uXXXX escapes. */
export function renderRouteReviewJson(report: RouteReview): string {
  const json = JSON.stringify(report, null, 2);
  let out = '';
  for (const ch of json) {
    const codePoint = ch.codePointAt(0)!;
    // JSON.stringify already escaped C0 controls inside strings; only its own newlines remain.
    const unsafe = codePoint !== 0x0a && (isUnsafeControl(codePoint) || isNewline(codePoint));
    out += unsafe ? `\\u${codePoint.toString(16).padStart(4, '0')}` : ch;
  }
  return out;
}

// ── Export ──────────────────────────────────────────────────────────────────

export type RouteReviewFormat = 'json' | 'markdown';

export type RouteReviewExport =
  | { ok: true; text: string; report: RouteReview }
  | { ok: false; code: RouteReviewFailureCode; detail: string };

/** Builds and renders; the rendered artifact is bounded too, so no partial text is ever returned. */
export function exportRouteReview(input: {
  scenario: ScenarioDefinition;
  format: RouteReviewFormat;
  bounds?: Partial<RouteReviewBounds> | undefined;
}): RouteReviewExport {
  const built = buildRouteReview({ scenario: input.scenario, bounds: input.bounds });
  if (!built.ok) return built;
  const bounds = resolveBounds(input.bounds)!;
  const text =
    input.format === 'json'
      ? renderRouteReviewJson(built.report)
      : renderRouteReviewMarkdown(built.report);
  if (text.length > bounds.maxOutputChars) {
    return {
      ok: false,
      code: 'OUTPUT_LIMIT',
      detail: `rendered report exceeds ${bounds.maxOutputChars} characters`,
    };
  }
  return { ok: true, text, report: built.report };
}
