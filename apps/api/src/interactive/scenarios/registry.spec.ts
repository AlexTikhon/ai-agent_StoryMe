import { describe, expect, it } from 'vitest';
import type { ScenarioDefinition } from '../domain/scenario-schema';
import { hashScenarioDefinition } from '../domain/scenario-schema';
import {
  DEFAULT_SCENARIO_TITLE,
  createScenarioRegistry,
  type ScenarioCatalogueMetadata,
} from './registry';
import {
  getLatestScenario,
  getScenario,
  getScenarioCatalogue,
  getScenarioTitle,
  listScenarioIds,
  WARSAW_LAST_DELIVERY_V1,
} from './index';

/** Test-only definitions: structurally minimal stand-ins, never registered as real content. */
function fake(id: string, version: number): ScenarioDefinition {
  return {
    id,
    version,
    language: 'en',
    title: `internal ${id}`,
    scenes: [{ id: 'secret-scene', choices: [{ id: 'secret-choice' }] }],
    endings: [{ id: 'secret-ending' }],
  } as unknown as ScenarioDefinition;
}

const meta = (scenarioId: string, version: number, extra = ''): ScenarioCatalogueMetadata => ({
  scenarioId,
  version,
  title: `Title ${scenarioId} v${version}${extra}`,
  synopsis: `Synopsis of ${scenarioId} v${version}.`,
});

describe('createScenarioRegistry', () => {
  it('lists one allowlisted entry per scenario: its latest version, sorted by id', () => {
    const registry = createScenarioRegistry(
      [fake('b-story', 1), fake('a-story', 1), fake('a-story', 2), fake('a-story', 3)],
      [meta('a-story', 1), meta('a-story', 2), meta('a-story', 3), meta('b-story', 1)],
    );
    expect(registry.catalogue()).toEqual([
      {
        scenarioId: 'a-story',
        scenarioVersion: 3,
        title: 'Title a-story v3',
        language: 'en',
        synopsis: 'Synopsis of a-story v3.',
      },
      {
        scenarioId: 'b-story',
        scenarioVersion: 1,
        title: 'Title b-story v1',
        language: 'en',
        synopsis: 'Synopsis of b-story v1.',
      },
    ]);
  });

  it('is independent of registration order', () => {
    const forward = createScenarioRegistry(
      [fake('a', 1), fake('a', 2)],
      [meta('a', 1), meta('a', 2)],
    );
    const reversed = createScenarioRegistry(
      [fake('a', 2), fake('a', 1)],
      [meta('a', 2), meta('a', 1)],
    );
    expect(reversed.catalogue()).toEqual(forward.catalogue());
    expect(reversed.getLatest('a')?.version).toBe(2);
  });

  it('resolves exact versions and the latest, and titles by pinned version', () => {
    const registry = createScenarioRegistry(
      [fake('a', 1), fake('a', 2)],
      [meta('a', 1), meta('a', 2)],
    );
    expect(registry.get('a', 1)?.version).toBe(1);
    expect(registry.get('a', 3)).toBeUndefined();
    expect(registry.getLatest('a')?.version).toBe(2);
    expect(registry.getLatest('zzz')).toBeUndefined();
    expect(registry.title('a', 1)).toBe('Title a v1');
    expect(registry.title('a', 2)).toBe('Title a v2');
  });

  it('falls back to a safe title when no metadata exists for a pinned version', () => {
    const registry = createScenarioRegistry([fake('a', 1), fake('a', 2)], [meta('a', 2)]);
    expect(registry.title('a', 1)).toBe(DEFAULT_SCENARIO_TITLE);
    expect(registry.title('unknown', 1)).toBe(DEFAULT_SCENARIO_TITLE);
    expect(registry.title('a', 9)).toBe(DEFAULT_SCENARIO_TITLE);
  });

  it('never exposes anything beyond the five allowlisted fields', () => {
    const [entry] = createScenarioRegistry([fake('a', 1)], [meta('a', 1)]).catalogue();
    expect(Object.keys(entry!).sort()).toEqual([
      'language',
      'scenarioId',
      'scenarioVersion',
      'synopsis',
      'title',
    ]);
    const text = JSON.stringify(entry);
    expect(text).not.toContain('secret');
    expect(text).not.toContain('internal');
  });

  it('rejects metadata for an identity that is not published', () => {
    expect(() => createScenarioRegistry([fake('a', 1)], [meta('a', 1), meta('ghost', 1)])).toThrow(
      /ghost@1/,
    );
    expect(() => createScenarioRegistry([fake('a', 1)], [meta('a', 1), meta('a', 2)])).toThrow(
      /a@2/,
    );
  });

  it('rejects duplicate metadata entries and duplicate definitions', () => {
    expect(() => createScenarioRegistry([fake('a', 1)], [meta('a', 1), meta('a', 1)])).toThrow(
      /duplicate/i,
    );
    expect(() => createScenarioRegistry([fake('a', 1), fake('a', 1)], [meta('a', 1)])).toThrow(
      /duplicate/i,
    );
  });

  it('requires metadata for the latest version of every scenario', () => {
    expect(() => createScenarioRegistry([fake('a', 1)], [])).toThrow(/a@1/);
    expect(() => createScenarioRegistry([fake('a', 1), fake('a', 2)], [meta('a', 1)])).toThrow(
      /a@2/,
    );
  });

  it('rejects empty, oversized or multi-line titles and synopses', () => {
    const bad = (patch: Partial<ScenarioCatalogueMetadata>) => () =>
      createScenarioRegistry([fake('a', 1)], [{ ...meta('a', 1), ...patch }]);
    expect(bad({ title: '' })).toThrow();
    expect(bad({ title: '   ' })).toThrow();
    expect(bad({ title: 'x'.repeat(81) })).toThrow();
    expect(bad({ synopsis: '' })).toThrow();
    expect(bad({ synopsis: 'x'.repeat(401) })).toThrow();
    expect(bad({ synopsis: 'line one\nline two' })).toThrow();
  });
});

