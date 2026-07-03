import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter, useParams } from 'next/navigation';
import BookDetailPage from './page';
import { SupportedLanguage, BookStatus, AgentStep } from '@book/types';
import type {
  BookDto,
  BookPreview,
  GeneratedImageEntry,
  GenerationDiagnosticsDto,
  IllustrationPlan,
  ImageGenerationResult,
  PagePlan,
} from '@book/types';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('next/navigation', () => ({
  useParams: vi.fn(),
  useRouter: vi.fn(),
}));

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

function makeImageGenerationResult(bookId = 'book-1'): ImageGenerationResult {
  const coverEntry: GeneratedImageEntry = {
    id: `${bookId}-cover`,
    kind: 'cover',
    prompt: "A child named Emma on the cover of a children's book, watercolor style",
    provider: 'local_mock',
    status: 'complete',
    imageUrl: `/mock-images/${bookId}/cover.svg`,
    altText: "Cover illustration for Emma's Friendship Adventure",
    width: 768,
    height: 1024,
    seed: `${bookId}:cover:0`,
  };
  const page1Entry: GeneratedImageEntry = {
    id: `${bookId}-page-1`,
    kind: 'page',
    pageNumber: 1,
    prompt: 'A child with wavy brown hair, Emma discovering a glowing light.',
    provider: 'local_mock',
    status: 'complete',
    imageUrl: `/mock-images/${bookId}/page-1.svg`,
    altText: 'Page 1 illustration',
    width: 1024,
    height: 768,
    seed: `${bookId}:page:1`,
  };
  const page2Entry: GeneratedImageEntry = {
    id: `${bookId}-page-2`,
    kind: 'page',
    pageNumber: 2,
    prompt: 'A child with wavy brown hair, Emma and friend walking through mushrooms.',
    provider: 'local_mock',
    status: 'complete',
    imageUrl: `/mock-images/${bookId}/page-2.svg`,
    altText: 'Page 2 illustration',
    width: 1024,
    height: 768,
    seed: `${bookId}:page:2`,
  };
  const backCoverEntry: GeneratedImageEntry = {
    id: `${bookId}-back-cover`,
    kind: 'back_cover',
    prompt: "Back cover for Emma's Friendship Adventure, child-friendly decorative design",
    provider: 'local_mock',
    status: 'complete',
    imageUrl: `/mock-images/${bookId}/back-cover.svg`,
    altText: 'Back cover illustration',
    width: 768,
    height: 1024,
    seed: `${bookId}:back_cover:0`,
  };
  return {
    provider: 'local_mock',
    status: 'complete',
    images: [coverEntry, page1Entry, page2Entry, backCoverEntry],
    createdAt: '1970-01-01T00:00:00.000Z',
  };
}

function makeBookPreview(childName = 'Emma'): BookPreview {
  return {
    title: `${childName}'s Friendship Adventure`,
    subtitle: 'A friendship story for Emma',
    cover: {
      title: `${childName}'s Friendship Adventure`,
      subtitle: 'A friendship story for Emma',
      childName,
      illustrationPrompt: `A child named ${childName} on the cover of a children's book, watercolor style`,
    },
    pages: [
      {
        pageNumber: 1,
        title: 'A Magical Discovery — Part 1',
        text: 'One sunny morning, Emma discovered something magical.',
        illustrationPrompt: `A child with wavy brown hair, ${childName} discovering a glowing light.`,
        layout: 'image_top_text_bottom',
        learningGoal: 'Through friendship, we learn kindness.',
      },
      {
        pageNumber: 2,
        title: 'A Magical Discovery — Part 2',
        text: `${childName} thought about friendship and took another brave step forward.`,
        illustrationPrompt: `A child with wavy brown hair, ${childName} and friend walking through mushrooms.`,
        layout: 'text_left_image_right',
        learningGoal: 'Through friendship, we learn kindness.',
      },
    ],
    backCover: {
      message: `The End! We hope ${childName} enjoyed this adventure. Keep exploring, keep dreaming!`,
      educationalSummary:
        'Through friendship, we learn the importance of courage, kindness, and believing in ourselves.',
    },
    metadata: {
      language: 'en',
      theme: 'Friendship',
      childAge: 5,
      totalPages: 2,
      generatedBy: 'LocalPipelineAgent',
    },
  };
}

function mockOk(body: unknown, status = 200): Response {
  return { ok: true, status, json: async () => body } as unknown as Response;
}

function mockError(status: number, message: string): Response {
  return { ok: false, status, json: async () => ({ message }) } as unknown as Response;
}

function mockPdfBlob(content = 'pdf-bytes', status = 200): Response {
  return {
    ok: true,
    status,
    blob: async () => new Blob([content], { type: 'application/pdf' }),
  } as unknown as Response;
}

function makeDiagnostics(
  overrides: Partial<GenerationDiagnosticsDto> = {},
): GenerationDiagnosticsDto {
  return {
    bookId: 'book-1',
    status: BookStatus.StoryDraft,
    failedStep: null,
    errorMessage: null,
    generationMetadata: {
      storyProvider: 'mock',
      imageProvider: 'mock',
    },
    recentLogs: [],
    previewPdfUrl: null,
    ...overrides,
  };
}

const DEFAULT_DIAGNOSTICS = makeDiagnostics();

// The book detail page now issues an automatic GET .../generation-diagnostics
// call alongside every book fetch/poll. Routing fetch responses by URL (instead
// of vitest's plain call-order `mockResolvedValueOnce` queue) keeps that call
// from silently stealing a response meant for a `/books/:id` request, without
// requiring every existing test below to be rewritten: those tests keep calling
// `vi.mocked(fetch).mockResolvedValueOnce(...)`, which this routes into the
// book-only queue. Tests that care about diagnostics content use
// `queueDiagnostics(...)` explicitly; otherwise a safe default is served.
interface RoutedFetchMock {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  mock: { calls: unknown[][] };
  mockResolvedValueOnce: (value: Response) => RoutedFetchMock;
  mockResolvedValue: (value: Response) => RoutedFetchMock;
}

