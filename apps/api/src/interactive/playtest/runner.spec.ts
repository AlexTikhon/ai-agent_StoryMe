import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LAST_TRAM_SCENARIO } from '../authoring/the-last-tram';
import { playChoices, startSession, verifyReplay } from '../domain/engine';
import { buildCanonicalNarration } from '../domain/narration';
import {
  hashScenarioDefinition,
  parseScenarioDefinition,
  type ScenarioDefinition,
} from '../domain/scenario-schema';
import { buildPublicView } from '../public-view';
import { getScenario, listScenarioIds } from '../scenarios';
import {
  MAX_INPUT_LINES,
  MAX_ROUTE_ARG_CHARS,
  MAX_ROUTE_STEPS,
  formatBanner,
  loadPlaytestCandidate,
  parseRoute,
  runInteractivePlaytest,
  runScriptedPlaytest,
  type LineRead,
  type LineSource,
} from './runner';

const REPORT_ROUTE = ['c-ask-driver', 'c-leave-cab', 'c-wait-for-terminus', 'c-report-to-depot'];
const QUIET_ROUTE = [
  'c-inspect-carriage',
  'c-pocket-receipt',
  'c-show-receipt',
  'c-let-hanna-repay',
];

const candidateText = JSON.stringify(LAST_TRAM_SCENARIO, null, 2);

function loadScenario(text = candidateText): ScenarioDefinition {
  const loaded = loadPlaytestCandidate(text);
  if (!loaded.ok) throw new Error(`candidate rejected: ${loaded.code}`);
  return loaded.scenario;
}

function sink() {
  const lines: string[] = [];
  return { lines, out: (line: string) => lines.push(line), text: () => lines.join('\n') };
}

/** Feeds a fixed list of reads, then EOF forever; counts how often it was asked. */
function fakeInput(
  reads: Array<string | LineRead>,
): LineSource & { asked: number; closed: boolean } {
  const queue = reads.map((r): LineRead => (typeof r === 'string' ? { kind: 'line', text: r } : r));
  const source = {
    asked: 0,
    closed: false,
    next: async (): Promise<LineRead> => {
      source.asked += 1;
      return queue.shift() ?? { kind: 'eof' };
    },
    close: () => {
      source.closed = true;
    },
  };
  return source;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadPlaytestCandidate', () => {
  it('accepts an unpublished candidate without approval and reports the canonical hash', () => {
    const loaded = loadPlaytestCandidate(candidateText);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.candidateHash).toBe(hashScenarioDefinition(LAST_TRAM_SCENARIO));
    expect(loaded.report.witnessRoutes).toHaveLength(2);
    expect(getScenario('warsaw-last-tram', 1)).toBeUndefined();
  });

  it('hashes canonically, so reformatting the file does not change the identity', () => {
    const compact = loadPlaytestCandidate(JSON.stringify(LAST_TRAM_SCENARIO));
    const pretty = loadPlaytestCandidate(candidateText);
    expect(compact.ok && pretty.ok && compact.candidateHash === pretty.candidateHash).toBe(true);
  });

  it('rejects oversized, non-JSON and mechanically invalid candidates', () => {
    const big = loadPlaytestCandidate('x'.repeat(250_000));
    expect(big).toMatchObject({ ok: false, code: 'CANDIDATE_TOO_LARGE' });
    expect(loadPlaytestCandidate('{oops')).toMatchObject({ ok: false, code: 'CANDIDATE_NOT_JSON' });

    const broken = structuredClone(LAST_TRAM_SCENARIO);
    broken.scenes[1]!.choices[0]!.to = 's-missing';
    const invalid = loadPlaytestCandidate(JSON.stringify(broken));
    expect(invalid).toMatchObject({ ok: false, code: 'CANDIDATE_INVALID' });
    if (!invalid.ok) expect(invalid.diagnostics.length).toBeGreaterThan(0);
  });

  it('rejects a candidate whose mechanical validation fails even if it parses', () => {
    const unreachable = structuredClone(LAST_TRAM_SCENARIO);
    unreachable.scenes[4]!.choices.pop(); // s-terminus loses a choice: an ending becomes unreachable
    expect(loadPlaytestCandidate(JSON.stringify(unreachable)).ok).toBe(false);
  });
});

