# Staging operations

This page is the authoritative staging runbook. It replaces the earlier
provider-neutral recommendations in `private-demo-deploy.md` for the actual
StoryMe staging environment.

## Selected topology

| Component               | Provider                                     | Region / scope                              |
| ----------------------- | -------------------------------------------- | ------------------------------------------- |
| Web                     | Vercel preview deployment                    | Global edge                                 |
| API                     | Railway                                      | EU West, Amsterdam (`europe-west4-drams3a`) |
| Generation worker       | Railway                                      | EU West, Amsterdam (`europe-west4-drams3a`) |
| PostgreSQL              | Railway Postgres                             | EU West, Amsterdam                          |
| Redis                   | Railway Redis                                | EU West, Amsterdam                          |
| PDF and image artifacts | Railway Storage Bucket (`storyme-artifacts`) | Amsterdam (`ams`)                           |

The Railway bucket is private and S3-compatible. API and worker use the same
isolated staging bucket with `PDF_STORAGE_DRIVER=s3` and
`IMAGE_STORAGE_DRIVER=s3`. Staging uses mock story/image providers and has
Stripe billing disabled; this makes smoke tests deterministic and prevents
accidental paid calls.

## GitHub Environment

The repository has a lowercase `staging` Environment restricted to `main`.
The migration workflow reads:

- Environment secret `DATABASE_URL`;
- Environment variables `MIGRATION_DB_HOSTNAME` and `MIGRATION_DB_NAME`.

Backup and monitoring workflows additionally read:

- secrets `BACKUP_S3_ACCESS_KEY_ID` and `BACKUP_S3_SECRET_ACCESS_KEY`;
- variables `BACKUP_S3_BUCKET`, `BACKUP_S3_REGION`, `BACKUP_S3_ENDPOINT`, and
  `STAGING_API_BASE_URL`.

Secret values must never be copied into repository files or workflow logs.

## Release order

1. Confirm CI on `main` is green.
2. Run `Database Migration (Manual)` with target `staging` and confirmation
   `APPLY_STAGING_MIGRATIONS`.
3. Deploy/redeploy API and wait for `/api/health` to return `{"status":"ok"}`.
4. Deploy/redeploy worker and confirm its startup log includes
   `processor registered=true`.
5. Run `pnpm --filter @book/api smoke:cloud-storage` with the staging bucket
   configuration and confirm cleanup.
6. Deploy the Vercel web preview with `NEXT_PUBLIC_API_URL` pointing to the
   staging API `/api` origin.
7. Run the product smoke: register, verify email through the temporary
   staging log link, create a book, generate it, open/download the PDF, edit
   and regenerate one page, then delete the book.

## Backup and restore

`Staging Database Backup` runs every day at 01:17 UTC and can also be
dispatched manually. It:

1. creates a PostgreSQL 18 custom-format logical dump;
2. validates the dump catalog;
3. uploads it below `backups/postgres/` in the staging artifact bucket;
4. restores it into a disposable PostgreSQL 18 container;
5. fails unless the restored database contains public tables.

This is an independent logical backup and restore proof. Railway volume
snapshots should also be enabled in the Postgres service Backups tab (daily,
weekly, and monthly schedules). A restore of a Railway snapshot creates or
rewinds platform volume state; rehearse it only against staging and follow
Railway's restore warnings.

## Monitoring and alerting

`Staging Health Monitor` probes `/api/health` every ten minutes. A failure
opens (or updates) one `staging-alert` GitHub issue and fails the workflow,
which also activates normal GitHub Actions notifications. Recovery closes the
open alert issue automatically.

In Railway, keep an Observability dashboard for API, worker, Postgres, and
Redis. On plans that support monitors, alert on:

- API/worker restart or failed deployment;
- CPU above 80% for 10 minutes;
- RAM above 85% for 10 minutes;
- Postgres and Redis volume usage above 75%;
- API health-check failures.

## Rollback

- Application: redeploy the previous successful Railway deployment and
  promote the previous Vercel deployment.
- Database: prefer a forward-fix migration. For data loss or an accidental
  destructive operation, restore a verified logical dump into a new database,
  validate it, then switch `DATABASE_URL`; do not overwrite the only database
  in place.
- Artifacts: the storage smoke deletes only its generated `smoke-<uuid>`
  namespace. Application hard deletion is irreversible, so bucket backups or
  versioning must be treated separately from database recovery.
