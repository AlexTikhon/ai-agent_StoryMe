import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { playChoices } from '../domain/engine';
import { buildCanonicalNarration } from '../domain/narration';
import { buildPublicView, type PublicSessionView } from '../public-view';
import { WARSAW_LAST_DELIVERY_V1 as scenario } from '../scenarios';
import { WARSAW_ROUTES } from '../scenarios/routes';
import { WARSAW_NOIR_V1_DATA } from './packs';
import {
  WARSAW_NOIR_V1,
  getPresentationPack,
  listPresentationPacks,
  loadPresentationPack,
  presentationResponseSchema,
  projectPresentation,
  projectTranscriptPresentation,
  transcriptPresentationResponseSchema,
} from './presentation';
import { PresentationPackError, parsePresentationPack } from './presentation-schema';

const SESSION_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
/** The web app serves these files; the API only names them. */
const WEB_PUBLIC = path.resolve(__dirname, '../../../../web/public');
const MAX_ASSET_BYTES = 20_000;

function viewAt(route: readonly string[]): PublicSessionView {
  const { state } = playChoices(scenario, route);
  return buildPublicView({
    sessionId: SESSION_ID,
    scenario,
    state,
    narration: buildCanonicalNarration(scenario, state),
  });
}

const allPanels = Object.values(WARSAW_NOIR_V1.scenes).flat();

describe('presentation pack coverage', () => {
  it('maps all eight shipped scenes, and only them', () => {
    const sceneIds = scenario.scenes.map((s) => s.id).sort();
    expect(sceneIds).toEqual([
      's-caretaker',
      's-cellar',
      's-courtyard',
      's-door',
      's-end-exposed',
      's-end-quiet',
      's-flat',
      's-mailboxes',
    ]);
    expect(Object.keys(WARSAW_NOIR_V1.scenes).sort()).toEqual(sceneIds);
  });

  it('has a panel for every scene on every known route', () => {
    for (const route of Object.values(WARSAW_ROUTES)) {
      for (let i = 0; i <= route.length; i += 1) {
        const view = viewAt(route.slice(0, i));
        const dto = projectPresentation(view);
        expect(dto.presentation?.panels.length, `${view.scene.id} @ step ${i}`).toBeGreaterThan(0);
        expect(dto.sceneId).toBe(view.scene.id);
      }
    }
  });

  it('is registered for warsaw-last-delivery v1 and identifies pack and version', () => {
    expect(getPresentationPack('warsaw-last-delivery', 1)).toBe(WARSAW_NOIR_V1);
    expect(WARSAW_NOIR_V1).toMatchObject({ packId: 'warsaw-noir', packVersion: 1 });
    expect(listPresentationPacks()).toHaveLength(1);
  });

  it('rejects a pack that misses or invents scenes', () => {
    const { 's-cellar': _dropped, ...rest } = WARSAW_NOIR_V1_DATA.scenes;
    expect(() => loadPresentationPack({ ...WARSAW_NOIR_V1_DATA, scenes: rest })).toThrow(
      /no panel for scene s-cellar/,
    );
    expect(() =>
      loadPresentationPack({
        ...WARSAW_NOIR_V1_DATA,
        scenes: {
          ...WARSAW_NOIR_V1_DATA.scenes,
          's-future': [
            {
              ...WARSAW_NOIR_V1_DATA.scenes['s-door'][0],
              id: 'p-future',
              src: '/interactive/warsaw-noir/v1/s-future.svg',
            },
          ],
        },
      }),
    ).toThrow(/unknown scene s-future/);
    expect(() => loadPresentationPack({ ...WARSAW_NOIR_V1_DATA, scenarioVersion: 99 })).toThrow(
      PresentationPackError,
    );
  });
});