describe('formatBanner', () => {
  it('states the boundary and the candidate identity without claiming approval', () => {
    const loaded = loadPlaytestCandidate(candidateText);
    if (!loaded.ok) throw new Error('expected a valid candidate');
    const banner = formatBanner(loaded).join('\n');
    expect(banner).toContain('LOCAL PLAYTEST');
    expect(banner).toContain('does not approve');
    expect(banner).toContain(`warsaw-last-tram@1`);
    expect(banner).toContain(loaded.candidateHash);
  });
});

describe('parseRoute', () => {
  it('splits comma-separated ids and trims whitespace', () => {
    expect(parseRoute(' a-1 , b_2,c.3 ')).toEqual({ ok: true, choiceIds: ['a-1', 'b_2', 'c.3'] });
  });

  it('rejects empty segments, odd characters and oversized routes', () => {
    expect(parseRoute('a,,b')).toMatchObject({ ok: false, code: 'ROUTE_MALFORMED' });
    expect(parseRoute('a,b c')).toMatchObject({ ok: false, code: 'ROUTE_MALFORMED' });
    expect(parseRoute('a,\u001b[31m')).toMatchObject({ ok: false, code: 'ROUTE_MALFORMED' });
    expect(parseRoute('a'.repeat(65))).toMatchObject({ ok: false, code: 'ROUTE_MALFORMED' });
    expect(parseRoute('a,'.repeat(MAX_ROUTE_STEPS + 1).slice(0, -1))).toMatchObject({
      ok: false,
      code: 'ROUTE_TOO_LONG',
    });
    expect(parseRoute('a'.repeat(MAX_ROUTE_ARG_CHARS + 1))).toMatchObject({
      ok: false,
      code: 'ROUTE_TOO_LONG',
    });
  });
});

