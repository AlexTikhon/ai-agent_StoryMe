import { loadScenario, createScenarioRegistry } from '../../../src/interactive/scenarios';
import type { ScenarioRegistry } from '../../../src/interactive/scenarios';
import type { ScenarioDefinition } from '../../../src/interactive/domain/scenario-schema';
import raw from '../../../src/interactive/scenarios/warsaw-last-delivery.v1.json';

/**
 * TEST-ONLY registry fixtures. They are playable copies of the real scenario
 * with a different identity and a distinguishable opening scene title. They
 * are never registered with the published registry and exist only so tests can
 * prove that the selected (id, version) is the one that is started.
 */
export function variantScenario(id: string, version: number): ScenarioDefinition {
  const copy = JSON.parse(JSON.stringify(raw)) as ScenarioDefinition;
  copy.id = id;
  copy.version = version;
  copy.scenes[0]!.title = openingTitle(id, version);
  return loadScenario(copy);
}

export const openingTitle = (id: string, version: number) => `Opening of ${id} v${version}`;

export const REAL_ID = 'warsaw-last-delivery';
export const SECOND_ID = 'test-second-story';

/** Two scenarios; the first has two published versions. */
export function twoStoryRegistry(): ScenarioRegistry {
  const definitions = [
    variantScenario(REAL_ID, 1),
    variantScenario(REAL_ID, 2),
    variantScenario(SECOND_ID, 1),
  ];
  return createScenarioRegistry(
    definitions,
    definitions.map((d) => ({
      scenarioId: d.id,
      version: d.version,
      title: `Title ${d.id} v${d.version}`,
      synopsis: `Synopsis ${d.id} v${d.version}.`,
    })),
  );
}

/** A registry that does not publish the real story at all. */
export function unrelatedRegistry(): ScenarioRegistry {
  const only = variantScenario(SECOND_ID, 1);
  return createScenarioRegistry(
    [only],
    [{ scenarioId: SECOND_ID, version: 1, title: 'Second', synopsis: 'Second.' }],
  );
}

/** The real story at v1 and v2, with catalogue metadata for v2 only. */
export function registryMissingV1Metadata(): ScenarioRegistry {
  return createScenarioRegistry(
    [variantScenario(REAL_ID, 1), variantScenario(REAL_ID, 2)],
    [{ scenarioId: REAL_ID, version: 2, title: 'Only v2', synopsis: 'Only v2.' }],
  );
}
