import type { BookDeletionRequestDto } from '@book/types';
import { isDeletionInProgress, type TrackedDeletion } from './use-book-deletions';

function describeFailure(request: BookDeletionRequestDto): string {
  switch (request.lastErrorCode) {
    case 'ARTIFACT_LIST_FAILED':
    case 'ARTIFACT_DELETE_FAILED': {
      const remaining = request.remainingArtifactCount;
      return remaining > 0
        ? `${remaining} stored file${remaining === 1 ? '' : 's'} could not be removed yet.`
        : 'Some stored files could not be removed yet.';
    }
    case 'BOOK_WORK_STILL_ACTIVE':
    case 'DATABASE_FINALIZATION_BLOCKED':
      return 'Background work for this book is still stopping.';
    default:
      return 'Something went wrong while erasing this book.';
  }
}

interface DeletionStatusPanelProps {
  deletions: TrackedDeletion[];
  retryingBookId: string | null;
  onRetry: (bookId: string, title: string | null) => void;
  onDismiss: (bookId: string) => void;
}

/**
 * Permanent deletion is asynchronous, so a removed card is not the end of the
 * story: this surfaces each request's progress, the retryable failures, and
 * the final confirmation.
 */
export function DeletionStatusPanel({
  deletions,
  retryingBookId,
  onRetry,
  onDismiss,
}: DeletionStatusPanelProps) {
  if (deletions.length === 0) return null;

  return (
    <section aria-label="Permanent deletions" className="mb-6 space-y-2">
      {deletions.map(({ request, title }) => {
        const label = title ? `“${title}”` : 'a book';
        return (
          <div
            key={request.id}
            role={request.status === 'retry_pending' ? 'alert' : 'status'}
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border-subtle bg-bg-surface px-4 py-3 text-sm"
          >
            {isDeletionInProgress(request.status) && (
              <p className="text-text-secondary">Deletion pending — permanently erasing {label}…</p>
            )}
            {request.status === 'retry_pending' && (
              <>
                <p className="text-danger-base">
                  Deleting {label} didn&apos;t finish. {describeFailure(request)}
                </p>
                <button
                  type="button"
                  onClick={() => onRetry(request.bookId, title)}
                  disabled={retryingBookId === request.bookId}
                  className="font-semibold text-violet-700 hover:text-violet-600 disabled:opacity-60"
                >
                  {retryingBookId === request.bookId ? 'Retrying…' : 'Retry deletion'}
                </button>
              </>
            )}
            {request.status === 'completed' && (
              <>
                <p className="text-text-secondary">
                  Permanently deleted {label}, including its stored files.
                </p>
                <button
                  type="button"
                  onClick={() => onDismiss(request.bookId)}
                  className="font-semibold text-text-muted hover:text-text-secondary"
                >
                  Dismiss
                </button>
              </>
            )}
          </div>
        );
      })}
    </section>
  );
}