describe('runScriptedPlaytest', () => {
  it.each([
    ['report-filed', REPORT_ROUTE],
    ['quiet-repayment', QUIET_ROUTE],
  ])('reaches the %s ending and agrees with playChoices and verifyReplay', (endingId, route) => {
    const scenario = loadScenario();
    const o = sink();
    const result = runScriptedPlaytest({ scenario, choiceIds: route, out: o.out });

    const expected = playChoices(scenario, route);
    expect(result.status).toBe('COMPLETED');
    expect(result.failureCode).toBeNull();
    expect(result.endingId).toBe(endingId);
    expect(result.route).toEqual(route);
    expect(result.events).toEqual(expected.events);
    expect(result.state).toEqual(expected.state);
    expect(verifyReplay(result.events, result.state, scenario)).toEqual(expected.state);

    const ending = scenario.endings.find((e) => e.id === endingId)!;
    expect(o.text()).toContain(ending.title);
    expect(o.text()).toContain(ending.summary);
  });

  it('prints exactly the production public projection for every step', () => {
    const scenario = loadScenario();
    const o = sink();
    runScriptedPlaytest({ scenario, choiceIds: QUIET_ROUTE, out: o.out });

    const { events } = playChoices(scenario, QUIET_ROUTE);
    let printed = o.text();
    for (let n = 1; n <= events.length; n += 1) {
      const state = playChoices(scenario, QUIET_ROUTE.slice(0, n - 1)).state;
      const view = buildPublicView({
        sessionId: 'x',
        scenario,
        state,
        narration: buildCanonicalNarration(scenario, state),
      });
      expect(printed).toContain(view.scene.title);
      expect(printed).toContain(view.narration);
      view.choices.forEach((c, i) => expect(printed).toContain(`${i + 1}. ${c.label}`));
      view.player.knowledge.forEach((k) => expect(printed).toContain(k.text));
      view.player.inventory.forEach((i) => expect(printed).toContain(i.name));
      printed = printed.slice(printed.indexOf(view.narration));
    }
  });

  it('is incomplete, never completed, when the route stops before an ending', () => {
    const scenario = loadScenario();
    const o = sink();
    const result = runScriptedPlaytest({ scenario, choiceIds: ['c-ask-driver'], out: o.out });
    expect(result.status).toBe('INCOMPLETE');
    expect(result.endingId).toBeNull();
    expect(result.route).toEqual(['c-ask-driver']);
    expect(runScriptedPlaytest({ scenario, choiceIds: [], out: sink().out }).status).toBe(
      'INCOMPLETE',
    );
  });

  it('rejects a locked choice without advancing or revealing why it is locked', () => {
    const scenario = loadScenario();
    const o = sink();
    const route = ['c-ask-driver', 'c-leave-cab', 'c-wait-for-terminus', 'c-let-hanna-repay'];
    const result = runScriptedPlaytest({ scenario, choiceIds: route, out: o.out });

    expect(result.status).toBe('FAILED');
    expect(result.failureCode).toBe('CHOICE_NOT_AVAILABLE');
    expect(result.route).toEqual(route.slice(0, 3));
    expect(result.events).toEqual(playChoices(scenario, route.slice(0, 3)).events);
    expect(result.endingId).toBeNull();
    const everything = `${o.text()}\n${result.detail}`;
    expect(everything).not.toMatch(/KNOWLEDGE_NOT_LEARNED|PREREQUISITE|ITEM_/);
    expect(everything).not.toContain(scenario.facts.find((f) => f.id === 'f-hanna-borrowed')!.text);
    expect(everything).not.toContain(
      scenario.scenes.flatMap((s) => s.choices).find((c) => c.id === 'c-let-hanna-repay')!.label,
    );
  });

  it('treats unknown and future-scene choices identically', () => {
    const scenario = loadScenario();
    const unknown = runScriptedPlaytest({ scenario, choiceIds: ['c-nope'], out: sink().out });
    const future = runScriptedPlaytest({ scenario, choiceIds: ['c-open-panel'], out: sink().out });
    expect(unknown.failureCode).toBe('CHOICE_NOT_AVAILABLE');
    expect(future.failureCode).toBe('CHOICE_NOT_AVAILABLE');
    expect(future.events).toHaveLength(1);
    expect(future.state.sceneId).toBe('s-boarding');
  });

  it('rejects commands after an ending and leaves the ended state untouched', () => {
    const scenario = loadScenario();
    const result = runScriptedPlaytest({
      scenario,
      choiceIds: [...REPORT_ROUTE, 'c-ask-driver'],
      out: sink().out,
    });
    expect(result.status).toBe('FAILED');
    expect(result.failureCode).toBe('SESSION_ENDED');
    expect(result.endingId).toBe('report-filed');
    expect(result.events).toEqual(playChoices(scenario, REPORT_ROUTE).events);
  });

  it('rejects an oversized route before playing any step', () => {
    const scenario = loadScenario();
    const o = sink();
    const result = runScriptedPlaytest({
      scenario,
      choiceIds: Array.from({ length: MAX_ROUTE_STEPS + 1 }, () => 'c-ask-driver'),
      out: o.out,
    });
    expect(result.status).toBe('FAILED');
    expect(result.failureCode).toBe('ROUTE_TOO_LONG');
    expect(result.events).toHaveLength(1);
    expect(o.lines).toHaveLength(0);
  });

  it('rejects malformed ids passed directly to the runner', () => {
    const result = runScriptedPlaytest({
      scenario: loadScenario(),
      choiceIds: ['c-ask-driver', 'bad id'],
      out: sink().out,
    });
    expect(result.failureCode).toBe('ROUTE_MALFORMED');
    expect(result.events).toHaveLength(1);
  });

  it('enforces consumed-item rules: a used one-time item cannot be used again', () => {
    const doc = structuredClone(LAST_TRAM_SCENARIO);
    doc.scenes[4]!.choices.push({
      id: 'c-reuse-key',
      label: 'Use the brass key a second time',
      to: 's-ending-report',
      requires: [{ kind: 'hasItem', item: 'service-key' }],
      effects: [],
    });
    const scenario = parseScenarioDefinition(doc);
    const base = ['c-ask-driver', 'c-leave-cab'];

    // Key still held (panel not opened): the extra choice is playable.
    const held = runScriptedPlaytest({
      scenario,
      choiceIds: [...base, 'c-wait-for-terminus', 'c-reuse-key'],
      out: sink().out,
    });
    expect(held.status).toBe('COMPLETED');

    // Key consumed by opening the panel: the same choice is now rejected.
    const consumed = runScriptedPlaytest({
      scenario,
      choiceIds: [...base, 'c-open-panel', 'c-reuse-key'],
      out: sink().out,
    });
    expect(consumed.status).toBe('FAILED');
    expect(consumed.failureCode).toBe('CHOICE_NOT_AVAILABLE');
    expect(consumed.state.consumedItems).toContain('service-key');
    expect(consumed.state.inventory).not.toContain('service-key');
  });

  it('stops with CANCELLED when the signal is already aborted', () => {
    const controller = new AbortController();
    controller.abort();
    const result = runScriptedPlaytest({
      scenario: loadScenario(),
      choiceIds: REPORT_ROUTE,
      out: sink().out,
      signal: controller.signal,
    });
    expect(result.status).toBe('CANCELLED');
    expect(result.events).toHaveLength(1);
  });

  it('produces identical results and transcripts on repeated runs', () => {
    const scenario = loadScenario();
    const a = sink();
    const b = sink();
    const first = runScriptedPlaytest({ scenario, choiceIds: QUIET_ROUTE, out: a.out });
    const second = runScriptedPlaytest({ scenario, choiceIds: QUIET_ROUTE, out: b.out });
    expect(second).toEqual(first);
    expect(b.lines).toEqual(a.lines);
  });

  it('fails with TRANSCRIPT_LIMIT instead of printing without bound', () => {
    const o = sink();
    const result = runScriptedPlaytest({
      scenario: loadScenario(),
      choiceIds: REPORT_ROUTE,
      out: o.out,
      maxTranscriptChars: 300,
    });
    expect(result.status).toBe('FAILED');
    expect(result.failureCode).toBe('TRANSCRIPT_LIMIT');
    expect(o.text().length).toBeLessThanOrEqual(300);
  });

  it('strips terminal control characters from authored text before printing', () => {
    const doc = structuredClone(LAST_TRAM_SCENARIO);
    doc.scenes[0]!.title = 'Boarding\u001b[31m RED \u0007';
    let scenario: ScenarioDefinition;
    try {
      scenario = parseScenarioDefinition(doc);
    } catch {
      return; // the schema already refuses control characters: nothing to sanitize
    }
    const o = sink();
    runScriptedPlaytest({ scenario, choiceIds: [], out: o.out });
    expect(o.text()).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
    expect(o.text()).toContain('Boarding');
  });
});

