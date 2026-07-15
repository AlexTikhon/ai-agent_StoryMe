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
  /**
   * Aborted by GenerationQueueProcessor's periodic heartbeat the moment it
   * discovers a newer claim already owns this run — checked by AgentService
   * at natural checkpoints (see AgentService.assertNotSuperseded) so a
   * fenced-out attempt stops doing further provider/storage work as soon as
   * possible, rather than only failing once its next DB write is rejected.
   * Optional so tests/callers that never construct a real heartbeat loop
   * (e.g. unit tests, retryGeneration's snapshot copy) don't need one.
   */
  readonly signal?: AbortSignal;
}
