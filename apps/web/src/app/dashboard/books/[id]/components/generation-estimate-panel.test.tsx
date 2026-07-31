import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { booksApi } from '@/lib/api/books';
import { GenerationEstimatePanel } from './generation-estimate-panel';

vi.mock('@/lib/api/books', () => ({
  booksApi: { getGenerationEstimate: vi.fn() },
}));

describe('GenerationEstimatePanel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders only the server-owned estimate and labels cost as an estimate', async () => {
    vi.mocked(booksApi.getGenerationEstimate).mockResolvedValue({
      kind: 'initial',
      providerMode: 'real',
      storyCalls: 1,
      characterProfileCalls: 1,
      imageCalls: 9,
      repairAllowanceCalls: 1,
      maximumProviderCalls: 12,
      reusedProviderCalls: 0,
      estimatedCostUsd: { minimum: 0.41, maximum: 0.41, label: 'estimate' },
      expectedDurationSeconds: { minimum: 30, maximum: 90 },
    });

    fireEvent.click(
      render(<GenerationEstimatePanel bookId="book-1" kind="initial" />).getByRole('button', {
        name: /view provider-work estimate/i,
      }),
    );

    expect(await screen.findByText(/estimated provider work: 12 calls/i)).toBeInTheDocument();
    expect(screen.getByText(/estimated external cost: \$0.41/i)).toHaveTextContent(
      'This is an estimate, not a quote.',
    );
    expect(screen.getByText(/expected duration: 30–90 seconds/i)).toBeInTheDocument();
    expect(booksApi.getGenerationEstimate).toHaveBeenCalledWith('book-1', 'initial');
  });

  it('shows zero external calls and cost for mock generation', async () => {
    vi.mocked(booksApi.getGenerationEstimate).mockResolvedValue({
      kind: 'initial',
      providerMode: 'mock',
      storyCalls: 0,
      characterProfileCalls: 0,
      imageCalls: 0,
      repairAllowanceCalls: 0,
      maximumProviderCalls: 0,
      reusedProviderCalls: 0,
      estimatedCostUsd: { minimum: 0, maximum: 0, label: 'estimate' },
    });

    fireEvent.click(
      render(<GenerationEstimatePanel bookId="book-1" kind="initial" />).getByRole('button', {
        name: /view provider-work estimate/i,
      }),
    );

    expect(await screen.findByText(/estimated provider work: 0 calls/i)).toBeInTheDocument();
    expect(screen.getByText(/estimated external cost: \$0.00/i)).toBeInTheDocument();
  });
});
