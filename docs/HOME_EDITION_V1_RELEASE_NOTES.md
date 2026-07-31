# Home Edition v1 release notes

StoryMe Home Edition provides a complete local family-book journey with
deterministic mock story, character, and image providers. Families can create a
book, view a server-owned work estimate, generate and read it, download its PDF,
correct page text, explicitly regenerate an illustration, retry a failed first
generation, regenerate a published book, and permanently delete a disposable
book and its artifacts.

Publication is revision-safe: a prior successful book remains readable during
a regeneration, failed or cancelled regeneration does not replace it, and a
successful regeneration atomically replaces the story/page/image/PDF
publication. Reloads resolve to the authoritative publication.

Home mode requires no credit purchase or paid provider. Page-image confirmation
is retained with a server-owned zero-credit quote; demo mode retains positive
credit costs when configured. PostgreSQL owns durable workflow/publication
state, Redis/BullMQ owns queued work, and workers use fencing tokens and leases
to reject stale writes.

PDF output embeds Noto Sans for English, Russian, and Polish glyph coverage.
The release harness uses disposable PostgreSQL and Redis, local artifact
storage, mock providers, changed-file quality gates, and browser coverage for
publication, correction, cancellation, retry, replacement, and deletion.

This release is a Home Edition milestone. It does not claim public-production
or commercial SaaS readiness and does not include a real-provider smoke test.
