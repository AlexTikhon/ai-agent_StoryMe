import type { LegacyBaselineEntry } from '../publication/guarded-registry';

/**
 * Content that was already published before editorial approval records existed.
 * This is an explicit, frozen exception for EXISTING content only: it pins one
 * exact (id, version) to its exact canonical hash, and records no retrospective
 * human approval. An edited copy, another scenario or a new version is not
 * covered and needs a real approval record like any future entry.
 *
 * Never add an entry here for new content. New content gets an approval record.
 */
export const LEGACY_PUBLISHED_BASELINE: readonly LegacyBaselineEntry[] = [
  {
    id: 'warsaw-last-delivery',
    version: 1,
    candidateHash: 'f88853f4534971a735f886a8bf7d8c72341ec16c2ddeac5254736028e43ee249',
    reason: 'EXISTING_PUBLISHED_CONTENT',
  },
];
