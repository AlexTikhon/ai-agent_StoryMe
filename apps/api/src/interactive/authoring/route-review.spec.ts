import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyChoice,
  availableChoices,
  playChoices,
  startSession,
  verifyReplay,
} from '../domain/engine';
import { buildCanonicalNarration } from '../domain/narration';
import { hashScenarioDefinition, type ScenarioDefinition } from '../domain/scenario-schema';
import type { InteractiveState } from '../domain/state';
import {
  DEFAULT_ROUTE_REVIEW_BOUNDS,
  ROUTE_REVIEW_SCHEMA_VERSION,
  buildRouteReview,
  exportRouteReview,
  renderRouteReviewJson,
  renderRouteReviewMarkdown,
  type RouteReview,
  type RouteReviewBounds,
} from './route-review';
import { validateNormalizedScenario } from './validate';
import { LAST_TRAM_SCENARIO } from './the-last-tram';

const scenario: ScenarioDefinition = LAST_TRAM_SCENARIO;

const EXPECTED_ROUTES = [
  ['c-ask-driver', 'c-leave-cab', 'c-open-panel', 'c-report-to-depot'],
  ['c-ask-driver', 'c-leave-cab', 'c-wait-for-terminus', 'c-report-to-depot'],
  ['c-inspect-carriage', 'c-pocket-receipt', 'c-show-receipt', 'c-report-to-depot'],
  ['c-inspect-carriage', 'c-pocket-receipt', 'c-show-receipt', 'c-let-hanna-repay'],
  ['c-inspect-carriage', 'c-pocket-receipt', 'c-wait-for-terminus', 'c-report-to-depot'],
];

/** The test's own walk over the production engine; deliberately independent of the unit under test. */
function walkRoutes(target: ScenarioDefinition): string[][] {
  const routes: string[][] = [];
  const walk = (state: InteractiveState, route: string[]): void => {
    if (state.endingId !== null) {
      routes.push(route);
      return;
    }
    for (const choice of availableChoices(state, target)) {
      walk(applyChoice(state, choice.id, target).state, [...route, choice.id]);
    }
  };
  walk(startSession(target).state, []);
  return routes;
}

function reviewOf(target: ScenarioDefinition, bounds?: Partial<RouteReviewBounds>): RouteReview {
  const result = buildRouteReview({ scenario: target, ...(bounds ? { bounds } : {}) });
  if (!result.ok) throw new Error(`expected a review, got ${result.code}`);
  return result.report;
}

/** Same scenario with a second, differently worded way to file the report. */
function withTwinReportChoice(): ScenarioDefinition {
  const clone = structuredClone(scenario);
  const terminus = clone.scenes.find((s) => s.id === 's-terminus')!;
  terminus.choices.push({
    id: 'c-file-report-again',
    label: 'Fill in the depot form by hand',
    to: 's-ending-report',
    effects: [],
  });
  return clone;
}

function hostileScenario(): ScenarioDefinition {
  const clone = structuredClone(scenario);
  const start = clone.scenes[0]!;
  start.title = '<img src=x onerror=alert(1)> & *Boarding*';
  start.narration[0]!.text =
    '# Injected heading\n- injected item\n1. injected number\n\n<script>alert(1)</script> **bold** _it_ `code` [link](javascript:alert(1)) https://evil.example/x www.evil.example a@evil.example &amp; \u001b[31mred\u001b[0m\u202eevil\u2028next\u0085end';
  start.choices[0]!.label = '> quoted | pipe ~~strike~~ \u001b]0;title\u0007 label';
  clone.endings[0]!.title = '| Table | Title |';
  clone.endings[0]!.summary = '---\n=== setext\n    indented code\n[ref]: http://evil.example';
  return clone;
}

