import { describe, expect, it } from 'vitest';
import { applyChoice, startSession, type AppliedEvent } from './domain/engine';
import { buildCanonicalNarration } from './domain/narration';
import type { InteractiveState } from './domain/state';
import { buildPublicView, type PublicSessionView } from './public-view';
import { getScenario } from './scenarios';
import { WARSAW_ROUTES } from './scenarios/routes';
import {
  TranscriptIntegrityError,
  assessCompletion,
  buildTranscriptPage,
  transcriptWindow,
  type StoredEventRow,
  type TranscriptSession,
} from './transcript';

const SESSION_ID = '9b2e7a9e-0f1c-4d5b-8a53-2f0f6a2e7c11';
const scenario = getScenario('warsaw-last-delivery', 1)!;

interface Played {
  session: TranscriptSession;
  rows: StoredEventRow[];
  views: PublicSessionView[];
}

/** Plays a real route through the real engine and stores what the service would store. */
function play(route: readonly string[], sessionId = SESSION_ID): Played {
  const rows: StoredEventRow[] = [];
  const views: PublicSessionView[] = [];
  const store = (applied: AppliedEvent) => {
    const state: InteractiveState = applied.state;
    const view = buildPublicView({
      sessionId,
      scenario,
      state,
      narration: buildCanonicalNarration(scenario, state),
    });
    views.push(view);
    rows.push({
      seq: applied.event.seq,
      type: applied.event.type,
      schemaVersion: applied.event.version,
      payload: applied.event.payload,
      response: view,
    });
    return state;
  };
  let state = store(startSession(scenario));
  for (const choiceId of route) state = store(applyChoice(state, choiceId, scenario));
  return {
    session: {
      id: sessionId,
      scenarioId: scenario.id,
      scenarioVersion: scenario.version,
      revision: state.revision,
    },
    rows,
    views,
  };
}

function page(played: Played, from: number, limit: number) {
  const { lo, hi } = transcriptWindow(from, limit, played.session.revision);
  return buildTranscriptPage({
    session: played.session,
    rows: played.rows.filter((r) => r.seq >= lo && r.seq <= hi),
    from,
    limit,
  });
}

function invalid(run: () => unknown): TranscriptIntegrityError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(TranscriptIntegrityError);
    return error as TranscriptIntegrityError;
  }
  throw new Error('expected a TranscriptIntegrityError');
}

describe('transcriptWindow', () => {
  it('fetches only the page plus its predecessor', () => {
    expect(transcriptWindow(0, 10, 5)).toEqual({ lo: 0, hi: 5 });
    expect(transcriptWindow(0, 3, 5)).toEqual({ lo: 0, hi: 2 });
    expect(transcriptWindow(3, 2, 9)).toEqual({ lo: 2, hi: 4 });
    expect(transcriptWindow(4, 25, 5)).toEqual({ lo: 3, hi: 5 });
  });
});

