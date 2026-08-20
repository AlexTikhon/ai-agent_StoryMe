import type { GeneratedImageEntry, ImageGenerationResult } from '@book/types';

export function ImageGenerationSection({ result }: { result: ImageGenerationResult }) {
  const coverImage = result.images.find((img) => img.kind === 'cover');
  const pageImages = result.images.filter((img) => img.kind === 'page');
  const backCoverImage = result.images.find((img) => img.kind === 'back_cover');

  return (
    <div className="mb-6 rounded-xl border border-sky-100 bg-sky-50 p-4">
      <h2 className="mb-3 font-display text-base font-semibold text-sky-800">Images are ready</h2>

      <dl className="mb-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-text-muted">
        <div>
          <dt className="inline font-medium">Rendered by: </dt>
          <dd className="inline text-text-secondary">{result.imageByteProvider ?? 'unknown'}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Status: </dt>
          <dd className="inline text-text-secondary">{result.status}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Total images: </dt>
          <dd className="inline text-text-secondary">{result.images.length}</dd>
        </div>
      </dl>

      <ul className="space-y-2">
        {coverImage && <ImageEntryCard image={coverImage} />}
        {pageImages.map((img) => (
          <ImageEntryCard key={img.id} image={img} />
        ))}
        {backCoverImage && <ImageEntryCard image={backCoverImage} />}
      </ul>
    </div>
  );
}

function ImageEntryCard({ image }: { image: GeneratedImageEntry }) {
  const kindLabel =
    image.kind === 'cover'
      ? 'Cover'
      : image.kind === 'back_cover'
        ? 'Back Cover'
        : `Page ${image.pageNumber}`;

  return (
    <li className="rounded-lg border border-sky-100 bg-white p-3 text-xs">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="rounded-full bg-sky-100 px-2 py-0.5 text-xs font-semibold text-sky-700">
          {kindLabel}
        </span>
        <span className="font-mono text-text-muted">{image.imageUrl}</span>
      </div>
      <p className="mb-0.5 text-text-muted">
        <span className="font-medium">Alt: </span>
        <span className="text-text-secondary">{image.altText}</span>
      </p>
      <p className="text-text-muted">
        <span className="font-medium">Size: </span>
        <span className="text-text-secondary">
          {image.width}×{image.height}px
        </span>
      </p>
    </li>
  );
}

// ── BookLayoutSection ─────────────────────────────────────────────────────────