describe('buildRouteReview', () => {
  it('lists exactly the five terminal routes of The Last Tram, in engine order', () => {
    const review = reviewOf(scenario);
    expect(review.routes.map((r) => r.choices.map((c) => c.id))).toEqual(walkRoutes(scenario));
    expect(review.routes.map((r) => r.choices.map((c) => c.id).join('>')).sort()).toEqual(
      EXPECTED_ROUTES.map((r) => r.join('>')).sort(),
    );
    expect(review.counts.routes).toBe(5);
    expect(review.counts.endingsDeclared).toBe(2);
    expect(review.counts.endingsReached).toBe(2);
  });

  it('carries identity, hash and the unapproved / unpublished labels', () => {
    const review = reviewOf(scenario);
    expect(review.schemaVersion).toBe(ROUTE_REVIEW_SCHEMA_VERSION);
    expect(review.status).toBe('REVIEW_REQUIRED');
    expect(review.approved).toBe(false);
    expect(review.editorialStatus).toBe('UNREVIEWED');
    expect(review.publication).toBe('NOT_PUBLISHED');
    expect(review.exhaustive).toBe(true);
    expect(review.candidate).toEqual({
      id: scenario.id,
      version: scenario.version,
      title: scenario.title,
      hash: hashScenarioDefinition(scenario),
    });
    expect(review.notProven.join(' ')).toMatch(/prose quality/i);
  });

  it('keeps different paths to the same ending as separate routes', () => {
    const review = reviewOf(scenario);
    const toReport = review.routes.filter((r) => r.ending.id === 'report-filed');
    expect(toReport).toHaveLength(4);
    expect(new Set(toReport.map((r) => r.choices.map((c) => c.id).join('>'))).size).toBe(4);
    const summary = review.endings.find((e) => e.id === 'report-filed')!;
    expect(summary.routeCount).toBe(4);
    expect(summary.routeIndexes).toEqual(toReport.map((r) => r.index));
  });

  it('keeps interchangeable choices as separate routes instead of collapsing them', () => {
    const twin = withTwinReportChoice();
    expect(validateNormalizedScenario(JSON.parse(JSON.stringify(twin)), null).ok).toBe(true);
    const review = reviewOf(twin);
    expect(review.counts.routes).toBe(9);
    const ids = review.routes.map((r) => r.choices.map((c) => c.id).join('>'));
    expect(new Set(ids).size).toBe(9);
    expect(review.endings.find((e) => e.id === 'report-filed')!.routeCount).toBe(8);
    const narrations = review.routes
      .filter((r) => r.choices.at(-1)!.id.startsWith('c-file-report'))
      .map((r) => r.chapters.at(-1)!.narration);
    expect(narrations).toHaveLength(4);
  });

  it('never traverses a locked choice', () => {
    const review = reviewOf(scenario);
    for (const route of review.routes) {
      const ids = route.choices.map((c) => c.id);
      let state = startSession(scenario).state;
      for (const id of ids) {
        expect(availableChoices(state, scenario).map((c) => c.id)).toContain(id);
        state = applyChoice(state, id, scenario).state;
      }
      expect(state.endingId).toBe(route.ending.id);
    }
    const quiet = review.routes.filter((r) => r.choices.some((c) => c.id === 'c-let-hanna-repay'));
    expect(quiet).toHaveLength(1);
    expect(quiet[0]!.choices.map((c) => c.id)).toContain('c-show-receipt');
  });

  it('matches the production engine for every chapter, label and ending', () => {
    const review = reviewOf(scenario);
    const sceneOf = (id: string) => scenario.scenes.find((s) => s.id === id)!;
    for (const route of review.routes) {
      expect(route.chapters).toHaveLength(route.choices.length + 1);
      route.chapters.forEach((chapter, index) => {
        const prefix = route.choices.slice(0, index).map((c) => c.id);
        const { state } = playChoices(scenario, prefix);
        expect(chapter.sceneId).toBe(state.sceneId);
        expect(chapter.sceneTitle).toBe(sceneOf(state.sceneId).title);
        expect(chapter.narration).toBe(buildCanonicalNarration(scenario, state).text);
        const taken = route.choices[index] ?? null;
        expect(chapter.choice).toEqual(taken);
        if (taken) {
          const label = sceneOf(state.sceneId).choices.find((c) => c.id === taken.id)!.label;
          expect(taken.label).toBe(label);
        }
      });
      const ending = scenario.endings.find((e) => e.id === route.ending.id)!;
      expect(route.ending).toEqual({ id: ending.id, title: ending.title, summary: ending.summary });
    }
  });

  it('shows conditional narration only where the production conditions hold', () => {
    const review = reviewOf(scenario);
    const finalNarration = (choiceIds: string[]) =>
      review.routes
        .find((r) => r.choices.map((c) => c.id).join('>') === choiceIds.join('>'))!
        .chapters.at(-1)!.narration;
    const panel = finalNarration(EXPECTED_ROUTES[0]!);
    const waited = finalNarration(EXPECTED_ROUTES[1]!);
    expect(panel).not.toBe(waited);
    expect(panel).toContain('recovered box');
    expect(waited).not.toContain('recovered box');
  });

  it('replays every route and reaches its ending', () => {
    const review = reviewOf(scenario);
    for (const route of review.routes) {
      const { events, state } = playChoices(
        scenario,
        route.choices.map((c) => c.id),
      );
      expect(() => verifyReplay(events, state, scenario)).not.toThrow();
      expect(state.endingId).toBe(route.ending.id);
    }
  });

  it('exposes only editorial fields: no state, NPC knowledge, flags or events', () => {
    const review = reviewOf(scenario);
    const forbidden = [
      'npcKnowledge',
      'playerKnowledge',
      'flags',
      'stateHash',
      'payload',
      'consumedItems',
      'inventory',
      'history',
      'revision',
      'events',
    ];
    const keys = new Set<string>();
    const collect = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(collect);
      else if (value && typeof value === 'object') {
        for (const [key, inner] of Object.entries(value)) {
          keys.add(key);
          collect(inner);
        }
      }
    };
    collect(review);
    for (const key of forbidden) expect(keys.has(key)).toBe(false);
    const text = renderRouteReviewJson(review);
    for (const flag of scenario.flags) expect(text).not.toContain(flag);
    for (const fact of scenario.facts) expect(text).not.toContain(fact.id);
  });

  it('is deterministic', () => {
    expect(renderRouteReviewJson(reviewOf(scenario))).toBe(
      renderRouteReviewJson(reviewOf(scenario)),
    );
    expect(renderRouteReviewMarkdown(reviewOf(scenario))).toBe(
      renderRouteReviewMarkdown(reviewOf(scenario)),
    );
  });
});

