import { describe, it, expect, vi } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import type { BookDto, GenerateBookResponse, GenerationDiagnosticsDto } from '@book/types';
import type { User } from '@prisma/client';
import { BooksController } from './books.controller';
import type { BooksService } from './books.service';
import type { CreateBookDto } from './dto/create-book.dto';
import type { UpdateBookDto } from './dto/update-book.dto';

const FAKE_USER = { id: 'u-1' } as User;
const PDF_RESULT = {
  buffer: Buffer.from('%PDF-1.4 test content'),
  contentType: 'application/pdf' as const,
  filename: 'storyme-preview-b-1.pdf',
};

function createMockBooksService(): jest.Mocked<BooksService> {
  return {
    findAllForUser: vi.fn(),
    create: vi.fn(),
    findOneForUser: vi.fn(),
    update: vi.fn(),
    startGeneration: vi.fn(),
    remove: vi.fn(),
    getPreviewPdfBuffer: vi.fn(),
    getGenerationDiagnostics: vi.fn(),
  } as unknown as jest.Mocked<BooksService>;
}

function createMockResponse(): jest.Mocked<Response> {
  return { set: vi.fn() } as unknown as jest.Mocked<Response>;
}

const BOOK_DTO = { id: 'b-1', userId: 'u-1', status: 'created' } as unknown as BookDto;

describe('BooksController.findAll', () => {
  it('delegates to booksService.findAllForUser with the current user and pagination', async () => {
    const booksService = createMockBooksService();
    const page = { items: [BOOK_DTO], page: 1, limit: 20, total: 1 };
    booksService.findAllForUser.mockResolvedValue(page);
    const controller = new BooksController(booksService);

    const result = await controller.findAll(FAKE_USER, 1, 20);

    expect(booksService.findAllForUser).toHaveBeenCalledWith('u-1', 1, 20);
    expect(result).toBe(page);
  });
});

describe('BooksController.create', () => {
  it('delegates to booksService.create with the current user and dto', async () => {
    const booksService = createMockBooksService();
    booksService.create.mockResolvedValue(BOOK_DTO);
    const controller = new BooksController(booksService);
    const dto: CreateBookDto = {
      title: 'The Adventures of Mia',
      childName: 'Mia',
      childAge: 5,
      language: 'en' as CreateBookDto['language'],
      theme: 'friendship',
    };

    const result = await controller.create(FAKE_USER, dto);

    expect(booksService.create).toHaveBeenCalledWith('u-1', dto);
    expect(result).toBe(BOOK_DTO);
  });
});

describe('BooksController.findOne', () => {
  it('delegates to booksService.findOneForUser', async () => {
    const booksService = createMockBooksService();
    booksService.findOneForUser.mockResolvedValue(BOOK_DTO);
    const controller = new BooksController(booksService);

    const result = await controller.findOne(FAKE_USER, 'b-1');

    expect(booksService.findOneForUser).toHaveBeenCalledWith('b-1', 'u-1');
    expect(result).toBe(BOOK_DTO);
  });

  it('propagates NotFoundException for a missing book', async () => {
    const booksService = createMockBooksService();
    booksService.findOneForUser.mockRejectedValue(new NotFoundException('Book not found'));
    const controller = new BooksController(booksService);

    await expect(controller.findOne(FAKE_USER, 'missing')).rejects.toThrow(NotFoundException);
  });
});

describe('BooksController.update', () => {
  it('delegates to booksService.update with id, user, and dto', async () => {
    const booksService = createMockBooksService();
    booksService.update.mockResolvedValue(BOOK_DTO);
    const controller = new BooksController(booksService);
    const dto: UpdateBookDto = { title: 'New Title' };

    const result = await controller.update(FAKE_USER, 'b-1', dto);

    expect(booksService.update).toHaveBeenCalledWith('b-1', 'u-1', dto);
    expect(result).toBe(BOOK_DTO);
  });

  it('propagates ConflictException when the book has advanced past created', async () => {
    const booksService = createMockBooksService();
    booksService.update.mockRejectedValue(new ConflictException('Only draft books can be updated'));
    const controller = new BooksController(booksService);

    await expect(controller.update(FAKE_USER, 'b-1', { title: 'X' })).rejects.toThrow(
      ConflictException,
    );
  });
});

