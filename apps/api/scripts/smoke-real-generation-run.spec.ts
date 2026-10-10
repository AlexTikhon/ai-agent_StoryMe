import { describe, it, expect, vi } from 'vitest';
import type { AgentLog, Book, GenerationRun } from '@prisma/client';
import type { SmokeBookConfig } from './smoke-real-generation-helpers';
import {
  describeSmokeError,
  publishedImageIdFor,
  runSmoke,
  type SmokePersistedState,
  type SmokePorts,
  type SmokeRunOptions,
} from './smoke-real-generation-run';

/**
 * Everything here runs against mocked ports: no Nest, no database, no OpenAI,
 * no cloud storage. The only "network" is vi.fn().
 */

const USER_ID = 'user-1';
const BOOK_ID = 'book-1';
const RUN_ID = 'run-1';
const SHEET_KEY = `books/${BOOK_ID}/runs/${RUN_ID}/claims/1/character-sheet`;
const PHOTO_SECRET = 'PHOTO-BYTES-MUST-NEVER-BE-LOGGED';

const CONFIG: SmokeBookConfig = {
  childName: 'Smoke',
  childAge: 5,
  language: 'en',
  theme: 'friendship',
  pageCount: 4,
};

function makeRun(overrides: Partial<GenerationRun> = {}): GenerationRun {
  return {
    id: RUN_ID,
    bookId: BOOK_ID,
    status: 'completed',
    kind: 'initial',
    attempt: 1,
    currentStep: 'pdf_render',
    errorCode: null,
    errorMessage: null,
    executionAuthorization: null,
    providerOperations: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    startedAt: new Date('2026-01-01T00:00:01Z'),
    completedAt: new Date('2026-01-01T00:01:00Z'),
    failedAt: null,
    updatedAt: new Date('2026-01-01T00:01:00Z'),
    ...overrides,
  } as unknown as GenerationRun;
}

function makeBook(overrides: Partial<Book> = {}): Book {
  return {
    id: BOOK_ID,
    status: 'complete',
    pageCount: 2,
    failedStep: null,
    errorMessage: null,
    previewPdfUrl: `/api/books/${BOOK_ID}/pdf/preview`,
    publishedRunId: RUN_ID,
    publishedRunFencingVersion: 1,
    storyPlan: { title: 'A story' },
    characterProfile: { name: 'Smoke' },
    characterSheetAssetKey: SHEET_KEY,
    childPhotoAssetKey: `${BOOK_ID}/child-photo-v1`,
    imageGenerationResult: {
      images: [
        { kind: 'cover' },
        { kind: 'page', pageNumber: 1 },
        { kind: 'page', pageNumber: 2 },
        { kind: 'back_cover' },
      ],
      failedImageCount: 0,
      characterReferenceAvailable: true,
      characterReferenceUsedForImages: true,
      imageGenerationMode: 'character-reference-edit',
    },
    aiModelVersions: null,
    bookPreview: null,
    qualityReport: null,
    generationTimeMs: 1234,
    updatedAt: new Date('2026-01-01T00:01:00Z'),
    ...overrides,
  } as unknown as Book;
}

function makeLog(overrides: Partial<AgentLog> = {}): AgentLog {
  return {
    id: 'log-1',
    bookId: BOOK_ID,
    agent: 'character',
    step: 'char_build',
    provider: 'openai',
    model: 'gpt-4o-mini',
    durationMs: 1000,
    tokensInput: null,
    tokensOutput: null,
    costUsd: null,
    attempt: 1,
    traceId: null,
    status: 'success',
    error: null,
    createdAt: new Date('2026-01-01T00:00:10Z'),
    ...overrides,
  } as unknown as AgentLog;
}

interface Harness {
  ports: SmokePorts;
  mocks: { [K in keyof SmokePorts]: ReturnType<typeof vi.fn> };
  lines: string[];
  sleeps: number[];
  options: SmokeRunOptions;
  /** Order in which port methods were invoked. */
  calls: string[];
}

