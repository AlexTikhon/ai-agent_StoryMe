import { describe, it, expect, vi } from 'vitest';
import type { DynamicModule, ForwardReference, Type } from '@nestjs/common';
import { MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
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

  it.each([false, true])(
    'registers no retired interactive controller and keeps the book controllers (worker: %s)',
    (enableGenerationWorker) => {
      const paths = collectControllerPaths(AppModule.register({ enableGenerationWorker }));

      expect(paths.some((path) => /(^|\/)interactive(\/|$)/.test(path))).toBe(false);
      expect(paths).toContain('books');
      expect(paths).toContain('child-profiles');
    },
  );
});

type ModuleRef = Type<unknown> | DynamicModule | ForwardReference | Promise<DynamicModule>;

/** Every controller route prefix reachable from a module, following static and dynamic imports. */
function collectControllerPaths(root: DynamicModule): string[] {
  const seen = new Set<unknown>();
  const paths: string[] = [];

  const visit = (ref: ModuleRef | undefined): void => {
    if (!ref || ref instanceof Promise) return;
    const resolved =
      typeof ref === 'object' && 'forwardRef' in ref ? (ref.forwardRef() as ModuleRef) : ref;
    if (seen.has(resolved)) return;
    seen.add(resolved);

    const isDynamic = typeof resolved === 'object' && 'module' in resolved;
    const moduleClass = isDynamic ? (resolved as DynamicModule).module : resolved;
    const controllers: Type<unknown>[] = [
      ...((Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, moduleClass) as Type<unknown>[]) ?? []),
      ...(isDynamic ? ((resolved as DynamicModule).controllers ?? []) : []),
    ];
    for (const controller of controllers) {
      const path = Reflect.getMetadata(PATH_METADATA, controller) as string | string[] | undefined;
      for (const value of [path ?? ''].flat()) paths.push(value.replace(/^\/+/, ''));
    }

    const imports: ModuleRef[] = [
      ...((Reflect.getMetadata(MODULE_METADATA.IMPORTS, moduleClass) as ModuleRef[]) ?? []),
      ...(isDynamic
        ? (((resolved as DynamicModule).imports as ModuleRef[] | undefined) ?? [])
        : []),
    ];
    imports.forEach(visit);
  };

  visit(root);
  return paths;
}
