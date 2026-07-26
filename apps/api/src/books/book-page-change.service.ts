import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { BookDto, BookPreview, ImageGenerationResult, StoryPlan } from '@book/types';
import { BookStatus, Prisma } from '@prisma/client';
import { bookLayoutStage } from '../agent/book-layout.stage';
import {
  claimNamespace,
  resolvePublishedImageNamespace,
} from '../agent/generation-artifact-namespace';
import { PrismaService } from '../database/prisma.service';
import { IMAGE_ASSET_STORAGE_TOKEN, type ImageAssetStorage } from '../images/image-asset-storage';
import { renderStorybookPdf } from '../pdf/pdf-renderer';
import { PDF_STORAGE_TOKEN, type PdfStorage } from '../pdf/pdf-storage';
import { toBookDto } from './books.mapper';
import { bookPreviewSchema, imageGenerationResultSchema, storyPlanSchema } from './books.schemas';
import { BookCrudService } from './book-crud.service';
import type { UpdateBookPageTextDto } from './dto/update-book-page-text.dto';
import { publishedImageKey } from './published-page-image-key';

const PAGE_EDIT_FENCING_VERSION = 1;

function parseRequiredJson<T>(
  schema: { safeParse(value: unknown): { success: boolean; data?: unknown } },
  value: unknown,
  label: string,
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ConflictException(`Published ${label} is unavailable or invalid`);
  }
  return result.data as T;
}

/**
 * Phase 4A text-only page revisions.
 *
 * The expensive work happens against an immutable candidate PDF namespace.
 * Only after every published image was resolved and the PDF was saved does a
 * single CAS transaction move the user-visible preview/layout/PDF pointers.
 * A failed render, storage error, stale expectedVersion, concurrent edit, or
 * newly-started generation therefore leaves the prior publication untouched.
 */
@Injectable()
export class BookPageChangeService {
  constructor(
    private readonly crud: BookCrudService,
    private readonly prisma: PrismaService,
    @Inject(PDF_STORAGE_TOKEN) private readonly pdfStorage: PdfStorage,
    @Inject(IMAGE_ASSET_STORAGE_TOKEN) private readonly imageStorage: ImageAssetStorage,
  ) {}