function makeHarness(
  overrides: {
    runs?: Array<GenerationRun | null>;
    persisted?: Partial<SmokePersistedState>;
    photo?: boolean;
    visualReferenceExpected?: boolean;
    timeoutMs?: number;
    mocks?: Partial<Record<keyof SmokePorts, ReturnType<typeof vi.fn>>>;
  } = {},
): Harness {
  const calls: string[] = [];
  const track = <T>(name: string, impl: (...args: never[]) => T) =>
    vi.fn((...args: never[]) => {
      calls.push(name);
      return impl(...args);
    });

  const runs = [...(overrides.runs ?? [makeRun()])];
  let runIndex = 0;
  const persisted: SmokePersistedState = {
    book: makeBook(),
    logs: [makeLog()],
    run: makeRun(),
    ...overrides.persisted,
  };

  const mocks = {
    ensureUser: track('ensureUser', async () => ({ id: USER_ID })),
    ensureCredits: track('ensureCredits', async () => undefined),
    createBook: track('createBook', async () => ({ id: BOOK_ID })),
    uploadChildPhoto: track('uploadChildPhoto', async () => undefined),
    startGeneration: track('startGeneration', async () => undefined),
    getLatestRun: track('getLatestRun', async () => {
      const run = runs[Math.min(runIndex, runs.length - 1)] ?? null;
      runIndex += 1;
      return run;
    }),
    cancelGeneration: track('cancelGeneration', async () => undefined),
    loadPersisted: track('loadPersisted', async () => persisted),
    readPublishedPdf: track('readPublishedPdf', async () => Buffer.from('%PDF-1.7 fake')),
    readPublishedImage: track('readPublishedImage', async () => Buffer.from('png-bytes')),
    readStoredAsset: track('readStoredAsset', async () => Buffer.from('sheet-bytes')),
    dispose: track('dispose', async () => undefined),
    ...overrides.mocks,
  } as Harness['mocks'];

  let now = 0;
  const sleeps: number[] = [];
  const lines: string[] = [];
  const options: SmokeRunOptions = {
    config: CONFIG,
    ...(overrides.photo && {
      photo: { buffer: Buffer.from(PHOTO_SECRET), contentType: 'image/jpeg' as const },
    }),
    visualReferenceExpected: overrides.visualReferenceExpected ?? false,
    timeoutMs: overrides.timeoutMs ?? 10_000,
    pollIntervalMs: 1_000,
    clock: {
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    },
    log: (line) => lines.push(line),
  };

  return { ports: mocks as unknown as SmokePorts, mocks, lines, sleeps, options, calls };
}

describe('runSmoke — admission and execution contract', () => {
  it('admits through startGeneration with real user/book ids, in order, and never touches an execution context', async () => {
    const h = makeHarness();

    const result = await runSmoke(h.ports, h.options);

    expect(result).toEqual({ ok: true });
    expect(h.calls.slice(0, 4)).toEqual([
      'ensureUser',
      'ensureCredits',
      'createBook',
      'startGeneration',
    ]);
    expect(h.mocks.createBook).toHaveBeenCalledWith(USER_ID, CONFIG);
    expect(h.mocks.startGeneration).toHaveBeenCalledWith(USER_ID, BOOK_ID);
    // Execution is the worker's job: the only run interaction is reading it back.
    expect(h.mocks.getLatestRun).toHaveBeenCalledWith(BOOK_ID);
  });

  it('turns an admission failure into a controlled failure without cancelling anything', async () => {
    const h = makeHarness({
      mocks: {
        startGeneration: vi.fn(async () => {
          throw new Error('GENERATION_QUOTA_EXCEEDED');
        }),
      },
    });

    const result = await runSmoke(h.ports, h.options);

    expect(result).toMatchObject({ ok: false, stage: 'admission' });
    expect(h.mocks.cancelGeneration).not.toHaveBeenCalled();
    expect(h.mocks.getLatestRun).not.toHaveBeenCalled();
    expect(h.mocks.dispose).toHaveBeenCalledTimes(1);
  });
});

describe('runSmoke — terminal completion and authoritative reload', () => {
  it('polls through non-terminal states and reloads persisted records only after the run is terminal', async () => {
    const h = makeHarness({
      runs: [makeRun({ status: 'queued' }), makeRun({ status: 'running' }), makeRun()],
    });

    const result = await runSmoke(h.ports, h.options);

    expect(result.ok).toBe(true);
    expect(h.sleeps).toEqual([1_000, 1_000]);
    const firstReload = h.calls.indexOf('loadPersisted');
    const lastPoll = h.calls.lastIndexOf('getLatestRun');
    expect(firstReload).toBeGreaterThan(lastPoll);
    expect(h.mocks.cancelGeneration).not.toHaveBeenCalled();
    expect(h.mocks.dispose).toHaveBeenCalledTimes(1);
  });

  it('builds the diagnostics summary from persisted Book/AgentLog/GenerationRun records', async () => {
    const h = makeHarness();

    await runSmoke(h.ports, h.options);

    const summary = h.lines.join('\n');
    expect(summary).toContain(`Book id:            ${BOOK_ID}`);
    expect(summary).toContain('Status:             complete');
    expect(summary).toContain('Char. profile prov.: openai');
    expect(summary).toContain('Expected images:    4');
    expect(summary).toContain('PDF exists:         yes');
    expect(summary).toContain('PDF size > 0:       yes');
    expect(summary).toContain(SHEET_KEY);
  });

  it('reports success only when run, book status and publication pointer all agree', async () => {
    const mismatchedPointer = makeHarness({
      persisted: { book: makeBook({ publishedRunId: 'some-other-run' }) },
    });
    const result = await runSmoke(mismatchedPointer.ports, mismatchedPointer.options);
    expect(result).toMatchObject({ ok: false, stage: 'verification' });
  });
});