describe('published registry', () => {
  it('serves "The Last Delivery" as the only published scenario', () => {
    expect(listScenarioIds()).toEqual(['warsaw-last-delivery']);
    expect(getScenarioCatalogue()).toEqual([
      {
        scenarioId: 'warsaw-last-delivery',
        scenarioVersion: 1,
        title: 'The Last Delivery',
        language: 'en',
        synopsis: expect.stringMatching(/\S/),
      },
    ]);
    expect(getScenarioTitle('warsaw-last-delivery', 1)).toBe('The Last Delivery');
  });

  it('keeps "The Last Tram" unregistered', () => {
    expect(getLatestScenario('warsaw-last-tram')).toBeUndefined();
    expect(getScenario('warsaw-last-tram', 1)).toBeUndefined();
    expect(getScenarioCatalogue().map((e) => e.scenarioId)).not.toContain('warsaw-last-tram');
  });

  it('keeps catalogue metadata outside the definition, so the definition hash is unchanged', () => {
    expect(JSON.stringify(WARSAW_LAST_DELIVERY_V1)).not.toContain('synopsis');
    // Pinned: adding or editing catalogue metadata must never change a published definition.
    expect(hashScenarioDefinition(WARSAW_LAST_DELIVERY_V1)).toBe(
      'f88853f4534971a735f886a8bf7d8c72341ec16c2ddeac5254736028e43ee249',
    );
  });

  it('has a spoiler-free synopsis that names no ending', () => {
    const [entry] = getScenarioCatalogue();
    for (const ending of WARSAW_LAST_DELIVERY_V1.endings) {
      expect(entry!.synopsis.toLowerCase()).not.toContain(ending.title.toLowerCase());
    }
  });
});
