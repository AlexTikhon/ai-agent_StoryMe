import { describe, it, expect, beforeEach } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Book } from '@prisma/client';
import { BooksService } from './books.service';
import { createMockPrisma } from '../common/test-utils/mock-prisma';
import type { CreateBookDto } from './dto/create-book.dto';
import type { UpdateBookDto } from './dto/update-book.dto';

type MockPrisma = ReturnType<typeof createMockPrisma>;

// Prisma emits string enum values that match the schema — 'created', 'char_build', etc.
const STATUS_CREATED = 'created' as Book['status'];
const STATUS_IN_PROGRESS = 'char_build' as Book['status'];

function makeBook(overrides: Partial<Book> = {}): Book {
  return {
    id: 'b-1',
    userId: 'u-1',
    childProfileId: null,
    status: STATUS_CREATED,
    request: null,
    title: 'The Adventures of Mia',
    dedicationText: null,
    pageCount: null,
    childName: 'Mia',
    childAge: 5,
    language: 'en' as Book['language'],
    theme: 'friendship',
    characterCard: null,
    storyPlan: null,
    chapters: null,
    imagePrompts: null,
    qualityReport: null,
    pageLayouts: null,
    coverUrl: null,
    pdfR2Key: null,
    pdfUrl: null,
    printPdfR2Key: null,
    printPdfUrl: null,
    previewPdfR2Key: null,
    previewPdfUrl: null,
    socialCardUrl: null,
    isPaid: false,
    paidAt: null,
    stripePaymentIntentId: null,
    isPublic: false,
    generationTimeMs: null,
    totalCostUsd: null,
    aiModelVersions: null,
    generatedDegraded: false,
    errorMessage: null,
    retryCount: 0,
    failedStep: null,
    deletedAt: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

describe('BooksService', () => {
  let service: BooksService;
  let prisma: MockPrisma;

  beforeEach(() => {
    prisma = createMockPrisma();
    service = new BooksService(prisma as never);
  });

  // ─── create ──────────────────────────────────────────────────────────────────

  describe('create', () => {
    it('persists a new book and returns a BookDto', async () => {
      const dto: CreateBookDto = {
        title: 'The Adventures of Mia',
        childName: 'Mia',
        childAge: 5,
        language: 'en' as CreateBookDto['language'],
        theme: 'friendship',
      };
      const book = makeBook({ userId: 'u-1' });
      prisma.book.create.mockResolvedValue(book);

      const result = await service.create('u-1', dto);

      expect(prisma.book.create).toHaveBeenCalledWith({
        data: {
          userId: 'u-1',
          title: dto.title,
          childName: dto.childName,
          childAge: dto.childAge,
          language: dto.language,
          theme: dto.theme,
        },
      });
      expect(result.id).toBe(book.id);
      expect(result.userId).toBe('u-1');
      expect(result.title).toBe(book.title);
    });
  });

  // ─── findAllForUser ───────────────────────────────────────────────────────────

  describe('findAllForUser', () => {
    it('returns paginated BookDtos for the given user', async () => {
      const books = [makeBook({ id: 'b-1' }), makeBook({ id: 'b-2' })];
      prisma.book.count.mockResolvedValue(2);
      prisma.book.findMany.mockResolvedValue(books);

      const result = await service.findAllForUser('u-1', 1, 20);

      expect(prisma.book.findMany).toHaveBeenCalledWith({
        where: { userId: 'u-1', deletedAt: null },
        orderBy: { createdAt: 'desc' },
        skip: 0,
        take: 20,
      });
      expect(result.items).toHaveLength(2);
      expect(result.items[0]?.id).toBe('b-1');
      expect(result.items[1]?.id).toBe('b-2');
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
      expect(result.total).toBe(2);
    });

    it('returns empty items array when the user has no books', async () => {
      prisma.book.count.mockResolvedValue(0);
      prisma.book.findMany.mockResolvedValue([]);

      const result = await service.findAllForUser('u-1', 1, 20);

      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('applies page offset as skip', async () => {
      prisma.book.count.mockResolvedValue(10);
      prisma.book.findMany.mockResolvedValue([]);

      await service.findAllForUser('u-1', 2, 5);

      expect(prisma.book.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 5, take: 5 }),
      );
    });

    it('clamps limit to 50', async () => {
      prisma.book.count.mockResolvedValue(0);
      prisma.book.findMany.mockResolvedValue([]);

      const result = await service.findAllForUser('u-1', 1, 999);

      expect(result.limit).toBe(50);
      expect(prisma.book.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 50 }),
      );
    });
  });

  // ─── findOneForUser ───────────────────────────────────────────────────────────

  describe('findOneForUser', () => {
    it('returns a BookDto when the book belongs to the user', async () => {
      const book = makeBook({ id: 'b-1', userId: 'u-1' });
      prisma.book.findFirst.mockResolvedValue(book);

      const result = await service.findOneForUser('b-1', 'u-1');

      expect(prisma.book.findFirst).toHaveBeenCalledWith({
        where: { id: 'b-1', userId: 'u-1', deletedAt: null },
      });
      expect(result.id).toBe('b-1');
    });

    it('throws NotFoundException when book belongs to a different user', async () => {
      // findFirst returns null because the userId filter excludes the row
      prisma.book.findFirst.mockResolvedValue(null);

      await expect(service.findOneForUser('b-1', 'u-other')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws NotFoundException when book does not exist', async () => {
      prisma.book.findFirst.mockResolvedValue(null);

      await expect(service.findOneForUser('no-such-id', 'u-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ─── update ───────────────────────────────────────────────────────────────────

  describe('update', () => {
    it('updates and returns BookDto when status is created', async () => {
      const book = makeBook({ status: STATUS_CREATED });
      const updated = makeBook({ title: 'New Title', status: STATUS_CREATED });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.book.update.mockResolvedValue(updated);

      const dto: UpdateBookDto = { title: 'New Title' };
      const result = await service.update('b-1', 'u-1', dto);

      expect(prisma.book.update).toHaveBeenCalledWith({
        where: { id: 'b-1' },
        data: dto,
      });
      expect(result.title).toBe('New Title');
    });

    it('throws ConflictException when book has advanced past created', async () => {
      const book = makeBook({ status: STATUS_IN_PROGRESS });
      prisma.book.findFirst.mockResolvedValue(book);

      await expect(service.update('b-1', 'u-1', { title: 'X' })).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.book.update).not.toHaveBeenCalled();
    });
  });

  // ─── remove ───────────────────────────────────────────────────────────────────

  describe('remove', () => {
    it('soft-deletes by setting deletedAt when status is created', async () => {
      const book = makeBook({ status: STATUS_CREATED });
      prisma.book.findFirst.mockResolvedValue(book);
      prisma.book.update.mockResolvedValue({ ...book, deletedAt: new Date() });

      await service.remove('b-1', 'u-1');

      expect(prisma.book.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'b-1' },
          data: expect.objectContaining({ deletedAt: expect.any(Date) }),
        }),
      );
    });

    it('throws ConflictException when book has advanced past created', async () => {
      const book = makeBook({ status: STATUS_IN_PROGRESS });
      prisma.book.findFirst.mockResolvedValue(book);

      await expect(service.remove('b-1', 'u-1')).rejects.toThrow(ConflictException);
      expect(prisma.book.update).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when book does not exist', async () => {
      prisma.book.findFirst.mockResolvedValue(null);

      await expect(service.remove('no-such', 'u-1')).rejects.toThrow(NotFoundException);
    });
  });
});
