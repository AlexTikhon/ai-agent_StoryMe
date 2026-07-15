import type { GenerationInputSnapshot } from './generation-input-snapshot';

/**
 * Everything a single claimed GenerationRun attempt needs to execute the
 * pipeline and fence every write it makes: the run/book identity, the exact
 * fencingVersion this attempt observed at claim time (every subsequent write
 * must prove that version still holds — see GenerationExecutionService.
 * applyFencedBookWrite), and the validated immutable input this run must
 * generate from — never the book's live, possibly-since-edited columns.
 */
export interface GenerationExecutionContext {
  readonly runId: string;
  readonly bookId: string;
  readonly fencingVersion: number;
  readonly inputHash: string;
  readonly inputSnapshot: GenerationInputSnapshot;
}
