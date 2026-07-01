import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter, useParams } from 'next/navigation';
import BookDetailPage from './page';
import { SupportedLanguage, BookStatus } from '@book/types';
import type { BookDto, PagePlan } from '@book/types';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('next/navigation', () => ({
  useParams: vi.fn(),
  useRouter: vi.fn(),
}));

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

function mockOk(body: unknown, status = 200): Response {
  return { ok: true, status, json: async () => body } as unknown as Response;
}

function mockError(status: number, message: string): Response {
  return { ok: false, status, json: async () => ({ message }) } as unknown as Response;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('BookDetailPage', () => {
  const pushMock = vi.fn();

  beforeEach(() => {
    vi.mocked(useParams).mockReturnValue({ id: 'book-1' });
    vi.mocked(useRouter).mockReturnValue({ push: pushMock } as unknown as ReturnType<typeof useRouter>);
    vi.stubGlobal('fetch', vi.fn());
    pushMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── Loading state ──────────────────────────────────────────────────────────

  it('shows a loading skeleton while the book is being fetched', () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(MOCK_BOOK));
    render(<BookDetailPage />);
    expect(screen.getByRole('status', { name: /loading book/i })).toBeDefined();
  });

  // ── Successful render ──────────────────────────────────────────────────────

  it('renders book details after a successful fetch', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(MOCK_BOOK));
    render(<BookDetailPage />);
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1, name: "Emma's Story" })).toBeDefined();
      expect(screen.getByText('Emma, age 5')).toBeDefined();
      expect(screen.getByText('Friendship')).toBeDefined();
    });
  });

  // ── Error / not found states ───────────────────────────────────────────────

  it('renders an error banner when the API returns a server error', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockError(500, 'Internal server error'));
    render(<BookDetailPage />);
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('Internal server error');
    });
  });

  it('renders a not-found state when the API returns 404', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockError(404, 'Book not found'));
    render(<BookDetailPage />);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /book not found/i })).toBeDefined();
    });
  });

  // ── Edit mode ─────────────────────────────────────────────────────────────

  it('shows validation error when saving with an empty child name', async () => {
    const user = userEvent.setup();
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(MOCK_BOOK));
    render(<BookDetailPage />);

    await waitFor(() => screen.getByRole('heading', { level: 1, name: "Emma's Story" }));
    await user.click(screen.getByRole('button', { name: /^edit$/i }));

    const nameInput = screen.getByPlaceholderText(/e\.g\. emma/i);
    await user.clear(nameInput);
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    expect(screen.getByRole('alert').textContent).toContain('required');
  });

  // ── Successful PATCH save ──────────────────────────────────────────────────

  it('saves edits and returns to view mode on successful PATCH', async () => {
    const user = userEvent.setup();
    const updated = { ...MOCK_BOOK, theme: 'Adventure' };
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockOk(MOCK_BOOK))   // initial GET
      .mockResolvedValueOnce(mockOk(updated));      // PATCH

    render(<BookDetailPage />);
    await waitFor(() => screen.getByRole('heading', { level: 1, name: "Emma's Story" }));

    await user.click(screen.getByRole('button', { name: /^edit$/i }));

    const themeInput = screen.getByPlaceholderText(/friendship/i);
    await user.clear(themeInput);
    await user.type(themeInput, 'Adventure');

    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: /edit book/i })).toBeNull();
      expect(screen.getByText('Adventure')).toBeDefined();
    });
  });

  // ── Delete ────────────────────────────────────────────────────────────────

  it('deletes the book and redirects to /dashboard', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockOk(MOCK_BOOK))
      .mockResolvedValueOnce({ ok: true, status: 204 } as Response);

    render(<BookDetailPage />);
    await waitFor(() => screen.getByRole('heading', { level: 1, name: "Emma's Story" }));

    await user.click(screen.getByRole('button', { name: /^delete$/i }));

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith('/dashboard');
    });
  });

  // ── Generate Story ────────────────────────────────────────────────────────

  it('renders the Generate Story button for a complete draft book', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(MOCK_BOOK));
    render(<BookDetailPage />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /generate story/i })).toBeDefined();
    });
  });

  it('disables Generate Story and shows a warning when required fields are missing', async () => {
    const incomplete = { ...MOCK_BOOK, childName: null };
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(incomplete));
    render(<BookDetailPage />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /generate story/i })).toBeDisabled();
      expect(screen.getByText(/complete all fields to generate/i)).toBeDefined();
    });
  });

  it('updates book status badge to page_plan after successful generation', async () => {
    const user = userEvent.setup();
    const generated = { ...MOCK_BOOK, status: BookStatus.PagePlan };
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockOk(MOCK_BOOK))
      .mockResolvedValueOnce(mockOk({ book: generated }));

    render(<BookDetailPage />);
    await waitFor(() => screen.getByRole('button', { name: /generate story/i }));
    await user.click(screen.getByRole('button', { name: /generate story/i }));

    await waitFor(() => {
      expect(screen.getByText('page_plan')).toBeDefined();
    });
  });

  it('shows an error alert when generation fails', async () => {
    const user = userEvent.setup();
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockOk(MOCK_BOOK))
      .mockResolvedValueOnce(mockError(400, 'Missing required draft fields: language'));

    render(<BookDetailPage />);
    await waitFor(() => screen.getByRole('button', { name: /generate story/i }));
    await user.click(screen.getByRole('button', { name: /generate story/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('Missing required draft fields');
    });
  });

  // ── Story plan section ────────────────────────────────────────────────────

  it('renders the story plan section when storyPlan is present in the response', async () => {
    const user = userEvent.setup();
    const storyPlan = {
      title: "Emma's Friendship Adventure",
      theme: 'Friendship',
      educationalMessage: 'Through friendship, we learn kindness.',
      openingHook: 'One sunny morning…',
      resolution: 'Emma returned home with joy.',
      chapters: [
        {
          chapterNumber: 1,
          title: 'A Magical Discovery',
          summary: 'Emma finds something unexpected.',
          setting: 'Garden',
          emotionalArc: 'curiosity',
          keyEvents: [],
          illustrableScenes: [],
        },
      ],
    };
    const generated = { ...MOCK_BOOK, status: BookStatus.StoryPlan, storyPlan };
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockOk(MOCK_BOOK))
      .mockResolvedValueOnce(mockOk({ book: generated }));

    render(<BookDetailPage />);
    await waitFor(() => screen.getByRole('button', { name: /generate story/i }));
    await user.click(screen.getByRole('button', { name: /generate story/i }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /story plan is ready/i })).toBeDefined();
      expect(screen.getByText("Emma's Friendship Adventure")).toBeDefined();
      expect(screen.getByText('Through friendship, we learn kindness.')).toBeDefined();
      expect(screen.getByText('A Magical Discovery')).toBeDefined();
    });
  });

  it('renders a story plan section when book loads with storyPlan already set', async () => {
    const storyPlan = {
      title: "Emma's Courage Adventure",
      theme: 'Courage',
      educationalMessage: 'Courage helps us grow.',
      openingHook: 'One day…',
      resolution: 'Emma was proud.',
      chapters: [
        {
          chapterNumber: 1,
          title: 'The Big Step',
          summary: 'Emma takes her first brave step.',
          setting: 'School',
          emotionalArc: 'nervousness to pride',
          keyEvents: [],
          illustrableScenes: [],
        },
      ],
    };
    const bookWithPlan = { ...MOCK_BOOK, status: BookStatus.StoryPlan, storyPlan };
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(bookWithPlan));

    render(<BookDetailPage />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /story plan is ready/i })).toBeDefined();
      expect(screen.getByText('The Big Step')).toBeDefined();
    });
  });

  // ── Page plan section ─────────────────────────────────────────────────────

  it('renders the page plan section when storyPlan.pages is present in the generation response', async () => {
    const user = userEvent.setup();
    const pages: PagePlan[] = [
      {
        pageNumber: 1,
        chapterIndex: 0,
        title: 'A Magical Discovery — Part 1',
        sceneDescription: 'Emma discovering a glowing light in the garden',
        narration: 'It all began with a glowing light.',
        illustrationPrompt: "Children's book illustration: Emma discovering a glowing light",
        learningGoal: 'Through friendship, we learn kindness.',
      },
    ];
    const storyPlan = {
      title: "Emma's Friendship Adventure",
      theme: 'Friendship',
      educationalMessage: 'Through friendship, we learn kindness.',
      openingHook: 'One sunny morning…',
      resolution: 'Emma returned home with joy.',
      chapters: [
        {
          chapterNumber: 1,
          title: 'A Magical Discovery',
          summary: 'Emma finds something unexpected.',
          setting: 'Garden',
          emotionalArc: 'curiosity',
          keyEvents: [],
          illustrableScenes: [],
        },
      ],
      pages,
    };
    const generated = { ...MOCK_BOOK, status: BookStatus.PagePlan, storyPlan };
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockOk(MOCK_BOOK))
      .mockResolvedValueOnce(mockOk({ book: generated }));

    render(<BookDetailPage />);
    await waitFor(() => screen.getByRole('button', { name: /generate story/i }));
    await user.click(screen.getByRole('button', { name: /generate story/i }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /page plan is ready/i })).toBeDefined();
      expect(screen.getByText('A Magical Discovery — Part 1')).toBeDefined();
      expect(screen.getByText('Emma discovering a glowing light in the garden')).toBeDefined();
    });
  });

  it('renders the page plan section when book loads with storyPlan.pages already set', async () => {
    const pages: PagePlan[] = [
      {
        pageNumber: 1,
        chapterIndex: 0,
        title: 'The Big Step — Part 1',
        sceneDescription: 'Emma taking her first brave step at school',
        narration: 'It all began with courage.',
        illustrationPrompt: "Children's book illustration: Emma at school",
        learningGoal: 'Courage helps us grow.',
      },
      {
        pageNumber: 2,
        chapterIndex: 0,
        title: 'The Big Step — Part 2',
        sceneDescription: 'Emma smiling with new friends',
        narration: 'The story continued as pride filled the air.',
        illustrationPrompt: "Children's book illustration: Emma with friends",
        learningGoal: 'Courage helps us grow.',
      },
    ];
    const storyPlan = {
      title: "Emma's Courage Adventure",
      theme: 'Courage',
      educationalMessage: 'Courage helps us grow.',
      openingHook: 'One day…',
      resolution: 'Emma was proud.',
      chapters: [
        {
          chapterNumber: 1,
          title: 'The Big Step',
          summary: 'Emma takes her first brave step.',
          setting: 'School',
          emotionalArc: 'nervousness to pride',
          keyEvents: [],
          illustrableScenes: [],
        },
      ],
      pages,
    };
    const bookWithPagePlan = { ...MOCK_BOOK, status: BookStatus.PagePlan, storyPlan };
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(bookWithPagePlan));

    render(<BookDetailPage />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /page plan is ready/i })).toBeDefined();
      expect(screen.getByText('The Big Step — Part 1')).toBeDefined();
      expect(screen.getByText('The Big Step — Part 2')).toBeDefined();
    });
  });

  // ── Edit/Delete gating ────────────────────────────────────────────────────

  it('hides Edit and Delete buttons when status is not created', async () => {
    const inProgress = { ...MOCK_BOOK, status: BookStatus.StoryPlan };
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(inProgress));

    render(<BookDetailPage />);

    await waitFor(() => {
      expect(screen.getByText('story_plan')).toBeDefined();
    });

    expect(screen.queryByRole('button', { name: /^edit$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^delete$/i })).toBeNull();
  });

  it('shows a "Generation has started" note when status is not created', async () => {
    const inProgress = { ...MOCK_BOOK, status: BookStatus.StoryPlan };
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(inProgress));

    render(<BookDetailPage />);

    await waitFor(() => {
      expect(screen.getByText(/generation has started/i)).toBeDefined();
    });
  });

  it('shows Edit and Delete buttons for books with created status', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(MOCK_BOOK));

    render(<BookDetailPage />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^edit$/i })).toBeDefined();
      expect(screen.getByRole('button', { name: /^delete$/i })).toBeDefined();
    });
  });

  it('hides Edit and Delete buttons when status is page_plan', async () => {
    const pagePlanBook = { ...MOCK_BOOK, status: BookStatus.PagePlan };
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(pagePlanBook));

    render(<BookDetailPage />);

    await waitFor(() => {
      expect(screen.getByText('page_plan')).toBeDefined();
    });

    expect(screen.queryByRole('button', { name: /^edit$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^delete$/i })).toBeNull();
  });

  it('shows a "Generation has started" note when status is page_plan', async () => {
    const pagePlanBook = { ...MOCK_BOOK, status: BookStatus.PagePlan };
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(pagePlanBook));

    render(<BookDetailPage />);

    await waitFor(() => {
      expect(screen.getByText(/generation has started/i)).toBeDefined();
    });
  });
});
