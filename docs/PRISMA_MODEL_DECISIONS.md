# Prisma Model Decisions

Phase 2 decision record for models with no current production delegate usage. "Retain" means the
model stays in this phase; it does not claim the feature is implemented.

| Model           | Decision                  | Reason and prerequisite for reconsideration                                                                                                                                                        |
| --------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ChildProfile`  | Retain                    | Book already has an optional relation and the concept fits a near-term private-family workflow. Removal would require deciding how existing foreign keys/data map to Book's embedded child fields. |
| `Upload`        | Remove later, not Phase 2 | Current child photos bypass it and use immutable storage keys on Book. Before removal, inspect deployed data and decide whether any historical child-profile photo references must be migrated.    |
| `BookPage`      | Retain                    | Phase 4 page-level edits/regeneration need normalized page identity/versioning. Define that contract before reusing or replacing this older shape.                                                 |
| `CharacterCard` | Remove later, not Phase 2 | Runtime stores character JSON on Book. Removal requires deployed-data confirmation and migration sequencing with `ChildProfile`.                                                                   |
| `BookSeries`    | Remove later, not Phase 2 | No current or planned small-production phase requires series. Confirm no deployed rows before a destructive migration.                                                                             |
| `WizardDraft`   | Remove later, not Phase 2 | The frontend creates Book directly and has no persisted wizard resume. Confirm no deployed rows.                                                                                                   |
| `ShareLink`     | Remove later, not Phase 2 | Public sharing is explicitly unimplemented and outside the small-production plan. Confirm no deployed links and remove related Book relations together.                                            |
| `Subscription`  | Remove later, not Phase 2 | Billing implements one-time credits only. Confirm Stripe/deployed data has no subscription records and update unused plan enums in the same reviewed migration.                                    |
| `UserBookState` | Remove later, not Phase 2 | No reader/progress/bookmark runtime exists. Re-evaluate after the Phase 3 reader design; retain only if it matches that concrete contract.                                                         |
| `Notification`  | Remove later, not Phase 2 | Email is sent directly for auth; no notification center or queued notification runtime exists. Confirm no deployed rows.                                                                           |
| `GenerationJob` | Remove in Phase 2         | It is a best-effort mirror of authoritative `GenerationRun`; the migration and compatibility sequence is specified in `PHASE_2_IMPLEMENTATION_PLAN.md`.                                            |

Only `GenerationJob` is approved for removal in this phase. Every other destructive decision is
deferred until deployed-data inspection and a feature-specific migration plan exist.