describe('runInteractivePlaytest', () => {
  it.each([
    ['report-filed', ['1', '1', '2', '1'], REPORT_ROUTE],
    ['quiet-repayment', ['2', '1', '1', '2'], QUIET_ROUTE],
  ])('plays numbered choices to the %s ending', async (endingId, lines, route) => {
    const scenario = loadScenario();
    const input = fakeInput(lines);
    const o = sink();
    const result = await runInteractivePlaytest({ scenario, input, out: o.out });

    const expected = playChoices(scenario, route);
    expect(result.status).toBe('COMPLETED');
    expect(result.endingId).toBe(endingId);
    expect(result.route).toEqual(route);
    expect(result.events).toEqual(expected.events);
    expect(result.state).toEqual(expected.state);
    expect(o.text()).toContain(scenario.endings.find((e) => e.id === endingId)!.title);
  });

  it('does not read input after the ending', async () => {
    const input = fakeInput(['1', '1', '2', '1', '1', '1', '1']);
    const result = await runInteractivePlaytest({
      scenario: loadScenario(),
      input,
      out: sink().out,
    });
    expect(result.status).toBe('COMPLETED');
    expect(input.asked).toBe(4);
  });

  it('keeps state and events unchanged for rejected input', async () => {
    const scenario = loadScenario();
    const input = fakeInput([
      'abc',
      '0',
      '9',
      '',
      '1.5',
      '-1',
      '01x',
      { kind: 'oversized' },
      '1',
      '1',
      '2',
      '1',
    ]);
    const o = sink();
    const result = await runInteractivePlaytest({ scenario, input, out: o.out });
    expect(result.status).toBe('COMPLETED');
    expect(result.rejectedInputs).toBe(8);
    expect(result.events).toEqual(playChoices(scenario, REPORT_ROUTE).events);
    expect(o.text()).not.toContain('abc');
  });

  it('quits cleanly on q without changing state', async () => {
    const scenario = loadScenario();
    const result = await runInteractivePlaytest({
      scenario,
      input: fakeInput(['abc', 'q']),
      out: sink().out,
    });
    expect(result.status).toBe('CANCELLED');
    expect(result.endingId).toBeNull();
    expect(result.events).toEqual(startSession(scenario) && playChoices(scenario, []).events);
    expect(result.rejectedInputs).toBe(1);
  });

  it('reports EOF before an ending as incomplete, not completed', async () => {
    const input = fakeInput(['1']);
    const result = await runInteractivePlaytest({
      scenario: loadScenario(),
      input,
      out: sink().out,
    });
    expect(result.status).toBe('INCOMPLETE');
    expect(result.route).toEqual(['c-ask-driver']);
  });

  it('reports a cancelled read (SIGINT) as cancelled', async () => {
    const result = await runInteractivePlaytest({
      scenario: loadScenario(),
      input: fakeInput(['1', { kind: 'cancelled' }]),
      out: sink().out,
    });
    expect(result.status).toBe('CANCELLED');
    expect(result.route).toEqual(['c-ask-driver']);
  });

  it('stops after the input limit instead of looping forever', async () => {
    const input = fakeInput(Array.from({ length: MAX_INPUT_LINES + 50 }, () => 'nope'));
    const result = await runInteractivePlaytest({
      scenario: loadScenario(),
      input,
      out: sink().out,
    });
    expect(result.status).toBe('FAILED');
    expect(result.failureCode).toBe('INPUT_LIMIT');
    expect(input.asked).toBe(MAX_INPUT_LINES);
  });

  it('fails with INPUT_LIMIT, not as end of input, when the line source overflows', async () => {
    const input = fakeInput(['abc', { kind: 'overflow' }, '1']);
    const result = await runInteractivePlaytest({
      scenario: loadScenario(),
      input,
      out: sink().out,
    });
    expect(result.status).toBe('FAILED');
    expect(result.failureCode).toBe('INPUT_LIMIT');
    expect(result.rejectedInputs).toBe(1);
    expect(input.asked).toBe(2);
  });

  it('never prints locked choices, future scenes, flags, ids or hidden knowledge', async () => {
    const scenario = loadScenario();
    // Waited quietly: the "let Hanna repay" choice stays locked at the terminus.
    const o = sink();
    const result = await runInteractivePlaytest({
      scenario,
      input: fakeInput(['1', '1', '2', 'q']),
      out: o.out,
    });
    expect(result.status).toBe('CANCELLED');
    const text = o.text();
    const choices = scenario.scenes.flatMap((s) => s.choices);
    expect(text).not.toContain(choices.find((c) => c.id === 'c-let-hanna-repay')!.label);
    for (const c of choices) expect(text).not.toContain(c.id);
    for (const flag of scenario.flags) expect(text).not.toContain(flag.id);
    for (const scene of scenario.scenes) expect(text).not.toContain(scene.id);
    for (const e of scenario.endings) {
      expect(text).not.toContain(e.title);
      expect(text).not.toContain(e.summary);
    }
    expect(text).not.toContain(scenario.facts.find((f) => f.id === 'f-hanna-borrowed')!.text);
    expect(text).not.toContain('Wiktor knows'); // no NPC-knowledge section exists
    expect(text).not.toMatch(/stateHash|npcKnowledge|consumedItems|"flags"/);
    // Future scene titles (only the current scene is ever printed):
    const future = scenario.scenes.filter(
      (s) => s.id === 's-ending-report' || s.id === 's-ending-quiet',
    );
    for (const s of future) expect(text).not.toContain(s.title);
  });

  it('makes no network or provider call', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('network access attempted');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const scenario = loadScenario();
    await runInteractivePlaytest({
      scenario,
      input: fakeInput(['1', '1', '2', '1']),
      out: sink().out,
    });
    runScriptedPlaytest({ scenario, choiceIds: QUIET_ROUTE, out: sink().out });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('playtest modules are offline and read-only', () => {
  it('import nothing that can reach a database, queue, provider, framework or the filesystem', () => {
    for (const name of ['runner.ts', 'line-source.ts']) {
      const source = readFileSync(path.join(__dirname, name), 'utf8');
      const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
      for (const spec of imports) {
        expect(spec).not.toMatch(
          /prisma|@nestjs|bullmq|ioredis|openai|node:fs|node:http|node:net|node:child_process|scenarios\/approvals|\/authoring\/(artifacts|openai|pipeline)/,
        );
      }
    }
  });

  it('leave the real catalogue untouched', async () => {
    const before = listScenarioIds();
    await runInteractivePlaytest({
      scenario: loadScenario(),
      input: fakeInput(['1', '1', '2', '1']),
      out: sink().out,
    });
    expect(listScenarioIds()).toEqual(before);
    expect(getScenario('warsaw-last-tram', 1)).toBeUndefined();
  });
});
