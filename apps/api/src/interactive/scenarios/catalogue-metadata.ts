import type { ScenarioCatalogueMetadata } from './registry';

/**
 * Catalogue metadata for published scenario versions. Written by hand; never
 * generated from a definition or a provider. An entry is added only together
 * with the registration of the version it describes (see
 * docs/interactive-authoring.md, "Publication boundary").
 */
export const CATALOGUE_METADATA: readonly ScenarioCatalogueMetadata[] = [
  {
    scenarioId: 'warsaw-last-delivery',
    version: 1,
    title: 'The Last Delivery',
    synopsis:
      'Warsaw, a wet evening. You are a courier with one parcel left and an address in Praga where nobody seems to be home.',
  },
];
