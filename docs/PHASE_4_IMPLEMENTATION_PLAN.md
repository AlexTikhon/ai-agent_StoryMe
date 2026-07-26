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

Next:

- Produce a server-owned price quote for exactly one page image.
- Require an explicit confirmation token before any paid provider call.
- Charge/refund idempotently and fence concurrent image regeneration attempts.
- Version only the selected image, reuse every unaffected artifact, and atomically publish the
  rebuilt layout/PDF.
- Keep the previous publication readable on provider, storage, render, or publication failure.

Whole-book free-form editing, concurrent collaborative editors, unbounded revision history, and
silent paid calls remain out of scope.