describe('runSmoke — no false success from intermediate or non-complete state', () => {
  it('fails when the run completed but the persisted Book is not complete (intermediate outcome is not a Book)', async () => {
    const h = makeHarness({
      persisted: { book: makeBook({ status: 'pdf_render', previewPdfUrl: null }) },
    });

    const result = await runSmoke(h.ports, h.options);

    expect(result).toMatchObject({ ok: false, stage: 'generation' });
    expect(h.mocks.readPublishedPdf).not.toHaveBeenCalled();
    expect(h.mocks.readPublishedImage).not.toHaveBeenCalled();
    expect(h.lines.join('\n')).not.toContain('passed');
  });

  it('fails on a failed run, prints its safe diagnostics, and verifies no artifacts', async () => {
    const failedRun = makeRun({ status: 'failed', errorMessage: 'image generation failed' });
    const h = makeHarness({
      runs: [failedRun],
      persisted: {
        run: failedRun,
        book: makeBook({
          status: 'failed',
          failedStep: 'image_gen',
          errorMessage: 'image generation failed',
          previewPdfUrl: null,
          publishedRunId: null,
        }),
      },
    });

    const result = await runSmoke(h.ports, h.options);

    expect(result).toMatchObject({ ok: false, stage: 'generation' });
    expect(h.lines.join('\n')).toContain('Failed step:        image_gen');
    expect(h.mocks.readPublishedPdf).not.toHaveBeenCalled();
    expect(h.mocks.readPublishedImage).not.toHaveBeenCalled();
    expect(h.mocks.cancelGeneration).not.toHaveBeenCalled();
    expect(h.mocks.dispose).toHaveBeenCalledTimes(1);
  });

  it('fails on a cancelled run', async () => {
    const cancelled = makeRun({ status: 'cancelled' });
    const h = makeHarness({
      runs: [cancelled],
      persisted: {
        run: cancelled,
        book: makeBook({ status: 'cancelled' as Book['status'], previewPdfUrl: null }),
      },
    });

    const result = await runSmoke(h.ports, h.options);

    expect(result).toMatchObject({ ok: false, stage: 'generation' });
    expect(h.mocks.readPublishedImage).not.toHaveBeenCalled();
  });
});

describe('runSmoke — bounded waiting', () => {
  it('times out with a controlled failure, cancels the still-active run, and always disposes', async () => {
    const h = makeHarness({ runs: [makeRun({ status: 'running' })], timeoutMs: 5_000 });

    const result = await runSmoke(h.ports, h.options);

    expect(result).toMatchObject({ ok: false, stage: 'generation' });
    expect(result.ok === false && result.reason).toMatch(/timed out after 5000ms/);
    expect(h.sleeps.length).toBeLessThanOrEqual(5);
    expect(h.mocks.loadPersisted).not.toHaveBeenCalled();
    expect(h.mocks.cancelGeneration).toHaveBeenCalledWith(USER_ID, BOOK_ID);
    expect(h.mocks.dispose).toHaveBeenCalledTimes(1);
  });

  it('still reports the timeout (and disposes) when the best-effort cancel itself fails', async () => {
    const h = makeHarness({
      runs: [null],
      timeoutMs: 2_000,
      mocks: {
        cancelGeneration: vi.fn(async () => {
          throw new Error('cancel unavailable');
        }),
      },
    });

    const result = await runSmoke(h.ports, h.options);

    expect(result).toMatchObject({ ok: false, stage: 'generation' });
    expect(result.ok === false && result.reason).toMatch(/no run recorded/);
    expect(h.mocks.dispose).toHaveBeenCalledTimes(1);
  });

  it('cancels and disposes when an unexpected error happens while waiting, with a scrubbed message', async () => {
    const h = makeHarness({
      mocks: {
        getLatestRun: vi.fn(async () => {
          throw new Error('redis down; key sk-live-SECRET123');
        }),
      },
    });

    const result = await runSmoke(h.ports, h.options);

    expect(result).toMatchObject({ ok: false, stage: 'generation' });
    expect(result.ok === false && result.reason).not.toContain('SECRET123');
    expect(h.mocks.cancelGeneration).toHaveBeenCalledTimes(1);
    expect(h.mocks.dispose).toHaveBeenCalledTimes(1);
  });
});