function createRoutedFetchMock(): {
  fetchFn: RoutedFetchMock;
  queueDiagnostics: (response: Response) => void;
} {
  const bookQueue: Response[] = [];
  let bookDefault: Response | undefined;
  const diagnosticsQueue: Response[] = [];
  const calls: unknown[][] = [];

  const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push([input, init]);
    const url = String(input);
    if (url.includes('/generation-diagnostics')) {
      const next = diagnosticsQueue.shift();
      return Promise.resolve(next ?? mockOk(DEFAULT_DIAGNOSTICS));
    }
    const next = bookQueue.shift() ?? bookDefault;
    if (!next) {
      return Promise.reject(new Error(`Unexpected fetch call with no queued response: ${url}`));
    }
    return Promise.resolve(next);
  }) as RoutedFetchMock;

  fetchFn.mock = { calls };
  fetchFn.mockResolvedValueOnce = (value: Response) => {
    bookQueue.push(value);
    return fetchFn;
  };
  fetchFn.mockResolvedValue = (value: Response) => {
    bookDefault = value;
    return fetchFn;
  };

  return { fetchFn, queueDiagnostics: (response: Response) => diagnosticsQueue.push(response) };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('BookDetailPage', () => {
  const pushMock = vi.fn();
  let fetchMock: ReturnType<typeof createRoutedFetchMock>;

  function queueDiagnostics(response: Response) {
    fetchMock.queueDiagnostics(response);
  }

  beforeEach(() => {
    vi.mocked(useParams).mockReturnValue({ id: 'book-1' });
    vi.mocked(useRouter).mockReturnValue({ push: pushMock } as unknown as ReturnType<
      typeof useRouter
    >);
    fetchMock = createRoutedFetchMock();
    vi.stubGlobal('fetch', fetchMock.fetchFn);
    pushMock.mockReset();
    global.URL.createObjectURL = vi.fn(() => 'blob:mock-url');
    global.URL.revokeObjectURL = vi.fn();
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

  // ── pageCount / educationalMessage display ────────────────────────────────

  it('shows page count when pageCount is present on the book', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockOk({ ...MOCK_BOOK, pageCount: 8 }));
    render(<BookDetailPage />);
    await waitFor(() => {
      expect(screen.getByText('Page count')).toBeDefined();
      expect(screen.getByText('8')).toBeDefined();
    });
  });

  it('does not show page count when pageCount is null', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockOk({ ...MOCK_BOOK, pageCount: null }));
    render(<BookDetailPage />);
    await waitFor(() => screen.getByRole('heading', { level: 1, name: "Emma's Story" }));
    expect(screen.queryByText('Page count')).toBeNull();
  });

  it('shows educational message when present and non-empty on the book', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockOk({ ...MOCK_BOOK, educationalMessage: 'Sharing makes everyone happier.' }),
    );
    render(<BookDetailPage />);
    await waitFor(() => {
      expect(screen.getByText('Educational message')).toBeDefined();
      expect(screen.getByText('Sharing makes everyone happier.')).toBeDefined();
    });
  });

  it('does not show educational message when it is null or empty', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockOk({ ...MOCK_BOOK, educationalMessage: '   ' }));
    render(<BookDetailPage />);
    await waitFor(() => screen.getByRole('heading', { level: 1, name: "Emma's Story" }));
    expect(screen.queryByText('Educational message')).toBeNull();
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

  it('retries the fetch when Retry is clicked after a load error', async () => {
    const user = userEvent.setup();
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockError(500, 'Internal server error'))
      .mockResolvedValueOnce(mockOk(MOCK_BOOK));

    render(<BookDetailPage />);
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('Internal server error');
    });

    await user.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1, name: "Emma's Story" })).toBeDefined();
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
      .mockResolvedValueOnce(mockOk(MOCK_BOOK)) // initial GET
      .mockResolvedValueOnce(mockOk(updated)); // PATCH

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

  it('updates book status badge to preview_ready after successful generation', async () => {
    const user = userEvent.setup();
    const generated = {
      ...MOCK_BOOK,
      status: BookStatus.PreviewReady,
      bookPreview: makeBookPreview(),
    };
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockOk(MOCK_BOOK))
      .mockResolvedValueOnce(mockOk({ book: generated }));

    render(<BookDetailPage />);
    await waitFor(() => screen.getByRole('button', { name: /generate story/i }));
    await user.click(screen.getByRole('button', { name: /generate story/i }));

    await waitFor(() => {
      expect(screen.getByText('preview_ready')).toBeDefined();
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

  // ── Story draft section ───────────────────────────────────────────────────

  it('renders the story draft section when pages include storyText in the generation response', async () => {
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
        storyText:
          'One sunny morning, Emma discovered something magical. It all began with a glowing light. Emma knew deep down: Through friendship, we learn kindness.',
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
    const generated = { ...MOCK_BOOK, status: BookStatus.StoryDraft, storyPlan };
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockOk(MOCK_BOOK))
      .mockResolvedValueOnce(mockOk({ book: generated }));

    render(<BookDetailPage />);
    await waitFor(() => screen.getByRole('button', { name: /generate story/i }));
    await user.click(screen.getByRole('button', { name: /generate story/i }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /story draft is ready/i })).toBeDefined();
      expect(
        screen.getByText(/one sunny morning, emma discovered something magical/i),
      ).toBeDefined();
    });
  });

  it('renders the story draft section when book loads with storyText already on pages', async () => {
    const pages: PagePlan[] = [
      {
        pageNumber: 1,
        chapterIndex: 0,
        title: 'The Big Step — Part 1',
        sceneDescription: 'Emma taking her first brave step at school',
        narration: 'It all began with courage.',
        illustrationPrompt: "Children's book illustration: Emma at school",
        learningGoal: 'Courage helps us grow.',
        storyText:
          'One sunny morning, Emma took her first brave step. It all began with courage. Emma knew deep down: Courage helps us grow.',
      },
      {
        pageNumber: 2,
        chapterIndex: 0,
        title: 'The Big Step — Part 2',
        sceneDescription: 'Emma smiling with new friends',
        narration: 'The story continued as pride filled the air.',
        illustrationPrompt: "Children's book illustration: Emma with friends",
        learningGoal: 'Courage helps us grow.',
        storyText:
          'Emma thought about courage and took another brave step. The story continued as pride filled the air. Emma knew deep down: Courage helps us grow.',
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
    const bookWithDraft = { ...MOCK_BOOK, status: BookStatus.StoryDraft, storyPlan };
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(bookWithDraft));

    render(<BookDetailPage />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /story draft is ready/i })).toBeDefined();
      expect(screen.getByText(/one sunny morning, emma took her first brave step/i)).toBeDefined();
      expect(screen.getByText(/emma thought about courage/i)).toBeDefined();
    });
  });

  it('renders story_draft status badge correctly', async () => {
    const storyDraftBook = { ...MOCK_BOOK, status: BookStatus.StoryDraft };
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(storyDraftBook));

    render(<BookDetailPage />);

    await waitFor(() => {
      expect(screen.getByText('story_draft')).toBeDefined();
    });
  });

  it('hides Edit and Delete buttons when status is story_draft', async () => {
    const storyDraftBook = { ...MOCK_BOOK, status: BookStatus.StoryDraft };
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(storyDraftBook));

    render(<BookDetailPage />);

    await waitFor(() => {
      expect(screen.getByText('story_draft')).toBeDefined();
    });

    expect(screen.queryByRole('button', { name: /^edit$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^delete$/i })).toBeNull();
  });

  it('shows "Writing your story…" message when status is story_draft', async () => {
    const storyDraftBook = { ...MOCK_BOOK, status: BookStatus.StoryDraft };
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(storyDraftBook));

    render(<BookDetailPage />);

    await waitFor(() => {
      expect(screen.getByText(/writing your story/i)).toBeDefined();
    });
  });

  // ── Illustration plan section ─────────────────────────────────────────────

  it('renders the illustration plan section when pages include illustration in the generation response', async () => {
    const user = userEvent.setup();
    const illustration: IllustrationPlan = {
      prompt:
        "A child with wavy brown hair, Emma discovering a glowing light. Children's book illustration.",
      negativePrompt: 'blurry, distorted face, extra limbs, scary, violent, text, watermark',
      style: 'warm children book illustration, soft colors, friendly character design',
      aspectRatio: '4:3',
      characters: ['Emma'],
      setting: 'Emma discovering a glowing light in the garden',
      mood: 'curiosity to excitement, child-friendly',
      consistencyNotes: 'Keep Emma visually consistent throughout.',
    };
    const pages: PagePlan[] = [
      {
        pageNumber: 1,
        chapterIndex: 0,
        title: 'A Magical Discovery — Part 1',
        sceneDescription: 'Emma discovering a glowing light in the garden',
        narration: 'It all began with a glowing light.',
        illustrationPrompt: "Children's book illustration: Emma discovering a glowing light",
        learningGoal: 'Through friendship, we learn kindness.',
        storyText: 'One sunny morning, Emma discovered something magical.',
        illustration,
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
          emotionalArc: 'curiosity to excitement',
          keyEvents: [],
          illustrableScenes: [],
        },
      ],
      pages,
    };
    const generated = { ...MOCK_BOOK, status: BookStatus.IllustPlan, storyPlan };
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockOk(MOCK_BOOK))
      .mockResolvedValueOnce(mockOk({ book: generated }));

    render(<BookDetailPage />);
    await waitFor(() => screen.getByRole('button', { name: /generate story/i }));
    await user.click(screen.getByRole('button', { name: /generate story/i }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /illustration plan is ready/i })).toBeDefined();
      expect(screen.getByText(/warm children book illustration/i)).toBeDefined();
      expect(screen.getByText(/blurry, distorted face/i)).toBeDefined();
    });
  });

  it('renders the illustration plan section when book loads with illustration already on pages', async () => {
    const illustration: IllustrationPlan = {
      prompt:
        "A child with wavy brown hair, Emma taking her first brave step. Children's book illustration.",
      negativePrompt: 'blurry, distorted face, extra limbs, scary, violent, text, watermark',
      style: 'warm children book illustration, soft colors, friendly character design',
      aspectRatio: '4:3',
      characters: ['Emma'],
      setting: 'Emma taking her first brave step at school',
      mood: 'nervousness to pride, child-friendly',
      consistencyNotes: 'Keep Emma visually consistent throughout.',
    };
    const pages: PagePlan[] = [
      {
        pageNumber: 1,
        chapterIndex: 0,
        title: 'The Big Step — Part 1',
        sceneDescription: 'Emma taking her first brave step at school',
        narration: 'It all began with courage.',
        illustrationPrompt: "Children's book illustration: Emma at school",
        learningGoal: 'Courage helps us grow.',
        storyText: 'One sunny morning, Emma took her first brave step.',
        illustration,
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
    const bookWithIllust = { ...MOCK_BOOK, status: BookStatus.IllustPlan, storyPlan };
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(bookWithIllust));

    render(<BookDetailPage />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /illustration plan is ready/i })).toBeDefined();
      expect(screen.getByText(/nervousness to pride, child-friendly/i)).toBeDefined();
      expect(screen.getByText(/keep emma visually consistent/i)).toBeDefined();
    });
  });

  it('renders illustration_plan status badge correctly', async () => {
    const illustPlanBook = { ...MOCK_BOOK, status: BookStatus.IllustPlan };
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(illustPlanBook));

    render(<BookDetailPage />);

    await waitFor(() => {
      expect(screen.getByText('illust_plan')).toBeDefined();
    });
  });

  it('hides Edit and Delete buttons when status is illust_plan', async () => {
    const illustPlanBook = { ...MOCK_BOOK, status: BookStatus.IllustPlan };
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(illustPlanBook));

    render(<BookDetailPage />);

    await waitFor(() => {
      expect(screen.getByText('illust_plan')).toBeDefined();
    });

    expect(screen.queryByRole('button', { name: /^edit$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^delete$/i })).toBeNull();
  });

  it('shows "Planning illustrations…" message when status is illust_plan', async () => {
    const illustPlanBook = { ...MOCK_BOOK, status: BookStatus.IllustPlan };
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(illustPlanBook));

    render(<BookDetailPage />);

    await waitFor(() => {
      expect(screen.getByText(/planning illustrations/i)).toBeDefined();
    });
  });

  // ── Book preview section ──────────────────────────────────────────────────

  it('renders the book preview section after generation returns bookPreview', async () => {
    const user = userEvent.setup();
    const bookPreview = makeBookPreview();
    const generated = {
      ...MOCK_BOOK,
      status: BookStatus.PreviewReady,
      bookPreview,
    };
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockOk(MOCK_BOOK))
      .mockResolvedValueOnce(mockOk({ book: generated }));

    render(<BookDetailPage />);
    await waitFor(() => screen.getByRole('button', { name: /generate story/i }));
    await user.click(screen.getByRole('button', { name: /generate story/i }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /generated story preview/i })).toBeDefined();
      expect(screen.getByText("Emma's Friendship Adventure")).toBeDefined();
      expect(screen.getByText(/A friendship story for Emma/i)).toBeDefined();
    });
  });

  it('renders the book preview section when book loads with bookPreview already set', async () => {
    const bookPreview = makeBookPreview();
    const bookWithPreview = {
      ...MOCK_BOOK,
      status: BookStatus.PreviewReady,
      bookPreview,
    };
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(bookWithPreview));

    render(<BookDetailPage />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /generated story preview/i })).toBeDefined();
      expect(screen.getByText("Emma's Friendship Adventure")).toBeDefined();
    });
  });

  it('renders preview pages with text and illustration prompt', async () => {
    const bookPreview = makeBookPreview();
    const bookWithPreview = { ...MOCK_BOOK, status: BookStatus.PreviewReady, bookPreview };
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(bookWithPreview));

    render(<BookDetailPage />);

    await waitFor(() => {
      expect(
        screen.getByText('One sunny morning, Emma discovered something magical.'),
      ).toBeDefined();
      expect(
        screen.getByText(/A child with wavy brown hair, Emma discovering a glowing light/i),
      ).toBeDefined();
    });
  });

  it('renders back cover content in the book preview section', async () => {
    const bookPreview = makeBookPreview();
    const bookWithPreview = { ...MOCK_BOOK, status: BookStatus.PreviewReady, bookPreview };
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(bookWithPreview));

    render(<BookDetailPage />);

    await waitFor(() => {
      expect(screen.getByText(/The End! We hope Emma enjoyed this adventure/i)).toBeDefined();
    });
  });

  it('renders metadata in the book preview section', async () => {
    const bookPreview = makeBookPreview();
    const bookWithPreview = { ...MOCK_BOOK, status: BookStatus.PreviewReady, bookPreview };
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(bookWithPreview));

    render(<BookDetailPage />);

    await waitFor(() => {
      // language 'en' appears in both the book detail row and the metadata — use getAllByText
      expect(screen.getAllByText('en').length).toBeGreaterThan(0);
      // totalPages renders in the metadata; page badges also render '1' and '2' separately
      expect(screen.getAllByText('2').length).toBeGreaterThan(0);
    });
  });

  it('renders preview_ready status badge correctly', async () => {
    const bookWithPreview = {
      ...MOCK_BOOK,
      status: BookStatus.PreviewReady,
      bookPreview: makeBookPreview(),
    };
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(bookWithPreview));

    render(<BookDetailPage />);

    await waitFor(() => {
      expect(screen.getByText('preview_ready')).toBeDefined();
    });
  });

  it('shows a fallback message when the generated preview has no pages', async () => {
    const emptyPreview = { ...makeBookPreview(), pages: [] };
    const bookWithEmptyPreview = {
      ...MOCK_BOOK,
      status: BookStatus.PreviewReady,
      bookPreview: emptyPreview,
    };
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(bookWithEmptyPreview));

    render(<BookDetailPage />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /generated story preview/i })).toBeDefined();
      expect(screen.getByText(/no pages were generated for this preview yet/i)).toBeDefined();
    });
  });

  it('hides Edit and Delete buttons when status is preview_ready', async () => {
    const bookWithPreview = {
      ...MOCK_BOOK,
      status: BookStatus.PreviewReady,
      bookPreview: makeBookPreview(),
    };
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(bookWithPreview));

    render(<BookDetailPage />);

    await waitFor(() => {
      expect(screen.getByText('preview_ready')).toBeDefined();
    });

    expect(screen.queryByRole('button', { name: /^edit$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^delete$/i })).toBeNull();
  });

  it('shows "Preparing preview…" message when status is preview_ready', async () => {
    const bookWithPreview = {
      ...MOCK_BOOK,
      status: BookStatus.PreviewReady,
      bookPreview: makeBookPreview(),
    };
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(bookWithPreview));

    render(<BookDetailPage />);

    await waitFor(() => {
      expect(screen.getByText(/preparing preview/i)).toBeDefined();
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

  it('shows "Planning your story…" message when status is story_plan', async () => {
    const inProgress = { ...MOCK_BOOK, status: BookStatus.StoryPlan };
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(inProgress));

    render(<BookDetailPage />);

    await waitFor(() => {
      expect(screen.getByText(/planning your story/i)).toBeDefined();
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

  it('shows "Planning pages…" message when status is page_plan', async () => {
    const pagePlanBook = { ...MOCK_BOOK, status: BookStatus.PagePlan };
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(pagePlanBook));

    render(<BookDetailPage />);

    await waitFor(() => {
      expect(screen.getByText(/planning pages/i)).toBeDefined();
    });
  });

  // ── Image generation section ──────────────────────────────────────────────

  it('renders "Images are ready" section when imageGenerationResult is present', async () => {
    const imageGenerationResult = makeImageGenerationResult();
    const bookWithImages = {
      ...MOCK_BOOK,
      status: BookStatus.ImageGen,
      bookPreview: makeBookPreview(),
      imageGenerationResult,
    };
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(bookWithImages));

    render(<BookDetailPage />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /images are ready/i })).toBeDefined();
    });
  });

  it('renders provider label in the image generation section', async () => {
    const imageGenerationResult = makeImageGenerationResult();
    const bookWithImages = {
      ...MOCK_BOOK,
      status: BookStatus.ImageGen,
      bookPreview: makeBookPreview(),
      imageGenerationResult,
    };
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(bookWithImages));

    render(<BookDetailPage />);

    await waitFor(() => {
      expect(screen.getByText('local_mock')).toBeDefined();
    });
  });

  it('renders total image count in the image generation section', async () => {
    const imageGenerationResult = makeImageGenerationResult();
    const bookWithImages = {
      ...MOCK_BOOK,
      status: BookStatus.ImageGen,
      bookPreview: makeBookPreview(),
      imageGenerationResult,
    };
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(bookWithImages));

    render(<BookDetailPage />);

    await waitFor(() => {
      expect(screen.getByText('4')).toBeDefined();
    });
  });

  it('renders Cover entry in the image generation section', async () => {
    const imageGenerationResult = makeImageGenerationResult();
    const bookWithImages = {
      ...MOCK_BOOK,
      status: BookStatus.ImageGen,
      bookPreview: makeBookPreview(),
      imageGenerationResult,
    };
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(bookWithImages));

    render(<BookDetailPage />);

    await waitFor(() => {
      expect(screen.getByText('Cover')).toBeDefined();
    });
  });

  it('renders page image entries in the image generation section', async () => {
    const imageGenerationResult = makeImageGenerationResult();
    const bookWithImages = {
      ...MOCK_BOOK,
      status: BookStatus.ImageGen,
      bookPreview: makeBookPreview(),
      imageGenerationResult,
    };
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(bookWithImages));

    render(<BookDetailPage />);

    await waitFor(() => {
      // multiple "Page N" labels appear (book preview + image section) — at least 2 occurrences each
      expect(screen.getAllByText('Page 1').length).toBeGreaterThanOrEqual(2);
      expect(screen.getAllByText('Page 2').length).toBeGreaterThanOrEqual(2);
    });
  });

  it('renders mock image URLs in the image generation section', async () => {
    const imageGenerationResult = makeImageGenerationResult();
    const bookWithImages = {
      ...MOCK_BOOK,
      status: BookStatus.ImageGen,
      bookPreview: makeBookPreview(),
      imageGenerationResult,
    };
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(bookWithImages));

    render(<BookDetailPage />);

    await waitFor(() => {
      expect(screen.getByText('/mock-images/book-1/cover.svg')).toBeDefined();
    });
  });

  it('renders Back Cover entry in the image generation section', async () => {
    const imageGenerationResult = makeImageGenerationResult();
    const bookWithImages = {
      ...MOCK_BOOK,
      status: BookStatus.ImageGen,
      bookPreview: makeBookPreview(),
      imageGenerationResult,
    };
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(bookWithImages));

    render(<BookDetailPage />);

    await waitFor(() => {
      expect(screen.getByText('Back Cover')).toBeDefined();
    });
  });

  it('renders without crashing when imageGenerationResult is absent (old books)', async () => {
    const oldBook = {
      ...MOCK_BOOK,
      status: BookStatus.PreviewReady,
      bookPreview: makeBookPreview(),
    };
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(oldBook));

    render(<BookDetailPage />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /generated story preview/i })).toBeDefined();
      expect(screen.queryByRole('heading', { name: /images are ready/i })).toBeNull();
    });
  });

  // ── PDF section ───────────────────────────────────────────────────────────

  it('shows "Your PDF is ready" heading, Open PDF link, and Download PDF button for a completed book with generated pages', async () => {
    const completeBook: BookDto = {
      ...MOCK_BOOK,
      status: BookStatus.Complete,
      previewPdfUrl: '/files/books/book-1/storybook.pdf',
      bookPreview: makeBookPreview(),
    };
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(completeBook));

    render(<BookDetailPage />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /your pdf is ready/i })).toBeDefined();
      expect(screen.getByRole('link', { name: /open pdf/i })).toBeDefined();
      expect(screen.getByRole('button', { name: /download pdf/i })).toBeDefined();
    });
  });

  it('Open PDF link uses the stable API endpoint /books/:id/pdf/preview', async () => {
    const completeBook: BookDto = {
      ...MOCK_BOOK,
      status: BookStatus.Complete,
      previewPdfUrl: '/files/books/book-1/storybook.pdf',
      bookPreview: makeBookPreview(),
    };
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(completeBook));

    render(<BookDetailPage />);

    await waitFor(() => {
      const link = screen.getByRole('link', { name: /open pdf/i }) as HTMLAnchorElement;
      expect(link.getAttribute('href')).toBe('http://localhost:4000/api/books/book-1/pdf/preview');
    });
  });

  it('clicking Open PDF fetches the PDF via the authenticated client and opens a blob URL instead of navigating directly', async () => {
    const user = userEvent.setup();
    const completeBook: BookDto = {
      ...MOCK_BOOK,
      status: BookStatus.Complete,
      previewPdfUrl: '/files/books/book-1/storybook.pdf',
      bookPreview: makeBookPreview(),
    };
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockOk(completeBook))
      .mockResolvedValueOnce(mockPdfBlob());

    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

    render(<BookDetailPage />);
    const openLink = await screen.findByRole('link', { name: /open pdf/i });
    await user.click(openLink);

    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith('blob:mock-url', '_blank', 'noopener,noreferrer');
    });

    const calls = fetchMock.fetchFn.mock.calls as [string, RequestInit][];
    const [pdfUrl] = calls[calls.length - 1];
    expect(pdfUrl).toBe('http://localhost:4000/api/books/book-1/pdf/preview');
    expect(global.URL.createObjectURL).toHaveBeenCalled();

    openSpy.mockRestore();
  });

  it('clicking Download PDF fetches the PDF endpoint and triggers a blob download with a safe filename', async () => {
    const user = userEvent.setup();
    const completeBook: BookDto = {
      ...MOCK_BOOK,
      status: BookStatus.Complete,
      previewPdfUrl: '/files/books/book-1/storybook.pdf',
      bookPreview: makeBookPreview(),
    };
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockOk(completeBook))
      .mockResolvedValueOnce(mockPdfBlob());

    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    render(<BookDetailPage />);
    const downloadButton = await screen.findByRole('button', { name: /download pdf/i });
    await user.click(downloadButton);

    await waitFor(() => {
      expect(global.URL.createObjectURL).toHaveBeenCalled();
    });

    const calls = vi.mocked(fetch).mock.calls as [string, RequestInit][];
    const [downloadUrl] = calls[calls.length - 1];
    expect(downloadUrl).toBe('http://localhost:4000/api/books/book-1/pdf/preview');
    expect(clickSpy).toHaveBeenCalled();
    expect(global.URL.revokeObjectURL).toHaveBeenCalled();

    clickSpy.mockRestore();
  });

  it('disables the Download PDF button and shows "Preparing PDF…" while the download is in progress', async () => {
    const user = userEvent.setup();
    const completeBook: BookDto = {
      ...MOCK_BOOK,
      status: BookStatus.Complete,
      previewPdfUrl: '/files/books/book-1/storybook.pdf',
      bookPreview: makeBookPreview(),
    };

    let resolveDownload: (value: Response) => void = () => {};
    const pendingDownload = new Promise<Response>((resolve) => {
      resolveDownload = resolve;
    });

    vi.mocked(fetch)
      .mockResolvedValueOnce(mockOk(completeBook))
      .mockResolvedValueOnce(pendingDownload as unknown as Response);

    render(<BookDetailPage />);
    const downloadButton = await screen.findByRole('button', { name: /download pdf/i });
    await user.click(downloadButton);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /preparing pdf/i })).toBeDisabled();
    });

    resolveDownload(mockPdfBlob());

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^download pdf$/i })).not.toBeDisabled();
    });
  });

  it('does not trigger a second download while one is already in progress', async () => {
    const user = userEvent.setup();
    const completeBook: BookDto = {
      ...MOCK_BOOK,
      status: BookStatus.Complete,
      previewPdfUrl: '/files/books/book-1/storybook.pdf',
      bookPreview: makeBookPreview(),
    };

    let resolveDownload: (value: Response) => void = () => {};
    const pendingDownload = new Promise<Response>((resolve) => {
      resolveDownload = resolve;
    });

    vi.mocked(fetch)
      .mockResolvedValueOnce(mockOk(completeBook))
      .mockResolvedValueOnce(pendingDownload as unknown as Response);

    render(<BookDetailPage />);
    const downloadButton = await screen.findByRole('button', { name: /download pdf/i });
    await user.click(downloadButton);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /preparing pdf/i })).toBeDisabled();
    });

    const callsBeforeSecondClick = vi.mocked(fetch).mock.calls.length;
    await user.click(screen.getByRole('button', { name: /preparing pdf/i }));
    expect(vi.mocked(fetch).mock.calls.length).toBe(callsBeforeSecondClick);

    resolveDownload(mockPdfBlob());
  });

  it('shows an error message when the PDF download request fails', async () => {
    const user = userEvent.setup();
    const completeBook: BookDto = {
      ...MOCK_BOOK,
      status: BookStatus.Complete,
      previewPdfUrl: '/files/books/book-1/storybook.pdf',
      bookPreview: makeBookPreview(),
    };
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockOk(completeBook))
      .mockResolvedValueOnce(mockError(500, 'PDF render failed'));

    render(<BookDetailPage />);
    const downloadButton = await screen.findByRole('button', { name: /download pdf/i });
    await user.click(downloadButton);

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain(
        'PDF download failed. Please try again.',
      );
    });
    expect(screen.getByRole('button', { name: /^download pdf$/i })).not.toBeDisabled();
  });

  it('hides the Download PDF button when the book is complete but has no generated pages', async () => {
    const completeBookNoPages: BookDto = {
      ...MOCK_BOOK,
      status: BookStatus.Complete,
      previewPdfUrl: '/files/books/book-1/storybook.pdf',
      bookPreview: { ...makeBookPreview(), pages: [] },
    };
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(completeBookNoPages));

    render(<BookDetailPage />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /your pdf is ready/i })).toBeDefined();
    });
    expect(screen.queryByRole('button', { name: /download pdf/i })).toBeNull();
  });

  it('hides the Download PDF button when the book is complete but bookPreview is absent', async () => {
    const completeBookNoPreview: BookDto = {
      ...MOCK_BOOK,
      status: BookStatus.Complete,
      previewPdfUrl: '/files/books/book-1/storybook.pdf',
    };
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(completeBookNoPreview));

    render(<BookDetailPage />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /your pdf is ready/i })).toBeDefined();
    });
    expect(screen.queryByRole('button', { name: /download pdf/i })).toBeNull();
  });

  it('shows "Rendering PDF…" heading when status is pdf_render', async () => {
    const pdfRenderBook: BookDto = {
      ...MOCK_BOOK,
      status: BookStatus.PdfRender,
    };
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(pdfRenderBook));

    render(<BookDetailPage />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /rendering pdf/i })).toBeDefined();
    });
  });

  it('shows "Your storybook PDF is being assembled" description when status is pdf_render', async () => {
    const pdfRenderBook: BookDto = {
      ...MOCK_BOOK,
      status: BookStatus.PdfRender,
    };
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(pdfRenderBook));

    render(<BookDetailPage />);

    await waitFor(() => {
      expect(screen.getByText(/your storybook pdf is being assembled/i)).toBeDefined();
    });
  });

  it('shows fallback text when status is complete but previewPdfUrl is null', async () => {
    const completeNoUrl: BookDto = {
      ...MOCK_BOOK,
      status: BookStatus.Complete,
      previewPdfUrl: null,
    };
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(completeNoUrl));

    render(<BookDetailPage />);

    await waitFor(() => {
      expect(
        screen.getByText(/book is complete, but pdf link is not available yet/i),
      ).toBeDefined();
    });
  });

  it('does not show Open PDF or Download PDF links when complete without previewPdfUrl', async () => {
    const completeNoUrl: BookDto = {
      ...MOCK_BOOK,
      status: BookStatus.Complete,
      previewPdfUrl: null,
    };
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(completeNoUrl));

    render(<BookDetailPage />);

    await waitFor(() => {
      expect(screen.queryByRole('link', { name: /open pdf/i })).toBeNull();
      expect(screen.queryByRole('link', { name: /download pdf/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /download pdf/i })).toBeNull();
    });
  });

  it('shows generation failed message when status is failed, with no download action', async () => {
    const failedBook: BookDto = {
      ...MOCK_BOOK,
      status: BookStatus.Failed,
    };
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(failedBook));

    render(<BookDetailPage />);

    await waitFor(() => {
      expect(screen.getByText(/generation failed/i)).toBeDefined();
    });
    expect(screen.queryByRole('button', { name: /download pdf/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /download pdf/i })).toBeNull();
  });

  it('does not show PDF section for in-progress statuses like image_gen', async () => {
    const imageGenBook: BookDto = {
      ...MOCK_BOOK,
      status: BookStatus.ImageGen,
    };
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(imageGenBook));

    render(<BookDetailPage />);

    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: /your pdf is ready/i })).toBeNull();
      expect(screen.queryByRole('heading', { name: /rendering pdf/i })).toBeNull();
    });
  });

  // ── Polling ───────────────────────────────────────────────────────────────

  describe('Polling', () => {
    // Only fake setInterval/clearInterval so waitFor (which uses setTimeout) still works.
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('polls for updates when status is non-terminal and updates the UI', async () => {
      const generatingBook: BookDto = { ...MOCK_BOOK, status: BookStatus.PdfRender };
      const completeBook: BookDto = {
        ...MOCK_BOOK,
        status: BookStatus.Complete,
        previewPdfUrl: '/files/books/book-1/storybook.pdf',
      };

      vi.mocked(fetch)
        .mockResolvedValueOnce(mockOk(generatingBook))
        .mockResolvedValue(mockOk(completeBook));

      render(<BookDetailPage />);
      await waitFor(() =>
        expect(screen.getByRole('heading', { name: /rendering pdf/i })).toBeDefined(),
      );

      await vi.advanceTimersByTimeAsync(2500);

      await waitFor(() =>
        expect(screen.getByRole('heading', { name: /your pdf is ready/i })).toBeDefined(),
      );
    });

    it('stops polling when status becomes complete', async () => {
      const generatingBook: BookDto = { ...MOCK_BOOK, status: BookStatus.Layout };
      const completeBook: BookDto = {
        ...MOCK_BOOK,
        status: BookStatus.Complete,
        previewPdfUrl: '/files/books/book-1/storybook.pdf',
      };

      vi.mocked(fetch)
        .mockResolvedValueOnce(mockOk(generatingBook))
        .mockResolvedValueOnce(mockOk(completeBook));

      render(<BookDetailPage />);
      await waitFor(() => expect(screen.getByText('layout')).toBeDefined());

      await vi.advanceTimersByTimeAsync(2500);
      await waitFor(() =>
        expect(screen.getByRole('heading', { name: /your pdf is ready/i })).toBeDefined(),
      );

      const callCountAfterComplete = vi.mocked(fetch).mock.calls.length;
      await vi.advanceTimersByTimeAsync(2500);
      expect(vi.mocked(fetch).mock.calls.length).toBe(callCountAfterComplete);
    });

    it('stops polling when status becomes failed', async () => {
      const generatingBook: BookDto = { ...MOCK_BOOK, status: BookStatus.StoryDraft };
      const failedBook: BookDto = { ...MOCK_BOOK, status: BookStatus.Failed };

      vi.mocked(fetch)
        .mockResolvedValueOnce(mockOk(generatingBook))
        .mockResolvedValueOnce(mockOk(failedBook));

      render(<BookDetailPage />);
      await waitFor(() => expect(screen.getByText(/writing your story/i)).toBeDefined());

      await vi.advanceTimersByTimeAsync(2500);
      await waitFor(() => expect(screen.getByText(/generation failed/i)).toBeDefined());

      const callCountAfterFailed = vi.mocked(fetch).mock.calls.length;
      await vi.advanceTimersByTimeAsync(2500);
      expect(vi.mocked(fetch).mock.calls.length).toBe(callCountAfterFailed);
    });

    it('does not start polling when status is already terminal on initial load', async () => {
      const completeBook: BookDto = {
        ...MOCK_BOOK,
        status: BookStatus.Complete,
        previewPdfUrl: '/files/books/book-1/storybook.pdf',
      };

      vi.mocked(fetch).mockResolvedValueOnce(mockOk(completeBook));

      render(<BookDetailPage />);
      await waitFor(() =>
        expect(screen.getByRole('heading', { name: /your pdf is ready/i })).toBeDefined(),
      );

      const callCountAfterLoad = vi.mocked(fetch).mock.calls.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(vi.mocked(fetch).mock.calls.length).toBe(callCountAfterLoad);
    });
  });

  // ── Manual refresh button ─────────────────────────────────────────────────

  it('shows "Refresh status" button for non-draft books', async () => {
    const inProgress = { ...MOCK_BOOK, status: BookStatus.StoryPlan };
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(inProgress));

    render(<BookDetailPage />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /refresh status/i })).toBeDefined();
    });
  });

  it('does not show "Refresh status" button for draft books', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(MOCK_BOOK));

    render(<BookDetailPage />);

    await waitFor(() => screen.getByRole('button', { name: /generate story/i }));

    expect(screen.queryByRole('button', { name: /refresh status/i })).toBeNull();
  });

  it('Refresh status button fetches updated book and shows PDF links', async () => {
    const user = userEvent.setup();
    const generatingBook: BookDto = { ...MOCK_BOOK, status: BookStatus.PdfRender };
    const completeBook: BookDto = {
      ...MOCK_BOOK,
      status: BookStatus.Complete,
      previewPdfUrl: '/files/books/book-1/storybook.pdf',
      bookPreview: makeBookPreview(),
    };

    vi.mocked(fetch)
      .mockResolvedValueOnce(mockOk(generatingBook))
      .mockResolvedValueOnce(mockOk(completeBook));

    render(<BookDetailPage />);
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /rendering pdf/i })).toBeDefined(),
    );

    await user.click(screen.getByRole('button', { name: /refresh status/i }));

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /your pdf is ready/i })).toBeDefined(),
    );
    expect(screen.getByRole('link', { name: /open pdf/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /download pdf/i })).toBeDefined();
  });

  // ── Retry generation ──────────────────────────────────────────────────────

  describe('Retry generation', () => {
    it('shows the Retry generation button only for failed books', async () => {
      const failedBook: BookDto = { ...MOCK_BOOK, status: BookStatus.Failed };
      vi.mocked(fetch).mockResolvedValueOnce(mockOk(failedBook));

      render(<BookDetailPage />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /retry generation/i })).toBeDefined();
      });
    });

    it('does not show the Retry generation button for non-failed books', async () => {
      const inProgress = { ...MOCK_BOOK, status: BookStatus.StoryDraft };
      vi.mocked(fetch).mockResolvedValueOnce(mockOk(inProgress));

      render(<BookDetailPage />);

      await waitFor(() => expect(screen.getByText('story_draft')).toBeDefined());

      expect(screen.queryByRole('button', { name: /retry generation/i })).toBeNull();
    });

    it('calls the retry-generation API when clicked', async () => {
      const user = userEvent.setup();
      const failedBook: BookDto = { ...MOCK_BOOK, status: BookStatus.Failed };
      const retried: BookDto = { ...MOCK_BOOK, status: BookStatus.StoryDraft };
      vi.mocked(fetch)
        .mockResolvedValueOnce(mockOk(failedBook))
        .mockResolvedValueOnce(mockOk({ book: retried }));

      render(<BookDetailPage />);
      await waitFor(() => screen.getByRole('button', { name: /retry generation/i }));

      await user.click(screen.getByRole('button', { name: /retry generation/i }));

      await waitFor(() => {
        const retryCall = fetchMock.fetchFn.mock.calls.find(([input]) =>
          String(input).includes('/retry-generation'),
        );
        expect(retryCall).toBeDefined();
        const [, init] = retryCall as [unknown, RequestInit | undefined];
        expect(init?.method).toBe('POST');
      });
    });

    it('disables the button while the retry request is in progress', async () => {
      const failedBook: BookDto = { ...MOCK_BOOK, status: BookStatus.Failed };
      let resolveRetry: (value: Response) => void = () => {};
      const pending = new Promise<Response>((resolve) => {
        resolveRetry = resolve;
      });
      const fetchFn = vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/retry-generation')) return pending;
        if (url.includes('/generation-diagnostics')) {
          return Promise.resolve(mockOk(DEFAULT_DIAGNOSTICS));
        }
        return Promise.resolve(mockOk(failedBook));
      });
      vi.stubGlobal('fetch', fetchFn);

      render(<BookDetailPage />);
      await waitFor(() => screen.getByRole('button', { name: /retry generation/i }));

      fireEvent.click(screen.getByRole('button', { name: /retry generation/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /retrying/i })).toBeDisabled();
      });

      resolveRetry(mockOk({ book: { ...failedBook, status: BookStatus.StoryDraft } }));

      await waitFor(() => expect(screen.getByText('story_draft')).toBeDefined());
    });

    it('shows a safe error message when the retry request fails', async () => {
      const user = userEvent.setup();
      const failedBook: BookDto = { ...MOCK_BOOK, status: BookStatus.Failed };
      vi.mocked(fetch)
        .mockResolvedValueOnce(mockOk(failedBook))
        .mockResolvedValueOnce(mockError(500, 'Internal server error'));

      render(<BookDetailPage />);
      await waitFor(() => screen.getByRole('button', { name: /retry generation/i }));

      await user.click(screen.getByRole('button', { name: /retry generation/i }));

      await waitFor(() => {
        expect(screen.getByRole('alert').textContent).toContain('Internal server error');
      });
    });

    describe('polling resumption', () => {
      beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      });
      afterEach(() => {
        vi.useRealTimers();
      });

      it('resumes status/diagnostics polling after a successful retry', async () => {
        const failedBook: BookDto = { ...MOCK_BOOK, status: BookStatus.Failed };
        const retriedBook: BookDto = { ...MOCK_BOOK, status: BookStatus.StoryDraft };
        const completeBook: BookDto = {
          ...MOCK_BOOK,
          status: BookStatus.Complete,
          previewPdfUrl: '/files/books/book-1/storybook.pdf',
        };

        vi.mocked(fetch)
          .mockResolvedValueOnce(mockOk(failedBook))
          .mockResolvedValueOnce(mockOk({ book: retriedBook }))
          .mockResolvedValue(mockOk(completeBook));

        render(<BookDetailPage />);
        await waitFor(() => screen.getByRole('button', { name: /retry generation/i }));

        fireEvent.click(screen.getByRole('button', { name: /retry generation/i }));

        await waitFor(() => expect(screen.getByText('story_draft')).toBeDefined());

        await vi.advanceTimersByTimeAsync(2500);

        await waitFor(() =>
          expect(screen.getByRole('heading', { name: /your pdf is ready/i })).toBeDefined(),
        );
      });
    });
  });

  // ── Status messages ───────────────────────────────────────────────────────

  it('shows "Rendering PDF…" status message in banner when status is pdf_render', async () => {
    const pdfRenderBook: BookDto = { ...MOCK_BOOK, status: BookStatus.PdfRender };
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(pdfRenderBook));

    render(<BookDetailPage />);

    // Both the PdfSection heading and the generating banner contain "Rendering PDF"
    await waitFor(() => {
      expect(screen.getAllByText(/rendering pdf/i).length).toBeGreaterThan(0);
    });
  });

  it('shows "Designing book pages…" status message when status is layout', async () => {
    const layoutBook: BookDto = { ...MOCK_BOOK, status: BookStatus.Layout };
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(layoutBook));

    render(<BookDetailPage />);

    await waitFor(() => {
      expect(screen.getByText(/designing book pages/i)).toBeDefined();
    });
  });

  it('does not show the generating status banner for complete status', async () => {
    const completeBook: BookDto = {
      ...MOCK_BOOK,
      status: BookStatus.Complete,
      previewPdfUrl: null,
    };
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(completeBook));

    render(<BookDetailPage />);

    await waitFor(() =>
      expect(
        screen.getByText(/book is complete, but pdf link is not available yet/i),
      ).toBeDefined(),
    );

    expect(screen.queryByText(/generation in progress/i)).toBeNull();
  });

  // ── Generation diagnostics panel ──────────────────────────────────────────

  describe('Generation diagnostics panel', () => {
    it('renders provider, model, generated pages, and duration info', async () => {
      const generatingBook: BookDto = { ...MOCK_BOOK, status: BookStatus.ImageGen };
      vi.mocked(fetch).mockResolvedValueOnce(mockOk(generatingBook));
      queueDiagnostics(
        mockOk(
          makeDiagnostics({
            status: BookStatus.ImageGen,
            generationMetadata: {
              storyProvider: 'openai',
              storyModel: 'gpt-4o-mini',
              imageProvider: 'openai',
              imageModel: 'dall-e-3',
              generatedPages: 2,
              requestedPages: 4,
              durationMs: 65_000,
            },
          }),
        ),
      );

      render(<BookDetailPage />);

      await waitFor(() => {
        const panel = within(screen.getByTestId('generation-diagnostics'));
        expect(panel.getByText(/openai \(gpt-4o-mini\)/)).toBeDefined();
        expect(panel.getByText(/openai \(dall-e-3\)/)).toBeDefined();
        expect(panel.getByText('2 / 4')).toBeDefined();
        expect(panel.getByText('1m 5s')).toBeDefined();
      });
    });

    it('shows failedStep and a safe errorMessage when generation fails', async () => {
      const failedBook: BookDto = { ...MOCK_BOOK, status: BookStatus.Failed };
      vi.mocked(fetch).mockResolvedValueOnce(mockOk(failedBook));
      queueDiagnostics(
        mockOk(
          makeDiagnostics({
            status: BookStatus.Failed,
            failedStep: AgentStep.ImageGen,
            errorMessage: 'Image provider returned an error after 3 attempts.',
          }),
        ),
      );

      render(<BookDetailPage />);

      await waitFor(() => {
        const panel = within(screen.getByTestId('generation-diagnostics'));
        expect(
          panel.getByText(
            (_, element) =>
              element?.tagName.toLowerCase() === 'p' &&
              element.textContent === 'Failed step: image_gen',
          ),
        ).toBeDefined();
        expect(panel.getByText('Image provider returned an error after 3 attempts.')).toBeDefined();
        expect(panel.getByText(/try again later, or check diagnostics/i)).toBeDefined();
      });
    });

    it('shows a PDF-ready indicator when previewPdfUrl is present in diagnostics', async () => {
      const completeBook: BookDto = {
        ...MOCK_BOOK,
        status: BookStatus.Complete,
        previewPdfUrl: '/files/books/book-1/storybook.pdf',
      };
      vi.mocked(fetch).mockResolvedValueOnce(mockOk(completeBook));
      queueDiagnostics(
        mockOk(
          makeDiagnostics({
            status: BookStatus.Complete,
            previewPdfUrl: '/files/books/book-1/storybook.pdf',
          }),
        ),
      );

      render(<BookDetailPage />);

      await waitFor(() => {
        const panel = within(screen.getByTestId('generation-diagnostics'));
        expect(panel.getByText('PDF:')).toBeDefined();
        expect(panel.getByText('ready')).toBeDefined();
      });
    });

    it('does not crash and shows the book normally when the diagnostics request fails', async () => {
      const generatingBook: BookDto = { ...MOCK_BOOK, status: BookStatus.StoryPlan };
      vi.mocked(fetch).mockResolvedValueOnce(mockOk(generatingBook));
      queueDiagnostics(mockError(500, 'Internal server error'));

      render(<BookDetailPage />);

      await waitFor(() => {
        expect(screen.getByRole('heading', { level: 1, name: "Emma's Story" })).toBeDefined();
        expect(screen.getByText('story_plan')).toBeDefined();
      });
      expect(screen.queryByTestId('generation-diagnostics')).toBeNull();
    });

    describe('polling', () => {
      beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      });
      afterEach(() => {
        vi.useRealTimers();
      });

      it('refreshes diagnostics on each poll tick while generating', async () => {
        const generatingBook: BookDto = { ...MOCK_BOOK, status: BookStatus.ImageGen };
        vi.mocked(fetch)
          .mockResolvedValueOnce(mockOk(generatingBook))
          .mockResolvedValue(mockOk(generatingBook));
        queueDiagnostics(
          mockOk(
            makeDiagnostics({
              status: BookStatus.ImageGen,
              generationMetadata: {
                storyProvider: 'mock',
                imageProvider: 'mock',
                generatedPages: 1,
              },
            }),
          ),
        );
        queueDiagnostics(
          mockOk(
            makeDiagnostics({
              status: BookStatus.ImageGen,
              generationMetadata: {
                storyProvider: 'mock',
                imageProvider: 'mock',
                generatedPages: 3,
              },
            }),
          ),
        );

        render(<BookDetailPage />);

        await waitFor(() => {
          const panel = within(screen.getByTestId('generation-diagnostics'));
          expect(panel.getByText('1')).toBeDefined();
        });

        await vi.advanceTimersByTimeAsync(2500);

        await waitFor(() => {
          const panel = within(screen.getByTestId('generation-diagnostics'));
          expect(panel.getByText('3')).toBeDefined();
        });
      });

      it('stops fetching diagnostics once status becomes terminal', async () => {
        const generatingBook: BookDto = { ...MOCK_BOOK, status: BookStatus.StoryDraft };
        const failedBook: BookDto = { ...MOCK_BOOK, status: BookStatus.Failed };
        vi.mocked(fetch)
          .mockResolvedValueOnce(mockOk(generatingBook))
          .mockResolvedValueOnce(mockOk(failedBook));
        queueDiagnostics(mockOk(makeDiagnostics({ status: BookStatus.StoryDraft })));
        queueDiagnostics(
          mockOk(
            makeDiagnostics({
              status: BookStatus.Failed,
              failedStep: AgentStep.StoryDraft,
              errorMessage: 'Story provider timed out.',
            }),
          ),
        );

        render(<BookDetailPage />);
        await waitFor(() => expect(screen.getByText(/writing your story/i)).toBeDefined());

        await vi.advanceTimersByTimeAsync(2500);
        await waitFor(() => expect(screen.getByText(/generation failed/i)).toBeDefined());

        // let any fetch triggered by the status transition itself settle before snapshotting
        await vi.advanceTimersByTimeAsync(0);
        const callCountAfterFailed = fetchMock.fetchFn.mock.calls.length;
        await vi.advanceTimersByTimeAsync(2500);
        expect(fetchMock.fetchFn.mock.calls.length).toBe(callCountAfterFailed);
      });
    });
  });
});
