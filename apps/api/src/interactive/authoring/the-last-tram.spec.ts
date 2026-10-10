import { describe, expect, it } from 'vitest';
import {
  applyChoice,
  availableChoices,
  playChoices,
  startSession,
  verifyReplay,
} from '../domain/engine';
import { buildCanonicalNarration } from '../domain/narration';
import type { ScenarioDefinition } from '../domain/scenario-schema';
import type { InteractiveState } from '../domain/state';
import { LAST_TRAM_BRIEF, LAST_TRAM_SCENARIO } from './the-last-tram';

/**
 * Editorial-consistency regressions for the unpublished "The Last Tram" draft.
 * They pin which narration TEMPLATES a route may show and what each choice is
 * allowed to claim, never the prose itself, so rewording stays free. They are
 * not a consistency detector and not editorial approval.
 */

const scenario: ScenarioDefinition = LAST_TRAM_SCENARIO;

/** Every terminal route, found by walking the production engine's available choices. */
function enumerateRoutes(): string[][] {
  const routes: string[][] = [];
  const walk = (state: InteractiveState, route: string[]): void => {
    if (state.endingId !== null) {
      routes.push(route);
      return;
    }
    const choices = availableChoices(state, scenario);
    expect(choices.length).toBeGreaterThan(0);
    for (const choice of choices) {
      walk(applyChoice(state, choice.id, scenario).state, [...route, choice.id]);
    }
  };
  walk(startSession(scenario).state, []);
  return routes;
}

const OPEN_PANEL = ['c-ask-driver', 'c-leave-cab', 'c-open-panel'];
const DRIVER_WAIT = ['c-ask-driver', 'c-leave-cab', 'c-wait-for-terminus'];
const RECEIPT_SHOWN = ['c-inspect-carriage', 'c-pocket-receipt', 'c-show-receipt'];
const RECEIPT_WAIT = ['c-inspect-carriage', 'c-pocket-receipt', 'c-wait-for-terminus'];

function templatesAfter(route: string[]): string[] {
  return buildCanonicalNarration(scenario, playChoices(scenario, route).state).templateIds;
}

function templateText(id: string): string {
  const found = scenario.scenes.flatMap((s) => s.narration).find((t) => t.id === id);
  if (!found) throw new Error(`no template ${id}`);
  return found.text;
}

describe('The Last Tram editorial routes', () => {
  it('has exactly five terminal routes and each replays', () => {
    const routes = enumerateRoutes();
    expect(routes.map((r) => r.join('>')).sort()).toEqual(
      [
        [...OPEN_PANEL, 'c-report-to-depot'],
        [...DRIVER_WAIT, 'c-report-to-depot'],
        [...RECEIPT_SHOWN, 'c-report-to-depot'],
        [...RECEIPT_SHOWN, 'c-let-hanna-repay'],
        [...RECEIPT_WAIT, 'c-report-to-depot'],
      ]
        .map((r) => r.join('>'))
        .sort(),
    );
    for (const route of routes) {
      const { events, state } = playChoices(scenario, route);
      expect(() => verifyReplay(events, state, scenario)).not.toThrow();
    }
  });

  it('offers quiet repayment only once the borrowing is established', () => {
    const atTerminus = [OPEN_PANEL, DRIVER_WAIT, RECEIPT_SHOWN, RECEIPT_WAIT];
    for (const route of atTerminus) {
      const { state } = playChoices(scenario, route);
      const ids = availableChoices(state, scenario).map((c) => c.id);
      expect(ids).toContain('c-report-to-depot');
      expect(ids.includes('c-let-hanna-repay')).toBe(
        state.playerKnowledge.includes('f-hanna-borrowed'),
      );
    }
    const confessed = playChoices(scenario, RECEIPT_SHOWN).state;
    expect(availableChoices(confessed, scenario).map((c) => c.id)).toContain('c-let-hanna-repay');
  });

  it('keeps the report choice true whether the box was recovered, missing or confessed', () => {
    const report = scenario.scenes
      .find((s) => s.id === 's-terminus')!
      .choices.find((c) => c.id === 'c-report-to-depot')!;
    expect(report.label).not.toMatch(/\bmissing\b|\bbox\b/i);
    expect(report.requires ?? []).toEqual([]);
    expect(LAST_TRAM_BRIEF.endings.find((e) => e.id === 'report-filed')!.concept).not.toMatch(
      /\bmissing\b/i,
    );
  });

  it('does not attribute the box to Hanna on the driver-and-panel route', () => {
    const { state } = playChoices(scenario, OPEN_PANEL);
    expect(state.playerKnowledge).not.toContain('f-hanna-borrowed');
    const ids = buildCanonicalNarration(scenario, state).templateIds;
    expect(ids).toContain('t-terminus-panel');
    expect(ids).not.toContain('t-terminus-receipt');
    expect(templateText('t-terminus-panel')).not.toMatch(/Hanna/);
  });

  it('records a recovered box only when the panel was opened', () => {
    const recovered = templatesAfter([...OPEN_PANEL, 'c-report-to-depot']);
    expect(recovered).toContain('t-report-recovered');
    expect(recovered).not.toContain('t-report-waited');
    expect(recovered).not.toContain('t-report-confession');
    expect(templateText('t-report-recovered')).not.toMatch(/Hanna/);

    for (const route of [DRIVER_WAIT, RECEIPT_SHOWN, RECEIPT_WAIT]) {
      expect(templatesAfter([...route, 'c-report-to-depot'])).not.toContain('t-report-recovered');
    }
  });

  it('records an unrecovered box as missing, with or without a confession', () => {
    const unknown = templatesAfter([...RECEIPT_WAIT, 'c-report-to-depot']);
    expect(unknown).toContain('t-report-waited');
    expect(unknown).not.toContain('t-report-confession');

    const confessed = templatesAfter([...RECEIPT_SHOWN, 'c-report-to-depot']);
    expect(confessed).toContain('t-report-confession');
    expect(confessed).not.toContain('t-report-waited');
    expect(confessed).not.toContain('t-report-recovered');
    expect(templateText('t-report-confession')).toMatch(/\bmissing\b/);
  });

  it('shows the confession, and Wiktor learning of it, only after the receipt was shown', () => {
    const shown = playChoices(scenario, RECEIPT_SHOWN).state;
    expect(shown.playerKnowledge).toContain('f-hanna-borrowed');
    expect(shown.npcKnowledge['wiktor']).toContain('f-hanna-borrowed');
    expect(buildCanonicalNarration(scenario, shown).templateIds).toContain('t-terminus-receipt');

    for (const route of [OPEN_PANEL, DRIVER_WAIT, RECEIPT_WAIT]) {
      const { state } = playChoices(scenario, route);
      expect(state.playerKnowledge).not.toContain('f-hanna-borrowed');
      expect(state.npcKnowledge['wiktor']).not.toContain('f-hanna-borrowed');
      expect(buildCanonicalNarration(scenario, state).templateIds).not.toContain(
        't-terminus-receipt',
      );
    }
  });

  it('voices the borrowing in the quiet ending only on the confession route', () => {
    const quiet = playChoices(scenario, [...RECEIPT_SHOWN, 'c-let-hanna-repay']).state;
    expect(quiet.endingId).toBe('quiet-repayment');
    expect(quiet.playerKnowledge).toContain('f-hanna-borrowed');
    expect(buildCanonicalNarration(scenario, quiet).templateIds).toEqual(
      expect.arrayContaining(['t-quiet-hanna', 't-quiet-driver']),
    );
  });
});
