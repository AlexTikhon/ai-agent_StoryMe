import type {
  GenerationDiagnosticsDto,
  LatestGenerationAttemptDiagnostics,
  PublishedEditionDiagnostics,
  RunProviderUsageProjection,
} from '@book/types';
import type { ReactNode } from 'react';

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

const UNAVAILABLE_REASONS: Record<string, string> = {
  never_claimed: 'never started by a worker',
  ledger_absent: 'no provider ledger recorded',
  source_run_unavailable: 'source run not recorded',
  legacy_publication: 'published before run tracking',
  run_record_missing: 'run record not found',
};

function unavailable(reason: string): string {
  return `Unavailable (${UNAVAILABLE_REASONS[reason] ?? reason})`;
}

function formatUsage(projection: RunProviderUsageProjection): string {
  if (projection.availability === 'unavailable') return unavailable(projection.reason);
  const { calls, actualPaidCalls } = projection.usage;
  return `${calls.length} provider call${calls.length === 1 ? '' : 's'}, ${actualPaidCalls} paid`;
}

/** Distinct providers recorded in this run's own ledger; never inferred from logs. */
function ledgerProviders(projection: RunProviderUsageProjection): string | null {
  if (projection.availability !== 'recorded') return null;
  const providers = [...new Set(projection.usage.calls.map(({ provider }) => provider))];
  return providers.length > 0 ? providers.join(', ') : null;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="inline font-medium">{label}: </dt>
      <dd className="inline text-text-secondary">{children}</dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="mt-3 border-t border-border-subtle pt-3">
      <h3 className="mb-2 font-display text-xs font-semibold text-text-secondary">{title}</h3>
      {children}
    </section>
  );
}

const flag = (value: boolean) => (value ? '✓' : '—');

function PublishedEditionSection({
  edition,
  pdfStorage,
}: {
  edition: PublishedEditionDiagnostics | null;
  pdfStorage: GenerationDiagnosticsDto['pdfStorage'];
}) {
  if (!edition) {
    return (
      <Section title="Published edition">
        <p className="text-xs text-text-muted">No published edition yet.</p>
      </Section>
    );
  }
  const source = edition.sourceGenerationRun;
  const record = edition.generationRecord;
  const personalization = edition.characterPersonalization;
  return (
    <Section title="Published edition">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-text-muted">
        <Field label="Edition">
          <code>{edition.edition}</code>
        </Field>
        <Field label="Source run">
          {source.availability === 'recorded' ? (
            <>
              <code>{source.runId}</code> ({source.kind}, {source.status})
            </>
          ) : (
            unavailable(source.reason)
          )}
        </Field>
        {source.availability === 'recorded' && (
          <>
            <Field label="Source completed">
              {source.timestamps.completedAt ?? 'not recorded'}
            </Field>
            <Field label="Source run wall clock">
              {source.runWallClockDurationMs !== null
                ? formatDurationMs(source.runWallClockDurationMs)
                : 'not recorded'}
            </Field>
          </>
        )}
        {edition.pageCount !== undefined && <Field label="Pages">{edition.pageCount}</Field>}
        {record.storyModel && <Field label="Story model">{record.storyModel}</Field>}
        {record.imageModel && <Field label="Image model">{record.imageModel}</Field>}
        {record.generatedImageCount !== undefined && (
          <Field label="Generated images">{record.generatedImageCount}</Field>
        )}
        <Field label="PDF">
          {pdfStorage.previewAvailable ? 'ready' : 'not found in storage (checked now)'}
        </Field>
        <Field label="Base generation usage">{formatUsage(edition.baseGenerationUsage)}</Field>
      </dl>
      {edition.revisedAfterGeneration && (
        <p className="mt-1 text-xs text-text-muted">
          Includes page revisions made after the source run. Base generation usage covers the source
          run only.
        </p>
      )}
      <h4 className="mb-1 mt-2 text-xs font-semibold text-text-secondary">
        Character personalization
      </h4>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-text-muted">
        <Field label="Reference photo">{flag(personalization.hasReferencePhoto)}</Field>
        <Field label="Character profile">{flag(personalization.characterProfileCreated)}</Field>
        <Field label="Character sheet">{flag(personalization.characterSheetGenerated)}</Field>
        <Field label="Consistent prompts">
          {flag(personalization.pagePromptsIncludeConsistencyData)}
        </Field>
      </dl>
    </Section>
  );
}

function LatestAttemptSection({
  attempt,
  stalledNoWorker,
}: {
  attempt: LatestGenerationAttemptDiagnostics | null;
  stalledNoWorker: boolean;
}) {
  if (!attempt) {
    return (
      <Section title="Latest generation attempt">
        <p className="text-xs text-text-muted">No generation attempt recorded.</p>
      </Section>
    );
  }
  const providers = ledgerProviders(attempt.providerUsage);
  const finishedAt =
    attempt.timestamps.completedAt ?? attempt.timestamps.failedAt ?? attempt.timestamps.cancelledAt;
  return (
    <Section title="Latest generation attempt">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-text-muted">
        <Field label="Run">
          <code>{attempt.runId}</code>
        </Field>
        <Field label="Status">
          {attempt.status} ({attempt.kind})
        </Field>
        <Field label="Published">
          {attempt.isPublishedSource ? 'source of the published edition' : 'not published'}
        </Field>
        <Field label="Started">{attempt.timestamps.startedAt ?? 'not recorded'}</Field>
        <Field label="Finished">{finishedAt ?? 'not recorded'}</Field>
        <Field label="Run wall clock">
          {attempt.runWallClockDurationMs !== null
            ? formatDurationMs(attempt.runWallClockDurationMs)
            : 'not recorded'}
        </Field>
        <Field label="Provider usage">{formatUsage(attempt.providerUsage)}</Field>
        {providers && <Field label="Providers">{providers}</Field>}
      </dl>

      {attempt.error && (
        <div className="mt-3 rounded-lg bg-danger-light px-3 py-2 text-xs text-danger-base">
          {attempt.error.failedStep && (
            <p>
              <span className="font-medium">Failed step:</span> {attempt.error.failedStep}
            </p>
          )}
          {attempt.error.message && <p>{attempt.error.message}</p>}
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
    </Section>
  );
}

export interface GenerationDiagnosticsPanelProps {
  diagnostics: GenerationDiagnosticsDto | null;
  diagnosticsError: string | null;
}

/**
 * Developer-facing diagnostics isolated from the product-facing book view.
 * The published edition and the latest generation attempt are rendered from
 * their own projections and never borrow each other's fields.
 */
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

  return (
    <div
      data-testid="generation-diagnostics"
      className="mb-6 rounded-xl border border-border-default bg-stone-50 p-4"
    >
      <h2 className="font-display text-sm font-semibold text-text-secondary">
        Generation diagnostics
      </h2>
      <PublishedEditionSection
        edition={diagnostics.publishedEdition ?? null}
        pdfStorage={diagnostics.pdfStorage}
      />
      <LatestAttemptSection
        attempt={diagnostics.latestAttempt ?? null}
        stalledNoWorker={diagnostics.queue?.stalledNoWorker ?? false}
      />
      <Section title="Book-level recent logs">
        <p className="text-xs text-text-muted">
          {diagnostics.recentLogs.length} most recent log entries for this book across all runs; not
          scoped to the latest attempt.
        </p>
      </Section>
    </div>
  );
}
