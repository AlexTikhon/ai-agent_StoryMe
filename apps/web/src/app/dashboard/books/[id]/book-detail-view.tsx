import { BookDetailContent, type BookDetailContentProps } from './components/book-detail-content';

/**
 * Composition root for the book detail screen. Server state remains owned by
 * `use-book-detail.ts`; focused child components own only their local action
 * state.
 */
export function BookDetailView(props: BookDetailContentProps) {
  return <BookDetailContent {...props} />;
}

export {
  getMissingDraftFields,
  BookDetailSkeleton,
  NotFoundState,
} from './components/book-detail-content';
