import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { BookStatus, type Book } from '@prisma/client';
import type {
  BookDto,
  BooksPageDto,
  GenerateBookResponse,
  GenerationDiagnosticsDto,
} from '@book/types';
import { PrismaService } from '../database/prisma.service';
import { AgentService } from '../agent/agent.service';
import { PDF_STORAGE_TOKEN, type PdfStorage } from '../pdf/pdf-storage';
import { toBookDto } from './books.mapper';
import { buildGenerationDiagnostics } from './generation-diagnostics';
import type { CreateBookDto } from './dto/create-book.dto';
import type { UpdateBookDto } from './dto/update-book.dto';

@Injectable()
export class BooksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agentService: AgentService,
    @Inject(PDF_STORAGE_TOKEN) private readonly pdfStorage: PdfStorage,
  ) {}

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

  /**
   * Retries a failed book generation in place: clears the failure markers,
   * then re-runs the same pipeline used by startGeneration. AgentService
   * appends new AgentLog rows rather than deleting prior ones, so retry
   * history stays visible in generation diagnostics.
   */
  async retryGeneration(userId: string, bookId: string): Promise<GenerateBookResponse> {
    const book = await this.findOwnedOrThrow(bookId, userId);
    if (book.status !== BookStatus.failed) {
      throw new ConflictException('Only failed books can be retried');
    }

    const cleared = await this.prisma.book.update({
      where: { id: bookId },
      data: { failedStep: null, errorMessage: null, retryCount: { increment: 1 } },
    });

    const updated = await this.agentService.startBookGeneration(cleared);
    return { book: toBookDto(updated) };
  }

  async startGeneration(userId: string, bookId: string): Promise<GenerateBookResponse> {
    const book = await this.findOwnedOrThrow(bookId, userId);

    const missing: string[] = [];
    if (!book.childName) missing.push('childName');
    if (book.childAge == null) missing.push('childAge');
    if (!book.language) missing.push('language');
    if (!book.theme) missing.push('theme');
    if (missing.length > 0) {
      throw new BadRequestException(`Missing required draft fields: ${missing.join(', ')}`);
    }

    if (book.status !== BookStatus.created) {
      throw new ConflictException('Generation already started or completed for this book');
    }

    const updated = await this.agentService.startBookGeneration(book);
    return { book: toBookDto(updated) };
  }

  async getPreviewPdfBuffer(
    bookId: string,
    userId: string,
  ): Promise<{ buffer: Buffer; contentType: 'application/pdf'; filename: string }> {
    const book = await this.findOwnedOrThrow(bookId, userId);
    if (!book.previewPdfUrl) {
      throw new ConflictException('PDF not ready — book generation is not complete');
    }
    const result = await this.pdfStorage.getPreviewPdf(bookId);
    if (!result) {
      throw new NotFoundException('PDF file not found in storage');
    }
    return result;
  }

  /** Safe, non-secret generation diagnostics for a book — see generation-diagnostics.ts. */
  async getGenerationDiagnostics(
    bookId: string,
    userId: string,
  ): Promise<GenerationDiagnosticsDto> {
    const book = await this.findOwnedOrThrow(bookId, userId);
    const logs = await this.prisma.agentLog.findMany({
      where: { bookId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    return buildGenerationDiagnostics(book, logs);
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
