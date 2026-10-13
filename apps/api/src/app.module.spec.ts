import { describe, it, expect, vi } from 'vitest';
import type { DynamicModule } from '@nestjs/common';
import { AppModule } from './app.module';
import { EnvModule } from './config/env.module';
import { BooksModule } from './books/books.module';
import { GenerationQueueProcessor } from './agent/generation-queue.processor';

/**
 * EnvModule evaluates ConfigModule.forRoot(...) when it is first imported, which
 * reads a `.env` from the working directory and rejects asynchronously when
 * required variables are absent. This spec only inspects module metadata, so it
 * replaces EnvModule with an inert class instead of inheriting a developer's
 * file or the CI environment. Validation itself is covered by
 * config/env.module.spec.ts and config/env.schema.spec.ts.
 */
vi.mock('./config/env.module', () => ({
  EnvModule: class EnvModule {},
}));

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
  it('imports EnvModule first so ConfigModule is global before the other modules', () => {
    const appModule = AppModule.register({ enableGenerationWorker: false });

    expect(appModule.imports?.[0]).toBe(EnvModule);
  });

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
