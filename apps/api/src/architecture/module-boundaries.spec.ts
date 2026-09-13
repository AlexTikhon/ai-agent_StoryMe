import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(resolve(process.cwd(), 'src', path), 'utf8');

describe('module import boundaries', () => {
  it('keeps HTTP book composition provider-neutral', () => {
    const booksModule = source('books/books.module.ts');
    expect(booksModule).not.toMatch(/openai/i);
    expect(booksModule).not.toContain('createImageGenerationProvider');
    expect(booksModule).not.toContain('createStoryGenerationProvider');
    expect(booksModule).not.toContain('createPdfStorage');
    expect(booksModule).not.toContain('createImageAssetStorage');
  });

  it('prevents provider execution from importing book feature internals', () => {
    expect(source('provider-execution/provider-execution.module.ts')).not.toMatch(
      /from ['"]\.\.\/books\//,
    );
  });

  it('keeps the worker entrypoint on its explicit non-HTTP composition root', () => {
    const worker = source('worker.ts');
    expect(worker).toContain('WorkerModule.register()');
    expect(worker).not.toContain('AppModule.register(');
  });
});
