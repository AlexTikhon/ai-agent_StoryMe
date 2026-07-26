import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type {
  BookDto,
  BookPreview,
  CharacterCard,
  GeneratedImageEntry,
  ImageGenerationResult,
  PageImageRegenerationQuote,
  PageImageRevisionDto,
} from '@book/types';
import {
  BookStatus,
  PageImageRevisionStatus,
  Prisma,
  type Book,
  type PageImageRevision,
} from '@prisma/client';
import { bookLayoutStage } from '../agent/book-layout.stage';
import {
  claimNamespace,
  resolvePublishedImageNamespace,
} from '../agent/generation-artifact-namespace';
import { readEstimatedCostUsd } from '../agent/generation-provider-telemetry';
import {
  CreditsService,
  PAGE_IMAGE_REGENERATION_CREDIT_COST,
  pageImageRevisionChargeIdempotencyKey,
  pageImageRevisionRefundIdempotencyKey,
} from '../credits/credits.service';
import { PrismaService } from '../database/prisma.service';
import {
  claimImageAssetKey,
  IMAGE_ASSET_STORAGE_TOKEN,
  type ImageAssetStorage,
} from '../images/image-asset-storage';
import {
  IMAGE_GENERATION_PROVIDER_TOKEN,
  type ImageGenerationProvider,
  type ImageReference,
} from '../images/image-generation-provider';
import { renderStorybookPdf } from '../pdf/pdf-renderer';
import { PDF_STORAGE_TOKEN, type PdfStorage } from '../pdf/pdf-storage';
import { toBookDto } from './books.mapper';
import {
  bookPreviewSchema,
  characterCardSchema,
  imageGenerationResultSchema,
} from './books.schemas';
import { BookCrudService } from './book-crud.service';
import type { CreatePageImageQuoteDto } from './dto/create-page-image-quote.dto';
import { publishedImageKey } from './published-page-image-key';

const PAGE_IMAGE_QUOTE_TTL_MS = 10 * 60 * 1000;
const PUBLIC_FAILURE_MESSAGE =
  'The page illustration could not be regenerated. The previous book is unchanged and the credit was refunded.';

function parseRequiredJson<T>(
  schema: { safeParse(value: unknown): { success: boolean; data?: unknown } },
  value: unknown,
  label: string,
): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ConflictException(`Published ${label} is unavailable or invalid`);
  return result.data as T;
}

function providerName(provider: ImageGenerationProvider): string {
  return provider.providerName ?? 'unknown';
}

@Injectable()
export class BookPageImageRevisionService {
  constructor(
    private readonly crud: BookCrudService,
    private readonly prisma: PrismaService,
    private readonly credits: CreditsService,
    @Inject(IMAGE_GENERATION_PROVIDER_TOKEN)
    private readonly imageProvider: ImageGenerationProvider,
    @Inject(IMAGE_ASSET_STORAGE_TOKEN)
    private readonly imageStorage: ImageAssetStorage,
    @Inject(PDF_STORAGE_TOKEN)
    private readonly pdfStorage: PdfStorage,
  ) {}

  async createQuote(
    userId: string,
    bookId: string,
    pageNumber: number,
    dto: CreatePageImageQuoteDto,
  ): Promise<PageImageRegenerationQuote> {
    const book = await this.crud.findOwnedOrThrow(bookId, userId);
    this.assertBookReady(book);
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
    const previewPage = preview.pages.find((page) => page.pageNumber === pageNumber);
    const image = imageResult.images.find(
      (entry) => entry.kind === 'page' && entry.pageNumber === pageNumber,
    );
    if (!previewPage || !image) throw new NotFoundException(`Page ${pageNumber} was not found`);

    const storedPage = await this.prisma.bookPage.findUnique({
      where: { bookId_pageNumber: { bookId, pageNumber } },
      select: { version: true },
    });
    const currentVersion = storedPage?.version ?? previewPage.version ?? 1;
    if (dto.expectedVersion !== currentVersion) {
      throw this.versionConflict(currentVersion);
    }

    const provider = providerName(this.imageProvider);
    const estimatedCostUsd = readEstimatedCostUsd(
      'illustration',
      provider === 'mock' || provider === 'openai' ? provider : 'unknown',
      process.env,
    );
    const revision = await this.prisma.pageImageRevision.create({
      data: {
        bookId,
        userId,
        pageNumber,
        expectedPageVersion: currentVersion,
        costCredits: PAGE_IMAGE_REGENERATION_CREDIT_COST,
        provider,
        ...(estimatedCostUsd !== undefined && { estimatedCostUsd }),
        quoteExpiresAt: new Date(Date.now() + PAGE_IMAGE_QUOTE_TTL_MS),
        sourceBookUpdatedAt: book.updatedAt,
        sourcePublishedRunId: book.publishedRunId,
        sourcePublishedRunFencingVersion: book.publishedRunFencingVersion,
        sourcePublishedPdfRunId: book.publishedPdfRunId,
        sourcePublishedPdfFencingVersion: book.publishedPdfFencingVersion,
      },
    });
    return this.toQuote(revision);
  }

