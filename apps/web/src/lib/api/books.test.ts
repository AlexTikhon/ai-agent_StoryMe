import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { booksApi } from './books';
import { setAccessToken } from '../auth/token-store';
import { SupportedLanguage, BookStatus } from '@book/types';
import type {
  BookDto,
  BooksPageDto,
  CancelGenerationResponse,
  GenerateBookResponse,
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
    it('sends DELETE /books/:id and returns undefined on 204', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 204 } as Response);

      const result = await booksApi.remove('book-1');

      expect(fetch).toHaveBeenCalledOnce();
      const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:4000/api/books/book-1');
      expect(init.method).toBe('DELETE');
      expect(result).toBeUndefined();
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