describe('bounds', () => {
  const failure = (bounds: Partial<RouteReviewBounds>) => {
    const result = buildRouteReview({ scenario, bounds });
    if (result.ok) throw new Error('expected a bound failure');
    return result;
  };

  it('has explicit finite defaults', () => {
    for (const value of Object.values(DEFAULT_ROUTE_REVIEW_BOUNDS)) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });

  it('fails when there are more routes than the bound, with no partial report', () => {
    const result = failure({ maxRoutes: 4 });
    expect(result.code).toBe('ROUTE_LIMIT');
    expect('report' in result).toBe(false);
    expect(reviewOf(scenario, { maxRoutes: 5 }).counts.routes).toBe(5);
  });

  it('fails when a route is deeper than the bound', () => {
    expect(failure({ maxDepth: 3 }).code).toBe('DEPTH_LIMIT');
    expect(reviewOf(scenario, { maxDepth: 4 }).counts.maxRouteLength).toBe(4);
  });

  it('fails when too many transitions would be explored', () => {
    expect(failure({ maxTransitions: 3 }).code).toBe('TRANSITION_LIMIT');
    const needed = reviewOf(scenario).counts.transitionsExplored;
    expect(failure({ maxTransitions: needed - 1 }).code).toBe('TRANSITION_LIMIT');
    expect(reviewOf(scenario, { maxTransitions: needed }).counts.routes).toBe(5);
  });

  it('fails when the collected text exceeds the output bound', () => {
    expect(failure({ maxOutputChars: 500 }).code).toBe('OUTPUT_LIMIT');
  });

  it('fails the export when the rendered artifact exceeds the output bound', () => {
    const json = exportRouteReview({ scenario, format: 'json' });
    expect(json.ok).toBe(true);
    if (!json.ok) return;
    const exact = json.text.length;
    expect(
      exportRouteReview({ scenario, format: 'json', bounds: { maxOutputChars: exact } }).ok,
    ).toBe(true);
    const over = exportRouteReview({
      scenario,
      format: 'json',
      bounds: { maxOutputChars: exact - 1 },
    });
    expect(over.ok).toBe(false);
    expect('text' in over).toBe(false);
  });

  it('rejects non-positive or fractional bounds instead of running unbounded', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = buildRouteReview({ scenario, bounds: { maxRoutes: bad } });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_BOUNDS');
    }
  });
});

