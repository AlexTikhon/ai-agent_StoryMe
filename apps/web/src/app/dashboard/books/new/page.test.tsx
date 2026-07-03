import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter } from 'next/navigation';
import NewBookPage from './page';
import { SupportedLanguage, BookStatus } from '@book/types';
import type { BookDto } from '@book/types';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('next/navigation', () => ({
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
  title: "Oliver's Story",
  childName: 'Oliver',
  childAge: 4,
  language: SupportedLanguage.English,
  theme: 'Space adventure',
  educationalMessage: null,
  pageCount: 6,
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

describe('NewBookPage wizard', () => {
  const pushMock = vi.fn();

  beforeEach(() => {
    vi.mocked(useRouter).mockReturnValue({ push: pushMock } as unknown as ReturnType<
      typeof useRouter
    >);
    vi.stubGlobal('fetch', vi.fn());
    pushMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── Step navigation ────────────────────────────────────────────────────────

  it('starts on step 1 showing the child fields', () => {
    render(<NewBookPage />);
    expect(screen.getByRole('heading', { name: /about the child/i })).toBeDefined();
    expect(screen.getByPlaceholderText(/e\.g\. emma/i)).toBeDefined();
  });

  it('advances to step 2 when Next is clicked with a valid child name', async () => {
    const user = userEvent.setup();
    render(<NewBookPage />);

    await user.type(screen.getByPlaceholderText(/e\.g\. emma/i), 'Oliver');
    await user.click(screen.getByRole('button', { name: 'Next' }));

    expect(screen.getByRole('heading', { name: /about the story/i })).toBeDefined();
  });

  it('does not advance step 1 when child name is empty', async () => {
    const user = userEvent.setup();
    render(<NewBookPage />);

    // child name starts empty — click Next without typing anything
    await user.click(screen.getByRole('button', { name: 'Next' }));

    expect(screen.getByRole('heading', { name: /about the child/i })).toBeDefined();
  });

  it('goes back from step 2 to step 1', async () => {
    const user = userEvent.setup();
    render(<NewBookPage />);

    await user.type(screen.getByPlaceholderText(/e\.g\. emma/i), 'Oliver');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Back' }));

    expect(screen.getByRole('heading', { name: /about the child/i })).toBeDefined();
  });

  it('advances from step 2 to step 3 (review) when theme is filled', async () => {
    const user = userEvent.setup();
    render(<NewBookPage />);

    await user.type(screen.getByPlaceholderText(/e\.g\. emma/i), 'Oliver');
    await user.click(screen.getByRole('button', { name: 'Next' }));

    await user.type(screen.getByPlaceholderText(/friendship/i), 'Space adventure');
    await user.click(screen.getByRole('button', { name: 'Next' }));

    expect(screen.getByRole('heading', { name: /review/i })).toBeDefined();
  });

  it('does not advance step 2 when theme is empty', async () => {
    const user = userEvent.setup();
    render(<NewBookPage />);

    await user.type(screen.getByPlaceholderText(/e\.g\. emma/i), 'Oliver');
    await user.click(screen.getByRole('button', { name: 'Next' }));

    // theme is empty — click Next without filling it
    await user.click(screen.getByRole('button', { name: 'Next' }));

    expect(screen.getByRole('heading', { name: /about the story/i })).toBeDefined();
  });

  it('goes back from step 3 to step 2', async () => {
    const user = userEvent.setup();
    render(<NewBookPage />);

    await user.type(screen.getByPlaceholderText(/e\.g\. emma/i), 'Oliver');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.type(screen.getByPlaceholderText(/friendship/i), 'Space adventure');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Back' }));

    expect(screen.getByRole('heading', { name: /about the story/i })).toBeDefined();
  });

  // ── Review step shows all values ───────────────────────────────────────────

  it('shows all selected values on the review step', async () => {
    const user = userEvent.setup();
    render(<NewBookPage />);

    await user.type(screen.getByPlaceholderText(/e\.g\. emma/i), 'Emma');
    const ageInput = screen.getByRole('spinbutton');
    await user.clear(ageInput);
    await user.type(ageInput, '6');
    await user.click(screen.getByRole('button', { name: 'Next' }));

    await user.type(screen.getByPlaceholderText(/friendship/i), 'Dragons');
    await user.click(screen.getByRole('button', { name: 'Next' }));

    expect(screen.getByText(/emma, age 6/i)).toBeDefined();
    expect(screen.getByText(/dragons/i)).toBeDefined();
    expect(screen.getByText(/english/i)).toBeDefined();
  });

  // ── Successful create ──────────────────────────────────────────────────────

  it('calls POST /books and redirects to /dashboard on success', async () => {
    const user = userEvent.setup();
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(MOCK_BOOK, 201));

    render(<NewBookPage />);

    await user.type(screen.getByPlaceholderText(/e\.g\. emma/i), 'Oliver');
    await user.click(screen.getByRole('button', { name: 'Next' }));

    await user.type(screen.getByPlaceholderText(/friendship/i), 'Space adventure');
    await user.click(screen.getByRole('button', { name: 'Next' }));

    await user.click(screen.getByRole('button', { name: 'Create Book' }));

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith('/dashboard');
    });

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/books');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.childName).toBe('Oliver');
    expect(body.theme).toBe('Space adventure');
  });

  // ── Phase 4A: pageCount + educationalMessage ───────────────────────────────

  it('sends a trimmed CreateBookInput payload with a default pageCount and language', async () => {
    const user = userEvent.setup();
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(MOCK_BOOK, 201));

    render(<NewBookPage />);

    await user.type(screen.getByPlaceholderText(/e\.g\. emma/i), '  Oliver  ');
    await user.click(screen.getByRole('button', { name: 'Next' }));

    await user.type(screen.getByPlaceholderText(/friendship/i), '  Space adventure  ');
    await user.click(screen.getByRole('button', { name: 'Next' }));

    await user.click(screen.getByRole('button', { name: 'Create Book' }));

    await waitFor(() => expect(pushMock).toHaveBeenCalled());

    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.childName).toBe('Oliver');
    expect(body.theme).toBe('Space adventure');
    expect(body.title).toBe("Oliver's Story");
    expect(body.language).toBe('en');
    expect(body.pageCount).toBe(6);
    expect(body.educationalMessage).toBeUndefined();
  });

  it('shows a pageCount selector bounded to [4, 12] on the story step', async () => {
    const user = userEvent.setup();
    render(<NewBookPage />);

    await user.type(screen.getByPlaceholderText(/e\.g\. emma/i), 'Oliver');
    await user.click(screen.getByRole('button', { name: 'Next' }));

    const pageCountSelect = screen.getByRole('combobox', { name: /number of pages/i });
    const options = Array.from(pageCountSelect.querySelectorAll('option')).map((o) => o.value);
    expect(options).toEqual(['4', '5', '6', '7', '8', '9', '10', '11', '12']);
  });

  it('includes the trimmed educationalMessage in the payload when provided', async () => {
    const user = userEvent.setup();
    vi.mocked(fetch).mockResolvedValueOnce(mockOk(MOCK_BOOK, 201));

    render(<NewBookPage />);

    await user.type(screen.getByPlaceholderText(/e\.g\. emma/i), 'Oliver');
    await user.click(screen.getByRole('button', { name: 'Next' }));

    await user.type(screen.getByPlaceholderText(/friendship/i), 'Space adventure');
    await user.type(
      screen.getByPlaceholderText(/it's okay to make mistakes/i),
      '  Sharing is caring  ',
    );
    const pageCountSelect = screen.getByRole('combobox', { name: /number of pages/i });
    await user.selectOptions(pageCountSelect, '10');
    await user.click(screen.getByRole('button', { name: 'Next' }));

    await user.click(screen.getByRole('button', { name: 'Create Book' }));

    await waitFor(() => expect(pushMock).toHaveBeenCalled());

    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.educationalMessage).toBe('Sharing is caring');
    expect(body.pageCount).toBe(10);
  });

  it('shows loading state while creating', async () => {
    const user = userEvent.setup();
    // Never resolve so we can check the loading state
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(() => undefined));

    render(<NewBookPage />);

    await user.type(screen.getByPlaceholderText(/e\.g\. emma/i), 'Oliver');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.type(screen.getByPlaceholderText(/friendship/i), 'Space');
    await user.click(screen.getByRole('button', { name: 'Next' }));

    await user.click(screen.getByRole('button', { name: 'Create Book' }));

    expect(screen.getByRole('button', { name: /creating/i })).toBeDefined();
  });

  it('shows an error alert when the API call fails', async () => {
    const user = userEvent.setup();
    vi.mocked(fetch).mockResolvedValueOnce(mockError(500, 'Server error'));

    render(<NewBookPage />);

    await user.type(screen.getByPlaceholderText(/e\.g\. emma/i), 'Oliver');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.type(screen.getByPlaceholderText(/friendship/i), 'Space');
    await user.click(screen.getByRole('button', { name: 'Next' }));

    await user.click(screen.getByRole('button', { name: 'Create Book' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeDefined();
      expect(screen.getByRole('alert').textContent).toContain('Server error');
    });
    // Should NOT have redirected
    expect(pushMock).not.toHaveBeenCalled();
  });
});
