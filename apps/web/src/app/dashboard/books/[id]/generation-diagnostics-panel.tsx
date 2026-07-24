import type { GenerationDiagnosticsDto } from '@book/types';

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

export interface GenerationDiagnosticsPanelProps {
  diagnostics: GenerationDiagnosticsDto | null;
  diagnosticsError: string | null;
}

/** Developer-facing diagnostics isolated from the product-facing book view. */
export function GenerationDiagnosticsPanel({
  diagnostics,
  diagnosticsError,
}: GenerationDiagnosticsPanelProps) {
  if (!diagnostics && !diagnosticsError) return null;
  if (!diagnostics) {
    return (
      <div className="mb-6 rounded-xl border border-border-default bg-stone-50 p-4 text-xs text-text-muted">
        Diagnostics unavailable{diagnosticsError ? `: ${diagnosticsError}` : '.'}
      </div>
    );
  }

  const meta =
    diagnostics.generationMetadata ??
    ({} as Partial<GenerationDiagnosticsDto['generationMetadata']>);
  const hasFailure = Boolean(diagnostics.failedStep ?? diagnostics.errorMessage);
  const stalledNoWorker = diagnostics.queue?.stalledNoWorker ?? false;

  return (
    <div
      data-testid="generation-diagnostics"
      className="mb-6 rounded-xl border border-border-default bg-stone-50 p-4"
    >
      <h2 className="mb-3 font-display text-sm font-semibold text-text-secondary">
        Generation diagnostics
      </h2>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-text-muted">
        {meta.storyProvider && (
          <div>
            <dt className="inline font-medium">Story: </dt>
            <dd className="inline text-text-secondary">
              {meta.storyProvider}
              {meta.storyModel ? ` (${meta.storyModel})` : ''}
            </dd>
          </div>
        )}
        {meta.imageProvider && (
          <div>
            <dt className="inline font-medium">Images: </dt>
            <dd className="inline text-text-secondary">
              {meta.imageProvider}
              {meta.imageModel ? ` (${meta.imageModel})` : ''}
            </dd>
          </div>
        )}
        {meta.generatedPages !== undefined && (
          <div>
            <dt className="inline font-medium">Generated pages: </dt>
            <dd className="inline text-text-secondary">
              {meta.generatedPages}
              {meta.requestedPages != null ? ` / ${meta.requestedPages}` : ''}
            </dd>
          </div>
        )}
        {meta.durationMs !== undefined && (
          <div>
            <dt className="inline font-medium">Duration: </dt>
            <dd className="inline text-text-secondary">{formatDurationMs(meta.durationMs)}</dd>
          </div>
        )}
        {diagnostics.previewPdfUrl && (
          <div>
            <dt className="inline font-medium">PDF: </dt>
            <dd className="inline text-text-secondary">ready</dd>
          </div>
        )}
      </dl>

      {diagnostics.characterPersonalization && (
        <div className="mt-3 border-t border-border-subtle pt-3">
          <h3 className="mb-2 font-display text-xs font-semibold text-text-secondary">
            Character personalization
          </h3>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-text-muted">
            <div>
              <dt className="inline font-medium">Reference photo: </dt>
              <dd className="inline text-text-secondary">
                {diagnostics.characterPersonalization.hasReferencePhoto ? '✓' : '—'}
              </dd>
            </div>
            <div>
              <dt className="inline font-medium">Character profile: </dt>
              <dd className="inline text-text-secondary">
                {diagnostics.characterPersonalization.characterProfileCreated ? '✓' : '—'}
              </dd>
            </div>
            <div>
              <dt className="inline font-medium">Character sheet: </dt>
              <dd className="inline text-text-secondary">
                {diagnostics.characterPersonalization.characterSheetGenerated ? '✓' : '—'}
              </dd>
            </div>
            <div>
              <dt className="inline font-medium">Consistent prompts: </dt>
              <dd className="inline text-text-secondary">
                {diagnostics.characterPersonalization.pagePromptsIncludeConsistencyData ? '✓' : '—'}
              </dd>
            </div>
          </dl>
        </div>
      )}

      {hasFailure && (
        <div className="mt-3 rounded-lg bg-danger-light px-3 py-2 text-xs text-danger-base">
          {diagnostics.failedStep && (
            <p>
              <span className="font-medium">Failed step:</span> {diagnostics.failedStep}
            </p>
          )}
          {diagnostics.errorMessage && <p>{diagnostics.errorMessage}</p>}
          <p className="mt-1 text-text-muted">
            Try again later, or check diagnostics for more detail.
          </p>
        </div>
      )}

      {stalledNoWorker && (
        <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <p className="font-medium">Generation job queued, but no worker is processing it.</p>
          <p className="mt-1 text-text-muted">
            The API isn&apos;t consuming generation jobs — set ENABLE_GENERATION_WORKER=true (local
            single-process dev) or start the worker with{' '}
            <code>pnpm --filter @book/api dev:worker</code>.
          </p>
        </div>
      )}
    </div>
  );
}