  async confirm(
    userId: string,
    bookId: string,
    pageNumber: number,
    revisionId: string,
  ): Promise<PageImageRevisionDto> {
    const revision = await this.prisma.$transaction(async (tx) => {
      const current = await tx.pageImageRevision.findFirst({
        where: { id: revisionId, userId, bookId, pageNumber },
      });
      if (!current) throw new NotFoundException('Page image quote not found');
      if (current.status !== PageImageRevisionStatus.quoted) return current;
      if (current.quoteExpiresAt.getTime() <= Date.now()) {
        throw new ConflictException({
          code: 'PAGE_IMAGE_QUOTE_EXPIRED',
          message: 'This price quote expired. Request a new quote before confirming.',
        });
      }

      const book = await tx.book.findFirst({
        where: { id: bookId, userId, deletedAt: null },
      });
      if (!book || !this.matchesSnapshot(book, current)) {
        throw new ConflictException({
          code: 'PAGE_IMAGE_QUOTE_STALE',
          message: 'The book changed after this quote was created. Request a new quote.',
        });
      }
      const page = await tx.bookPage.findUnique({
        where: { bookId_pageNumber: { bookId, pageNumber } },
        select: { version: true },
      });
      const preview = parseRequiredJson<BookPreview>(
        bookPreviewSchema,
        book.bookPreview,
        'book preview',
      );
      const previewVersion =
        preview.pages.find((candidate) => candidate.pageNumber === pageNumber)?.version ?? 1;
      const currentVersion = page?.version ?? previewVersion;
      if (currentVersion !== current.expectedPageVersion) {
        throw this.versionConflict(currentVersion);
      }

      const reserved = await tx.book.updateMany({
        where: {
          id: bookId,
          userId,
          status: BookStatus.complete,
          activeRunId: null,
          activePageImageRevisionId: null,
          updatedAt: current.sourceBookUpdatedAt,
        },
        data: { activePageImageRevisionId: current.id },
      });
      if (reserved.count === 0) {
        throw new ConflictException(
          'Another generation or page-image revision is already in progress.',
        );
      }
      const reservedBook = await tx.book.findUniqueOrThrow({
        where: { id: bookId },
        select: { updatedAt: true },
      });

      const queued = await tx.pageImageRevision.updateMany({
        where: { id: current.id, status: PageImageRevisionStatus.quoted },
        data: {
          status: PageImageRevisionStatus.queued,
          confirmedAt: new Date(),
          sourceBookUpdatedAt: reservedBook.updatedAt,
        },
      });
      if (queued.count === 0) {
        throw new ConflictException('This quote was already confirmed by another request.');
      }
      await this.credits.deductInTransaction(tx, {
        userId,
        amount: current.costCredits,
        reason: 'regen_page',
        bookId,
        idempotencyKey: pageImageRevisionChargeIdempotencyKey(current.id),
      });
      await tx.outboxEvent.create({
        data: {
          aggregateType: 'page_image_revision',
          aggregateId: current.id,
          eventType: 'page_image_revision_queued',
          payload: {
            bookId,
            revisionId: current.id,
          } as unknown as Prisma.InputJsonValue,
        },
      });
      return tx.pageImageRevision.findUniqueOrThrow({ where: { id: current.id } });
    });
    return this.toDto(revision);
  }

