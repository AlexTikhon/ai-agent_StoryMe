import { describe, expect, it } from 'vitest';
import { playChoices } from '../domain/engine';
import {
  MAX_NARRATION_TEXT_LENGTH,
  buildCanonicalNarration,
  validateNarration,
  type NarrationOutput,
} from '../domain/narration';
import { WARSAW_LAST_DELIVERY_V1 as scenario } from '../scenarios';
import { WARSAW_ROUTES } from '../scenarios/routes';
import { MockNarratorProvider } from './mock-narrator.provider';
import {
  NarrationRejectedError,
  prepareNarration,
  type NarrationRequest,
  type NarratorProvider,
} from './narrator';
import { hashState } from '../domain/state';

const cellar = playChoices(scenario, WARSAW_ROUTES.quietViaStamp.slice(0, 3)).state;
const flatCellar = playChoices(scenario, WARSAW_ROUTES.exposed.slice(0, 4)).state;

function good(state = flatCellar): NarrationOutput {
  return buildCanonicalNarration(scenario, state);
}

function reasonFor(output: unknown, state = flatCellar): string {
  const result = validateNarration(output, scenario, state);
  return result.ok ? 'ACCEPTED' : result.code;
}

describe('trusted narration rendering', () => {
  it('renders only templates whose conditions hold for the state', () => {
    const viaFlat = good(flatCellar);
    const viaStamp = good(cellar);
    expect(viaFlat.templateIds).toEqual(['t-cellar-intro', 't-cellar-tomasz', 't-cellar-accuse']);
    expect(viaStamp.templateIds).toEqual(['t-cellar-intro', 't-cellar-tomasz', 't-cellar-page']);
    expect(viaFlat.utterances).toEqual([
      { speakerId: 'tomasz', factId: 'f-parcel-holds-ledger' },
      { speakerId: 'mara', factId: 'f-ines-altered-ledger' },
    ]);
    expect(viaFlat.text).toContain('Ines has been altering the ledger');
    expect(viaStamp.text).not.toContain('altering the ledger');
  });

  it('binds the narration to scenario, version, scene and state hash', () => {
    expect(good()).toMatchObject({
      scenarioId: 'warsaw-last-delivery',
      scenarioVersion: 1,
      sceneId: 's-cellar',
      stateHash: hashState(flatCellar),
    });
  });

  it('accepts the deterministic mock narrator for every scene of every route', async () => {
    const narrator = new MockNarratorProvider();
    for (const route of Object.values(WARSAW_ROUTES)) {
      for (let i = 0; i <= route.length; i += 1) {
        const { state } = playChoices(scenario, route.slice(0, i));
        const narration = await prepareNarration(narrator, scenario, state);
        expect(narration.text.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('narration validation', () => {
  it('accepts the exact trusted rendering', () => {
    expect(reasonFor(good())).toBe('ACCEPTED');
  });

  it('rejects malformed and oversized output', () => {
    expect(reasonFor(null)).toBe('NARRATION_MALFORMED');
    expect(reasonFor('text')).toBe('NARRATION_MALFORMED');
    expect(reasonFor({ ...good(), extra: 'field' })).toBe('NARRATION_MALFORMED');
    expect(reasonFor({ ...good(), templateIds: [] })).toBe('NARRATION_MALFORMED');
    expect(reasonFor({ ...good(), text: 'x'.repeat(MAX_NARRATION_TEXT_LENGTH + 1) })).toBe(
      'NARRATION_MALFORMED',
    );
    expect(reasonFor({ ...good(), templateIds: Array(13).fill('t-cellar-intro') })).toBe(
      'NARRATION_MALFORMED',
    );
  });

  it('rejects incorrect scene, version, scenario or state identity', () => {
    expect(reasonFor({ ...good(), sceneId: 's-door' })).toBe('NARRATION_BINDING_MISMATCH');
    expect(reasonFor({ ...good(), scenarioVersion: 2 })).toBe('NARRATION_BINDING_MISMATCH');
    expect(reasonFor({ ...good(), scenarioId: 'other' })).toBe('NARRATION_BINDING_MISMATCH');
    expect(reasonFor({ ...good(), stateHash: 'a'.repeat(64) })).toBe('NARRATION_BINDING_MISMATCH');
    // Narration prepared for a different state of the same scene is stale.
    expect(reasonFor(good(cellar))).toBe('NARRATION_BINDING_MISMATCH');
  });

  it('rejects unknown templates, speakers and facts', () => {
    expect(reasonFor({ ...good(), templateIds: ['t-invented'] })).toBe(
      'NARRATION_UNKNOWN_TEMPLATE',
    );
    expect(
      reasonFor({ ...good(), utterances: [{ speakerId: 'stranger', factId: 'f-gone-two-days' }] }),
    ).toBe('NARRATION_UNKNOWN_SPEAKER');
    expect(
      reasonFor({ ...good(), utterances: [{ speakerId: 'ines', factId: 'f-invented' }] }),
    ).toBe('NARRATION_UNKNOWN_FACT');
  });

  it('rejects a speaker voicing a fact they have not learned', () => {
    // On the stamp route Mara never learned the ledger was altered.
    const attempt: NarrationOutput = {
      ...good(cellar),
      utterances: [{ speakerId: 'mara', factId: 'f-ines-altered-ledger' }],
    };
    expect(reasonFor(attempt, cellar)).toBe('NARRATION_KNOWLEDGE_UNAVAILABLE');
    // Knowledge is per speaker: an NPC cannot voice a fact only the world defines.
    const npcAttempt = {
      ...good(cellar),
      utterances: [{ speakerId: 'tomasz', factId: 'f-gone-two-days' }],
    };
    expect(reasonFor(npcAttempt, cellar)).toBe('NARRATION_KNOWLEDGE_UNAVAILABLE');
  });

  it('rejects approved templates from the wrong scene or the wrong selection', () => {
    expect(reasonFor({ ...good(), templateIds: ['t-door-intro'] })).toBe(
      'NARRATION_TEMPLATE_MISMATCH',
    );
    expect(reasonFor({ ...good(), templateIds: good().templateIds.slice(0, 2) })).toBe(
      'NARRATION_TEMPLATE_MISMATCH',
    );
    // A conditional template whose condition does not hold cannot be smuggled in.
    expect(
      reasonFor(
        { ...good(cellar), templateIds: [...good(cellar).templateIds, 't-cellar-accuse'] },
        cellar,
      ),
    ).toBe('NARRATION_TEMPLATE_MISMATCH');
  });

  it('rejects declared utterances that differ from the templates', () => {
    expect(reasonFor({ ...good(), utterances: [] })).toBe('NARRATION_UTTERANCE_MISMATCH');
  });

  it('rejects text that is not the approved rendering', () => {
    expect(
      reasonFor({ ...good(), text: `${good().text} Suddenly Ines confessed everything.` }),
    ).toBe('NARRATION_TEXT_MISMATCH');
    expect(reasonFor({ ...good(), text: 'Tomasz is dead.' })).toBe('NARRATION_TEXT_MISMATCH');
  });
});

describe('prepareNarration', () => {
  class FixedNarrator implements NarratorProvider {
    readonly providerName = 'test-invalid';
    constructor(private readonly produce: (request: NarrationRequest) => unknown) {}
    narrate(request: NarrationRequest): Promise<unknown> {
      return Promise.resolve(this.produce(request));
    }
  }

  it('rejects a deliberately invalid provider', async () => {
    const lying = new FixedNarrator((r) => ({
      ...buildCanonicalNarration(r.scenario, r.state),
      text: 'A completely different story.',
    }));
    await expect(prepareNarration(lying, scenario, flatCellar)).rejects.toMatchObject({
      reason: 'NARRATION_TEXT_MISMATCH',
    });
  });

  it('reports provider failures without leaking the provider error', async () => {
    const broken: NarratorProvider = {
      providerName: 'broken',
      narrate: () => Promise.reject(new Error('secret upstream detail')),
    };
    const error = await prepareNarration(broken, scenario, flatCellar).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NarrationRejectedError);
    expect((error as NarrationRejectedError).reason).toBe('NARRATION_PROVIDER_FAILED');
    expect((error as Error).message).not.toContain('secret');
  });
});
