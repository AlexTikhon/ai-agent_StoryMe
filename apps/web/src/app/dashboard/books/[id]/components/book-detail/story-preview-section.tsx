import type { BookPreview, BookPreviewPage } from '@book/types';

export function BookPreviewSection({ preview }: { preview: BookPreview }) {
  const previewPages = Array.isArray(preview.pages) ? preview.pages : [];

  return (
    <div className="mb-6 rounded-xl border border-teal-100 bg-teal-50 p-4">
      <h2 className="mb-3 font-display text-base font-semibold text-teal-800">
        Generated story preview
      </h2>

      <div className="mb-4 rounded-lg border border-teal-100 bg-white p-3 text-sm">
        <p className="mb-0.5 font-semibold text-text-primary">{preview.title}</p>
        <p className="mb-2 text-xs text-text-muted">{preview.subtitle}</p>
        <div className="mb-1 text-xs text-teal-700">
          <span className="font-medium">Cover illustration:</span>{' '}
          {preview.cover.illustrationPrompt}
        </div>
      </div>

      {previewPages.length > 0 ? (
        <ul className="mb-4 space-y-3">
          {previewPages.map((page) => (
            <BookPreviewPageItem key={page.pageNumber} page={page} />
          ))}
        </ul>
      ) : (
        <p className="mb-4 rounded-lg border border-teal-100 bg-white p-3 text-sm text-text-muted">
          No pages were generated for this preview yet.
        </p>
      )}

      <div className="mb-3 rounded-lg border border-teal-100 bg-white p-3 text-sm">
        <p className="mb-0.5 font-medium text-text-primary">Back cover</p>
        <p className="mb-1 text-text-secondary">{preview.backCover.message}</p>
        <p className="text-xs text-text-muted">{preview.backCover.educationalSummary}</p>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-text-muted">
        <div>
          <dt className="inline font-medium">Language: </dt>
          <dd className="inline">{preview.metadata.language}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Theme: </dt>
          <dd className="inline">{preview.metadata.theme}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Age: </dt>
          <dd className="inline">{preview.metadata.childAge}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Pages: </dt>
          <dd className="inline">{preview.metadata.totalPages}</dd>
        </div>
      </dl>
    </div>
  );
}

function BookPreviewPageItem({ page }: { page: BookPreviewPage }) {
  return (
    <li className="rounded-lg border border-teal-100 bg-white p-3 text-sm">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="rounded-full bg-teal-100 px-2 py-0.5 text-xs font-semibold text-teal-700">
          Page {page.pageNumber}
        </span>
        <span className="text-xs text-text-muted">{page.layout}</span>
      </div>
      <p className="mb-0.5 font-medium text-text-primary">{page.title}</p>
      <p className="mb-1 leading-relaxed text-text-secondary">{page.text}</p>
      <p className="mb-0.5 text-xs text-teal-600">
        <span className="font-medium">Illustration:</span> {page.illustrationPrompt}
      </p>
      <p className="text-xs text-teal-500">
        <span className="font-medium">Learning goal:</span> {page.learningGoal}
      </p>
    </li>
  );
}

// ── ImageGenerationSection ────────────────────────────────────────────────────
