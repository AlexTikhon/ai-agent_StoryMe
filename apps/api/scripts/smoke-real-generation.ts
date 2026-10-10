/**
 * Phase 3D — Manual real end-to-end generation smoke test
 *
 * Exercises the FULL real pipeline: OpenAIStoryGenerationProvider +
 * OpenAIImageGenerationProvider against the real OpenAI API. This makes real
 * network calls and costs real money (one story completion call plus one
 * image-generation call per page/cover/back-cover). Never run in CI or
 * automated tests — see docs/local-generation-pipeline.md for the full
 * runbook.
 *
 * Usage:
 *   pnpm --filter @book/api smoke:real-generation
 *
 * Required env vars:
 *   OPENAI_API_KEY
 *   STORY_GENERATION_PROVIDER=openai
 *   IMAGE_GENERATION_PROVIDER=openai
 *
 * Optional env vars (all have safe defaults — see resolveSmokeBookConfig):
 *   SMOKE_CHILD_NAME, SMOKE_CHILD_AGE, SMOKE_LANGUAGE, SMOKE_THEME,
 *   SMOKE_PAGE_COUNT (defaults to MIN_BOOK_PAGE_COUNT = 4, the cheapest page
 *   count that can still reach a real "complete" book), SMOKE_CHILD_PHOTO_PATH
 *   (local jpg/png/webp file path — uploaded through BooksService.uploadChildPhoto,
 *   exactly like the wizard's child-photo upload, before generation is admitted,
 *   so the real CharacterProfileProvider analyzes it; also set
 *   CHARACTER_PROFILE_PROVIDER=openai to exercise the real vision-based
 *   character-sheet path), SMOKE_TIMEOUT_MS (bound on waiting for the worker;
 *   default 20 minutes — on timeout the run is cancelled and the script fails).
 *   MAX_GENERATED_IMAGES_PER_BOOK (cost cap) is enforced by generation
 *   admission itself.
 *
 * Boots the real Nest application context *with the generation worker
 * enabled in-process* (the same module graph worker.ts uses), so it needs a
 * running local Postgres + Redis matching apps/api/.env. It admits a run
 * through BooksService.startGeneration, lets the worker execute it under the
 * normal claim/fencing/completion rules, waits (bounded) for the persisted run
 * to reach a terminal state, then reloads and verifies the persisted records
 * and published artifacts. The orchestration lives in
 * smoke-real-generation-run.ts so it is unit-testable without this entry point.
 */
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { UsersService } from '../src/users/users.service';
import { BooksService } from '../src/books/books.service';
import { CreditsService, GENERATION_CREDIT_COST } from '../src/credits/credits.service';
import { GenerationRunService } from '../src/agent/generation-run.service';
import { assertPdfStorageSupportsWorker } from '../src/pdf/pdf-storage';
import {
  IMAGE_ASSET_STORAGE_TOKEN,
  assertImageStorageSupportsWorker,
  type ImageAssetStorage,
} from '../src/images/image-asset-storage';
import {
  SMOKE_POLL_INTERVAL_MS,
  checkPreconditions,
  loadSmokePhoto,
  parseSmokeLanguage,
  resolveSmokeBookConfig,
  resolveSmokeTimeoutMs,
} from './smoke-real-generation-helpers';
import { runSmoke, type SmokePhoto, type SmokePorts } from './smoke-real-generation-run';

const SMOKE_USER_EMAIL = 'smoke-real-generation@storyme.local';

function toMulterFile(photo: SmokePhoto): Express.Multer.File {
  return {
    fieldname: 'photo',
    originalname: 'smoke-child-photo',
    encoding: '7bit',
    mimetype: photo.contentType,
    size: photo.buffer.length,
    buffer: photo.buffer,
    stream: Readable.from(photo.buffer),
    destination: '',
    filename: '',
    path: '',
  };
}