describe('presentation pack validation', () => {
  const panel = WARSAW_NOIR_V1_DATA.scenes['s-door'][0];
  const withPanel = (override: Record<string, unknown>) => ({
    ...WARSAW_NOIR_V1_DATA,
    scenes: { 's-door': [{ ...panel, ...override }] },
  });

  it('accepts the shipped pack', () => {
    expect(parsePresentationPack(WARSAW_NOIR_V1_DATA)).toEqual(WARSAW_NOIR_V1_DATA);
  });

  it.each([
    ['a remote URL', 'https://cdn.example.com/interactive/warsaw-noir/v1/s-door.svg'],
    ['a protocol-relative URL', '//evil.example/interactive/warsaw-noir/v1/s-door.svg'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a data: URL', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='],
    ['path traversal', '/interactive/warsaw-noir/v1/../../secret.svg'],
    ['a query string', '/interactive/warsaw-noir/v1/s-door.svg?x=1'],
    ['a non-SVG extension', '/interactive/warsaw-noir/v1/s-door.html'],
    ['an unversioned directory', '/interactive/warsaw-noir/s-door.svg'],
    ['a different pack directory', '/interactive/other-pack/v1/s-door.svg'],
    ['a different pack version directory', '/interactive/warsaw-noir/v2/s-door.svg'],
  ])('rejects %s as an asset path', (_name, src) => {
    expect(() => parsePresentationPack(withPanel({ src }))).toThrow(PresentationPackError);
  });

  it('rejects unknown keys, bad dimensions, empty alt text and duplicate ids', () => {
    expect(() => parsePresentationPack(withPanel({ extra: 1 }))).toThrow(PresentationPackError);
    expect(() => parsePresentationPack(withPanel({ width: 0 }))).toThrow(PresentationPackError);
    expect(() => parsePresentationPack(withPanel({ width: 12.5 }))).toThrow(PresentationPackError);
    expect(() => parsePresentationPack(withPanel({ alt: '' }))).toThrow(PresentationPackError);
    expect(() =>
      parsePresentationPack({
        ...WARSAW_NOIR_V1_DATA,
        scenes: {
          's-door': [panel],
          's-flat': [{ ...panel, src: panel.src.replace('door', 'flat') }],
        },
      }),
    ).toThrow(/duplicate panel id/);
  });
});

