# Phase 4: One-page changes

Phase 4 is being delivered in two bounded slices so that free text corrections and paid image
generation do not share an ambiguous cost or failure boundary.

## Slice 4A — page text revision

Implemented in `agent/one-page-changes`:

- An owner can edit the text of one page on a completed book.
- `expectedVersion` provides optimistic concurrency. A stale editor receives
  `409 PAGE_VERSION_CONFLICT` instead of overwriting newer work.
- The page version, preview, layout, rebuilt PDF, and independent published-PDF pointer move in
  one transaction after the candidate PDF has been saved.
- Existing cover and page images stay in the original published generation namespace. No story or
  image provider is called, and no credit is charged.
- A render/storage failure or a lost publication compare-and-swap leaves the previous published
  book untouched. Unreferenced candidate artifacts remain eligible for normal claim cleanup.
- A later successful whole-book generation atomically clears page revision rows and the independent
  PDF pointer, making the new generation the complete source of truth.

The route is `PATCH /api/books/:id/pages/:pageNumber/text` with:

```json
{
  "text": "Corrected page narration",
  "expectedVersion": 1
}
```

## Slice 4B — page image revision

Implemented in `agent/one-page-image-changes`:

- The server produces a ten-minute quote for exactly one page image without charging a credit or
  invoking the image provider.
- Explicit confirmation atomically reserves the book, deducts one credit with a revision-scoped
  idempotency key, and creates the durable outbox event.
- The worker makes one logical paid image call, saves candidate artifacts in a fenced immutable
  namespace, reuses every unaffected image, and atomically publishes the selected image plus the
  rebuilt layout/PDF.
- Provider, storage, render, and stale-publication failures leave the previous publication
  readable, clear the reservation, and refund the credit idempotently.
- Whole-book generation, page text changes, and another page-image confirmation are rejected while
  a page-image revision owns the book. Cleanup protects both active and published page-image
  namespaces.

The routes are:

- `POST /api/books/:id/pages/:pageNumber/image-regeneration-quote`
- `POST /api/books/:id/pages/:pageNumber/image-revisions/:revisionId/confirm`
- `GET /api/books/:id/page-image-revisions/:revisionId`

BullMQ is configured for one attempt for this paid job. The provider may still perform its own
bounded transport retries. A hard process failure after the provider accepts a request cannot
provide strict external exactly-once semantics unless the provider offers an idempotency key;
database charging, refunding, fencing, and publication remain idempotent.

Whole-book free-form editing, concurrent collaborative editors, unbounded revision history, and
silent paid calls remain out of scope.
