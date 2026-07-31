import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { booksApi } from './books';
import { setAccessToken } from '../auth/token-store';
import { SupportedLanguage, BookStatus } from '@book/types';
import type {
  BookDto,
  BooksPageDto,
  CancelGenerationResponse,
  GenerateBookResponse,
  GenerationProgressDto,
} from '@book/types';

const MOCK_BOOK: BookDto = {
  id: 'book-1',
  userId: 'user-1',
  title: "Emma's Story",
  childName: 'Emma',
  childAge: 5,
  language: SupportedLanguage.English,
  theme: 'Friendship',
  educationalMessage: null,
  pageCount: 6,
  status: BookStatus.Created,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

function mockOk(body: unknown, status = 200): Response {
  return {
    ok: true,
    status,
    json: async () => body,
  } as unknown as Response;
}

function mockError(status: number, message: string | string[]): Response {
  return {
    ok: false,
    status,
    json: async () => ({ message }),
  } as unknown as Response;
}

describe('booksApi', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    setAccessToken(null);
    delete process.env['NEXT_PUBLIC_AUTH_MODE'];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setAccessToken(null);
    delete process.env['NEXT_PUBLIC_AUTH_MODE'];
  });

  describe('list()', () => {
    it('sends GET /books with pagination params and a Bearer token in jwt mode', async () => {
      setAccessToken('access-token-123');
      const page: BooksPageDto = { items: [MOCK_BOOK], page: 1, limit: 20, total: 1 };
      vi.mocked(fetch).mockResolvedValueOnce(mockOk(page));

      const result = await booksApi.list();

      expect(fetch).toHaveBeenCalledOnce();
      const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:4000/api/books?page=1&limit=20');
      expect((init.headers as Record<string, string>)['Authorization']).toBe(
        'Bearer access-token-123',
      );
      expect((init.headers as Record<string, string>)['x-user-email']).toBeUndefined();
      expect(result).toEqual(page);
    });

    it('sends dev auth headers instead of a Bearer token when AUTH_MODE=dev', async () => {
      process.env['NEXT_PUBLIC_AUTH_MODE'] = 'dev';
      const page: BooksPageDto = { items: [MOCK_BOOK], page: 1, limit: 20, total: 1 };
      vi.mocked(fetch).mockResolvedValueOnce(mockOk(page));

      await booksApi.list();

      const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)['x-user-email']).toBe('dev@storyme.local');
      expect((init.headers as Record<string, string>)['x-user-name']).toBe('Dev User');
      expect((init.headers as Record<string, string>)['Authorization']).toBeUndefined();
    });

    it('forwards custom page and limit params', async () => {
      const page: BooksPageDto = { items: [], page: 2, limit: 5, total: 0 };
      vi.mocked(fetch).mockResolvedValueOnce(mockOk(page));

      await booksApi.list(2, 5);

      const [url] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:4000/api/books?page=2&limit=5');
    });
  });

  describe('create()', () => {
    it('sends POST /books with the request body', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(mockOk(MOCK_BOOK, 201));

      const input = {
        title: "Emma's Story",
        childName: 'Emma',
        childAge: 5,
        language: SupportedLanguage.English,
        theme: 'Friendship',
      };
      const result = await booksApi.create(input);

      expect(fetch).toHaveBeenCalledOnce();
      const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:4000/api/books');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual(input);
      expect(result).toEqual(MOCK_BOOK);
    });
  });

  describe('uploadChildPhoto()', () => {
    it('sends POST /books/:id/child-photo with FormData and no Content-Type header', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(mockOk(MOCK_BOOK));
      const file = new File(['fake-bytes'], 'child.jpg', { type: 'image/jpeg' });

      const result = await booksApi.uploadChildPhoto('book-1', file);

      expect(fetch).toHaveBeenCalledOnce();
      const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:4000/api/books/book-1/child-photo');
      expect(init.method).toBe('POST');
      expect(init.body).toBeInstanceOf(FormData);
      expect((init.body as FormData).get('photo')).toBe(file);
      expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
      expect(result).toEqual(MOCK_BOOK);
    });

    it('propagates a validation error from the API', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(mockError(400, 'No photo file provided'));
      const file = new File(['fake-bytes'], 'child.jpg', { type: 'image/jpeg' });

      await expect(booksApi.uploadChildPhoto('book-1', file)).rejects.toThrow(
        'No photo file provided',
      );
    });
  });

  describe('update()', () => {
    it('sends PATCH /books/:id with partial body', async () => {
      const updated = { ...MOCK_BOOK, theme: 'Adventure' };
      vi.mocked(fetch).mockResolvedValueOnce(mockOk(updated));

      const result = await booksApi.update('book-1', { theme: 'Adventure' });

      expect(fetch).toHaveBeenCalledOnce();
      const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:4000/api/books/book-1');
      expect(init.method).toBe('PATCH');
      expect(JSON.parse(init.body as string)).toEqual({ theme: 'Adventure' });
      expect(result).toEqual(updated);
    });
  });

  describe('updatePageText()', () => {
    it('sends a versioned PATCH to the one-page text endpoint', async () => {
      const updated = { ...MOCK_BOOK, status: BookStatus.Complete };
      vi.mocked(fetch).mockResolvedValueOnce(mockOk(updated));

      const result = await booksApi.updatePageText('book-1', 3, {
        text: 'A corrected page.',
        expectedVersion: 2,
      });

      const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:4000/api/books/book-1/pages/3/text');
      expect(init.method).toBe('PATCH');
      expect(JSON.parse(init.body as string)).toEqual({
        text: 'A corrected page.',
        expectedVersion: 2,
      });
      expect(result).toEqual(updated);
    });
  });

  describe('generate()', () => {
    it('sends POST /books/:id/generate and returns GenerateBookResponse', async () => {
      const generated: GenerateBookResponse = {
        book: { ...MOCK_BOOK, status: BookStatus.CharBuild },
      };
      vi.mocked(fetch).mockResolvedValueOnce(mockOk(generated));

      const result = await booksApi.generate('book-1');

      expect(fetch).toHaveBeenCalledOnce();
      const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:4000/api/books/book-1/generate');
      expect(init.method).toBe('POST');
      expect(result).toEqual(generated);
    });
  });

  describe('retryGeneration()', () => {
    it('sends POST /books/:id/retry-generation and returns GenerateBookResponse', async () => {
      const retried: GenerateBookResponse = {
        book: { ...MOCK_BOOK, status: BookStatus.CharBuild },
      };
      vi.mocked(fetch).mockResolvedValueOnce(mockOk(retried));

      const result = await booksApi.retryGeneration('book-1');

      expect(fetch).toHaveBeenCalledOnce();
      const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:4000/api/books/book-1/retry-generation');
      expect(init.method).toBe('POST');
      expect(result).toEqual(retried);
    });
  });

  describe('regenerateBook()', () => {
    it('sends POST /books/:id/regenerate (a distinct endpoint from retry-generation) and returns GenerateBookResponse', async () => {
      const regenerated: GenerateBookResponse = {
        book: { ...MOCK_BOOK, status: BookStatus.CharBuild },
      };
      vi.mocked(fetch).mockResolvedValueOnce(mockOk(regenerated));

      const result = await booksApi.regenerateBook('book-1');

      expect(fetch).toHaveBeenCalledOnce();
      const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:4000/api/books/book-1/regenerate');
      expect(init.method).toBe('POST');
      expect(result).toEqual(regenerated);
    });
  });

  describe('cancelGeneration()', () => {
    it('sends POST /books/:id/cancel and returns CancelGenerationResponse', async () => {
      const cancelled: CancelGenerationResponse = {
        book: { ...MOCK_BOOK, status: BookStatus.Cancelled },
        creditsRefunded: 1,
      };
      vi.mocked(fetch).mockResolvedValueOnce(mockOk(cancelled));

      const result = await booksApi.cancelGeneration('book-1');

      expect(fetch).toHaveBeenCalledOnce();
      const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:4000/api/books/book-1/cancel');
      expect(init.method).toBe('POST');
      expect(result).toEqual(cancelled);
    });

    it('propagates the stable BOOK_ALREADY_CANCELLED error code', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(mockError(409, 'Book generation already cancelled'));

      await expect(booksApi.cancelGeneration('book-1')).rejects.toThrow(
        'Book generation already cancelled',
      );
    });
  });

  describe('remove()', () => {
    it('requests permanent deletion with the exact book-id confirmation', async () => {
      const deletion = {
        id: '11111111-1111-4111-8111-111111111111',
        bookId: 'book-1',
        status: 'requested',
        attemptCount: 0,
        deletedArtifactCount: 0,
        remainingArtifactCount: 0,
        lastErrorCode: null,
        requestedAt: '2026-07-31T00:00:00.000Z',
        completedAt: null,
      };
      vi.mocked(fetch).mockResolvedValueOnce(mockOk(deletion));

      const result = await booksApi.remove('book-1');

      expect(fetch).toHaveBeenCalledOnce();
      const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:4000/api/books/book-1/hard-delete');
      expect(init).toMatchObject({
        method: 'POST',
        body: JSON.stringify({ confirmation: 'book-1' }),
      });
      expect(result).toEqual(deletion);
    });
  });

  describe('downloadPublishedImage()', () => {
    it('fetches an ownership-checked published image as a blob', async () => {
      const image = new Blob(['image-bytes'], { type: 'image/png' });
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        blob: async () => image,
      } as Response);

      const result = await booksApi.downloadPublishedImage('book-1', 'page-2');

      expect(fetch).toHaveBeenCalledOnce();
      const [url] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:4000/api/books/book-1/images/page-2');
      expect(result).toBe(image);
    });
  });

  describe('page image regeneration', () => {
    it('requests a server-owned quote with the expected page version', async () => {
      const quote = {
        id: 'revision-1',
        bookId: 'book-1',
        pageNumber: 2,
        expectedVersion: 3,
        costCredits: 1,
        provider: 'openai',
        expiresAt: '2026-07-26T12:10:00.000Z',
        confirmationRequired: true as const,
      };
      vi.mocked(fetch).mockResolvedValueOnce(mockOk(quote));

      await expect(
        booksApi.createPageImageQuote('book-1', 2, { expectedVersion: 3 }),
      ).resolves.toEqual(quote);
      const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:4000/api/books/book-1/pages/2/image-regeneration-quote');
      expect(init).toMatchObject({
        method: 'POST',
        body: JSON.stringify({ expectedVersion: 3 }),
      });
    });

    it('confirms the exact quote and reads its durable status', async () => {
      const queued = {
        id: 'revision-1',
        bookId: 'book-1',
        pageNumber: 2,
        status: 'queued' as const,
        costCredits: 1,
        provider: 'openai',
      };
      vi.mocked(fetch).mockResolvedValueOnce(mockOk(queued)).mockResolvedValueOnce(mockOk(queued));

      await booksApi.confirmPageImageRevision('book-1', 2, 'revision-1');
      await booksApi.getPageImageRevision('book-1', 'revision-1');

      expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
        'http://localhost:4000/api/books/book-1/pages/2/image-revisions/revision-1/confirm',
      );
      expect(vi.mocked(fetch).mock.calls[1]?.[0]).toBe(
        'http://localhost:4000/api/books/book-1/page-image-revisions/revision-1',
      );
    });
  });

  describe('getGenerationProgress()', () => {
    it('fetches the minimal owned progress contract', async () => {
      const progress: GenerationProgressDto = {
        status: 'running',
        step: 'image_gen' as GenerationProgressDto['step'],
      };
      vi.mocked(fetch).mockResolvedValueOnce(mockOk(progress));

      const result = await booksApi.getGenerationProgress('book-1');

      expect(fetch).toHaveBeenCalledOnce();
      const [url] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:4000/api/books/book-1/generation-progress');
      expect(result).toEqual(progress);
    });
  });

  describe('error handling', () => {
    it('throws with the string message from the error body', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(mockError(404, 'Book not found'));

      await expect(booksApi.list()).rejects.toThrow('Book not found');
    });

    it('joins array messages from validation errors', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        mockError(400, ['childAge must not be less than 1', 'theme must be a string']),
      );

      await expect(
        booksApi.create({
          title: 'x',
          childName: 'x',
          childAge: 0,
          language: SupportedLanguage.English,
          theme: '',
        }),
      ).rejects.toThrow('childAge must not be less than 1, theme must be a string');
    });

    it('falls back to HTTP status when body has no message', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => {
          throw new Error('not json');
        },
      } as unknown as Response);

      await expect(booksApi.list()).rejects.toThrow('HTTP 500');
    });
  });
});