describe('presentation assets', () => {
  it('has exactly the referenced files in the versioned directory', () => {
    const dir = path.join(WEB_PUBLIC, 'interactive', 'warsaw-noir', 'v1');
    const onDisk = readdirSync(dir).sort();
    const referenced = allPanels.map((p) => path.posix.basename(p.src)).sort();
    expect(onDisk).toEqual(referenced);
  });

  it.each(allPanels.map((p) => [p.id, p] as const))('asset %s is a small, safe SVG', (_id, p) => {
    const file = path.join(WEB_PUBLIC, p.src);
    const size = statSync(file).size;
    expect(size).toBeGreaterThan(1_000); // a real drawing, not a stub
    expect(size).toBeLessThan(MAX_ASSET_BYTES);

    const svg = readFileSync(file, 'utf8');
    expect(svg).toMatch(/^<svg\s/);
    // Declared dimensions agree with the pack, so reserved space is exact.
    expect(svg).toContain(`viewBox="0 0 ${p.width} ${p.height}"`);
    const root = /^<svg\s[^>]*>/.exec(svg)![0];
    expect(root).toContain(`width="${p.width}"`);
    expect(root).toContain(`height="${p.height}"`);

    // Safe by construction: no active content and nothing outside the file.
    expect(svg).not.toMatch(/<\s*script/i);
    expect(svg).not.toMatch(/<\s*foreignObject/i);
    expect(svg).not.toMatch(/<\s*(iframe|object|embed|image|audio|video|link|style)\b/i);
    expect(svg).not.toMatch(/\son[a-z]+\s*=/i);
    expect(svg).not.toMatch(/javascript:|data:|@import|<!ENTITY|<!DOCTYPE/i);
    expect(svg).not.toMatch(/\b(xlink:)?href\s*=/i);
    // Only internal references: every url() points at a fragment.
    for (const ref of svg.matchAll(/url\(([^)]*)\)/g)) expect(ref[1]).toMatch(/^#[A-Za-z0-9_-]+$/);
    // The only URL-looking text is the SVG namespace declaration.
    const urls = [...svg.matchAll(/https?:\/\/[^\s"')]+/g)].map((m) => m[0]);
    expect(urls.every((u) => u === 'http://www.w3.org/2000/svg')).toBe(true);
    // Pictures only: no readable text baked into the art.
    expect(svg).not.toMatch(/<\s*text\b/i);
  });

  it('draws different compositions for different scenes', () => {
    const bodies = allPanels.map((p) => readFileSync(path.join(WEB_PUBLIC, p.src), 'utf8'));
    expect(new Set(bodies).size).toBe(allPanels.length);
  });
});

describe('presentation projection', () => {
  it('returns the current scene only, with exactly the allow-listed fields', () => {
    const view = viewAt(['c-ask-caretaker']);
    const dto = projectPresentation(view);
    expect(presentationResponseSchema.parse(dto)).toEqual(dto);
    expect(Object.keys(dto).sort()).toEqual(
      ['presentation', 'revision', 'sceneId', 'scenarioId', 'scenarioVersion', 'sessionId'].sort(),
    );
    expect(dto).toMatchObject({
      sessionId: SESSION_ID,
      revision: 1,
      scenarioId: 'warsaw-last-delivery',
      scenarioVersion: 1,
      sceneId: 's-caretaker',
    });
    expect(dto.presentation?.panels).toHaveLength(1);
    expect(dto.presentation?.panels[0]).toMatchObject({ id: 'p-caretaker' });
    expect(Object.keys(dto.presentation!).sort()).toEqual(['packId', 'packVersion', 'panels']);
    expect(Object.keys(dto.presentation!.panels[0]!).sort()).toEqual([
      'alt',
      'height',
      'id',
      'src',
      'width',
    ]);
  });

  it('never leaks other scenes, future panels, state, flags, events or narration', () => {
    const view = viewAt(['c-ask-caretaker']);
    const wire = JSON.stringify(projectPresentation(view));
    for (const other of allPanels.filter((p) => p.id !== 'p-caretaker')) {
      expect(wire).not.toContain(other.id);
      expect(wire).not.toContain(other.src);
    }
    for (const scene of scenario.scenes.filter((s) => s.id !== 's-caretaker')) {
      expect(wire).not.toContain(scene.id);
    }
    for (const hidden of [
      'asked-caretaker',
      'flags',
      'stateHash',
      'knowledge',
      'inventory',
      'narration',
      'choices',
      'c-climb-from-caretaker',
      'f-ines-altered-ledger',
      'entry-card',
    ]) {
      expect(wire).not.toContain(hidden);
    }
  });

  it('is a pure function of the view', () => {
    const view = viewAt(['c-read-mailboxes']);
    const frozen = JSON.stringify(view);
    expect(projectPresentation(view)).toEqual(projectPresentation(view));
    expect(JSON.stringify(view)).toBe(frozen);
  });

  it('returns presentation: null for an unconfigured scenario or version, not an error', () => {
    const view = viewAt([]);
    for (const patch of [{ scenarioVersion: 2 }, { scenarioId: 'unknown-story' }]) {
      const dto = projectPresentation({ ...view, ...patch });
      expect(dto.presentation).toBeNull();
      expect(dto.sceneId).toBe('s-courtyard');
    }
  });

  it('returns presentation: null for a scene the pack does not name', () => {
    const view = viewAt([]);
    const dto = projectPresentation({ ...view, scene: { id: 's-unmapped', title: 'Unmapped' } });
    expect(dto.presentation).toBeNull();
  });
});

describe('shared quiet ending artwork', () => {
  const routes = [
    ['parcel handed over (via flat)', WARSAW_ROUTES.quietViaFlat],
    ['parcel handed over (via stamp)', WARSAW_ROUTES.quietViaStamp],
    ['parcel left at the door', WARSAW_ROUTES.quietAtDoor],
  ] as const;

  it.each(routes)('is valid and identical when reached by: %s', (_name, route) => {
    const view = viewAt(route);
    expect(view.scene.id).toBe('s-end-quiet');
    expect(view.ending?.id).toBe('quiet-delivery');
    const dto = projectPresentation(view);
    expect(dto.presentation?.panels).toEqual(WARSAW_NOIR_V1.scenes['s-end-quiet']);
  });

  it('asserts neither delivery route in its alt text or file name', () => {
    const [panel] = WARSAW_NOIR_V1.scenes['s-end-quiet']!;
    expect(panel!.alt).not.toMatch(
      /hand|gives?|gave|takes?|took|door|slip|Tomasz|Mara|parcel|package/i,
    );
    expect(panel!.src).not.toMatch(/hand|door|left/i);
  });

  it('shows the exposed ending only on the exposed route', () => {
    const exposed = projectPresentation(viewAt(WARSAW_ROUTES.exposed));
    expect(exposed.sceneId).toBe('s-end-exposed');
    expect(exposed.presentation?.panels[0]?.id).toBe('p-end-exposed');
  });
});

describe('transcript presentation projection', () => {
  /** The narrow shape of a transcript page that the projection needs. */
  function pageOf(route: readonly string[], patch: Record<string, unknown> = {}) {
    const steps = Array.from({ length: route.length + 1 }, (_, i) => {
      const view = viewAt(route.slice(0, i));
      return {
        revision: view.revision,
        scene: { id: view.scene.id, title: view.scene.title },
        narration: view.narration,
        arrivedByChoiceLabel: null,
        ending: null,
      };
    });
    return {
      sessionId: SESSION_ID,
      scenarioId: 'warsaw-last-delivery',
      scenarioVersion: 1,
      completedRevision: route.length,
      steps,
      nextCursor: null,
      ...patch,
    };
  }

  it.each(['exposed', 'quietAtDoor'] as const)(
    'selects, per stored step, the same artwork the current-scene projection selects (%s)',
    (name) => {
      const route = WARSAW_ROUTES[name];
      const dto = projectTranscriptPresentation(pageOf(route));
      expect(dto.steps.map((s) => s.revision)).toEqual(Array.from({ length: route.length + 1 }, (_, i) => i));
      for (const [i, step] of dto.steps.entries()) {
        const current = projectPresentation(viewAt(route.slice(0, i)));
        expect(step.sceneId).toBe(current.sceneId);
        expect(step.presentation).toEqual(current.presentation);
        expect(step.presentation?.panels.length).toBeGreaterThan(0);
      }
    },
  );

  it('carries identity, completed revision and cursor through unchanged, with only allow-listed fields', () => {
    const dto = projectTranscriptPresentation(
      pageOf(WARSAW_ROUTES.quietAtDoor, { nextCursor: 'opaque-cursor' }),
    );
    expect(transcriptPresentationResponseSchema.parse(dto)).toEqual(dto);
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
    expect(dto).toMatchObject({
      sessionId: SESSION_ID,
      completedRevision: 3,
      nextCursor: 'opaque-cursor',
    });
    for (const step of dto.steps) {
      expect(Object.keys(step).sort()).toEqual(['presentation', 'revision', 'sceneId']);
    }
    const wire = JSON.stringify(dto);
    for (const hidden of ['narration', 'choices', 'title', 'arrivedBy', 'ending', 'flags']) {
      expect(wire).not.toContain(hidden);
    }
  });

  it('shows artwork only for scenes that were visited', () => {
    const dto = projectTranscriptPresentation(pageOf(WARSAW_ROUTES.quietAtDoor));
    const wire = JSON.stringify(dto);
    const visited = new Set(dto.steps.map((s) => s.sceneId));
    for (const [sceneId, panels] of Object.entries(WARSAW_NOIR_V1.scenes)) {
      if (visited.has(sceneId)) continue;
      expect(wire).not.toContain(sceneId);
      for (const panel of panels) expect(wire).not.toContain(panel.src);
    }
  });

  it('returns presentation: null for an unconfigured scenario version, an unknown scenario or an unmapped scene', () => {
    for (const patch of [{ scenarioVersion: 2 }, { scenarioId: 'unknown-story' }]) {
      const dto = projectTranscriptPresentation(pageOf(['c-ask-caretaker'], patch));
      expect(dto.steps).toHaveLength(2);
      expect(dto.steps.every((s) => s.presentation === null)).toBe(true);
    }
    const page = pageOf([]);
    page.steps[0]!.scene = { id: 's-unmapped', title: 'Unmapped' };
    expect(projectTranscriptPresentation(page).steps[0]).toEqual({
      revision: 0,
      sceneId: 's-unmapped',
      presentation: null,
    });
  });

  it('is pure: it does not mutate its input', () => {
    const page = pageOf(WARSAW_ROUTES.exposed);
    const frozen = JSON.stringify(page);
    projectTranscriptPresentation(page);
    expect(JSON.stringify(page)).toBe(frozen);
  });

  it('is validated by a strict schema that rejects extra fields at every level', () => {
    const dto = projectTranscriptPresentation(pageOf(['c-ask-caretaker']));
    const accepts = (mutate: (copy: any) => void) => {
      const copy = JSON.parse(JSON.stringify(dto));
      mutate(copy);
      return transcriptPresentationResponseSchema.safeParse(copy).success;
    };
    expect(accepts(() => undefined)).toBe(true);
    expect(accepts((c) => (c.narration = 'x'))).toBe(false);
    expect(accepts((c) => (c.steps[0].choices = []))).toBe(false);
    expect(accepts((c) => (c.steps[0].presentation.manifest = {}))).toBe(false);
    expect(accepts((c) => (c.steps[0].presentation.panels[0].extra = 1))).toBe(false);
  });
});
