import { describe, it, expect } from 'vitest';
import type { InteractiveTranscriptPresentationDto } from '@book/types';
import { describeAcceptedPage } from './accepted-page';
import { checkTranscriptArtwork } from './validate-transcript-artwork';
import {
  makeArtworkPage,
  makeArtworkPanel,
  makeTranscriptPage,
} from '../../interactive-test-fixtures';

const text = makeTranscriptPage(3, 5, 6);
const accepted = describeAcceptedPage(text, { limit: 3, cursor: 'cursor-3' });
const good = () => makeArtworkPage(text);

function withStep(
  patch: Partial<InteractiveTranscriptPresentationDto['steps'][number]>,
  index = 0,
): InteractiveTranscriptPresentationDto {
  const page = good();
  page.steps[index] = { ...page.steps[index]!, ...patch };
  return page;
}

const withPanel = (patch: Record<string, unknown>) =>
  withStep({
    presentation: {
      packId: 'warsaw-noir',
      packVersion: 1,
      panels: [{ ...makeArtworkPanel('scene-3'), ...patch }],
    },
  });

const rejected = (raw: unknown) => {
  const result = checkTranscriptArtwork(raw, accepted);
  expect(result.ok).toBe(false);
  return result;
};

describe('describeAcceptedPage', () => {
  it('freezes the exact request and the validated identity of the text page', () => {
    expect(accepted).toMatchObject({
      id: 'cursor:cursor-3',
      request: { limit: 3, cursor: 'cursor-3' },
      sessionId: text.sessionId,
      completedRevision: 6,
      revisions: [3, 4, 5],
      sceneIds: ['scene-3', 'scene-4', 'scene-5'],
      nextCursor: 'cursor-6',
    });
    expect(Object.isFrozen(accepted)).toBe(true);
    expect(Object.isFrozen(accepted.revisions)).toBe(true);
    expect(describeAcceptedPage(makeTranscriptPage(0, 2, 6), { limit: 3, cursor: null }).id).toBe(
      'first',
    );
  });
});

describe('checkTranscriptArtwork', () => {
  it('accepts artwork that matches its text page exactly, in order', () => {
    const result = checkTranscriptArtwork(good(), accepted);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.steps.map((s) => s?.panels[0]?.id)).toEqual([
      'p-scene-3',
      'p-scene-4',
      'p-scene-5',
    ]);
    expect(result.steps[0]).toMatchObject({ packId: 'warsaw-noir', packVersion: 1 });
  });

  it('accepts a page with no artwork configured', () => {
    const result = checkTranscriptArtwork(makeArtworkPage(text, { pack: false }), accepted);
    expect(result).toEqual({ ok: true, steps: [null, null, null] });
  });

  it('drops fields it does not know', () => {
    const page = withPanel({ extra: 'x' });
    const result = checkTranscriptArtwork(page, accepted);
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(Object.keys(result.steps[0]!.panels[0]!).sort()).toEqual([
        'alt',
        'height',
        'id',
        'src',
        'width',
      ]);
  });

  it.each<[string, (page: InteractiveTranscriptPresentationDto) => unknown]>([
    ['another session', (p) => ({ ...p, sessionId: 'other' })],
    ['another scenario', (p) => ({ ...p, scenarioId: 'other' })],
    ['another version', (p) => ({ ...p, scenarioVersion: 2 })],
    ['another completed revision', (p) => ({ ...p, completedRevision: 7 })],
    ['another cursor', (p) => ({ ...p, nextCursor: 'cursor-9' })],
    ['no cursor where one is expected', (p) => ({ ...p, nextCursor: null })],
    ['a missing step', (p) => ({ ...p, steps: p.steps.slice(0, 2) })],
    ['an extra step', (p) => ({ ...p, steps: [...p.steps, p.steps[2]!] })],
    ['reordered steps', (p) => ({ ...p, steps: [p.steps[1]!, p.steps[0]!, p.steps[2]!] })],
    ['a wrong revision', (p) => ({ ...p, steps: p.steps.map((s) => ({ ...s, revision: 9 })) })],
    [
      'a wrong scene id',
      (p) => ({ ...p, steps: [{ ...p.steps[0]!, sceneId: 'x' }, ...p.steps.slice(1)] }),
    ],
    ['a non-array steps', (p) => ({ ...p, steps: 'nope' })],
    ['an array', () => []],
    ['null', () => null],
    ['a string', () => 'x'],
  ])('rejects the whole page for %s', (_name, mutate) => {
    rejected(mutate(good()));
  });

  it.each<[string, Record<string, unknown>]>([
    ['a remote src', { src: 'https://evil.example/a.svg' }],
    ['a protocol-relative src', { src: '//evil.example/a.svg' }],
    ['a traversing src', { src: '/interactive/warsaw-noir/v1/../../secret.svg' }],
    ['a src with a query', { src: '/interactive/warsaw-noir/v1/s.svg?x=1' }],
    ['a non-svg src', { src: '/interactive/warsaw-noir/v1/s.png' }],
    ['a javascript src', { src: 'javascript:alert(1)' }],
    ['a src of another pack', { src: '/interactive/other-pack/v1/s.svg' }],
    ['a src of another pack version', { src: '/interactive/warsaw-noir/v2/s.svg' }],
    ['a zero width', { width: 0 }],
    ['a fractional height', { height: 10.5 }],
    ['an oversized width', { width: 4001 }],
    ['an oversized height', { height: 4001 }],
    ['empty alt text', { alt: '' }],
    ['over-long alt text', { alt: 'a'.repeat(301) }],
    ['a non-string id', { id: 7 }],
    ['an over-long id', { id: 'p'.repeat(64) }],
  ])('rejects the page for %s', (_name, patch) => {
    rejected(withPanel(patch));
  });

  it('rejects an invalid pack identity or panel list', () => {
    const base = { packId: 'warsaw-noir', packVersion: 1, panels: [makeArtworkPanel('scene-3')] };
    for (const presentation of [
      { ...base, packId: 'Warsaw Noir' },
      { ...base, packId: '' },
      { ...base, packId: 7 },
      { ...base, packVersion: 0 },
      { ...base, packVersion: 1.5 },
      { ...base, packVersion: '1' },
      { ...base, panels: [] },
      { ...base, panels: 'x' },
      { ...base, panels: Array.from({ length: 5 }, (_, i) => makeArtworkPanel(`s${i}`)) },
      { ...base, panels: [makeArtworkPanel('scene-3'), makeArtworkPanel('scene-3')] },
      'warsaw-noir',
      [],
    ]) {
      rejected(withStep({ presentation: presentation as never }));
    }
  });

  it('rejects mixed packs within one page, and attaches nothing from it', () => {
    const page = good();
    page.steps[1] = {
      ...page.steps[1]!,
      presentation: {
        packId: 'other-pack',
        packVersion: 1,
        panels: [makeArtworkPanel('scene-4', { src: '/interactive/other-pack/v1/s-4.svg' })],
      },
    };
    const result = rejected(page);
    expect(result).not.toHaveProperty('steps');
  });
});
