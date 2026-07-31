'use client';

import { useState } from 'react';
import type { GenerationEstimateDto, GenerationEstimateKind } from '@book/types';
import { booksApi } from '@/lib/api/books';

export function GenerationEstimatePanel({
  bookId,
  kind,
}: {
  bookId: string;
  kind: GenerationEstimateKind;
}) {
  const [estimate, setEstimate] = useState<GenerationEstimateDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setEstimate(await booksApi.getGenerationEstimate(bookId, kind));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to load generation estimate');
    } finally {
      setLoading(false);
    }
  };

  if (!estimate) {
    return (
      <div className="mb-3 text-center text-xs text-text-muted">
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="font-semibold text-violet-700 underline hover:no-underline disabled:opacity-60"
        >
          {loading ? 'Estimating…' : 'View provider-work estimate'}
        </button>
        {error && <p role="alert">{error}</p>}
      </div>
    );
  }

  return (
    <div className="mb-3 rounded-lg bg-violet-50 px-4 py-3 text-xs text-violet-900">
      <p className="font-semibold">
        Estimated provider work: {estimate.maximumProviderCalls} call
        {estimate.maximumProviderCalls === 1 ? '' : 's'} ({estimate.imageCalls} image)
      </p>
      {estimate.reusedProviderCalls > 0 && (
        <p>{estimate.reusedProviderCalls} reusable call(s) are excluded.</p>
      )}
      {estimate.estimatedCostUsd && (
        <p>
          Estimated external cost: ${estimate.estimatedCostUsd.minimum.toFixed(2)}
          {estimate.estimatedCostUsd.maximum !== estimate.estimatedCostUsd.minimum &&
            `–$${estimate.estimatedCostUsd.maximum.toFixed(2)}`}
          . This is an estimate, not a quote.
        </p>
      )}
      {estimate.expectedDurationSeconds && (
        <p>
          Expected duration: {estimate.expectedDurationSeconds.minimum}–
          {estimate.expectedDurationSeconds.maximum} seconds.
        </p>
      )}
    </div>
  );
}