  async updatePageText(
    userId: string,
    bookId: string,
    pageNumber: number,
    dto: UpdateBookPageTextDto,
  ): Promise<BookDto> {
    const book = await this.crud.findOwnedOrThrow(bookId, userId);
    if (
      book.status !== BookStatus.complete ||
      book.activeRunId != null ||
      book.activePageImageRevisionId != null
    ) {
      throw new ConflictException('Only a completed, idle book can have one page edited');
    }

    const preview = parseRequiredJson<BookPreview>(
      bookPreviewSchema,
      book.bookPreview,
      'book preview',
    );
    const imageResult = parseRequiredJson<ImageGenerationResult>(
      imageGenerationResultSchema,
      book.imageGenerationResult,
      'image plan',
    );
    const pageIndex = preview.pages.findIndex((page) => page.pageNumber === pageNumber);
    if (pageIndex < 0) throw new NotFoundException(`Page ${pageNumber} was not found`);

    const storedPage = await this.prisma.bookPage.findUnique({
      where: { bookId_pageNumber: { bookId, pageNumber } },
      select: { version: true },
    });
    const previewPage = preview.pages[pageIndex]!;
    const currentVersion = storedPage?.version ?? previewPage.version ?? 1;
    if (dto.expectedVersion !== currentVersion) {
      throw new ConflictException({
        code: 'PAGE_VERSION_CONFLICT',
        message: 'This page changed after it was opened. Refresh the book and try again.',
        currentVersion,
      });
    }

    const nextVersion = currentVersion + 1;
    const nextPreview: BookPreview = {
      ...preview,
      pages: preview.pages.map((page, index) =>
        index === pageIndex ? { ...page, text: dto.text, version: nextVersion } : page,
      ),
    };
    const nextStoryPlan = this.updateStoryPlan(book.storyPlan, pageNumber, dto.text);
    const nextLayout = bookLayoutStage.execute({
      bookId,
      bookPreview: nextPreview,
      imageGenerationResult: imageResult,
    });

    const imageNamespace = resolvePublishedImageNamespace(book);
    if (imageNamespace.kind === 'not_ready') {
      throw new ConflictException('Published images are not ready');
    }
    const imageOverrides = new Map(
      (
        await this.prisma.bookPage.findMany({
          where: { bookId, imageR2Key: { not: null } },
          select: { pageNumber: true, imageR2Key: true },
        })
      )
        .filter((page): page is { pageNumber: number; imageR2Key: string } => !!page.imageR2Key)
        .map((page) => [page.pageNumber, page.imageR2Key]),
    );
    const imageBuffers = new Map<string, Buffer>();
    await Promise.all(
      nextLayout.entries
        .filter((entry) => entry.imageBlock)
        .map(async (entry) => {
          const key = publishedImageKey(
            bookId,
            imageNamespace,
            entry.kind,
            entry.pageNumber,
            imageOverrides,
          );
          const buffer = await this.imageStorage.getImageAsset(key);
          if (!buffer) {
            throw new ConflictException(
              `Published illustration for ${entry.kind === 'page' ? `page ${entry.pageNumber}` : entry.kind} is missing`,
            );
          }
          imageBuffers.set(entry.id, buffer);
        }),
    );

    const pdfBuffer = await renderStorybookPdf(nextLayout, {
      resolveImageBuffer: (_imageBlock, entry) => imageBuffers.get(entry.id),
    });
    const candidateNamespace = claimNamespace(randomUUID(), PAGE_EDIT_FENCING_VERSION);
    const savedPdf = await this.pdfStorage.saveClaimPreviewPdf(
      bookId,
      candidateNamespace,
      pdfBuffer,
    );

    const updatedBook = await this.prisma.$transaction(async (tx) => {
      const currentPage = await tx.bookPage.findUnique({
        where: { bookId_pageNumber: { bookId, pageNumber } },
        select: { version: true },
      });
      const transactionVersion = currentPage?.version ?? previewPage.version ?? 1;
      if (transactionVersion !== dto.expectedVersion) {
        throw new ConflictException({
          code: 'PAGE_VERSION_CONFLICT',
          message: 'This page changed after it was opened. Refresh the book and try again.',
          currentVersion: transactionVersion,
        });
      }

      const changed = await tx.book.updateMany({
        where: {
          id: bookId,
          userId,
          deletedAt: null,
          status: BookStatus.complete,
          activeRunId: null,
          activePageImageRevisionId: null,
          updatedAt: book.updatedAt,
          publishedRunId: book.publishedRunId,
          publishedRunFencingVersion: book.publishedRunFencingVersion,
          publishedPdfRunId: book.publishedPdfRunId,
          publishedPdfFencingVersion: book.publishedPdfFencingVersion,
        },
        data: {
          bookPreview: nextPreview as unknown as Prisma.InputJsonValue,
          bookLayout: nextLayout as unknown as Prisma.InputJsonValue,
          ...(nextStoryPlan && {
            storyPlan: nextStoryPlan as unknown as Prisma.InputJsonValue,
          }),
          previewPdfUrl: savedPdf.url,
          publishedPdfRunId: candidateNamespace.runId,
          publishedPdfFencingVersion: candidateNamespace.fencingVersion,
        },
      });
      if (changed.count === 0) {
        throw new ConflictException(
          'The book changed while this page was being rebuilt. Refresh and try again.',
        );
      }

      const pageLayout = nextLayout.entries.find(
        (entry) => entry.kind === 'page' && entry.pageNumber === pageNumber,
      );
      const image = imageResult.images.find(
        (entry) => entry.kind === 'page' && entry.pageNumber === pageNumber,
      );
      await tx.bookPage.upsert({
        where: { bookId_pageNumber: { bookId, pageNumber } },
        create: {
          bookId,
          pageNumber,
          textContent: dto.text,
          version: nextVersion,
          textRegenCount: 1,
          ...(image && {
            imagePrompt: {
              prompt: image.prompt,
              negativePrompt: image.negativePrompt ?? null,
            } as Prisma.InputJsonValue,
            imageR2Key: publishedImageKey(
              bookId,
              imageNamespace,
              'page',
              pageNumber,
              imageOverrides,
            ),
            imageUrl: image.imageUrl,
          }),
          ...(pageLayout && {
            layoutSpec: pageLayout as unknown as Prisma.InputJsonValue,
          }),
        },
        update: {
          textContent: dto.text,
          version: nextVersion,
          textRegenCount: { increment: 1 },
          ...(pageLayout && {
            layoutSpec: pageLayout as unknown as Prisma.InputJsonValue,
          }),
        },
      });

      return tx.book.findUniqueOrThrow({ where: { id: bookId } });
    });

    return toBookDto(updatedBook);
  }

  private updateStoryPlan(
    raw: Prisma.JsonValue | null,
    pageNumber: number,
    text: string,
  ): StoryPlan | null {
    const parsed = storyPlanSchema.safeParse(raw);
    if (!parsed.success || !parsed.data.pages) return null;
    const storyPlan = parsed.data as StoryPlan;
    return {
      ...storyPlan,
      pages: storyPlan.pages!.map((page) =>
        page.pageNumber === pageNumber ? { ...page, narration: text, storyText: text } : page,
      ),
    };
  }
}
