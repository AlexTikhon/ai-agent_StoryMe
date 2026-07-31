# Phase 7 schema and lifecycle audit

Date: 2026-07-31

Scope: repository-derived audit only. No table, column, enum, or migration was removed.

## Method and evidence boundary

The audit compared `apps/api/prisma/schema.prisma`, every committed migration, and runtime
delegate references under `apps/api/src`, `apps/api/scripts`, `apps/web/src`, `packages`, and
`scripts`. Delegate usage was searched independently from similarly named JSON properties (for
example, `Book.characterCard` is active JSON data and is not the `CharacterCard` Prisma model).

The repository cannot prove that a deployed database contains zero rows. Therefore no destructive
migration is safe to create from source inspection alone. Before any future removal, run read-only
row counts and foreign-key checks against every deployed environment and archive any data that has
an owner-approved retention need.

## Model decision table

| Prisma model    | Actual runtime delegate usage                                                                                                                                           | Foreign-key/data dependencies                                                                                                                   | Existing migration and deployed-data risk                                                       | Recommendation                                                                                                                 | Required removal sequence                                                                                                                                                                                                      | Rollback                                                                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Upload`        | No `prisma.upload` delegate call. Current child-photo upload writes storage keys directly on `Book`.                                                                    | `User.uploads`; optional `ChildProfile.photoAssetId` uses `ON DELETE SET NULL`. May point at R2 objects not represented elsewhere.              | Created in the initial migration; row and object existence is unknown.                          | Retain/deprecate. It is unused now, but its `ChildProfile` link and storage-key ownership make repository-only removal unsafe. | Count rows and non-null `ChildProfile.photoAssetId`; inventory referenced objects; choose object retention/deletion policy; null child-profile FKs; drop FK/table; drop `UploadStatus` only after proving no other dependency. | Restore table/FK/enum migration and import the archived rows; retained object keys must remain recoverable.                                        |
| `CharacterCard` | No `prisma.characterCard` delegate call. Active generation uses `Book.characterCard` JSON.                                                                              | `User`, optional `ChildProfile`, and optional `BookSeries.characterCardId`; contains possible LoRA object keys.                                 | Initial migration; unknown rows and external objects.                                           | Deprecation candidate, not proven safe. Do not confuse it with active `Book.characterCard` JSON.                               | Count rows; inventory LoRA keys; remove/replace `BookSeries` references first; export rows; drop FKs/table.                                                                                                                    | Recreate table/FKs and restore exported rows/object keys.                                                                                          |
| `BookSeries`    | Active maintenance-only usage: hard deletion reads and updates `prisma.bookSeries` to remove a deleted book UUID from `bookIds`. No create/read product flow was found. | `User`, optional `CharacterCard`; denormalized `bookIds` has no FK but is coupled to hard deletion.                                             | Initial migration and live hard-delete behavior make immediate removal unsafe.                  | Retain until series is explicitly retired. If retired, remove hard-delete coupling in the same reviewed change.                | Count/export rows; decide fate of memberships; remove hard-delete delegate path; remove `User.series`/`CharacterCard.series`; drop table.                                                                                      | Restore table and hard-delete cleanup logic, then import memberships.                                                                              |
| `WizardDraft`   | No delegate usage. Current draft flow persists directly to `Book(status=created)`.                                                                                      | Optional unique `User` FK; `childProfileId` is a UUID-shaped scalar without a Prisma relation.                                                  | Initial migration; guest or user drafts may exist in deployed data.                             | Removal candidate after deployed row/expiry audit.                                                                             | Count active/unexpired rows; export if needed; confirm no external client calls it; remove `User.wizardDraft`; drop table.                                                                                                     | Recreate table/indexes/FK and restore unexpired rows.                                                                                              |
| `ShareLink`     | No delegate usage and no public-sharing route/UI.                                                                                                                       | `Book.shareLinks`, cascade on book deletion; token/password-hash data may be security-sensitive.                                                | Initial migration; previously issued tokens cannot be ruled out from source.                    | Removal candidate consistent with private-family scope, but only after proving no deployed links are relied upon.              | Count active (not revoked/not expired) links; explicitly revoke; remove relation; drop table; drop `ShareLinkMode` after dependency check.                                                                                     | Recreate schema and restore only intentionally reactivated links with a security review; otherwise issue new tokens rather than restoring secrets. |
| `Subscription`  | No delegate usage. Current billing is credit-purchase based; product scope explicitly excludes subscriptions.                                                           | Unique `User` FK; Stripe customer/subscription identifiers; `UserPlan` is also stored on `User`, so its enum cannot be dropped with this table. | Initial migration; external Stripe state may exist even if the table is unused in current code. | Removal candidate, but requires database and Stripe reconciliation first.                                                      | Count rows; reconcile every Stripe identifier externally; cancel/retain per owner decision; export audit data; remove `User.subscription`; drop table; drop `SubscriptionStatus` only.                                         | Recreate table and restore reconciled rows; external Stripe rollback must be handled separately and is not achieved by a DB rollback.              |
| `UserBookState` | No delegate usage.                                                                                                                                                      | Unique `(userId, bookId)` with cascade FKs to `User` and `Book`; models private reading progress/bookmarks.                                     | Initial migration; removing it could discard useful family reading state.                       | Retain for the private-family reader use case, even though the UI does not persist it yet.                                     | If later removed: export progress/bookmarks, remove relations, then drop table.                                                                                                                                                | Recreate table/FKs and restore per-user progress.                                                                                                  |
| `Notification`  | No delegate usage. Current email delivery does not use this table.                                                                                                      | `User.notifications` cascade FK; enum dependencies `NotificationType` and `NotificationChannel`.                                                | Initial migration; sent/read history may exist and can have retention implications.             | Deprecation candidate. Keep until deployed row counts and notification-history retention are decided.                          | Count/export rows; verify no external producer; remove relation; drop table; then drop both notification enums.                                                                                                                | Recreate enums/table/FK and import retained history.                                                                                               |

`ChildProfile` is retained: it owns the family-domain relationship and remains a valid home-mode
extension point even though book drafts also carry snapshot fields. `BookPage` is retained: page
text versioning and page-image revision concurrency depend on it.

## Lifecycle enum reachability

### `BookStatus`

| Values                                                                                                                          | Repository reachability                                                                                                                                               | Recommendation                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `created`                                                                                                                       | Draft creation and generation admission source state.                                                                                                                 | Retain.                                                                                                         |
| `char_build`                                                                                                                    | Scheduling transition for every initial/retry/regenerate run.                                                                                                         | Retain.                                                                                                         |
| `layout`                                                                                                                        | Fenced intermediate publication write.                                                                                                                                | Retain.                                                                                                         |
| `complete`, `failed`, `cancelled`                                                                                               | Current terminal outcomes.                                                                                                                                            | Retain.                                                                                                         |
| `partial`                                                                                                                       | Explicitly documented as reserved; no API write sets it. Read paths treat it as terminal/editable.                                                                    | Historical/reserved. Do not remove until deployed counts are zero and compatibility policy is decided.          |
| `story_plan`, `page_plan`, `story_draft`, `chapter_gen`, `illust_plan`, `preview_ready`, `image_gen`, `qa_review`, `pdf_render` | No current production `Book.status` assignment was found. The UI still accepts these coarse legacy values, while new progress comes from `GenerationRun.currentStep`. | Historical compatibility values. Prefer a later expand/observe/contract migration, not immediate enum deletion. |

### `AgentStep`

Current `GenerationRun.currentStep` writes are `char_build`, `story_plan`, `qa_review`,
`image_gen`, `layout`, and `pdf_render`.

`page_plan`, `story_draft`, `illust_plan`, and `preview_ready` remain in persisted diagnostic/log
structures but are not current `markStep` transitions. `chapter_gen` and `char_consistency` have no
production transition. They are historical values and must not be removed until database counts,
serialized JSON compatibility, and old worker-version compatibility are checked.

All `GenerationRunStatus` values (`queued`, `running`, `completed`, `failed`, `cancelled`) are
reachable and must be retained.

## Safe future enum contraction

PostgreSQL enum contraction should use an expand/observe/contract sequence:

1. Deploy code that no longer writes the candidate values but continues reading them.
2. Query deployed tables and JSON payloads for every candidate value; retain an observation window
   covering the longest rollback and queued-job lifetime.
3. Map any remaining rows to an owner-approved replacement in a separate data migration.
4. Replace the enum type using a new enum plus cast, with queue workers stopped or version-fenced.
5. Deploy readers without the legacy values only after the migration is complete everywhere.

Rollback before step 4 is code-only. After contraction, rollback requires recreating the old enum
and restoring mapped values from a pre-migration backup; application rollback alone is insufficient.

## Decision

No destructive migration is included in Phase 7. Runtime source proves several models are unused by
the current application, but it cannot prove deployed tables are empty, external objects have no
owners, historical share/subscription state is irrelevant, or older workers/clients no longer emit
legacy enum values.
