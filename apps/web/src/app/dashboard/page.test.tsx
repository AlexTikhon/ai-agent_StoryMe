import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DashboardPage from './page';
import { SupportedLanguage, BookStatus } from '@book/types';
import type {
  BookDeletionRequestDto,
  BookDeletionStatus,
  BookDto,
  BooksPageDto,
} from '@book/types';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('next/link', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: ({ href, children, className }: any) => (
    <a href={href} className={className}>
      {children}
    </a>
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
  educationalMessage: null,
  pageCount: 6,
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

function mockImageBlob(content = 'cover-bytes'): Response {
  return {
    ok: true,
    status: 200,
    blob: async () => new Blob([content], { type: 'image/png' }),
  } as unknown as Response;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

// The unfinished-deletion listing is requested on every mount; it is routed
// separately so the ordered per-test mocks below only describe book/cover
// traffic. Deletion lifecycle tests drive it through `pendingDeletions`.
const apiMock = vi.fn();
let pendingDeletions: BookDeletionRequestDto[] = [];

function routedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (String(input).endsWith('/books/deletion-requests') && !init?.method) {
    return Promise.resolve(mockOk(pendingDeletions));
  }
  return apiMock(input, init) as Promise<Response>;
}

function deletionRequest(
  status: BookDeletionStatus,
  overrides: Partial<BookDeletionRequestDto> = {},
): BookDeletionRequestDto {
  return {
    id: 'req-1',
    bookId: 'book-1',
    status,
    attemptCount: 0,
    deletedArtifactCount: 0,
    remainingArtifactCount: 0,
    lastErrorCode: null,
    requestedAt: '2026-07-31T00:00:00.000Z',
    completedAt: null,
    ...overrides,
  };
}

describe('DashboardPage', () => {
  beforeEach(() => {
    apiMock.mockReset();
    pendingDeletions = [];
    vi.stubGlobal('fetch', vi.fn(routedFetch));
    global.URL.createObjectURL = vi.fn(() => 'blob:published-cover');
    global.URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // ── Loading / empty / list states ──────────────────────────────────────────

  it('renders a loading skeleton while books are being fetched', () => {
    vi.mocked(apiMock).mockResolvedValueOnce(mockOk(mockPage([])));
    render(<DashboardPage />);
    expect(screen.getByRole('list', { name: /loading book drafts/i })).toBeDefined();
  });

  it('renders empty state after API returns an empty list', async () => {
    vi.mocked(apiMock).mockResolvedValueOnce(mockOk(mockPage([])));
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByText(/no book drafts yet/i)).toBeDefined();
    });
  });

  it('renders all books from the API', async () => {
    vi.mocked(apiMock).mockResolvedValueOnce(mockOk(mockPage([MOCK_BOOK, MOCK_BOOK_2])));
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByText("Emma's Story")).toBeDefined();
      expect(screen.getByText("Oliver's Story")).toBeDefined();
    });
  });

  it('loads and can delete a book beyond the first 20 results', async () => {
    const firstPage = Array.from({ length: 20 }, (_, index) => ({
      ...MOCK_BOOK,
      id: `book-${index + 1}`,
      title: `Story ${index + 1}`,
    }));
    const laterBook = { ...MOCK_BOOK, id: 'book-21', title: 'Story 21' };
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    vi.mocked(apiMock)
      .mockResolvedValueOnce(mockOk({ items: firstPage, page: 1, limit: 20, total: 21 }))
      .mockResolvedValueOnce(mockOk({ items: [laterBook], page: 2, limit: 20, total: 21 }))
      .mockResolvedValueOnce(mockOk(deletionRequest('requested'), 202));

    const user = userEvent.setup();
    render(<DashboardPage />);
    await screen.findByText('Story 20');
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByText('Story 21');

    const pageTwoCall = vi
      .mocked(apiMock)
      .mock.calls.find(([url]) => String(url).includes('/books?page=2&limit=20'));
    expect(pageTwoCall).toBeDefined();

    const card = screen.getByText('Story 21').closest('li');
    expect(card).not.toBeNull();
    await user.click(card!.querySelector('button')!);
    await waitFor(() => expect(screen.queryByText('Story 21')).toBeNull());
  });

  it('renders an error banner when the API fails', async () => {
    vi.mocked(apiMock).mockResolvedValueOnce(mockError(500, 'Server down'));
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeDefined();
      expect(screen.getByRole('alert').textContent).toContain('Server down');
    });
  });

  // ── Navigation links ───────────────────────────────────────────────────────

  it('New Book header button links to the wizard', async () => {
    vi.mocked(apiMock).mockResolvedValueOnce(mockOk(mockPage([])));
    render(<DashboardPage />);
    const link = screen.getByRole('link', { name: /new book/i });
    expect(link.getAttribute('href')).toBe('/dashboard/books/new');
  });

  it('book card title links to the book detail page', async () => {
    vi.mocked(apiMock).mockResolvedValueOnce(mockOk(mockPage([MOCK_BOOK])));
    render(<DashboardPage />);
    await waitFor(() => {
      const link = screen.getByRole('link', { name: "Emma's Story" });
      expect(link.getAttribute('href')).toBe('/dashboard/books/book-1');
    });
  });

  it('book card Edit button links to the book detail page', async () => {
    vi.mocked(apiMock).mockResolvedValueOnce(mockOk(mockPage([MOCK_BOOK])));
    render(<DashboardPage />);
    await waitFor(() => {
      const links = screen.getAllByRole('link', { name: /^edit$/i });
      expect(links[0]?.getAttribute('href')).toBe('/dashboard/books/book-1');
    });
  });

  it('shows a View button (instead of Edit) for a complete book', async () => {
    const completeBook: BookDto = { ...MOCK_BOOK, status: BookStatus.Complete };
    vi.mocked(apiMock).mockResolvedValueOnce(mockOk(mockPage([completeBook])));
    render(<DashboardPage />);
    await waitFor(() => {
      const link = screen.getByRole('link', { name: /^view$/i });
      expect(link.getAttribute('href')).toBe('/dashboard/books/book-1');
    });
    expect(screen.queryByRole('link', { name: /^edit$/i })).toBeNull();
  });

  it('loads the published cover for a book with a publication marker', async () => {
    const publishedBook: BookDto = {
      ...MOCK_BOOK,
      status: BookStatus.Complete,
      previewPdfUrl: '/published.pdf',
    };
    vi.mocked(apiMock)
      .mockResolvedValueOnce(mockOk(mockPage([publishedBook])))
      .mockResolvedValueOnce(mockImageBlob());

    render(<DashboardPage />);

    expect(await screen.findByAltText("Cover of Emma's Story")).toHaveAttribute(
      'src',
      'blob:published-cover',
    );
    expect(vi.mocked(apiMock)).toHaveBeenLastCalledWith(
      'http://localhost:4000/api/books/book-1/images/cover-thumb',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('does not request a cover for a book without a publication marker', async () => {
    vi.mocked(apiMock).mockResolvedValueOnce(mockOk(mockPage([MOCK_BOOK])));

    render(<DashboardPage />);

    expect(await screen.findByRole('img', { name: 'No published cover' })).toBeDefined();
    expect(vi.mocked(apiMock)).toHaveBeenCalledTimes(1);
  });

  it('disables the Delete button while a book is still generating', async () => {
    const generatingBook: BookDto = { ...MOCK_BOOK, status: BookStatus.StoryDraft };
    vi.mocked(apiMock).mockResolvedValueOnce(mockOk(mockPage([generatingBook])));
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^delete$/i })).toBeDisabled();
    });
  });

  it('Create First Book link in empty state links to the wizard', async () => {
    vi.mocked(apiMock).mockResolvedValueOnce(mockOk(mockPage([])));
    render(<DashboardPage />);
    await waitFor(() => {
      const link = screen.getByRole('link', { name: /create first book/i });
      expect(link.getAttribute('href')).toBe('/dashboard/books/new');
    });
  });

  // ── Retry ──────────────────────────────────────────────────────────────────

  it('retries loading books when Retry is clicked after an error', async () => {
    vi.mocked(apiMock)
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
    vi.mocked(apiMock)
      .mockResolvedValueOnce(mockOk(mockPage([MOCK_BOOK, MOCK_BOOK_2])))
      .mockResolvedValueOnce(mockOk(deletionRequest('requested'), 202));

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

  // ── Permanent deletion lifecycle ───────────────────────────────────────────

  describe('permanent deletion lifecycle', () => {
    function routeApi(opts: {
      books: BookDto[];
      hardDelete?: () => BookDeletionRequestDto;
      statuses?: BookDeletionRequestDto[];
    }) {
      const statuses = [...(opts.statuses ?? [])];
      let last: BookDeletionRequestDto | undefined;
      apiMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'POST' && url.endsWith('/hard-delete')) {
          return mockOk(opts.hardDelete?.() ?? deletionRequest('requested'), 202);
        }
        if (url.includes('/books/deletion-requests/')) {
          last = statuses.shift() ?? last;
          return mockOk(last);
        }
        if (url.includes('/books?')) return mockOk(mockPage(opts.books));
        throw new Error(`unexpected request: ${url}`);
      });
    }

    async function advancePoll() {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2600);
      });
    }

    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    });

    it('keeps a deletion pending through accepted → processing → retry_pending → retry → completed', async () => {
      let hardDeleteCalls = 0;
      routeApi({
        books: [MOCK_BOOK],
        hardDelete: () => {
          hardDeleteCalls += 1;
          return deletionRequest('requested', { attemptCount: hardDeleteCalls - 1 });
        },
        statuses: [
          deletionRequest('processing', { attemptCount: 1 }),
          deletionRequest('retry_pending', {
            attemptCount: 1,
            lastErrorCode: 'ARTIFACT_DELETE_FAILED',
            remainingArtifactCount: 2,
          }),
        ],
      });

      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<DashboardPage />);
      await screen.findByText("Emma's Story");

      await user.click(screen.getByRole('button', { name: /^delete$/i }));

      // Accepted: the card is gone, but the deletion is shown as pending, not done.
      await waitFor(() => expect(screen.queryByText("Emma's Story")).toBeNull());
      expect(screen.getByText(/deletion pending/i)).toBeDefined();
      expect(screen.queryByText(/permanently deleted/i)).toBeNull();

      // processing → still pending.
      await advancePoll();
      expect(screen.getByText(/deletion pending/i)).toBeDefined();

      // retry_pending (partial storage failure) → surfaced with a recovery control.
      await advancePoll();
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toMatch(/didn.t finish/i);
      expect(alert.textContent).toMatch(/2 stored files could not be removed/i);

      // Resubmitting the same request re-queues it.
      apiMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'POST' && url.endsWith('/hard-delete')) {
          hardDeleteCalls += 1;
          return mockOk(deletionRequest('requested', { attemptCount: 1 }), 202);
        }
        if (url.includes('/books/deletion-requests/')) {
          return mockOk(
            deletionRequest('completed', {
              attemptCount: 2,
              deletedArtifactCount: 3,
              completedAt: '2026-07-31T00:01:00.000Z',
            }),
          );
        }
        throw new Error(`unexpected request: ${url}`);
      });
      await user.click(screen.getByRole('button', { name: /retry deletion/i }));
      await waitFor(() => expect(screen.getByText(/deletion pending/i)).toBeDefined());
      expect(hardDeleteCalls).toBe(2);

      await advancePoll();
      await waitFor(() => expect(screen.getByText(/permanently deleted/i)).toBeDefined());
      expect(screen.queryByText(/deletion pending/i)).toBeNull();

      await user.click(screen.getByRole('button', { name: /dismiss/i }));
      expect(screen.queryByText(/permanently deleted/i)).toBeNull();
    });

    it('restores an in-progress deletion after a reload and follows it to completion', async () => {
      pendingDeletions = [deletionRequest('processing', { attemptCount: 1 })];
      routeApi({
        books: [],
        statuses: [
          deletionRequest('completed', {
            attemptCount: 1,
            completedAt: '2026-07-31T00:01:00.000Z',
          }),
        ],
      });

      render(<DashboardPage />);

      await waitFor(() => expect(screen.getByText(/deletion pending/i)).toBeDefined());

      await advancePoll();
      await waitFor(() => expect(screen.getByText(/permanently deleted/i)).toBeDefined());
    });

    it('restores a stalled deletion with its retry control after a reload', async () => {
      pendingDeletions = [
        deletionRequest('retry_pending', {
          attemptCount: 3,
          lastErrorCode: 'ARTIFACT_LIST_FAILED',
          remainingArtifactCount: 0,
        }),
      ];
      routeApi({ books: [] });

      render(<DashboardPage />);

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toMatch(/didn.t finish/i);
      expect(screen.getByRole('button', { name: /retry deletion/i })).toBeDefined();
    });

    it('keeps the card and reports an error when the deletion request is rejected', async () => {
      const alertSpy = vi.fn();
      vi.stubGlobal('alert', alertSpy);
      apiMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'POST') return mockError(429, 'Too many deletion requests');
        if (url.includes('/books?')) return mockOk(mockPage([MOCK_BOOK]));
        throw new Error(`unexpected request: ${url}`);
      });

      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<DashboardPage />);
      await screen.findByText("Emma's Story");
      await user.click(screen.getByRole('button', { name: /^delete$/i }));

      await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('Too many deletion requests'));
      expect(screen.getByText("Emma's Story")).toBeDefined();
      expect(screen.queryByText(/deletion pending/i)).toBeNull();
    });
  });
});
