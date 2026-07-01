import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { BookStatus, type Book } from '@prisma/client';
import type { BookDto, BooksPageDto } from '@book/types';
import { PrismaService } from '../database/prisma.service';
import { toBookDto } from './books.mapper';
import type { CreateBookDto } from './dto/create-book.dto';
import type { UpdateBookDto } from './dto/update-book.dto';

@Injectable()
export class BooksService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, dto: CreateBookDto): Promise<BookDto> {
    const book = await this.prisma.book.create({
      data: {
        userId,
        title: dto.title,
        childName: dto.childName,
        childAge: dto.childAge,
        language: dto.language,
        theme: dto.theme,
      },
    });
    return toBookDto(book);
  }

  async findAllForUser(userId: string, page: number, limit: number): Promise<BooksPageDto> {
    const safeLimit = Math.min(Math.max(1, limit), 50);
    const safePage = Math.max(1, page);
    const skip = (safePage - 1) * safeLimit;

    const [total, books] = await Promise.all([
      this.prisma.book.count({ where: { userId, deletedAt: null } }),
      this.prisma.book.findMany({
        where: { userId, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        skip,
        take: safeLimit,
      }),
    ]);

    return { items: books.map(toBookDto), page: safePage, limit: safeLimit, total };
  }

  async findOneForUser(id: string, userId: string): Promise<BookDto> {
    const book = await this.findOwnedOrThrow(id, userId);
    return toBookDto(book);
  }

  async update(id: string, userId: string, dto: UpdateBookDto): Promise<BookDto> {
    const book = await this.findOwnedOrThrow(id, userId);
    if (book.status !== BookStatus.created) {
      throw new ConflictException('Only draft books can be updated');
    }
    const updated = await this.prisma.book.update({
      where: { id },
      data: dto,
    });
    return toBookDto(updated);
  }

  async remove(id: string, userId: string): Promise<void> {
    const book = await this.findOwnedOrThrow(id, userId);
    if (book.status !== BookStatus.created) {
      throw new ConflictException('Only draft books can be deleted');
    }
    await this.prisma.book.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  /** Looks up a book and verifies ownership in one query — 404s rather than leaking existence of another user's book. */
  private async findOwnedOrThrow(id: string, userId: string): Promise<Book> {
    const book = await this.prisma.book.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!book) {
      throw new NotFoundException('Book not found');
    }
    return book;
  }
}
