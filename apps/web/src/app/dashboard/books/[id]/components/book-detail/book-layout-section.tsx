import type { BookLayout, BookLayoutEntry, IllustrationPlan } from '@book/types';

export function BookLayoutSection({ layout }: { layout: BookLayout }) {
  const coverEntry = layout.entries.find((e) => e.kind === 'cover');
  const pageEntries = layout.entries.filter((e) => e.kind === 'page');
  const backCoverEntry = layout.entries.find((e) => e.kind === 'back_cover');

  return (
    <div className="mb-6 rounded-xl border border-rose-100 bg-rose-50 p-4">
      <h2 className="mb-3 font-display text-base font-semibold text-rose-800">Layout is ready</h2>

      <dl className="mb-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-text-muted">
        <div>
          <dt className="inline font-medium">Trim size: </dt>
          <dd className="inline text-text-secondary">{layout.trimSize}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Status: </dt>
          <dd className="inline text-text-secondary">{layout.status}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Pages: </dt>
          <dd className="inline text-text-secondary">{layout.metadata.totalPages}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Entries: </dt>
          <dd className="inline text-text-secondary">{layout.entries.length}</dd>
        </div>
      </dl>

      <ul className="space-y-2">
        {coverEntry && <LayoutEntryCard entry={coverEntry} />}
        {pageEntries.map((entry) => (
          <LayoutEntryCard key={entry.id} entry={entry} />
        ))}
        {backCoverEntry && <LayoutEntryCard entry={backCoverEntry} />}
      </ul>
    </div>
  );
}

function LayoutEntryCard({ entry }: { entry: BookLayoutEntry }) {
  const kindLabel =
    entry.kind === 'cover'
      ? 'Cover'
      : entry.kind === 'back_cover'
        ? 'Back Cover'
        : `Page ${entry.pageNumber}`;

  return (
    <li className="rounded-lg border border-rose-100 bg-white p-3 text-xs">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-700">
          {kindLabel}
        </span>
        <span className="font-mono text-text-muted">{entry.template}</span>
      </div>
      <p className="mb-0.5 text-text-muted">
        <span className="font-medium">Canvas: </span>
        <span className="text-text-secondary">
          {entry.canvas.width}×{entry.canvas.height}
          {entry.canvas.unit}
        </span>
      </p>
      {entry.imageBlock && (
        <p className="mb-0.5 text-text-muted">
          <span className="font-medium">Image: </span>
          <span className="font-mono text-text-secondary">{entry.imageBlock.imageUrl}</span>
        </p>
      )}
      {entry.textBlock && (
        <p className="text-text-muted">
          <span className="font-medium">Text: </span>
          <span className="text-text-secondary">
            {entry.textBlock.text.slice(0, 80)}
            {entry.textBlock.text.length > 80 ? '…' : ''}
          </span>
        </p>
      )}
    </li>
  );
}

// ── IllustrationPlanDetail ────────────────────────────────────────────────────

export function IllustrationPlanDetail({ illust }: { illust: IllustrationPlan }) {
  return (
    <dl className="space-y-1 text-xs">
      <div>
        <dt className="inline font-medium text-text-muted">Prompt: </dt>
        <dd className="inline text-text-secondary">{illust.prompt}</dd>
      </div>
      <div>
        <dt className="inline font-medium text-text-muted">Negative prompt: </dt>
        <dd className="inline text-text-secondary">{illust.negativePrompt}</dd>
      </div>
      <div>
        <dt className="inline font-medium text-text-muted">Style: </dt>
        <dd className="inline text-text-secondary">{illust.style}</dd>
      </div>
      <div>
        <dt className="inline font-medium text-text-muted">Aspect ratio: </dt>
        <dd className="inline text-text-secondary">{illust.aspectRatio}</dd>
      </div>
      <div>
        <dt className="inline font-medium text-text-muted">Characters: </dt>
        <dd className="inline text-text-secondary">{illust.characters.join(', ')}</dd>
      </div>
      <div>
        <dt className="inline font-medium text-text-muted">Setting: </dt>
        <dd className="inline text-text-secondary">{illust.setting}</dd>
      </div>
      <div>
        <dt className="inline font-medium text-text-muted">Mood: </dt>
        <dd className="inline text-text-secondary">{illust.mood}</dd>
      </div>
      <div>
        <dt className="inline font-medium text-text-muted">Consistency notes: </dt>
        <dd className="inline text-text-secondary">{illust.consistencyNotes}</dd>
      </div>
    </dl>
  );
}

// ── PdfSection ────────────────────────────────────────────────────────────────
