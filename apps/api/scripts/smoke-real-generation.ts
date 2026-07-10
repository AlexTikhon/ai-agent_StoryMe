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
 *   SMOKE_PAGE_COUNT, SMOKE_CHILD_PHOTO_PATH (local jpg/png/webp file path —
 *   uploaded exactly like the wizard's child-photo upload before generation
 *   starts, so the real CharacterProfileProvider analyzes it).
 *   MAX_GENERATED_IMAGES_PER_BOOK (cost cap — see agent.service.ts) is
 *   respected automatically; set it to at least the book's total image count
 *   for a full real-image run, or leave the default for a cheap smoke test.
 *
 * Also boots the real Nest application context, so it needs a running local
 * Postgres + Redis matching apps/api/.env — the same stack
 * `pnpm --filter @book/api dev` uses.
 */
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { BookLanguage, BookStatus } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { UsersService } from '../src/users/users.service';
import { AgentService } from '../src/agent/agent.service';
import { PDF_STORAGE_TOKEN, type PdfStorage } from '../src/pdf/pdf-storage';
import {
  IMAGE_ASSET_STORAGE_TOKEN,
  childPhotoAssetKey,
  imageAssetKey,
  type ImageAssetContentType,
  type ImageAssetStorage,
} from '../src/images/image-asset-storage';
import { isAllowedChildPhotoMimeType } from '../src/books/child-photo.constants';
import {
  checkPreconditions,
  formatDiagnosticsSummary,
  resolveSmokeBookConfig,
} from './smoke-real-generation-helpers';
import { buildGenerationDiagnostics } from '../src/books/generation-diagnostics';

const SMOKE_USER_EMAIL = 'smoke-real-generation@storyme.local';

const CONTENT_TYPE_BY_EXTENSION: Record<string, ImageAssetContentType> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function main(): Promise<void> {
  const precondition = checkPreconditions(process.env);
  if (precondition) {
    console.log(precondition);
    process.exitCode = 1;
    return;
  }

  console.log('Booting Nest application context (requires a running Postgres + Redis)...');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const prisma = app.get(PrismaService);
    const usersService = app.get(UsersService);
    const agentService = app.get(AgentService);
    const pdfStorage = app.get<PdfStorage>(PDF_STORAGE_TOKEN);
    const imageAssetStorage = app.get<ImageAssetStorage>(IMAGE_ASSET_STORAGE_TOKEN);

    const config = resolveSmokeBookConfig(process.env);

    console.log(`[1/5] Ensuring smoke-test user (${SMOKE_USER_EMAIL})...`);
    const user = await usersService.findOrCreateByEmail(SMOKE_USER_EMAIL, 'Smoke Test');

    console.log(
      `[2/5] Creating a test book (childAge=${config.childAge}, language=${config.language}, theme="${config.theme}"${config.pageCount ? `, pageCount=${config.pageCount}` : ''})...`,
    );
    let book = await prisma.book.create({
      data: {
        userId: user.id,
        title: 'Real Generation Smoke Test',
        childName: config.childName,
        childAge: config.childAge,
        language: config.language as BookLanguage,
        theme: config.theme,
        ...(config.pageCount !== undefined && { pageCount: config.pageCount }),
      },
    });
    console.log(`      Book id: ${book.id}`);

    if (config.childPhotoPath) {
      console.log(`[3/5] Uploading child reference photo from ${config.childPhotoPath}...`);
      const ext = extname(config.childPhotoPath).toLowerCase();
      const contentType = CONTENT_TYPE_BY_EXTENSION[ext];
      if (!contentType || !isAllowedChildPhotoMimeType(contentType)) {
        throw new Error(
          `SMOKE_CHILD_PHOTO_PATH must point to a .jpg/.jpeg/.png/.webp file, got "${config.childPhotoPath}"`,
        );
      }
      const photoBuffer = readFileSync(config.childPhotoPath);
      const key = childPhotoAssetKey(book.id);
      await imageAssetStorage.saveImageAsset(key, photoBuffer, contentType);
      book = await prisma.book.update({
        where: { id: book.id },
        data: { childPhotoAssetKey: key, childPhotoContentType: contentType },
      });
      console.log(`      Photo saved (${photoBuffer.length} bytes) — never logged as raw bytes/base64.`);
    } else {
      console.log('[3/5] No SMOKE_CHILD_PHOTO_PATH set — generating without a reference photo.');
    }

    console.log(
      '[4/5] Running the real generation pipeline (calls the real OpenAI story + image APIs — costs money)...',
    );
    const result = await agentService.startBookGeneration(book);

    console.log(`[5/5] Verifying results (final status: ${result.status})...`);
    if (result.status !== BookStatus.complete) {
      throw new Error(
        `Expected book to reach status "complete", got "${result.status}" ` +
          `(failedStep=${result.failedStep ?? 'n/a'}, errorMessage=${result.errorMessage ?? 'n/a'})`,
      );
    }

    assert(result.storyPlan !== null, 'expected storyPlan to be persisted');
    assert(result.imageGenerationResult !== null, 'expected imageGenerationResult to be persisted');

    const images =
      (
        result.imageGenerationResult as {
          images?: Array<{ kind: string; pageNumber?: number }>;
        } | null
      )?.images ?? [];
    assert(images.length > 0, 'expected at least one generated image entry');

    for (const image of images) {
      const key = imageAssetKey(
        book.id,
        image.kind as 'cover' | 'page' | 'back_cover',
        image.pageNumber,
      );
      const buffer = await imageAssetStorage.getImageAsset(key);
      assert(!!buffer && buffer.length > 0, `expected saved image bytes for key "${key}"`);
    }
    console.log(`      ${images.length} generated image asset(s) saved and verified.`);

    assert(!!result.previewPdfUrl, 'expected previewPdfUrl to be set');
    assert(
      await pdfStorage.previewPdfExists(book.id),
      'expected the rendered PDF to exist in storage',
    );

    const agentLogs = await prisma.agentLog.findMany({
      where: { bookId: book.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    const diagnostics = buildGenerationDiagnostics(result, agentLogs);

    console.log('\n✔ Real generation smoke test passed — all checks succeeded.');
    console.log(formatDiagnosticsSummary(diagnostics));
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error('\n✘ Real generation smoke test FAILED:', err);
  process.exit(1);
});
