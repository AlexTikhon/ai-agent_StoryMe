import { describe, it, expect, vi } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import type { Response } from 'express';
import type {
  BookDto,
  CancelGenerationResponse,
  GenerateBookResponse,
  GenerationDiagnosticsDto,
  GenerationProgressDto,
} from '@book/types';
import type { User } from '@prisma/client';
import { BooksController } from './books.controller';
import type { BooksService } from './books.service';
import type { CreateBookDto } from './dto/create-book.dto';
import type { UpdateBookDto } from './dto/update-book.dto';
import type { UpdateBookPageTextDto } from './dto/update-book-page-text.dto';

const FAKE_USER = { id: 'u-1' } as User;
const PDF_RESULT = {
  buffer: Buffer.from('%PDF-1.4 test content'),
  contentType: 'application/pdf' as const,
  filename: 'storyme-preview-b-1.pdf',
};
const IMAGE_RESULT = {
  buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  contentType: 'image/png' as const,
  filename: 'cover.png',
};

function createMockBooksService(): jest.Mocked<BooksService> {
  return {
    findAllForUser: vi.fn(),
    create: vi.fn(),
    findOneForUser: vi.fn(),
    update: vi.fn(),
    updatePageText: vi.fn(),
    createPageImageQuote: vi.fn(),
    confirmPageImageRevision: vi.fn(),
    getPageImageRevision: vi.fn(),
    startGeneration: vi.fn(),
    retryGeneration: vi.fn(),
    cancelGeneration: vi.fn(),
    remove: vi.fn(),
    getPreviewPdfBuffer: vi.fn(),
    getPublishedImage: vi.fn(),
    getGenerationDiagnostics: vi.fn(),
    getGenerationProgress: vi.fn(),
    uploadChildPhoto: vi.fn(),
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

  it('propagates ConflictException when the book is actively generating', async () => {
    const booksService = createMockBooksService();
    booksService.update.mockRejectedValue(
      new ConflictException('Book cannot be edited while generation is in progress'),
    );
    const controller = new BooksController(booksService);

    await expect(controller.update(FAKE_USER, 'b-1', { title: 'X' })).rejects.toThrow(
      ConflictException,
    );
  });
});

