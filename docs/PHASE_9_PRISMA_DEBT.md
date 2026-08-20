# Phase 9 Prisma debt audit

Audit date: 2026-08-20. This is an evidence-only audit; Phase 9 makes no destructive schema or migration changes.

## Definitely active

- `User`, `RefreshToken`: authentication, account state, and ownership.
- `Book`: current aggregate and persisted generation/publication state.
- `BookPage`, `PageImageRevision`: published page text revisions and paid page-image regeneration.
- `CreditTransaction`: charging, idempotency, cancellation/failure compensation, and billing grants.
- `AgentLog`: privacy-safe generation diagnostics.
- `GenerationRun`, `OutboxEvent`: authoritative ownership/fencing and transactional queue delivery.
- `BookDeletionRequest`: hard-deletion state machine.
- `RecoveryLease`: generation recovery and claim-artifact cleanup leadership.

## Not directly used by current Home Edition services

No production Prisma delegate calls were found for:

- `ChildProfile`
- `Upload`
- `CharacterCard` (the current `Book.characterCard` JSON contract is unrelated to this historical table)
- `WizardDraft`
- `ShareLink`
- `Subscription`
- `UserBookState`
- `Notification`

Their enums and user/book relations remain in the generated Prisma surface. Some corresponding shared vocabulary is still displayed for historical credit reasons, but that is not evidence of table use.

## Indirectly used historical models

- `BookSeries` has no creation/read product flow, but hard deletion queries it and removes a deleted book ID from its denormalized `bookIds` array. It is therefore operationally active until deployed rows are proven absent or migrated.
- `ChildProfile` is still referenced by nullable `Book.childProfileId`; `Upload` is referenced by `ChildProfile.photoAssetId`; `CharacterCard` and `BookSeries` reference each other. Even without delegate calls, these foreign keys and existing rows affect deletion order and migration safety.
- `ShareLink`, `UserBookState`, and `AgentLog` have `Book` foreign keys with cascading deletion. They can contain deployed data and participate in hard deletion even when application delegates do not address them directly.
- `Subscription`, `WizardDraft`, `Notification`, `ChildProfile`, `Upload`, `CharacterCard`, and `BookSeries` are connected to `User` cascade/set-null behavior.

## Safe future deletion candidates

Candidates, not approved migrations:

1. `WizardDraft`, `Notification`, `Subscription`, and their exclusively owned enums/columns, after production row counts and external/reporting consumers are checked.
2. `UserBookState` and `ShareLink`, after confirming no deployed reader/share URLs or back-office jobs depend on them.
3. `ChildProfile` and `Upload`, only after proving `books.child_profile_id` is null for all retained books and confirming no historical photo-retention process uses either table.
4. `CharacterCard` and `BookSeries` together, only after migrating/removing any series rows and deleting the explicit hard-deletion cleanup branch.
5. Reserved `BookStatus.partial`, legacy pipeline statuses, and unused `AgentStep` values only after querying deployed rows, logs, run snapshots, dashboards, and alert rules. Enum-value removal is higher risk than leaving dormant values.

## Migration prerequisites

- Inventory row counts and non-null foreign-key counts in every deployed database, including backups/restores used by Home Edition.
- Search scheduled jobs, admin scripts, exports, analytics/reporting SQL, and support tooling outside this repository.
- Define retention/export handling for historical child/profile/upload data before dropping it.
- Remove application references (including hard-deletion cleanup), then regenerate Prisma and run all unit/integration/E2E gates.
- Use additive/expand-contract migrations where relations cross tables. For PostgreSQL enum cleanup, prove no row contains each value before rebuilding/remapping the enum.
- Take a recoverable backup and rehearse the migration against a production-shaped copy. A repository-wide absence of delegate calls alone is not sufficient evidence to delete deployed data.
