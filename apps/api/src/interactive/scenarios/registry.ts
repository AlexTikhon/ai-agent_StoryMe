import type { InteractiveScenarioCatalogueEntryDto } from '@book/types';
import type { ScenarioDefinition } from '../domain/scenario-schema';

/**
 * Catalogue metadata is authored separately from scenario definitions, so a
 * title or synopsis change never alters a published definition (or its hash).
 * Identity is (scenarioId, version): a session pinned to v1 keeps its v1 title
 * after v2 is published.
 */
export interface ScenarioCatalogueMetadata {
  scenarioId: string;
  version: number;
  title: string;
  /** Short, manually authored and spoiler-free: no later scenes, facts or endings. */
  synopsis: string;
}

/** Shown when a session's pinned version has no catalogue metadata. */
export const DEFAULT_SCENARIO_TITLE = 'Interactive story';

export const MAX_TITLE_LENGTH = 80;
export const MAX_SYNOPSIS_LENGTH = 400;

/**
 * Published scenario definitions plus their catalogue metadata. The definitions
 * passed in are the publication authority; the metadata can only describe them.
 */
export interface ScenarioRegistry {
  get(id: string, version: number): ScenarioDefinition | undefined;
  getLatest(id: string): ScenarioDefinition | undefined;
  listIds(): string[];
  /** One allowlisted entry per scenario, for its latest version, sorted by id. */
  catalogue(): InteractiveScenarioCatalogueEntryDto[];
  /** Title of exactly this version, or DEFAULT_SCENARIO_TITLE when unavailable. */
  title(id: string, version: number): string;
}

const identity = (id: string, version: number) => `${id}@${version}`;

function assertText(label: string, value: string, max: number): void {
  if (value.trim().length === 0 || value.length > max || /[\r\n]/.test(value)) {
    throw new Error(`Catalogue ${label} must be one non-empty line of at most ${max} characters`);
  }
}

export function createScenarioRegistry(
  definitions: readonly ScenarioDefinition[],
  metadata: readonly ScenarioCatalogueMetadata[],
): ScenarioRegistry {
  const byIdentity = new Map<string, ScenarioDefinition>();
  for (const definition of definitions) {
    const key = identity(definition.id, definition.version);
    if (byIdentity.has(key)) throw new Error(`Duplicate scenario definition ${key}`);
    byIdentity.set(key, definition);
  }

  const metaByIdentity = new Map<string, ScenarioCatalogueMetadata>();
  for (const entry of metadata) {
    const key = identity(entry.scenarioId, entry.version);
    if (!byIdentity.has(key)) {
      throw new Error(`Catalogue metadata for unpublished scenario ${key}`);
    }
    if (metaByIdentity.has(key)) throw new Error(`Duplicate catalogue metadata for ${key}`);
    assertText(`title of ${key}`, entry.title, MAX_TITLE_LENGTH);
    assertText(`synopsis of ${key}`, entry.synopsis, MAX_SYNOPSIS_LENGTH);
    metaByIdentity.set(key, { ...entry });
  }

  const latestById = new Map<string, ScenarioDefinition>();
  for (const definition of definitions) {
    const current = latestById.get(definition.id);
    if (!current || definition.version > current.version) latestById.set(definition.id, definition);
  }
  const ids = [...latestById.keys()].sort();

  // The browser lists only latest versions, so each must be describable.
  const entries: InteractiveScenarioCatalogueEntryDto[] = ids.map((id) => {
    const latest = latestById.get(id)!;
    const key = identity(id, latest.version);
    const described = metaByIdentity.get(key);
    if (!described) throw new Error(`Missing catalogue metadata for ${key}`);
    return {
      scenarioId: id,
      scenarioVersion: latest.version,
      title: described.title,
      language: latest.language,
      synopsis: described.synopsis,
    };
  });

  return {
    get: (id, version) => byIdentity.get(identity(id, version)),
    getLatest: (id) => latestById.get(id),
    listIds: () => [...ids],
    catalogue: () => entries.map((entry) => ({ ...entry })),
    title: (id, version) =>
      metaByIdentity.get(identity(id, version))?.title ?? DEFAULT_SCENARIO_TITLE,
  };
}