describe('rendering', () => {
  it('JSON carries authored text unchanged and is terminal-safe', () => {
    const hostile = hostileScenario();
    const review = reviewOf(hostile);
    const text = renderRouteReviewJson(review);
    expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e]/);
    const parsed = JSON.parse(text) as RouteReview;
    expect(parsed.routes[0]!.chapters[0]!.narration).toBe(
      hostile.scenes[0]!.narration.filter((t) => !t.when)
        .map((t) => t.text)
        .join(' '),
    );
    expect(parsed.routes[0]!.chapters[0]!.sceneTitle).toBe(hostile.scenes[0]!.title);
    expect(parsed).toEqual(JSON.parse(JSON.stringify(review)));
  });

  it('Markdown displays authored text literally', () => {
    const md = renderRouteReviewMarkdown(reviewOf(hostileScenario()));
    expect(md).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e]/);
    // A literal `<` may only appear escaped (`\<`), never as active HTML.
    expect(md).not.toMatch(/(^|[^\\])</);
    expect(md).not.toContain('**bold**');
    expect(md).not.toContain('](javascript');
    expect(md).not.toContain('https://evil');
    expect(md).not.toContain('a@evil');
    expect(md).not.toContain('www.evil');
    expect(md).toContain('\\<script\\>alert\\(1\\)\\</script\\>');
    expect(md).toContain('\\*\\*bold\\*\\*');
    expect(md).toContain('\\[link\\]\\(javascript\\:alert\\(1\\)\\)');
    expect(md).toContain('\\&amp;');
    const lines = md.split('\n');
    expect(lines).toContain('> \\# Injected heading');
    expect(lines).toContain('> \\- injected item');
    expect(lines).toContain('> 1\\. injected number');
    expect(lines).toContain('> \\---');
    expect(lines).toContain('> \\=== setext');
    // Authored lines never start a block of their own: each is quoted.
    expect(
      lines.filter((l) => /injected|setext|indented code|evil/i.test(l) && !l.startsWith('>')),
    ).toEqual([]);
  });

  it('Markdown states that the report is not approved and not published', () => {
    const md = renderRouteReviewMarkdown(reviewOf(scenario));
    expect(md).toContain('REVIEW_REQUIRED');
    expect(md).toContain('NOT approved');
    expect(md).toContain('NOT_PUBLISHED');
    expect(md).toContain(hashScenarioDefinition(scenario));
    expect((md.match(/^### Route \d+/gm) ?? []).length).toBe(5);
  });
});

describe('module boundary', () => {
  it('imports nothing that can reach a database, provider, framework or the filesystem', () => {
    const source = readFileSync(path.join(__dirname, 'route-review.ts'), 'utf8');
    const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) {
      expect(spec).not.toMatch(
        /prisma|@nestjs|bullmq|ioredis|openai|node:|scenarios\/approvals|\/authoring\/(artifacts|openai|pipeline)|\/playtest\//,
      );
    }
  });
});
