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
 *   (local jpg/png/webp file path — uploaded exactly like the wizard's
 *   child-photo upload before generation starts, so the real
 *   CharacterProfileProvider analyzes it; also set CHARACTER_PROFILE_PROVIDER=
 *   openai to exercise the real vision-based character-sheet path).
 *   MAX_GENERATED_IMAGES_PER_BOOK (cost cap — see agent.service.ts) is
 *   respected automatically; the default (see apps/api/.env) already covers a
 *   4-page book's 6 planned illustrations (cover + 4 pages + back cover) —
 *   raise it only for a longer book.
 *
 * Also boots the real Nest application context, so it needs a running local
 * Postgres + Redis matching apps/api/.env — the same stack
 * `pnpm --filter @book/api dev` uses.
 */
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { type BookLanguage, BookStatus } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { UsersService } from '../src/users/users.service';
import { AgentService } from '../src/agent/agent.service';
import { PDF_STORAGE_TOKEN, type PdfStorage } from '../src/pdf/pdf-storage';
import {
  IMAGE_ASSET_STORAGE_TOKEN,
  characterSheetAssetKey,
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
  type SmokeValidationExtras,
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

/** Tracks which phase is running so any thrown error can be reported with a clear failure stage (never just a bare stack trace). */
let stage = 'preconditions';

async function main(): Promise<void> {
  const precondition = checkPreconditions(process.env);
  if (precondition) {
    console.log(precondition);
    process.exitCode = 1;
    return;
  }

  const wantsCharacterProfile =
    !!process.env['SMOKE_CHILD_PHOTO_PATH']?.trim() &&
    process.env['CHARACTER_PROFILE_PROVIDER']?.trim().toLowerCase() !== 'openai';
  if (wantsCharacterProfile) {
    console.log(
      'Warning: SMOKE_CHILD_PHOTO_PATH is set but CHARACTER_PROFILE_PROVIDER is not "openai" — ' +
        'the real vision-based character profile/sheet path will not run, so visual-reference ' +
        'consistency cannot be validated this run. Set CHARACTER_PROFILE_PROVIDER=openai too if ' +
        'that is what you want to test.',
    );
  }

  stage = 'nest-bootstrap';
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

    stage = 'setup';
    const config = resolveSmokeBookConfig(process.env);

    console.log(`[1/5] Ensuring smoke-test user (${SMOKE_USER_EMAIL})...`);
    const user = await usersService.findOrCreateByEmail(SMOKE_USER_EMAIL, 'Smoke Test');

    console.log(
      `[2/5] Creating a test book (childAge=${config.childAge}, language=${config.language}, theme="${config.theme}", pageCount=${config.pageCount})...`,
    );
    let book = await prisma.book.create({
      data: {
        userId: user.id,
        title: 'Real Generation Smoke Test',
        childName: config.childName,
        childAge: config.childAge,
        language: config.language as BookLanguage,
        theme: config.theme,
        pageCount: config.pageCount,
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
      console.log(
        `      Photo saved (${photoBuffer.length} bytes) — never logged as raw bytes/base64.`,
      );
    } else {
      console.log('[3/5] No SMOKE_CHILD_PHOTO_PATH set — generating without a reference photo.');
    }

    stage = 'generation';
    console.log(
      '[4/5] Running the real generation pipeline (calls the real OpenAI story + image APIs — costs money)...',
    );
    const result = await agentService.startBookGeneration(book);

    // Always build and print the safe validation summary before doing
    // anything else — even a failed/incomplete run should surface its full
    // safe diagnostics, not just a bare thrown error (see docs "Manual
    // end-to-end smoke test").
    stage = 'diagnostics';
    console.log(`[5/5] Building diagnostics (final status: ${result.status})...`);
    const agentLogs = await prisma.agentLog.findMany({
      where: { bookId: book.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    const diagnostics = buildGenerationDiagnostics(result, agentLogs);

    const imageGenerationResult = result.imageGenerationResult as {
      images?: Array<{ kind: string; pageNumber?: number }>;
      failedImageCount?: number;
    } | null;
    const expectedImageCount = imageGenerationResult?.images?.length ?? 0;
    const characterProfileProvider =
      agentLogs.find((log) => log.step === 'char_build')?.provider ?? 'unknown';
    const characterSheetAssetId = result.characterSheetAssetKey
      ? characterSheetAssetKey(book.id)
      : undefined;
    const pdfExists = await pdfStorage.previewPdfExists(book.id);
    const pdfSizeBytes = pdfExists
      ? (await pdfStorage.getPreviewPdf(book.id))?.buffer.length
      : undefined;
    const extras: SmokeValidationExtras = {
      expectedImageCount,
      fallbackImageCount: imageGenerationResult?.failedImageCount ?? 0,
      ...(characterSheetAssetId && { characterSheetAssetId }),
      characterProfileProvider,
      pdfExists,
      ...(pdfSizeBytes !== undefined && { pdfSizeBytes }),
    };

    console.log('\n--- Validation summary ---');
    console.log(formatDiagnosticsSummary(diagnostics, extras));

    if (result.status !== BookStatus.complete) {
      console.log(
        `\n✘ Real generation smoke test FAILED — book did not reach "complete" status ` +
          `(failedStep=${result.failedStep ?? 'n/a'}). See failed step/error above.`,
      );
      process.exitCode = 1;
      return;
    }

    stage = 'verification';
    assert(result.storyPlan !== null, 'expected storyPlan to be persisted');
    assert(result.imageGenerationResult !== null, 'expected imageGenerationResult to be persisted');
    assert(result.characterProfile !== null, 'expected a CharacterProfile to be persisted');

    // Visual-reference verification only applies when a photo was supplied
    // and all three OpenAI providers (character profile, story, image) are
    // enabled — that's the only configuration where the character-sheet ->
    // images/edits path can actually run end to end.
    const allThreeProvidersOpenAI =
      process.env['CHARACTER_PROFILE_PROVIDER']?.trim().toLowerCase() === 'openai' &&
      process.env['STORY_GENERATION_PROVIDER']?.trim().toLowerCase() === 'openai' &&
      process.env['IMAGE_GENERATION_PROVIDER']?.trim().toLowerCase() === 'openai';

    if (config.childPhotoPath && allThreeProvidersOpenAI) {
      assert(
        !!result.characterSheetAssetKey,
        'expected a character-sheet reference image to be generated and stored',
      );
      const sheetBuffer = await imageAssetStorage.getImageAsset(characterSheetAssetKey(book.id));
      assert(
        !!sheetBuffer && sheetBuffer.length > 0,
        'expected the character-sheet reference image bytes to be readable from storage',
      );

      const referenceUsage = result.imageGenerationResult as {
        characterReferenceAvailable?: boolean;
        characterReferenceUsedForImages?: boolean;
        imageGenerationMode?: string;
      } | null;
      assert(
        referenceUsage?.characterReferenceAvailable === true,
        'expected characterReferenceAvailable to be true when a character sheet was generated',
      );
      assert(
        referenceUsage?.characterReferenceUsedForImages === true,
        'expected page image generation to report visual-reference usage (characterReferenceUsedForImages)',
      );
      console.log(
        `      Visual-reference character consistency verified (imageGenerationMode=${referenceUsage?.imageGenerationMode}).`,
      );
    } else {
      console.log(
        '      Skipping visual-reference verification (requires a child photo and CHARACTER_PROFILE_PROVIDER/STORY_GENERATION_PROVIDER/IMAGE_GENERATION_PROVIDER all set to "openai").',
      );
    }

    const images = imageGenerationResult?.images ?? [];
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
    assert(pdfExists, 'expected the rendered PDF to exist in storage');
    assert(!!pdfSizeBytes && pdfSizeBytes > 0, 'expected the rendered PDF to have non-zero size');

    console.log('\n✔ Real generation smoke test passed — all checks succeeded.');
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error(`\n✘ Real generation smoke test FAILED at stage "${stage}":`, err);
  process.exit(1);
});
