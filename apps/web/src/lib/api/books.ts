import type {
  BookDto,
  BooksPageDto,
  CreateBookInput,
  GenerateBookResponse,
  GenerationDiagnosticsDto,
  UpdateBookInput,
} from '@book/types';
import { apiFetch, apiFetchBlob, apiFetchForm } from './client';
import { getApiBase } from './config';

const API_BASE = getApiBase();

/** Returns the stable API endpoint URL for a book's preview PDF. */
export function bookPdfPreviewUrl(bookId: string): string {
  return `${API_BASE}/books/${bookId}/pdf/preview`;
}

export const booksApi = {
  list: (page = 1, limit = 20): Promise<BooksPageDto> =>
    apiFetch(`/books?page=${page}&limit=${limit}`),

  get: (id: string): Promise<BookDto> => apiFetch(`/books/${id}`),

  create: (data: CreateBookInput): Promise<BookDto> =>
    apiFetch('/books', { method: 'POST', body: JSON.stringify(data) }),

  /** Uploads an optional child reference photo for a still-editable (pre-generation) book. */
  uploadChildPhoto: (id: string, file: File): Promise<BookDto> => {
    const formData = new FormData();
    formData.append('photo', file);
    return apiFetchForm(`/books/${id}/child-photo`, formData);
  },

  update: (id: string, data: UpdateBookInput): Promise<BookDto> =>
    apiFetch(`/books/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  generate: (id: string): Promise<GenerateBookResponse> =>
    apiFetch(`/books/${id}/generate`, { method: 'POST' }),

  /** Resumes a failed book using the exact input the failed run used. For a complete book, or to pick up edits made since a failure, use regenerateBook instead. */
  retryGeneration: (id: string): Promise<GenerateBookResponse> =>
    apiFetch(`/books/${id}/retry-generation`, { method: 'POST' }),

  /** Replaces a failed or complete book's story/images/PDF with a fresh run built from the book's current fields. */
  regenerateBook: (id: string): Promise<GenerateBookResponse> =>
    apiFetch(`/books/${id}/regenerate`, { method: 'POST' }),

  remove: (id: string): Promise<void> => apiFetch(`/books/${id}`, { method: 'DELETE' }),

  getGenerationDiagnostics: (id: string): Promise<GenerationDiagnosticsDto> =>
    apiFetch(`/books/${id}/generation-diagnostics`),

  downloadPdf: (id: string): Promise<Blob> => apiFetchBlob(`/books/${id}/pdf/preview`),
};
