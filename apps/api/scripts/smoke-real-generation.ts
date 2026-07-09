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
 * Also boots the real Nest application context, so it needs a running local
 * Postgres + Redis matching apps/api/.env — the same stack
 * `pnpm --filter @book/api dev` uses.
 */
import { NestFactory } from '@nestjs/core';
import { BookLanguage, BookStatus } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { UsersService } from '../src/users/users.service';
import { AgentService } from '../src/agent/agent.service';
import { PDF_STORAGE_TOKEN, type PdfStorage } from '../src/pdf/pdf-storage';
import {
  IMAGE_ASSET_STORAGE_TOKEN,
  imageAssetKey,
  type ImageAssetStorage,
} from '../src/images/image-asset-storage';
import { checkPreconditions, formatDiagnosticsSummary } from './smoke-real-generation-helpers';
import { buildGenerationDiagnostics } from '../src/books/generation-diagnostics';

const SMOKE_USER_EMAIL = 'smoke-real-generation@storyme.local';

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

    console.log(`[1/4] Ensuring smoke-test user (${SMOKE_USER_EMAIL})...`);
    const user = await usersService.findOrCreateByEmail(SMOKE_USER_EMAIL, 'Smoke Test');

    console.log('[2/4] Creating a small test book (4 pages, theme=friendship)...');
    const book = await prisma.book.create({
      data: {
        userId: user.id,
        title: 'Real Generation Smoke Test',
        childName: 'Smoke',
        childAge: 5,
        language: BookLanguage.en,
        theme: 'friendship',
      },
    });
    console.log(`      Book id: ${book.id}`);

    console.log(
      '[3/4] Running the real generation pipeline (calls the real OpenAI story + image APIs — costs money)...',
    );
    const result = await agentService.startBookGeneration(book);

    console.log(`[4/4] Verifying results (final status: ${result.status})...`);
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
