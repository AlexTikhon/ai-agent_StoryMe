import { vi } from 'vitest';
import type { BookArtifactWriteCoordinator } from '../../storage/book-artifact-write-coordinator';

/**
 * Unit-test double for BookArtifactWriteCoordinator: admits every writer and
 * records the calls. Cross-boundary behavior (locking, fencing, cleanup records)
 * is covered against real PostgreSQL in
 * test/integration/book-artifact-write-coordination.integration.spec.ts.
 */
export function createFakeArtifactWrites() {
  return {
    admit: vi.fn().mockResolvedValue({ id: 'intent-1', bookId: 'b-1' }),
    releaseInTransaction: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
    discard: vi.fn().mockResolvedValue(undefined),
    recoverStale: vi.fn().mockResolvedValue({ cleaned: 0, failed: 0 }),
    countBlockingWriters: vi.fn().mockResolvedValue(0),
    settleForDeletion: vi.fn().mockResolvedValue(0),
  } satisfies Record<string, ReturnType<typeof vi.fn>> as unknown as {
    [K in keyof BookArtifactWriteCoordinator]: ReturnType<typeof vi.fn>;
  };
}
