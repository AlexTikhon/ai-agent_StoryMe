import type { BookDto, BooksPageDto, CreateBookInput, UpdateBookInput } from '@book/types';
import { apiFetch } from './client';

export const booksApi = {
  list: (page = 1, limit = 20): Promise<BooksPageDto> =>
    apiFetch(`/books?page=${page}&limit=${limit}`),

  get: (id: string): Promise<BookDto> =>
    apiFetch(`/books/${id}`),

  create: (data: CreateBookInput): Promise<BookDto> =>
    apiFetch('/books', { method: 'POST', body: JSON.stringify(data) }),

  update: (id: string, data: UpdateBookInput): Promise<BookDto> =>
    apiFetch(`/books/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  remove: (id: string): Promise<void> =>
    apiFetch(`/books/${id}`, { method: 'DELETE' }),
};
