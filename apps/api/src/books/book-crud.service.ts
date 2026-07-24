import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { BookStatus, type Book } from '@prisma/client';
import {
  DEFAULT_BOOK_PAGE_COUNT,
  SupportedLanguage,
  type BookDto,
  type BooksPageDto,
} from '@book/types';
import { PrismaService } from '../database/prisma.service';
import { toBookDto } from './books.mapper';
import type { CreateBookDto } from './dto/create-book.dto';
import type { UpdateBookDto } from './dto/update-book.dto';

export const EDITABLE_BOOK_STATUSES = new Set<BookStatus>([
  BookStatus.created,
  BookStatus.complete,
  BookStatus.failed,
  BookStatus.partial,
  BookStatus.cancelled,
]);

@Injectable()
export class BookCrudService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, dto: CreateBookDto): Promise<BookDto> {
    return toBookDto(
      await this.prisma.book.create({
        data: {
          userId,
          title: dto.title,
          childName: dto.childName,
          childAge: dto.childAge,
          language: dto.language ?? SupportedLanguage.English,
          theme: dto.theme,
          educationalMessage: dto.educationalMessage ?? null,
          pageCount: dto.pageCount ?? DEFAULT_BOOK_PAGE_COUNT,
        },
      }),
    );
  }

  async findAllForUser(userId: string, page: number, limit: number): Promise<BooksPageDto> {
    const safeLimit = Math.min(Math.max(1, limit), 50);
    const safePage = Math.max(1, page);
    const [total, books] = await Promise.all([
      this.prisma.book.count({ where: { userId, deletedAt: null } }),
      this.prisma.book.findMany({
        where: { userId, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
      }),
    ]);
    return { items: books.map(toBookDto), page: safePage, limit: safeLimit, total };
  }

  async findOneForUser(id: string, userId: string): Promise<BookDto> {
    return toBookDto(await this.findOwnedOrThrow(id, userId));
  }

  async update(id: string, userId: string, dto: UpdateBookDto): Promise<BookDto> {
    const book = await this.findOwnedOrThrow(id, userId);
    if (!EDITABLE_BOOK_STATUSES.has(book.status)) {
      throw new ConflictException('Book cannot be edited while generation is in progress');
    }
    const result = await this.prisma.book.updateMany({
      where: { id, userId, deletedAt: null, status: { in: [...EDITABLE_BOOK_STATUSES] } },
      data: dto,
    });
    if (result.count === 0) {
      throw new ConflictException('Book cannot be edited while generation is in progress');
    }
    return toBookDto(await this.findOwnedOrThrow(id, userId));
  }

  async remove(id: string, userId: string): Promise<void> {
    const book = await this.findOwnedOrThrow(id, userId);
    if (!EDITABLE_BOOK_STATUSES.has(book.status)) {
      throw new ConflictException('Book cannot be deleted while generation is in progress');
    }
    const result = await this.prisma.book.updateMany({
      where: { id, userId, deletedAt: null, status: { in: [...EDITABLE_BOOK_STATUSES] } },
      data: { deletedAt: new Date() },
    });
    if (result.count === 0) {
      throw new ConflictException('Book cannot be deleted while generation is in progress');
    }
  }

  /**
   * A missing, soft-deleted, or differently-owned book is deliberately the
   * same 404, preventing ownership probing.
   */
  async findOwnedOrThrow(id: string, userId: string): Promise<Book> {
    const book = await this.prisma.book.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!book) throw new NotFoundException('Book not found');
    return book;
  }
}
