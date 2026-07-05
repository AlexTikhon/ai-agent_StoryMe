import { describe, it, expect } from 'vitest';
import type { DynamicModule } from '@nestjs/common';
import { AppModule } from './app.module';
import { BooksModule } from './books/books.module';
import { GenerationQueueProcessor } from './agent/generation-queue.processor';

/**
 * As in books.module.spec.ts, this checks the DynamicModule metadata
 * AppModule.register produces rather than booting a real Nest app (which
 * would need live Postgres/Redis). It proves the enableGenerationWorker flag
 * actually reaches BooksModule through AppModule's composition — i.e. that
 * main.ts (API) and worker.ts get genuinely different module graphs.
 */
function findBooksModule(appModule: DynamicModule): DynamicModule {
  const imports = appModule.imports ?? [];
  const match = imports.find(
    (imported): imported is DynamicModule =>
      typeof imported === 'object' &&
      imported !== null &&
      'module' in imported &&
      (imported as DynamicModule).module === BooksModule,
  );
  if (!match) {
    throw new Error('BooksModule not found among AppModule.register(...) imports');
  }
  return match;
}

describe('AppModule.register', () => {
  it('API mode (enableGenerationWorker: false) does not wire up the generation queue processor', () => {
    const appModule = AppModule.register({ enableGenerationWorker: false });
    const booksModule = findBooksModule(appModule);

    expect(booksModule.providers).not.toContain(GenerationQueueProcessor);
  });

  it('worker mode (enableGenerationWorker: true) wires up the generation queue processor', () => {
    const appModule = AppModule.register({ enableGenerationWorker: true });
    const booksModule = findBooksModule(appModule);

    expect(booksModule.providers).toContain(GenerationQueueProcessor);
  });
});