describe('BooksController.generate', () => {
  it('delegates to booksService.startGeneration and returns its response', async () => {
    const booksService = createMockBooksService();
    const response: GenerateBookResponse = { book: BOOK_DTO };
    booksService.startGeneration.mockResolvedValue(response);
    const controller = new BooksController(booksService);

    const result = await controller.generate(FAKE_USER, 'b-1');

    expect(booksService.startGeneration).toHaveBeenCalledWith('u-1', 'b-1');
    expect(result).toBe(response);
  });

  it('propagates BadRequestException when required draft fields are missing', async () => {
    const booksService = createMockBooksService();
    booksService.startGeneration.mockRejectedValue(
      new BadRequestException('Missing required draft fields: childName'),
    );
    const controller = new BooksController(booksService);

    await expect(controller.generate(FAKE_USER, 'b-1')).rejects.toThrow(BadRequestException);
  });

  it('propagates ConflictException when generation already started', async () => {
    const booksService = createMockBooksService();
    booksService.startGeneration.mockRejectedValue(
      new ConflictException('Generation already started or completed for this book'),
    );
    const controller = new BooksController(booksService);

    await expect(controller.generate(FAKE_USER, 'b-1')).rejects.toThrow(ConflictException);
  });
});

describe('BooksController.remove', () => {
  it('delegates to booksService.remove', async () => {
    const booksService = createMockBooksService();
    booksService.remove.mockResolvedValue(undefined);
    const controller = new BooksController(booksService);

    await controller.remove(FAKE_USER, 'b-1');

    expect(booksService.remove).toHaveBeenCalledWith('b-1', 'u-1');
  });

  it('propagates ConflictException when the book has advanced past created', async () => {
    const booksService = createMockBooksService();
    booksService.remove.mockRejectedValue(new ConflictException('Only draft books can be deleted'));
    const controller = new BooksController(booksService);

    await expect(controller.remove(FAKE_USER, 'b-1')).rejects.toThrow(ConflictException);
  });
});

describe('BooksController.getPreviewPdf', () => {
  it('sets Content-Type, Content-Disposition, and Content-Length headers from the service result', async () => {
    const booksService = createMockBooksService();
    booksService.getPreviewPdfBuffer.mockResolvedValue(PDF_RESULT);
    const controller = new BooksController(booksService);
    const res = createMockResponse();

    const result = await controller.getPreviewPdf(FAKE_USER, 'b-1', res);

    expect(res.set).toHaveBeenCalledWith({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${PDF_RESULT.filename}"`,
      'Content-Length': String(PDF_RESULT.buffer.length),
    });
    expect(result.getStream().read()).toEqual(PDF_RESULT.buffer);
  });

  it('propagates NotFoundException from the service without swallowing it', async () => {
    const booksService = createMockBooksService();
    booksService.getPreviewPdfBuffer.mockRejectedValue(new NotFoundException('Book not found'));
    const controller = new BooksController(booksService);
    const res = createMockResponse();

    await expect(controller.getPreviewPdf(FAKE_USER, 'missing', res)).rejects.toThrow(
      NotFoundException,
    );
    expect(res.set).not.toHaveBeenCalled();
  });

  it('propagates ConflictException from the service when the PDF is not ready', async () => {
    const booksService = createMockBooksService();
    booksService.getPreviewPdfBuffer.mockRejectedValue(
      new ConflictException('PDF not ready — book generation is not complete'),
    );
    const controller = new BooksController(booksService);
    const res = createMockResponse();

    await expect(controller.getPreviewPdf(FAKE_USER, 'b-1', res)).rejects.toThrow(
      ConflictException,
    );
    expect(res.set).not.toHaveBeenCalled();
  });
});

describe('BooksController.getGenerationDiagnostics', () => {
  it('delegates to booksService.getGenerationDiagnostics with the current user', async () => {
    const booksService = createMockBooksService();
    const diagnostics = { bookId: 'b-1', status: 'complete' } as unknown as GenerationDiagnosticsDto;
    booksService.getGenerationDiagnostics.mockResolvedValue(diagnostics);
    const controller = new BooksController(booksService);

    const result = await controller.getGenerationDiagnostics(FAKE_USER, 'b-1');

    expect(booksService.getGenerationDiagnostics).toHaveBeenCalledWith('b-1', 'u-1');
    expect(result).toBe(diagnostics);
  });

  it('propagates NotFoundException for a missing book', async () => {
    const booksService = createMockBooksService();
    booksService.getGenerationDiagnostics.mockRejectedValue(new NotFoundException('Book not found'));
    const controller = new BooksController(booksService);

    await expect(controller.getGenerationDiagnostics(FAKE_USER, 'missing')).rejects.toThrow(
      NotFoundException,
    );
  });
});
