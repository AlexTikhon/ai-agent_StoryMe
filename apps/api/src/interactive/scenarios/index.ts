import { analyzeScenario } from '../domain/scenario-analysis';
import {
  parseScenarioDefinition,
  ScenarioValidationError,
  type ScenarioDefinition,
} from '../domain/scenario-schema';
import { CATALOGUE_METADATA } from './catalogue-metadata';
import { createScenarioRegistry, type ScenarioRegistry } from './registry';
import warsawLastDeliveryV1 from './warsaw-last-delivery.v1.json';

export { DEFAULT_SCENARIO_TITLE, createScenarioRegistry } from './registry';
export type { ScenarioCatalogueMetadata, ScenarioRegistry } from './registry';

/**
 * Validates a raw definition structurally and by exhaustive play analysis.
 * Throws ScenarioValidationError listing every problem found.
 */
export function loadScenario(raw: unknown): ScenarioDefinition {
  const scenario = parseScenarioDefinition(raw);
  const analysis = analyzeScenario(scenario);
  if (analysis.issues.length > 0) throw new ScenarioValidationError(analysis.issues);
  return scenario;
}

/**
 * Every published (id, version). Definitions are append-only: a new version is
 * added as a new entry, an existing entry is never edited, and sessions stay
 * pinned to the version they were created with. This static list is the
 * publication authority; catalogue metadata can only describe what is here.
 */
const SCENARIOS: readonly ScenarioDefinition[] = [loadScenario(warsawLastDeliveryV1)];

export const WARSAW_LAST_DELIVERY_V1: ScenarioDefinition = SCENARIOS[0]!;

/** The registry of real published content, validated at module load. */
export const publishedScenarioRegistry: ScenarioRegistry = createScenarioRegistry(
  SCENARIOS,
  CATALOGUE_METADATA,
);

export function getScenario(id: string, version: number): ScenarioDefinition | undefined {
  return publishedScenarioRegistry.get(id, version);
}

/** The newest version of a scenario; used when a start request names no version. */
export function getLatestScenario(id: string): ScenarioDefinition | undefined {
  return publishedScenarioRegistry.getLatest(id);
}

export function listScenarioIds(): string[] {
  return publishedScenarioRegistry.listIds();
}

export function getScenarioCatalogue() {
  return publishedScenarioRegistry.catalogue();
}

export function getScenarioTitle(id: string, version: number): string {
  return publishedScenarioRegistry.title(id, version);
}