describe('runSmoke — published artifact verification', () => {
  it('reads every generated image and the PDF through the published read APIs using current image ids', async () => {
    const h = makeHarness();

    await runSmoke(h.ports, h.options);

    const ids = h.mocks.readPublishedImage.mock.calls.map((call) => call[2]);
    expect(ids).toEqual(['cover', 'page-1', 'page-2', 'back-cover']);
    for (const call of h.mocks.readPublishedImage.mock.calls) {
      expect(call[0]).toBe(USER_ID);
      expect(call[1]).toBe(BOOK_ID);
    }
    expect(h.mocks.readPublishedPdf).toHaveBeenCalledWith(USER_ID, BOOK_ID);
  });

  it('fails when a published image is empty or unreadable, without leaking the underlying error secret', async () => {
    const empty = makeHarness({
      mocks: { readPublishedImage: vi.fn(async () => Buffer.alloc(0)) },
    });
    expect(await runSmoke(empty.ports, empty.options)).toMatchObject({
      ok: false,
      stage: 'verification',
    });

    const unreadable = makeHarness({
      mocks: {
        readPublishedImage: vi.fn(async () => {
          throw new Error('NotFound sk-abc123456');
        }),
      },
    });
    const result = await runSmoke(unreadable.ports, unreadable.options);
    expect(result).toMatchObject({ ok: false, stage: 'verification' });
    expect(result.ok === false && result.reason).not.toContain('abc123456');
    expect(unreadable.mocks.dispose).toHaveBeenCalledTimes(1);
  });

  it('fails when the published PDF is missing or empty', async () => {
    const missing = makeHarness({
      mocks: {
        readPublishedPdf: vi.fn(async () => {
          throw new Error('PDF not ready');
        }),
      },
    });
    expect(await runSmoke(missing.ports, missing.options)).toMatchObject({
      ok: false,
      stage: 'verification',
    });

    const empty = makeHarness({
      mocks: { readPublishedPdf: vi.fn(async () => Buffer.alloc(0)) },
    });
    expect(await runSmoke(empty.ports, empty.options)).toMatchObject({
      ok: false,
      stage: 'verification',
    });
  });
});

describe('runSmoke — optional child photo', () => {
  it('uploads the photo through the supported upload port before admission, and never logs its bytes', async () => {
    const h = makeHarness({ photo: true });

    const result = await runSmoke(h.ports, h.options);

    expect(result.ok).toBe(true);
    expect(h.calls.indexOf('uploadChildPhoto')).toBeLessThan(h.calls.indexOf('startGeneration'));
    expect(h.mocks.uploadChildPhoto).toHaveBeenCalledWith(USER_ID, BOOK_ID, {
      buffer: Buffer.from(PHOTO_SECRET),
      contentType: 'image/jpeg',
    });
    expect(h.lines.join('\n')).not.toContain(PHOTO_SECRET);
    expect(h.lines.join('\n').toLowerCase()).not.toContain('base64');
  });

  it('skips the upload when no photo is configured', async () => {
    const h = makeHarness();
    await runSmoke(h.ports, h.options);
    expect(h.mocks.uploadChildPhoto).not.toHaveBeenCalled();
  });

  it('fails verification when a photo was uploaded but the persisted Book records none', async () => {
    const h = makeHarness({
      photo: true,
      persisted: { book: makeBook({ childPhotoAssetKey: null }) },
    });
    expect(await runSmoke(h.ports, h.options)).toMatchObject({ ok: false, stage: 'verification' });
  });

  it('verifies the persisted character-sheet key and reference usage when visual reference is expected', async () => {
    const h = makeHarness({ photo: true, visualReferenceExpected: true });

    const result = await runSmoke(h.ports, h.options);

    expect(result.ok).toBe(true);
    expect(h.mocks.readStoredAsset).toHaveBeenCalledWith(SHEET_KEY);
  });

  it('fails when visual reference is expected but the images did not use it', async () => {
    const book = makeBook();
    const h = makeHarness({
      photo: true,
      visualReferenceExpected: true,
      persisted: {
        book: makeBook({
          imageGenerationResult: {
            ...(book.imageGenerationResult as Record<string, unknown>),
            characterReferenceUsedForImages: false,
          },
        }),
      },
    });
    expect(await runSmoke(h.ports, h.options)).toMatchObject({ ok: false, stage: 'verification' });
  });

  it('does not require a character sheet when the providers are not all real', async () => {
    const h = makeHarness({
      photo: true,
      visualReferenceExpected: false,
      persisted: { book: makeBook({ characterSheetAssetKey: null }) },
    });
    const result = await runSmoke(h.ports, h.options);
    expect(result.ok).toBe(true);
    expect(h.mocks.readStoredAsset).not.toHaveBeenCalled();
  });
});

