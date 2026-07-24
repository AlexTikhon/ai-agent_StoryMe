# Small-Production Plan

StoryMe should remain a deterministic durable workflow: no LangGraph, multiple autonomous agents,
unbounded repair loops, new providers, or SaaS-scale abstractions.

## Phase 2: separate existing responsibilities

**User value:** safer, faster maintenance. **Technical scope:** extract typed pipeline stages and
a thin `AgentService` orchestrator; split `BooksService` into CRUD, generation, asset, and
diagnostics services; separate product UI from diagnostics in `book-detail-view.tsx`; migrate
away from `GenerationJob`; decide whether each unused Prisma model stays or is removed.
**Migration risk:** high around transactions, fencing, retry, and diagnostics. **Acceptance:**
existing contracts/tests remain green; all writes retain fencing/coordinator boundaries; each
service is narrow/tested; legacy removal has an explicit migration and unused-model decisions are
recorded. **Out of scope:** product features, provider/billing/framework changes, output changes,
and unrelated schema redesign.

## Phase 3: reader, previews, and honest progress

**User value:** read and recognize books without internal details. **Technical scope:**
authenticated in-browser reader; real image previews; library cover thumbnail; progress derived
from actual execution stages; diagnostics behind an explicit development/admin flag.
**Migration risk:** medium-high for ownership, claim scoping, and truthful progress.
**Acceptance:** only owners can fetch every published asset; reader shows every page; library
shows the published cover; progress has durable evidence; ordinary production users see no
diagnostics. **Out of scope:** editing, public sharing, analytics, and broad UI redesign.

## Phase 4: one-page changes

**User value:** correct one page without replacing a good book. **Technical scope:** edit one
page's text; regenerate one page image; version the changed artifact; reuse all unaffected
artifacts; rebuild only dependent layout/PDF; show/confirm cost before a paid call.
**Migration risk:** high because partial publication must never corrupt the published book.
**Acceptance:** unchanged identities remain unchanged; failure preserves the previous published
book; only requested calls occur; paid cost is confirmed; retry is idempotent/fenced.
**Out of scope:** whole-book free-form editing, concurrent editors, unbounded history, and silent
paid calls.

## Phase 5: bounded quality and repair

**User value:** fewer consistency and age-suitability problems. **Technical scope:** deterministic
checks followed by at most one optional typed LLM repair; validate the candidate before
publication. **Migration risk:** medium-high for cost, latency, and safe failure. **Acceptance:**
checks are deterministic/tested; one repair maximum; budgets include it; failed validation
preserves the prior publication; telemetry contains no private content. **Out of scope:**
autonomous agents, recursive reflection, multiple repair attempts, and replacing human review.

## Phase 6: E2E, observability, and retention

**User value:** release-tested journeys, diagnosable failures, and deliberate private-data
lifecycle. **Technical scope:** Playwright register/login, mock generation, cancellation, retry,
and PDF download; structured request/run correlation; privacy-aware retention and hard-delete
across PostgreSQL and local/cloud artifacts. **Migration risk:** high for concurrent deletion;
medium for privacy-safe logging. **Acceptance:** E2E uses disposable mock data; correlation spans
API/outbox/worker without prompts/photos/tokens; retention is configurable; hard-delete is
owned, auditable, idempotent, fences active runs, and reports retriable provider failures.
**Out of scope:** automatic deletion without explicit policy, destructive startup cleanup,
warehouse exports, and unsupported compliance claims.
