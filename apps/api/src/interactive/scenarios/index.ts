import { analyzeScenario } from '../domain/scenario-analysis';
import {
  parseScenarioDefinition,
  ScenarioValidationError,
  type ScenarioDefinition,
} from '../domain/scenario-schema';
import warsawLastDeliveryV1 from './warsaw-last-delivery.v1.json';

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
 * pinned to the version they were created with.
 */
const SCENARIOS: readonly ScenarioDefinition[] = [loadScenario(warsawLastDeliveryV1)];

export const WARSAW_LAST_DELIVERY_V1: ScenarioDefinition = SCENARIOS[0]!;

export function getScenario(id: string, version: number): ScenarioDefinition | undefined {
  return SCENARIOS.find((s) => s.id === id && s.version === version);
}

/** The newest version of a scenario; used when starting a new session. */
export function getLatestScenario(id: string): ScenarioDefinition | undefined {
  return SCENARIOS.filter((s) => s.id === id).sort((a, b) => b.version - a.version)[0];
}

export function listScenarioIds(): string[] {
  return [...new Set(SCENARIOS.map((s) => s.id))].sort();
}