describe('runSmoke — offline guarantees', () => {
  it('disposes exactly once on success and on every failure path', async () => {
    const harnesses = [
      makeHarness(),
      makeHarness({ runs: [makeRun({ status: 'failed' })] }),
      makeHarness({ runs: [makeRun({ status: 'running' })], timeoutMs: 1_000 }),
      makeHarness({
        mocks: {
          createBook: vi.fn(async () => {
            throw new Error('db down');
          }),
        },
      }),
    ];
    for (const h of harnesses) {
      await runSmoke(h.ports, h.options);
      expect(h.mocks.dispose).toHaveBeenCalledTimes(1);
    }
  });

  it('survives a failing dispose', async () => {
    const h = makeHarness({
      mocks: {
        dispose: vi.fn(async () => {
          throw new Error('close failed');
        }),
      },
    });
    expect(await runSmoke(h.ports, h.options)).toEqual({ ok: true });
  });
});

describe('helpers', () => {
  it('maps generated image entries to published image ids', () => {
    expect(publishedImageIdFor({ kind: 'cover' })).toBe('cover');
    expect(publishedImageIdFor({ kind: 'back_cover' })).toBe('back-cover');
    expect(publishedImageIdFor({ kind: 'page', pageNumber: 3 })).toBe('page-3');
    expect(() => publishedImageIdFor({ kind: 'page' })).toThrow(/pageNumber/);
  });

  it('describeSmokeError scrubs API keys and bearer tokens and bounds length', () => {
    expect(describeSmokeError(new Error('bad sk-proj-ABC_123 and Bearer abc.def'))).toBe(
      'Error: bad sk-*** and Bearer ***',
    );
    expect(describeSmokeError('x'.repeat(1000))).toBe('non-Error value thrown');
    expect(describeSmokeError(new Error('y'.repeat(1000))).length).toBeLessThanOrEqual(301);
  });
});

describe('smoke-real-generation entry point', () => {
  it('does not boot Nest or touch any service when imported', async () => {
    const createApplicationContext = vi.fn().mockRejectedValue(new Error('must not boot'));
    // Satisfy every precondition so an unguarded main() would reach Nest bootstrap.
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    vi.stubEnv('STORY_GENERATION_PROVIDER', 'openai');
    vi.stubEnv('IMAGE_GENERATION_PROVIDER', 'openai');
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    // Stub every heavy dependency so the import is cheap and provably side-effect free.
    const stubs: Record<string, () => Record<string, unknown>> = {
      '@nestjs/core': () => ({ NestFactory: { createApplicationContext } }),
      '../src/app.module': () => ({ AppModule: { register: vi.fn() } }),
      '../src/database/prisma.service': () => ({ PrismaService: class {} }),
      '../src/users/users.service': () => ({ UsersService: class {} }),
      '../src/books/books.service': () => ({ BooksService: class {} }),
      '../src/credits/credits.service': () => ({
        CreditsService: class {},
        GENERATION_CREDIT_COST: 1,
      }),
      '../src/agent/generation-run.service': () => ({ GenerationRunService: class {} }),
      '../src/pdf/pdf-storage': () => ({ assertPdfStorageSupportsWorker: vi.fn() }),
      '../src/images/image-asset-storage': () => ({
        IMAGE_ASSET_STORAGE_TOKEN: 'IMAGE_ASSET_STORAGE',
        assertImageStorageSupportsWorker: vi.fn(),
      }),
      '../src/books/generation-diagnostics': () => ({ buildGenerationDiagnostics: vi.fn() }),
    };
    vi.resetModules();
    for (const [path, factory] of Object.entries(stubs)) vi.doMock(path, factory);

    try {
      await import('./smoke-real-generation');
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(createApplicationContext).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
      vi.unstubAllEnvs();
      for (const path of Object.keys(stubs)) vi.doUnmock(path);
    }
  }, 30_000);
});
