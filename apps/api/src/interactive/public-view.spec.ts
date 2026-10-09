import { describe, expect, it } from 'vitest';
import { playChoices } from './domain/engine';
import { buildCanonicalNarration } from './domain/narration';
import { hashState } from './domain/state';
import { buildPublicView, publicSessionViewSchema } from './public-view';
import { WARSAW_LAST_DELIVERY_V1 as scenario } from './scenarios';
import { WARSAW_ROUTES } from './scenarios/routes';

const SESSION_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

function viewAfter(route: readonly string[]) {
  const { state } = playChoices(scenario, route);
  const view = buildPublicView({
    sessionId: SESSION_ID,
    scenario,
    state,
    narration: buildCanonicalNarration(scenario, state),
  });
  return { state, view };
}

describe('public session view', () => {
  it('shows the scene, available choices and player-visible state', () => {
    const { view } = viewAfter([]);
    expect(view).toMatchObject({
      sessionId: SESSION_ID,
      revision: 0,
      scene: { id: 's-courtyard' },
      status: 'in_progress',
      ending: null,
      player: {
        inventory: [{ id: 'parcel', name: 'Sealed parcel' }],
        knowledge: [{ id: 'f-parcel-unmarked' }],
      },
    });
    expect(view.choices.map((c) => c.id)).toEqual(['c-ask-caretaker', 'c-read-mailboxes']);
    expect(publicSessionViewSchema.parse(view)).toEqual(view);
  });

  it('lists only choices that are available right now', () => {
    const { view } = viewAfter(['c-read-mailboxes', 'c-climb-from-mailboxes']);
    // The locked card branch is not hinted at.
    expect(view.choices.map((c) => c.id)).toEqual(['c-follow-stamp', 'c-leave-parcel']);
  });

  it('never discloses hidden facts, NPC knowledge, flags, hashes or future branches', () => {
    const { state, view } = viewAfter([]);
    const wire = JSON.stringify(view);
    // NPC secrets the player has not learned.
    expect(wire).not.toContain('altering the building');
    expect(wire).not.toContain('hiding in the cellar');
    expect(wire).not.toContain('original, unaltered');
    // Internal structure.
    for (const leaked of [
      'npcKnowledge',
      'consumedItems',
      'flags',
      'history',
      'stateHash',
      'payload',
    ]) {
      expect(wire).not.toContain(leaked);
    }
    expect(wire).not.toContain(hashState(state));
    // Future scenes and locked choices.
    for (const future of ['s-cellar', 's-flat', 'c-confront-ines', 'c-use-card', 's-end-exposed']) {
      expect(wire).not.toContain(future);
    }
  });

  it('reveals a fact only once the player has learned it', () => {
    const early = viewAfter(['c-ask-caretaker']).view;
    expect(early.player.knowledge.map((k) => k.id)).toEqual([
      'f-parcel-unmarked',
      'f-gone-two-days',
    ]);
    const late = viewAfter(WARSAW_ROUTES.exposed.slice(0, 3)).view;
    expect(late.player.knowledge.map((k) => k.id)).toContain('f-ines-altered-ledger');
  });

  it('reports consumed items as gone and terminal status with the ending', () => {
    const { view } = viewAfter(WARSAW_ROUTES.exposed);
    expect(view).toMatchObject({
      status: 'ended',
      choices: [],
      ending: { id: 'ledger-exposed', title: 'The Ledger Exposed' },
    });
    expect(view.player.inventory.map((i) => i.id)).not.toContain('parcel');
    expect(JSON.stringify(view)).not.toContain('consumed');
  });

  it('rejects stored responses carrying extra fields', () => {
    const { view } = viewAfter([]);
    expect(publicSessionViewSchema.safeParse({ ...view, state: {} }).success).toBe(false);
  });
});
