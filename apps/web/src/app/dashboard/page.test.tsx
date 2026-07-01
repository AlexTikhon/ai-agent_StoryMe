import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DashboardPage from './page';
import { SupportedLanguage, BookStatus } from '@book/types';
import type { BookDto, BooksPageDto } from '@book/types';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('next/link', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: ({ href, children, className }: any) => (
    <a href={href} className={className}>{children}</a>
  ),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const MOCK_BOOK: BookDto = {
  id: 'book-1',
  userId: 'user-1',
  title: "Emma's Story",
  childName: 'Emma',
  childAge: 5,
  language: SupportedLanguage.English,
  theme: 'Friendship',
  status: BookStatus.Created,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

const MOCK_BOOK_2: BookDto = {
  ...MOCK_BOOK,
  id: 'book-2',
  title: "Oliver's Story",
  childName: 'Oliver',
};

function mockPage(items: BookDto[], total?: number): BooksPageDto {
  return { items, page: 1, limit: 20, total: total ?? items.length };
}

function mockOk(body: unknown, status = 200): Response {
  return { ok: true, status, json: async () => body } as unknown as Response;
}

function mockError(status: number, message: string): Response {
  return { ok: false, status, json: async () => ({ message }) } as unknown as Response;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DashboardPage', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── Loading / empty / list states ──────────────────────────────────────────

  it('renders a loading skeleton while books are being fetched', () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(mockPage([])));
    render(<DashboardPage />);
    expect(screen.getByRole('list', { name: /loading book drafts/i })).toBeDefined();
  });

  it('renders empty state after API returns an empty list', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(mockPage([])));
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByText(/no book drafts yet/i)).toBeDefined();
    });
  });

  it('renders all books from the API', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(mockPage([MOCK_BOOK, MOCK_BOOK_2])));
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByText("Emma's Story")).toBeDefined();
      expect(screen.getByText("Oliver's Story")).toBeDefined();
    });
  });

  it('renders an error banner when the API fails', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockError(500, 'Server down'));
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeDefined();
      expect(screen.getByRole('alert').textContent).toContain('Server down');
    });
  });

  // ── Navigation links ───────────────────────────────────────────────────────

  it('New Book header button links to the wizard', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(mockPage([])));
    render(<DashboardPage />);
    const link = screen.getByRole('link', { name: /new book/i });
    expect(link.getAttribute('href')).toBe('/dashboard/books/new');
  });

  it('book card title links to the book detail page', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(mockPage([MOCK_BOOK])));
    render(<DashboardPage />);
    await waitFor(() => {
      const link = screen.getByRole('link', { name: "Emma's Story" });
      expect(link.getAttribute('href')).toBe('/dashboard/books/book-1');
    });
  });

  it('book card Edit button links to the book detail page', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(mockPage([MOCK_BOOK])));
    render(<DashboardPage />);
    await waitFor(() => {
      const links = screen.getAllByRole('link', { name: /^edit$/i });
      expect(links[0]?.getAttribute('href')).toBe('/dashboard/books/book-1');
    });
  });

  it('Create First Book link in empty state links to the wizard', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(mockPage([])));
    render(<DashboardPage />);
    await waitFor(() => {
      const link = screen.getByRole('link', { name: /create first book/i });
      expect(link.getAttribute('href')).toBe('/dashboard/books/new');
    });
  });

  // ── Retry ──────────────────────────────────────────────────────────────────

  it('retries loading books when Retry is clicked after an error', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockError(500, 'Server down'))
      .mockResolvedValueOnce(mockOk(mockPage([MOCK_BOOK])));

    const user = userEvent.setup();
    render(<DashboardPage />);

    await waitFor(() => screen.getByRole('alert'));
    await user.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => {
      expect(screen.getByText("Emma's Story")).toBeDefined();
    });
  });

  // ── Delete ─────────────────────────────────────────────────────────────────

  it('removes a book card after successful delete', async () => {
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockOk(mockPage([MOCK_BOOK, MOCK_BOOK_2])))
      .mockResolvedValueOnce({ ok: true, status: 204 } as Response);

    const user = userEvent.setup();
    render(<DashboardPage />);

    await waitFor(() => screen.getByText("Emma's Story"));

    const deleteButtons = screen.getAllByRole('button', { name: /^delete$/i });
    await user.click(deleteButtons[0]!);

    await waitFor(() => {
      expect(screen.queryByText("Emma's Story")).toBeNull();
      expect(screen.getByText("Oliver's Story")).toBeDefined();
    });
  });
});
