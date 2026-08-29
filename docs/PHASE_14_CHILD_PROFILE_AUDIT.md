# Phase 14A Child Profile Audit

Date: 2026-08-29

## Scope and source

This audit was performed against the extracted `AI-AGENT-safe-2026-08-29.zip` snapshot before
Phase 14A runtime changes. The archive contains no Git metadata, secrets, dependencies, build
output, or generated user artifacts. `docs/CURRENT_PRODUCT.md` correctly reports that reusable
child-profile management is not implemented.

## Existing reusable schema

- `ChildProfile` already stores an owner (`userId`), `name`, `age`, optional nickname/birthday,
  pronouns, optional avatar JSON, optional `photoAssetId`, timestamps, and `deletedAt`. It relates
  to `Book` and `CharacterCard` rows.
- `Book.childProfileId` is nullable and its foreign key uses `ON DELETE SET NULL`. A Book also has
  the already-established generation input fields `childName` and `childAge`.
- `Upload` stores an owner and mutable processing/storage fields (`r2Key`, `processedR2Key`, and
  `processedUrl`). It has no deletion tombstone, content digest, immutable revision identity, or
  explicit reference-count/retention contract.
- `CharacterCard.childProfileId` is nullable and uses `ON DELETE SET NULL`, but CharacterCard is
  not part of this vertical slice.
- `GenerationRun.inputSnapshot` is JSON plus a canonical SHA-256 `inputHash`. The current v2
  runtime schema includes `childName`, `childAge`, language, theme, lesson, page count, and a full
  immutable per-book photo identity.
- The initial and regenerate paths call `buildInputSnapshot(book)`. The retry path normalizes and
  copies the previous run's snapshot instead of reading mutable Book or profile state.

The initial migration already created all profile/book columns and foreign keys needed by Phase
14A. Historical migrations must remain unchanged.

## Missing runtime functionality

- There is no child-profile controller, service, DTO validation, mapping, API type, or frontend
  API client.
- There is no authenticated profile list/management screen.
- Book create/update DTOs do not accept `childProfileId`, and Book CRUD does not resolve a profile
  or copy its values.
- `BookDto` does not expose the selected profile identifier, so the edit UI cannot distinguish a
  saved-profile selection from manual details or explain a deleted selection.
- The create/edit UI has no profile loading, selection, reapply, manual-entry, empty, or
  deleted-profile state.
- No focused unit, integration, frontend, or E2E coverage exists for reusable profiles.

## Ownership and privacy risks

- Looking up a profile by globally unique ID without `userId` and `deletedAt: null` would allow
  cross-account selection or existence probing. Every read and mutation must use the composite
  owner/active predicate and return the same 404 for missing, deleted, or differently owned rows.
- The API must derive `userId` only from the authenticated principal and must not accept it in a
  DTO.
- Returning Prisma rows directly would expose internal fields such as `photoAssetId`,
  `avatarConfig`, and deletion state. Phase 14A needs an explicit public projection containing
  only id, name, age, and timestamps.
- Unbounded profile creation/listing is an abuse and accidental-data-retention risk. The slice
  will cap active profiles per user at 20 and cap list page size at 20.
- A profile update racing with book selection must not make generation consult live profile data.
  Resolution and Book writes will be transaction-scoped; after the Book write, only Book fields
  are authoritative for generation.

## Mutable profile versus immutable generation boundary

`ChildProfile` is mutable convenience data. `Book.childProfileId` records which reusable profile
was explicitly applied, while `Book.childName` and `Book.childAge` are the draft snapshot. Applying
or reapplying a profile atomically copies the profile's current name and age to those Book fields.
Editing or deleting the profile does not update any Book.

`GenerationRun.inputSnapshot` remains independent of `ChildProfile`: initial generation and
regeneration snapshot the Book fields; retry copies the failed run's original snapshot verbatim.
No worker, provider, resume, publication, or retry path will query `ChildProfile`. This preserves
the existing hashing, fencing, cancellation, retry, publication, provider-budget, privacy, and
artifact-storage invariants.

The manual one-off flow remains valid with `Book.childProfileId = null`. On edit, sending
`childProfileId: null` explicitly detaches the reusable profile without discarding the Book's
snapshotted name/age. Omitting the field preserves the current association. Sending an active,
owned profile ID explicitly reapplies its current values.

## Profile photo decision

Reusable profile photos are deferred to Phase 14B. The current safe per-book photo path mints a
fresh asset key per upload and stores SHA-256, content type, and byte size on Book before copying
that full identity into each GenerationRun. `Upload`/`ChildProfile.photoAssetId` does not provide
those same immutability and retention guarantees, and the hard-delete workflow deletes artifacts
by Book namespace without a shared-asset reference model. Reusing an Upload now could delete bytes
still referenced by a Book/run, expose mutable storage metadata, or bypass the rule that original
photo bytes go only to the character-profile stage and never page-image generation.

Phase 14A will neither read nor return `photoAssetId`. Existing per-book child-photo behavior stays
unchanged.

## Migration decision

No forward migration is required. The existing nullable relation, Book snapshot columns,
ChildProfile owner field, and `deletedAt` support the complete Phase 14A slice. A composite index
could optimize a much larger profile collection, but the active-profile cap of 20 makes a new
index unnecessary for this release.

## Exact implementation plan

1. Add shared safe `ChildProfileDto`/page/input types and expose `BookDto.childProfileId`.
2. Add authenticated `ChildProfilesModule`, DTOs, controller, and owner-scoped service with
   normalized name/age validation, active-only pagination, a 20-profile cap, and soft deletion.
3. Extend book create/update inputs with optional `childProfileId`; resolve active ownership in a
   transaction, copy name/age to Book, allow explicit null detachment on update, and never query a
   profile during generation.
4. Add a focused `/dashboard/child-profiles` management page and navigation link.
5. Add saved-profile selection and manual-entry controls to new/edit book forms, including
   loading, empty, error, authorization-safe, and deleted-profile states plus the immutable-book
   explanation.
6. Add unit tests for validation, CRUD/ownership/soft deletion, Book application/snapshotting,
   clients, and UI; add disposable-Postgres integration coverage and a Home Edition Playwright
   profile-to-book flow without provider calls.
7. Update current-product, API, local-demo/E2E, and privacy documentation; validate Prisma,
   typecheck, tests, offline evaluation, build, integration, Playwright, lint, and formatting as
   available in the extracted no-Git workspace.
