# Recovery demonstration

One browser journey shows three things about a book that already has a published edition:

- a real provider failure during regeneration leaves the published edition in place;
- a retry publishes a replacement edition;
- cancelling a later regeneration leaves that replacement in place.

The journey uses the real local API, BullMQ queue and worker, PostgreSQL, Redis, and local
artifact storage. The failure comes from the mock image provider inside the worker. No HTTP
response is intercepted, and no status is written to the database by the test.

The mechanisms behind each step (fenced publication, checkpoint reuse, cancellation) are
explained in the [generation case study](generation-case-study.md#5-failure-sequence-the-recovery-journey).

## Command

```bash
pnpm verify:local --profile browser
```

The `browser` profile runs the ordinary journeys first. If they pass, it runs the recovery
journey on the same disposable PostgreSQL/Redis. It uses the preflight, failure reporting, and
cleanup described in [local-verification.md](local-verification.md). You need Docker running,
Playwright Chromium installed, and ports `5440`, `6380`, `4100`, `3100` free.

To run only the recovery journey, start the disposable infrastructure yourself:

```bash
pnpm test:infra:up
pnpm --filter @book/web test:e2e:recovery
pnpm test:infra:down
```

When run directly, the API inherits your shell environment and can fill in values from
`apps/api/.env`. `verify:local` removes inherited credentials first, so use it for evidence.

## Configuration

The journey is `apps/web/e2e/storyme.recovery.spec.ts`. Only
`apps/web/playwright.recovery.config.ts` runs it, and the base `playwright.config.ts` ignores it.
The recovery config reuses the base settings (mock providers, local storage, JWT auth, home
mode, the guarded disposable targets) and changes these:

| Setting                 | Value | Why                                                                      |
| ----------------------- | ----- | ------------------------------------------------------------------------ |
| `MOCK_FAILURE_STAGE`    | image | Inject at the image provider                                             |
| `MOCK_FAILURE_PAGE`     | 2     | Only the page-2 illustration matches                                     |
| `MOCK_FAILURE_ON_MATCH` | 2     | Only the second matching call fails, once                                |
| `MOCK_STAGE_DELAY_MS`   | 1500  | Bounded delay per mock provider call, so a regeneration can be cancelled |
| workers / retries       | 1 / 0 | One run with no retries, so a failure is never hidden                    |

The failure settings go only to the API process this config starts. The ordinary journeys
start their own API without them, and `verify:local` removes any `MOCK_*` variables inherited
from your shell.

The match count is kept in memory by the image provider's failure controller, one per API
process. Calls for other stages and pages do not count. Concurrent matching calls are numbered
in the order they start. Production startup still rejects `MOCK_FAILURES_ENABLED=true`. Without
`MOCK_FAILURE_ON_MATCH`, every matching call fails, as before.

## Expected transitions

| Step                             | Page-2 call    | Book status               | Published edition |
| -------------------------------- | -------------- | ------------------------- | ----------------- |
| Create and generate              | match 1, ok    | `char_build` … `complete` | A                 |
| Change theme, regenerate         | match 2, fails | active, then `failed`     | A                 |
| Retry generation (UI)            | match 3, ok    | active, then `complete`   | B                 |
| Change theme, regenerate, cancel | not relevant   | active, then `cancelled`  | B                 |

The regeneration fails because the PDF stage refuses to publish a book with a missing page
illustration. The book is marked `failed`, and the earlier publication is not touched.

## Published diagnostics vs. current-run telemetry

`GET /books/:id/generation-diagnostics` mixes two sources, and the journey only reads each one
for what it actually describes:

| Fields                       | Source                                    | Describes                            |
| ---------------------------- | ----------------------------------------- | ------------------------------------ |
| `latestJob`, `providerUsage` | the newest `GenerationRun` and its ledger | the run in progress or just finished |
| `imageFailures`, `resume`    | `Book.imageGenerationResult`              | the published edition                |

Only a successful publication replaces `Book.imageGenerationResult`. After the failed
regeneration, `imageFailures` is still the empty list from edition A, and `resume` still reports
`finalBookStatus: complete`. The page-2 failure shows up only in the latest run's
`providerUsage.calls`. The journey therefore checks that failure in the run ledger.
`providerUsage` falls back to the Book snapshot when a run has no ledger, so the journey also
requires `actualDispatches`, which only the per-run ledger reports. A run cancelled while still
queued has no ledger. Its `providerUsage` is then the published edition's snapshot. For the
cancelled run the journey therefore checks only the run's identity, type and status.

Every user action creates a new `GenerationRun`. The journey records each `latestJob.id` and
requires the next one to be new, so evidence after an action can't come from an earlier run. A
regeneration is still reported as `type: generate`, for API compatibility. Only a retry reports
`type: retry`.

## Evidence checked

Every wait polls the API or UI with a timeout. The test never sleeps for a fixed time.

- **Initial publication (A):** edition id, title and page text from `GET /books/:id`, and the
  bytes of the PDF and cover read with `?edition=A`. The PDF must start with `%PDF-`, end with
  `%%EOF`, and contain a page object. The cover must be a PNG with a valid header and size.
  Both are hashed with SHA-256. The run is a completed `generate`, and its single page-2
  illustration call (match 1) succeeded.
- **Failure:** the book status becomes `failed`. The latest run is new, a failed `generate`
  run with `failedStep: pdf_render`. Its ledger holds exactly one page-2 illustration call:
  provider `mock`, status `error`, `failureKind: provider_error`. It is the only call in the
  run that did not succeed, and the other illustrations succeeded. The book's and the run's
  error messages both say the page 2 illustration is missing. The UI says the new version
  could not be generated.
- **A still served after the failure:** same edition, title, page text, PDF hash and cover
  hash. The reader shows A's title and decodes its cover. The UI's **Download PDF** button
  saves a file whose hash equals A's PDF hash. All of this is checked again after a browser
  reload.
- **Retry (B):** the latest run is a new, completed `retry`. A retry may reuse checkpointed
  story and illustrations, so the journey doesn't require every provider call to run again.
  It requires only that page 2 was illustrated again (match 3, `mock`, success) and that no
  call in the run failed. B's publication replaces the Book-level diagnostics, so
  `imageFailures` is empty. The edition id changes, the title changes, and no page text from A remains. B's PDF and cover pass the same
  byte checks. Requests for edition A's PDF and cover return `409`. The reader shows B, and
  the downloaded PDF matches B's hash.
- **Cancellation:** the cancel button is clicked while the API reports an active status. The
  book becomes `cancelled`, and the latest run is a new `generate` run whose status is
  `cancelled`. Edition, text, PDF hash and cover hash are still B's. This is checked again after a reload, including a UI download whose hash
  matches B's.

The test does not use a PDF hash difference as proof that content changed, because rendering
metadata alone could change it. The proof that B is new content is the new edition id and the
changed title and page text.

## Limitations

- This shows that the system recovers from a **mock provider failure**, a retry, and a
  cancellation. It does not show recovery from a worker or API crash, a lost Redis job, or a
  database outage.
- It does not test real-model output, real-provider error handling, rate limits, or cost. Mock
  providers only, with no paid calls.
- The failure is one deterministic page-2 illustration failure. This journey does not exercise
  story or character failures, repeated failures, or storage failures.
- Only Chromium is used, with one synthetic account and local storage drivers (no S3/R2).
- The cancellation relies on the 1.5-second delay per provider call. If the regeneration
  finishes before the cancel request is handled, the run fails with a clear error. It does not
  pass silently.
- Passing unit tests for the failure injector and the verifier are not runtime evidence. Only a
  real `pnpm verify:local --profile browser` run counts.
