# Local troubleshooting

- **Docker unavailable:** start Docker Desktop/Engine and confirm `docker info` and `docker compose version`; `test:e2e:home` fails before mutation.
- **PostgreSQL unavailable:** check `docker compose -f docker-compose.e2e.yml ps`; disposable port is `5440`. Main Compose exposes `5433`, not `5432`.
- **Redis unavailable/queue stalled:** verify `6380` for E2E or `6379` for main, then ensure either the dedicated `dev:worker` runs or the API explicitly has `ENABLE_GENERATION_WORKER=true`. Inspect pending outbox rows and BullMQ keys only in the selected Redis DB.
- **Migration mismatch:** set the intended `DATABASE_URL`, run `pnpm --filter @book/api prisma:migrate:status`, then `pnpm migrate:deploy`. Do not use destructive reset on family data.
- **Artifacts unwritable:** ensure `apps/api/tmp` is writable. Run `pnpm privacy:cleanup-local` before any deliberate cleanup; never remove a published namespace by hand.
- **Mocks disabled:** confirm all three provider selections are `mock` and no inherited shell variable selects `openai`. Real providers require explicit configuration and may cost money.
- **Mode mismatch:** API refuses `PRODUCT_MODE`/`NEXT_PUBLIC_PRODUCT_MODE` disagreement. The browser variable is presentation only; API policy remains authoritative.
- **PDF failure:** confirm bundled Noto fonts exist and `apps/api/tmp` is writable. A missing planned image safely fails publication instead of producing a partial PDF.
- **Windows line endings:** baseline formatting/lint currently report committed CRLF issues. Avoid bulk formatting unrelated files; run Prettier only on Phase 8 files.

## Safe recovery

Use the UI/API cancel endpoint for active work and retry only a failed/cancelled run; use regenerate for a complete publication. Old publication pointers remain valid until a fenced successful replacement commits. Inspect owned run diagnostics or query `generation_runs`, `outbox_events`, and `books.active_run_id/published_run_id` in the disposable database. Recreate disposable infrastructure with `pnpm local:home:down` then `pnpm local:home:up`; tmpfs data is intentionally lost. Never delete valid published artifacts to unstick a queue—restore the worker/outbox path or retry through the application contract.
