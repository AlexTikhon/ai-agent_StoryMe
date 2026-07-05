import { describe, it, expect } from 'vitest';
import { BooksModule } from './books.module';
import { GenerationQueueProcessor } from '../agent/generation-queue.processor';

/**
 * These assert on the DynamicModule metadata BooksModule.register produces,
 * not a booted Nest application — booting for real would require live
 * Postgres/Redis (DatabaseModule/QueueModule connect eagerly), which normal
 * tests must not depend on. Metadata inspection is enough to prove
 * GenerationQueueProcessor (a real BullMQ Worker the moment it's
 * instantiated) is only ever wired in when explicitly enabled.
 */
describe('BooksModule.register', () => {
  it('omits GenerationQueueProcessor when enableGenerationWorker is false (API mode)', () => {
    const dynamicModule = BooksModule.register({ enableGenerationWorker: false });

    expect(dynamicModule.providers).not.toContain(GenerationQueueProcessor);
  });

  it('includes GenerationQueueProcessor when enableGenerationWorker is true (worker mode)', () => {
    const dynamicModule = BooksModule.register({ enableGenerationWorker: true });

    expect(dynamicModule.providers).toContain(GenerationQueueProcessor);
  });
});