describe('BooksController.updatePageText', () => {
  it('delegates the authenticated owner, page number, and optimistic version', async () => {
    const booksService = createMockBooksService();
    booksService.updatePageText.mockResolvedValue(BOOK_DTO);
    const controller = new BooksController(booksService);
    const dto: UpdateBookPageTextDto = { text: 'Corrected text', expectedVersion: 2 };

    const result = await controller.updatePageText(FAKE_USER, 'b-1', 3, dto);

    expect(booksService.updatePageText).toHaveBeenCalledWith('u-1', 'b-1', 3, dto);
    expect(result).toBe(BOOK_DTO);
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

describe('BooksController.retryGeneration', () => {
  it('delegates to booksService.retryGeneration and returns its response', async () => {
    const booksService = createMockBooksService();
    const response: GenerateBookResponse = {
      book: { ...BOOK_DTO, status: 'story_plan' } as BookDto,
    };
    booksService.retryGeneration.mockResolvedValue(response);
    const controller = new BooksController(booksService);

    const result = await controller.retryGeneration(FAKE_USER, 'b-1');

    expect(booksService.retryGeneration).toHaveBeenCalledWith('u-1', 'b-1');
    expect(result).toBe(response);
  });

  it('propagates ConflictException when the book cannot be regenerated', async () => {
    const booksService = createMockBooksService();
    booksService.retryGeneration.mockRejectedValue(
      new ConflictException('Only failed or complete books can be regenerated'),
    );
    const controller = new BooksController(booksService);

    await expect(controller.retryGeneration(FAKE_USER, 'b-1')).rejects.toThrow(ConflictException);
  });

  it('propagates NotFoundException for a missing or unauthorized book', async () => {
    const booksService = createMockBooksService();
    booksService.retryGeneration.mockRejectedValue(new NotFoundException('Book not found'));
    const controller = new BooksController(booksService);

    await expect(controller.retryGeneration(FAKE_USER, 'missing')).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('BooksController.cancel', () => {
  it('delegates to booksService.cancelGeneration with the current user and book id, and returns its response', async () => {
    const booksService = createMockBooksService();
    const response: CancelGenerationResponse = {
      book: { ...BOOK_DTO, status: 'cancelled' } as BookDto,
      creditsRefunded: 1,
    };
    booksService.cancelGeneration.mockResolvedValue(response);
    const controller = new BooksController(booksService);

    const result = await controller.cancel(FAKE_USER, 'b-1');

    expect(booksService.cancelGeneration).toHaveBeenCalledWith('u-1', 'b-1');
    expect(result).toBe(response);
  });

  it('propagates NotFoundException for a missing or unowned book', async () => {
    const booksService = createMockBooksService();
    booksService.cancelGeneration.mockRejectedValue(new NotFoundException('Book not found'));
    const controller = new BooksController(booksService);

    await expect(controller.cancel(FAKE_USER, 'missing')).rejects.toThrow(NotFoundException);
  });

  it('propagates a 409 BOOK_ALREADY_CANCELLED conflict without swallowing it', async () => {
    const booksService = createMockBooksService();
    const conflict = new HttpException(
      { error: 'Book generation already cancelled', code: 'BOOK_ALREADY_CANCELLED' },
      HttpStatus.CONFLICT,
    );
    booksService.cancelGeneration.mockRejectedValue(conflict);
    const controller = new BooksController(booksService);

    await expect(controller.cancel(FAKE_USER, 'b-1')).rejects.toThrow(conflict);
  });

  it('propagates a 409 BOOK_NOT_IN_PROGRESS conflict without swallowing it', async () => {
    const booksService = createMockBooksService();
    const conflict = new HttpException(
      { error: 'Book is not currently generating', code: 'BOOK_NOT_IN_PROGRESS' },
      HttpStatus.CONFLICT,
    );
    booksService.cancelGeneration.mockRejectedValue(conflict);
    const controller = new BooksController(booksService);

    await expect(controller.cancel(FAKE_USER, 'b-1')).rejects.toThrow(conflict);
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

  it('propagates ConflictException when the book is actively generating', async () => {
    const booksService = createMockBooksService();
    booksService.remove.mockRejectedValue(
      new ConflictException('Book cannot be deleted while generation is in progress'),
    );
    const controller = new BooksController(booksService);

    await expect(controller.remove(FAKE_USER, 'b-1')).rejects.toThrow(ConflictException);
  });
});

describe('BooksController.uploadChildPhoto', () => {
  function makeFile(): Express.Multer.File {
    return {
      fieldname: 'photo',
      originalname: 'child.jpg',
      encoding: '7bit',
      mimetype: 'image/jpeg',
      size: 1024,
      buffer: Buffer.from('fake-jpeg-bytes'),
      stream: undefined as never,
      destination: '',
      filename: '',
      path: '',
    };
  }

  it('delegates to booksService.uploadChildPhoto with the current user, book id, and file', async () => {
    const booksService = createMockBooksService();
    booksService.uploadChildPhoto.mockResolvedValue(BOOK_DTO);
    const controller = new BooksController(booksService);
    const file = makeFile();

    const result = await controller.uploadChildPhoto(FAKE_USER, 'b-1', file);

    expect(booksService.uploadChildPhoto).toHaveBeenCalledWith('u-1', 'b-1', file);
    expect(result).toBe(BOOK_DTO);
  });

  it('passes through undefined when multer rejected the upload (no file on the request)', async () => {
    const booksService = createMockBooksService();
    booksService.uploadChildPhoto.mockRejectedValue(
      new BadRequestException('No photo file provided'),
    );
    const controller = new BooksController(booksService);

    await expect(controller.uploadChildPhoto(FAKE_USER, 'b-1', undefined)).rejects.toThrow(
      BadRequestException,
    );
    expect(booksService.uploadChildPhoto).toHaveBeenCalledWith('u-1', 'b-1', undefined);
  });

  it('propagates ConflictException when generation is already in progress', async () => {
    const booksService = createMockBooksService();
    booksService.uploadChildPhoto.mockRejectedValue(
      new ConflictException('Child photo cannot be uploaded while generation is in progress'),
    );
    const controller = new BooksController(booksService);

    await expect(controller.uploadChildPhoto(FAKE_USER, 'b-1', makeFile())).rejects.toThrow(
      ConflictException,
    );
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

describe('BooksController.getPublishedImage', () => {
  it('delegates with ownership context and sets private, sniff-safe image headers', async () => {
    const booksService = createMockBooksService();
    booksService.getPublishedImage.mockResolvedValue(IMAGE_RESULT);
    const controller = new BooksController(booksService);
    const res = createMockResponse();

    const result = await controller.getPublishedImage(FAKE_USER, 'b-1', 'cover', res);

    expect(booksService.getPublishedImage).toHaveBeenCalledWith('b-1', 'u-1', 'cover');
    expect(res.set).toHaveBeenCalledWith({
      'Content-Type': 'image/png',
      'Content-Disposition': 'inline; filename="cover.png"',
      'Content-Length': String(IMAGE_RESULT.buffer.length),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    expect(result.getStream().read()).toEqual(IMAGE_RESULT.buffer);
  });

  it('adds a sandbox content-security policy when serving SVG', async () => {
    const booksService = createMockBooksService();
    booksService.getPublishedImage.mockResolvedValue({
      buffer: Buffer.from('<svg></svg>'),
      contentType: 'image/svg+xml',
      filename: 'cover.svg',
    });
    const controller = new BooksController(booksService);
    const res = createMockResponse();

    await controller.getPublishedImage(FAKE_USER, 'b-1', 'cover', res);

    expect(res.set).toHaveBeenCalledWith(
      expect.objectContaining({
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      }),
    );
  });

  it('does not set response headers when ownership fails', async () => {
    const booksService = createMockBooksService();
    booksService.getPublishedImage.mockRejectedValue(new NotFoundException('Book not found'));
    const controller = new BooksController(booksService);
    const res = createMockResponse();

    await expect(controller.getPublishedImage(FAKE_USER, 'b-1', 'cover', res)).rejects.toThrow(
      NotFoundException,
    );
    expect(res.set).not.toHaveBeenCalled();
  });
});

describe('BooksController.getGenerationDiagnostics', () => {
  it('delegates to booksService.getGenerationDiagnostics with the current user', async () => {
    const booksService = createMockBooksService();
    const diagnostics = {
      bookId: 'b-1',
      status: 'complete',
    } as unknown as GenerationDiagnosticsDto;
    booksService.getGenerationDiagnostics.mockResolvedValue(diagnostics);
    const controller = new BooksController(booksService);

    const result = await controller.getGenerationDiagnostics(FAKE_USER, 'b-1');

    expect(booksService.getGenerationDiagnostics).toHaveBeenCalledWith('b-1', 'u-1');
    expect(result).toBe(diagnostics);
  });

  it('propagates NotFoundException for a missing book', async () => {
    const booksService = createMockBooksService();
    booksService.getGenerationDiagnostics.mockRejectedValue(
      new NotFoundException('Book not found'),
    );
    const controller = new BooksController(booksService);

    await expect(controller.getGenerationDiagnostics(FAKE_USER, 'missing')).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('BooksController.getGenerationProgress', () => {
  it('delegates to the owned user-facing progress read', async () => {
    const booksService = createMockBooksService();
    const progress: GenerationProgressDto = {
      status: 'running',
      step: 'image_gen' as GenerationProgressDto['step'],
    };
    booksService.getGenerationProgress.mockResolvedValue(progress);
    const controller = new BooksController(booksService);

    const result = await controller.getGenerationProgress(FAKE_USER, 'b-1');

    expect(booksService.getGenerationProgress).toHaveBeenCalledWith('b-1', 'u-1');
    expect(result).toBe(progress);
  });
});

describe('BooksController page image revisions', () => {
  it('delegates quote, explicit confirmation, and owned status reads', async () => {
    const booksService = createMockBooksService();
    const quote = {
      id: 'revision-1',
      bookId: 'b-1',
      pageNumber: 2,
      expectedVersion: 3,
      costCredits: 1,
      provider: 'openai',
      expiresAt: '2026-07-26T12:10:00.000Z',
      confirmationRequired: true as const,
    };
    const revision = {
      id: 'revision-1',
      bookId: 'b-1',
      pageNumber: 2,
      status: 'queued' as const,
      costCredits: 1,
      provider: 'openai',
    };
    booksService.createPageImageQuote.mockResolvedValue(quote);
    booksService.confirmPageImageRevision.mockResolvedValue(revision);
    booksService.getPageImageRevision.mockResolvedValue(revision);
    const controller = new BooksController(booksService);

    await expect(
      controller.createPageImageQuote(FAKE_USER, 'b-1', 2, { expectedVersion: 3 }),
    ).resolves.toBe(quote);
    await expect(
      controller.confirmPageImageRevision(FAKE_USER, 'b-1', 2, 'revision-1'),
    ).resolves.toBe(revision);
    await expect(controller.getPageImageRevision(FAKE_USER, 'b-1', 'revision-1')).resolves.toBe(
      revision,
    );

    expect(booksService.createPageImageQuote).toHaveBeenCalledWith('u-1', 'b-1', 2, {
      expectedVersion: 3,
    });
    expect(booksService.confirmPageImageRevision).toHaveBeenCalledWith(
      'u-1',
      'b-1',
      2,
      'revision-1',
    );
    expect(booksService.getPageImageRevision).toHaveBeenCalledWith('u-1', 'b-1', 'revision-1');
  });
});