async function main(): Promise<void> {
  const precondition = checkPreconditions(process.env);
  if (precondition) {
    console.log(precondition);
    process.exitCode = 1;
    return;
  }

  const config = resolveSmokeBookConfig(process.env);
  const language = parseSmokeLanguage(config.language);
  // Fail fast on a bad photo path before booting Nest or creating any row.
  const photo = config.childPhotoPath
    ? loadSmokePhoto(config.childPhotoPath, (path) => readFileSync(path))
    : undefined;

  const characterProfileIsOpenAI =
    process.env['CHARACTER_PROFILE_PROVIDER']?.trim().toLowerCase() === 'openai';
  if (photo && !characterProfileIsOpenAI) {
    console.log(
      'Warning: SMOKE_CHILD_PHOTO_PATH is set but CHARACTER_PROFILE_PROVIDER is not "openai" — ' +
        'the real vision-based character profile/sheet path will not run, so visual-reference ' +
        'consistency cannot be validated this run. Set CHARACTER_PROFILE_PROVIDER=openai too if ' +
        'that is what you want to test.',
    );
  }
  const visualReferenceExpected =
    characterProfileIsOpenAI &&
    process.env['STORY_GENERATION_PROVIDER']?.trim().toLowerCase() === 'openai' &&
    process.env['IMAGE_GENERATION_PROVIDER']?.trim().toLowerCase() === 'openai';

  // Same fail-fast worker-topology guards worker.ts applies.
  assertPdfStorageSupportsWorker(process.env);
  assertImageStorageSupportsWorker(process.env);

  console.log(
    'Booting Nest application context with the generation worker (requires a running Postgres + Redis)...',
  );
  const app = await NestFactory.createApplicationContext(
    AppModule.register({ enableGenerationWorker: true }),
    { logger: ['error', 'warn', 'log'] },
  );

  const prisma = app.get(PrismaService, { strict: false });
  const usersService = app.get(UsersService, { strict: false });
  const booksService = app.get(BooksService, { strict: false });
  const creditsService = app.get(CreditsService, { strict: false });
  const generationRunService = app.get(GenerationRunService, { strict: false });
  const imageAssetStorage = app.get<ImageAssetStorage>(IMAGE_ASSET_STORAGE_TOKEN, {
    strict: false,
  });

  const ports: SmokePorts = {
    ensureUser: () => usersService.findOrCreateByEmail(SMOKE_USER_EMAIL, 'Smoke Test'),
    ensureCredits: async (userId) => {
      const { credits } = await creditsService.getBalance(userId);
      if (credits < GENERATION_CREDIT_COST) {
        await creditsService.add({
          userId,
          amount: GENERATION_CREDIT_COST,
          reason: 'promotional_grant',
        });
      }
    },
    createBook: (userId, bookConfig) =>
      booksService.create(userId, {
        title: 'Real Generation Smoke Test',
        childName: bookConfig.childName,
        childAge: bookConfig.childAge,
        language,
        theme: bookConfig.theme,
        pageCount: bookConfig.pageCount,
      }),
    uploadChildPhoto: async (userId, bookId, uploaded) => {
      await booksService.uploadChildPhoto(userId, bookId, toMulterFile(uploaded));
    },
    startGeneration: async (userId, bookId) => {
      await booksService.startGeneration(userId, bookId);
    },
    getLatestRun: (bookId) => generationRunService.findLatestForBook(bookId),
    cancelGeneration: async (userId, bookId) => {
      await booksService.cancelGeneration(userId, bookId);
    },
    loadPersisted: async (_userId, bookId) => ({
      book: await prisma.book.findUniqueOrThrow({ where: { id: bookId } }),
      logs: await prisma.agentLog.findMany({
        where: { bookId },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      run: await generationRunService.findLatestForBook(bookId),
    }),
    readPublishedPdf: async (userId, bookId) =>
      (await booksService.getPreviewPdfBuffer(bookId, userId)).buffer,
    readPublishedImage: async (userId, bookId, imageId) =>
      (await booksService.getPublishedImage(bookId, userId, imageId)).buffer,
    readStoredAsset: (key) => imageAssetStorage.getImageAsset(key),
    dispose: () => app.close(),
  };

  const result = await runSmoke(ports, {
    config,
    ...(photo && { photo }),
    visualReferenceExpected,
    timeoutMs: resolveSmokeTimeoutMs(process.env),
    pollIntervalMs: SMOKE_POLL_INTERVAL_MS,
    clock: {
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
    log: (line) => console.log(line),
  });

  if (!result.ok) {
    console.log(
      `\n✘ Real generation smoke test FAILED at stage "${result.stage}": ${result.reason}`,
    );
    process.exitCode = 1;
  }
}

// Only run as a CLI — importing this module (e.g. from a test) must never boot Nest.
if (require.main === module) {
  main().catch((err: unknown) => {
    console.error('\n✘ Real generation smoke test FAILED before the run started:', err);
    process.exit(1);
  });
}