describe('buildTranscriptPage', () => {
  it.each(Object.entries(WARSAW_ROUTES))('renders the whole %s route in one page', (_n, route) => {
    const played = play(route);
    const dto = page(played, 0, 25);

    expect(dto.nextCursor).toBeNull();
    expect(dto.completedRevision).toBe(route.length);
    expect(dto.steps.map((s) => s.revision)).toEqual(played.views.map((v) => v.revision));
    expect(dto.steps[0]).toMatchObject({ revision: 0, arrivedByChoiceLabel: null, ending: null });
    for (const [i, step] of dto.steps.entries()) {
      const view = played.views[i]!;
      expect(step.scene).toEqual(view.scene);
      expect(step.narration).toBe(view.narration);
      if (i > 0) {
        const label = played.views[i - 1]!.choices.find((c) => c.id === route[i - 1])!.label;
        expect(step.arrivedByChoiceLabel).toBe(label);
      }
    }
    const last = dto.steps[dto.steps.length - 1]!;
    expect(last.ending).toEqual({
      title: played.views.at(-1)!.ending!.title,
      summary: played.views.at(-1)!.ending!.summary,
    });
    expect(dto.steps.slice(0, -1).every((s) => s.ending === null)).toBe(true);
  });

  it('covers both distinct endings', () => {
    const titles = [WARSAW_ROUTES.exposed, WARSAW_ROUTES.quietAtDoor].map(
      (route) => page(play(route), 0, 25).steps.at(-1)!.ending!.title,
    );
    expect(new Set(titles).size).toBe(2);
  });

  it('paginates with nextCursor information at the exact boundaries', () => {
    const played = play(WARSAW_ROUTES.exposed); // revisions 0..5
    const first = page(played, 0, 2);
    expect(first.steps.map((s) => s.revision)).toEqual([0, 1]);
    expect(first.nextCursor).toEqual({
      sessionId: SESSION_ID,
      completedRevision: 5,
      nextRevision: 2,
    });

    const exact = page(played, 0, 6);
    expect(exact.steps).toHaveLength(6);
    expect(exact.nextCursor).toBeNull();

    const oneShort = page(played, 0, 5);
    expect(oneShort.nextCursor).toMatchObject({ nextRevision: 5 });

    const tail = page(played, 5, 25);
    expect(tail.steps.map((s) => s.revision)).toEqual([5]);
    expect(tail.nextCursor).toBeNull();
  });

  it('derives choice labels across a page boundary from the predecessor view', () => {
    const played = play(WARSAW_ROUTES.exposed);
    const whole = page(played, 0, 25);
    const stitched = [0, 2, 4].flatMap((from) => page(played, from, 2).steps);
    expect(stitched).toEqual(whole.steps);
    expect(page(played, 3, 1).steps[0]!.arrivedByChoiceLabel).toBe(
      played.views[2]!.choices.find((c) => c.id === WARSAW_ROUTES.exposed[2])!.label,
    );
  });

  it('uses the stored labels, not the current scenario text', () => {
    const played = play(WARSAW_ROUTES.quietAtDoor);
    const edited = structuredClone(played);
    edited.views[0]!.choices = edited.views[0]!.choices.map((c) => ({
      ...c,
      label: `OLD ${c.id}`,
    }));
    edited.rows[0]!.response = edited.views[0];
    const step = page(edited, 0, 25).steps[1]!;
    expect(step.arrivedByChoiceLabel).toBe(`OLD ${WARSAW_ROUTES.quietAtDoor[0]}`);
  });

  it('exposes exactly the allow-listed fields and nothing hidden', () => {
    const dto = page(play(WARSAW_ROUTES.exposed), 0, 25);
    expect(Object.keys(dto).sort()).toEqual(
      [
        'completedRevision',
        'nextCursor',
        'scenarioId',
        'scenarioVersion',
        'sessionId',
        'steps',
      ].sort(),
    );
    for (const step of dto.steps) {
      expect(Object.keys(step).sort()).toEqual(
        ['arrivedByChoiceLabel', 'ending', 'narration', 'revision', 'scene'].sort(),
      );
      expect(Object.keys(step.scene).sort()).toEqual(['id', 'title']);
    }
    expect(Object.keys(dto.steps.at(-1)!.ending!).sort()).toEqual(['summary', 'title']);
    const text = JSON.stringify(dto);
    for (const leaked of [
      'stateHash',
      'payload',
      'idempotency',
      'requestHash',
      'fromSceneId',
      'knowledge',
      'inventory',
      'choices',
    ]) {
      expect(text).not.toContain(leaked);
    }
  });

  describe('corrupt stored data fails loudly', () => {
    const base = () => play(WARSAW_ROUTES.quietAtDoor); // revisions 0..3
    const run =
      (p: Played, from = 0, limit = 25) =>
      () =>
        page(p, from, limit);

    it('rejects a missing event', () => {
      const p = base();
      p.rows.splice(2, 1);
      invalid(run(p));
    });

    it('rejects a missing predecessor on a later page', () => {
      const p = base();
      p.rows.splice(1, 1);
      invalid(run(p, 2, 1));
    });

    it('rejects a sequence gap or duplicate', () => {
      const gap = base();
      gap.rows[2]!.seq = 5;
      invalid(run(gap));
      const dup = base();
      dup.rows[2]!.seq = 1;
      invalid(run(dup));
    });

    it('rejects wrong event types and versions', () => {
      const a = base();
      a.rows[0]!.type = 'ChoiceMade';
      invalid(run(a));
      const b = base();
      b.rows[2]!.type = 'SessionStarted';
      invalid(run(b));
      const c = base();
      c.rows[1]!.type = 'Bogus';
      invalid(run(c));
      const d = base();
      d.rows[1]!.schemaVersion = 2;
      invalid(run(d));
    });

    it('rejects malformed payloads', () => {
      const a = base();
      a.rows[1]!.payload = { choiceId: 'x' };
      invalid(run(a));
      const b = base();
      b.rows[1]!.payload = { ...(b.rows[1]!.payload as object), extra: 1 };
      invalid(run(b));
      const c = base();
      c.rows[0]!.payload = { nope: true };
      invalid(run(c));
    });

    it('rejects a genesis payload for a different scenario', () => {
      const p = base();
      p.rows[0]!.payload = { ...(p.rows[0]!.payload as object), scenarioVersion: 9 };
      invalid(run(p));
    });

    it('rejects a response that is not a valid public view', () => {
      const p = base();
      p.rows[2]!.response = { ...p.views[2]!, extra: 'field' };
      invalid(run(p));
      const q = base();
      q.rows[2]!.response = null;
      invalid(run(q));
    });

    it('rejects mismatched response identity', () => {
      const wrongSession = base();
      wrongSession.rows[1]!.response = { ...wrongSession.views[1]!, sessionId: 'other' };
      invalid(run(wrongSession));
      const wrongRevision = base();
      wrongRevision.rows[1]!.response = { ...wrongRevision.views[2]! };
      invalid(run(wrongRevision));
      const wrongScenario = base();
      wrongScenario.rows[1]!.response = { ...wrongScenario.views[1]!, scenarioVersion: 2 };
      invalid(run(wrongScenario));
    });

    it('rejects a choice that was not offered at the previous revision', () => {
      const p = base();
      p.rows[1]!.payload = { choiceId: 'c-made-up', fromSceneId: p.views[0]!.scene.id };
      invalid(run(p));
    });

    it('rejects a choice recorded from a different scene than the previous view', () => {
      const p = base();
      p.rows[1]!.payload = { choiceId: WARSAW_ROUTES.quietAtDoor[0], fromSceneId: 'elsewhere' };
      invalid(run(p));
    });

    it('rejects a non-terminal step that already shows an ending, or a missing terminal ending', () => {
      const early = base();
      early.rows[1]!.response = { ...early.views[3]!, revision: 1 };
      invalid(run(early));
      const noEnd = base();
      noEnd.rows[3]!.response = { ...noEnd.views[2]!, revision: 3 };
      invalid(run(noEnd));
    });
  });
});

describe('assessCompletion', () => {
  it('reports ended and in-progress sessions from the stored terminal view', () => {
    const done = play(WARSAW_ROUTES.quietAtDoor);
    expect(assessCompletion(done.session, done.rows.at(-1)!)).toBe('ended');
    const running = play(['c-ask-caretaker']);
    expect(assessCompletion(running.session, running.rows.at(-1)!)).toBe('in_progress');
  });

  it('refuses a terminal event that does not belong to the session', () => {
    const done = play(WARSAW_ROUTES.quietAtDoor);
    invalid(() => assessCompletion(done.session, { ...done.rows.at(-1)!, seq: 2 }));
    invalid(() =>
      assessCompletion(done.session, {
        ...done.rows.at(-1)!,
        response: { ...done.views.at(-1)!, sessionId: 'other' },
      }),
    );
  });
});