  async getRevision(
    userId: string,
    bookId: string,
    revisionId: string,
  ): Promise<PageImageRevisionDto> {
    const revision = await this.prisma.pageImageRevision.findFirst({
      where: { id: revisionId, userId, bookId },
    });
    if (!revision) throw new NotFoundException('Page image revision not found');
    const book =
      revision.status === PageImageRevisionStatus.completed
        ? toBookDto(await this.crud.findOwnedOrThrow(bookId, userId))
        : undefined;
    return this.toDto(revision, book);
  }

  async claim(revisionId: string, deliveryToken: string): Promise<PageImageRevision | null> {
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.pageImageRevision.updateMany({
        where: {
          id: revisionId,
          status: { in: [PageImageRevisionStatus.queued, PageImageRevisionStatus.running] },
        },
        data: {
          status: PageImageRevisionStatus.running,
          deliveryToken,
          fencingVersion: { increment: 1 },
          startedAt: new Date(),
        },
      });
      if (claimed.count === 0) return null;
      return tx.pageImageRevision.findUniqueOrThrow({ where: { id: revisionId } });
    });
  }

  async executeClaimed(revisionId: string, fencingVersion: number): Promise<void> {
    const revision = await this.prisma.pageImageRevision.findUnique({
      where: { id: revisionId },
      include: { book: true },
    });
    if (
      !revision ||
      revision.status !== PageImageRevisionStatus.running ||
      revision.fencingVersion !== fencingVersion
    ) {
      return;
    }
    if (!this.matchesSnapshot(revision.book, revision)) {
      await this.failAndRefund(revisionId, 'PAGE_IMAGE_SOURCE_CHANGED', PUBLIC_FAILURE_MESSAGE);
      return;
    }

    const book = revision.book;
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
    const characterCard = parseRequiredJson<CharacterCard>(
      characterCardSchema,
      book.characterCard,
      'character card',
    );
    const previewPage = preview.pages.find((page) => page.pageNumber === revision.pageNumber);
    const originalImage = imageResult.images.find(
      (entry) => entry.kind === 'page' && entry.pageNumber === revision.pageNumber,
    );
    if (!previewPage || !originalImage) {
      await this.failAndRefund(revisionId, 'PAGE_IMAGE_SOURCE_INVALID', PUBLIC_FAILURE_MESSAGE);
      return;
    }
    const storedPages = await this.prisma.bookPage.findMany({
      where: { bookId: book.id },
      select: { pageNumber: true, version: true, imageR2Key: true },
    });
    const currentPage = storedPages.find((page) => page.pageNumber === revision.pageNumber);
    const currentVersion = currentPage?.version ?? previewPage.version ?? 1;
    if (currentVersion !== revision.expectedPageVersion) {
      await this.failAndRefund(revisionId, 'PAGE_VERSION_CONFLICT', PUBLIC_FAILURE_MESSAGE);
      return;
    }

    const namespace = claimNamespace(revision.id, fencingVersion);
    const candidateImage: GeneratedImageEntry = {
      ...originalImage,
      seed: `${originalImage.seed}:revision:${revision.id}`,
    };
    const characterReference = await this.loadCharacterReference(book.characterSheetAssetKey);
    const generated = await this.imageProvider.generateImage({
      bookId: book.id,
      entry: candidateImage,
      characterCard,
      ...(characterReference && { characterReference }),
    });
    const candidateImageKey = claimImageAssetKey(book.id, namespace, 'page', revision.pageNumber);
    await this.imageStorage.saveImageAsset(
      candidateImageKey,
      generated.buffer,
      generated.contentType,
    );

    const nextImageResult: ImageGenerationResult = {
      ...imageResult,
      images: imageResult.images.map((entry) =>
        entry.kind === 'page' && entry.pageNumber === revision.pageNumber ? candidateImage : entry,
      ),
      imageByteProvider: providerName(this.imageProvider),
    };
    const nextPreview: BookPreview = {
      ...preview,
      pages: preview.pages.map((page) =>
        page.pageNumber === revision.pageNumber
          ? { ...page, version: revision.expectedPageVersion + 1 }
          : page,
      ),
    };
    const nextLayout = bookLayoutStage.execute({
      bookId: book.id,
      bookPreview: nextPreview,
      imageGenerationResult: nextImageResult,
    });
    const sourceNamespace = resolvePublishedImageNamespace(book);
    if (sourceNamespace.kind === 'not_ready') {
      await this.failAndRefund(revisionId, 'PAGE_IMAGE_SOURCE_INVALID', PUBLIC_FAILURE_MESSAGE);
      return;
    }
    const overrides = new Map(
      storedPages
        .filter((page): page is typeof page & { imageR2Key: string } => !!page.imageR2Key)
        .map((page) => [page.pageNumber, page.imageR2Key]),
    );
    const buffers = new Map<string, Buffer>();
    await Promise.all(
      nextLayout.entries
        .filter((entry) => entry.imageBlock)
        .map(async (entry) => {
          if (entry.kind === 'page' && entry.pageNumber === revision.pageNumber) {
            buffers.set(entry.id, generated.buffer);
            return;
          }
          const key = publishedImageKey(
            book.id,
            sourceNamespace,
            entry.kind,
            entry.pageNumber,
            overrides,
          );
          const buffer = await this.imageStorage.getImageAsset(key);
          if (!buffer) throw new Error(`Published illustration "${entry.id}" is missing`);
          buffers.set(entry.id, buffer);
        }),
    );
    const pdf = await renderStorybookPdf(nextLayout, {
      resolveImageBuffer: (_block, entry) => buffers.get(entry.id),
    });
    const savedPdf = await this.pdfStorage.saveClaimPreviewPdf(book.id, namespace, pdf);

    await this.prisma.$transaction(async (tx) => {
      const applied = await tx.book.updateMany({
        where: {
          id: book.id,
          userId: revision.userId,
          status: BookStatus.complete,
          activeRunId: null,
          activePageImageRevisionId: revision.id,
          updatedAt: revision.sourceBookUpdatedAt,
          publishedRunId: revision.sourcePublishedRunId,
          publishedRunFencingVersion: revision.sourcePublishedRunFencingVersion,
          publishedPdfRunId: revision.sourcePublishedPdfRunId,
          publishedPdfFencingVersion: revision.sourcePublishedPdfFencingVersion,
        },
        data: {
          bookPreview: nextPreview as unknown as Prisma.InputJsonValue,
          imageGenerationResult: nextImageResult as unknown as Prisma.InputJsonValue,
          bookLayout: nextLayout as unknown as Prisma.InputJsonValue,
          previewPdfUrl: savedPdf.url,
          publishedPdfRunId: namespace.runId,
          publishedPdfFencingVersion: namespace.fencingVersion,
          activePageImageRevisionId: null,
        },
      });
      if (applied.count === 0) throw new Error('Page image publication fence was superseded');

      const pageLayout = nextLayout.entries.find(
        (entry) => entry.kind === 'page' && entry.pageNumber === revision.pageNumber,
      );
      await tx.bookPage.upsert({
        where: {
          bookId_pageNumber: { bookId: book.id, pageNumber: revision.pageNumber },
        },
        create: {
          bookId: book.id,
          pageNumber: revision.pageNumber,
          textContent: previewPage.text,
          version: revision.expectedPageVersion + 1,
          imageRegenCount: 1,
          imageR2Key: candidateImageKey,
          imageUrl: candidateImage.imageUrl,
          imagePrompt: {
            prompt: candidateImage.prompt,
            negativePrompt: candidateImage.negativePrompt ?? null,
          } as Prisma.InputJsonValue,
          ...(pageLayout && { layoutSpec: pageLayout as unknown as Prisma.InputJsonValue }),
        },
        update: {
          version: revision.expectedPageVersion + 1,
          imageRegenCount: { increment: 1 },
          imageR2Key: candidateImageKey,
          imageUrl: candidateImage.imageUrl,
          imagePrompt: {
            prompt: candidateImage.prompt,
            negativePrompt: candidateImage.negativePrompt ?? null,
          } as Prisma.InputJsonValue,
          ...(pageLayout && { layoutSpec: pageLayout as unknown as Prisma.InputJsonValue }),
        },
      });
      const completed = await tx.pageImageRevision.updateMany({
        where: {
          id: revision.id,
          status: PageImageRevisionStatus.running,
          fencingVersion,
        },
        data: {
          status: PageImageRevisionStatus.completed,
          completedAt: new Date(),
          errorCode: null,
          errorMessage: null,
        },
      });
      if (completed.count === 0) throw new Error('Page image revision fence was superseded');
    });
  }

  async failAndRefund(
    revisionId: string,
    errorCode = 'PAGE_IMAGE_REGENERATION_FAILED',
    errorMessage = PUBLIC_FAILURE_MESSAGE,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const revision = await tx.pageImageRevision.findUnique({ where: { id: revisionId } });
      if (
        !revision ||
        revision.status === PageImageRevisionStatus.completed ||
        revision.status === PageImageRevisionStatus.failed ||
        revision.status === PageImageRevisionStatus.quoted
      ) {
        return;
      }
      const failed = await tx.pageImageRevision.updateMany({
        where: {
          id: revision.id,
          status: { in: [PageImageRevisionStatus.queued, PageImageRevisionStatus.running] },
        },
        data: {
          status: PageImageRevisionStatus.failed,
          failedAt: new Date(),
          errorCode,
          errorMessage,
        },
      });
      if (failed.count === 0) return;
      await tx.book.updateMany({
        where: { id: revision.bookId, activePageImageRevisionId: revision.id },
        data: { activePageImageRevisionId: null },
      });
      const charge = await tx.creditTransaction.findUnique({
        where: { idempotencyKey: pageImageRevisionChargeIdempotencyKey(revision.id) },
      });
      if (charge) {
        await this.credits.addInTransaction(tx, {
          userId: charge.userId,
          amount: -charge.amount,
          reason: 'refund_page_regeneration_failure',
          ...(charge.bookId && { bookId: charge.bookId }),
          idempotencyKey: pageImageRevisionRefundIdempotencyKey(revision.id),
        });
      }
    });
  }

  private assertBookReady(book: Book): void {
    if (
      book.status !== BookStatus.complete ||
      book.activeRunId != null ||
      book.activePageImageRevisionId != null
    ) {
      throw new ConflictException(
        'Only a completed, idle book can regenerate one page illustration.',
      );
    }
  }

  private matchesSnapshot(book: Book, revision: PageImageRevision): boolean {
    return (
      book.status === BookStatus.complete &&
      book.activeRunId == null &&
      (book.activePageImageRevisionId == null || book.activePageImageRevisionId === revision.id) &&
      book.updatedAt.getTime() === revision.sourceBookUpdatedAt.getTime() &&
      book.publishedRunId === revision.sourcePublishedRunId &&
      book.publishedRunFencingVersion === revision.sourcePublishedRunFencingVersion &&
      book.publishedPdfRunId === revision.sourcePublishedPdfRunId &&
      book.publishedPdfFencingVersion === revision.sourcePublishedPdfFencingVersion
    );
  }

  private async loadCharacterReference(key: string | null): Promise<ImageReference | undefined> {
    if (!key) return undefined;
    const buffer = await this.imageStorage.getImageAsset(key);
    return buffer ? { buffer, contentType: 'image/png' } : undefined;
  }

  private versionConflict(currentVersion: number): ConflictException {
    return new ConflictException({
      code: 'PAGE_VERSION_CONFLICT',
      message: 'This page changed after it was opened. Refresh the book and try again.',
      currentVersion,
    });
  }

  private toQuote(revision: PageImageRevision): PageImageRegenerationQuote {
    return {
      id: revision.id,
      bookId: revision.bookId,
      pageNumber: revision.pageNumber,
      expectedVersion: revision.expectedPageVersion,
      costCredits: revision.costCredits,
      provider: revision.provider,
      estimatedCostUsd: revision.estimatedCostUsd?.toNumber() ?? null,
      expiresAt: revision.quoteExpiresAt.toISOString(),
      confirmationRequired: true,
    };
  }

  private toDto(revision: PageImageRevision, book?: BookDto): PageImageRevisionDto {
    return {
      id: revision.id,
      bookId: revision.bookId,
      pageNumber: revision.pageNumber,
      status: revision.status,
      costCredits: revision.costCredits,
      provider: revision.provider,
      errorCode: revision.errorCode,
      errorMessage: revision.errorMessage,
      ...(book && { book }),
    };
  }
}
