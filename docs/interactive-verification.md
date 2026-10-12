# Interactive candidate verification (Phase 16.1)

An audit of one candidate commit across the API, web, database boundaries and the
existing book/PDF workflow. No application code, tests, dependencies, lint rules or
package scripts were changed. Nothing was committed, pushed, deployed, published or
dispatched, and no paid or production call was made.

This report makes no claim of production readiness, model quality or editorial
approval. Corpus scenarios remain unpublished and no paid experiment is authorized.

## 1. Audited candidate

| Item               | Value                                                                |
| ------------------ | -------------------------------------------------------------------- |
| Branch             | `docs/phase-15-1-interactive-case-study`                             |
| HEAD               | `3feb6801f27e7554b30dba51469bd2f91d88e918`                           |
| Subject            | docs: add offline authoring experiment walkthrough (phase 15.2)      |
| Working tree       | clean at start and at end (`git status --short` empty)               |
| Audit date         | 2026-10-12                                                           |
| Delta vs `dc5b31e` | 4 Markdown files only (README, `docs/CURRENT_PRODUCT.md`, 2 docs/)   |
| Remote branch head | `a8276d0`; local HEAD is one commit ahead and unpushed               |
| Local OS           | Windows 11 Home 10.0.26300, `core.autocrlf=true`, LongPaths disabled |

Tool versions (local / CI): Node v24.11.1 / 22; pnpm 9.4.0 / 9.4.0; Docker 29.7.2;
TypeScript 5.9.3; ESLint 9.39.4; Prettier 3.9.4; Turbo 2.1.3; Vitest 2.1.9;
Playwright 1.62.0; Next 16.3.3; Prisma 5.22.0; NestJS core 10.4.22. Test targets:
`postgres:16-alpine` on 5440 and `redis:7-alpine` on 6380 (tmpfs-backed).

## 2. How the evidence was gathered, and why

Three evidence tiers are used. Read the labels in the tables.

- **WT** — the working tree. Used only for static commands that execute no
  application code.
- **LF** — a `git archive` snapshot of HEAD with `core.autocrlf=false`, extracted
  to a short path (`C:\sm-iso`). Used for everything that executes application
  code. This is the authoritative tier for results.
- **CRLF** — a first snapshot that was meant to be LF but was not (see below).
  Kept only as a datapoint.

Why a snapshot rather than running tests in the working tree:

- `apps/api/.env` (gitignored) exists in the working tree. It sets
  `NODE_ENV=development`, `STORY_GENERATION_PROVIDER=openai`,
  `IMAGE_GENERATION_PROVIDER=openai`, `DATABASE_URL` to `localhost:5433/storyme`
  (the development database target), `REDIS_URL` to `localhost:6379` (a port
  published by another project's Redis container), and non-empty OpenAI,
  Anthropic, Stripe, R2 and Google values. Values were never printed.
- `ConfigModule.forRoot` in `apps/api/src/config/env.module.ts:11` has no
  `envFilePath`, so any process started with cwd `apps/api` loads that file.
  Blanking the keys is not viable: `OPENAI_API_KEY` is `.min(1)` and
  `R2_ENDPOINT`/`R2_PUBLIC_URL`/`GOOGLE_CALLBACK_URL` are `.url()` in
  `env.schema.ts`.
- A snapshot has no `.env`, which is also what CI has. No paid credential and no
  development database target was ever present in an audited process.

Equivalence with the working tree: the tree was clean, 784 files are tracked, the
snapshot contains 784 files, and a byte comparison with CR stripped found **784
of 784 identical, 0 mismatches**. So the snapshot is the candidate's tracked
content; it is not a substitute for any dirty file, because there were none.

Method correction, disclosed: the first extraction used plain `git archive`,
which honors `core.autocrlf=true` and produced a fully CRLF tree. That was
detected from `Delete ␍` lint output, re-extracted with
`git -c core.autocrlf=false archive HEAD`, and verified: 0 tracked files in the
snapshot contain CR. All "LF" results below come from the corrected snapshot.

## 3. Commands, results and counts

### 3.1 Static checks

| Tier | Command                                                   | Exit | Result                                                                                       |
| ---- | --------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------- |
| WT   | `pnpm --filter @book/api typecheck`                       | 0    | pass                                                                                         |
| WT   | `pnpm --filter @book/api typecheck:scripts`               | 0    | pass                                                                                         |
| WT   | `pnpm --filter @book/api typecheck:integration:hardening` | 0    | pass                                                                                         |
| WT   | `pnpm --filter @book/web typecheck`                       | 0    | pass                                                                                         |
| WT   | `pnpm lint --force` (first run)                           | 1    | `@book/types` 237 errors; turbo aborted, `Tasks: 0 successful, 1 total`                      |
| WT   | `pnpm lint --force --continue` (diagnostic)               | 1    | types 237; web 11,022; api 28,891 errors + 26 warnings = 40,176 items                        |
| WT   | `pnpm format:check`                                       | 1    | 243 files flagged                                                                            |
| WT   | `git diff --check`, `--cached`, `HEAD`                    | 0    | no whitespace errors                                                                         |
| LF   | `pnpm --filter @book/api prisma:generate`                 | 0    | pass                                                                                         |
| LF   | `pnpm --filter @book/types build`                         | 0    | pass                                                                                         |
| LF   | `pnpm lint --force --continue`                            | 1    | types pass, web pass, **api 142 problems (116 errors, 26 warnings)**; 2 of 3 tasks succeeded |
| LF   | `pnpm typecheck --force`                                  | 0    | 4 of 4 tasks                                                                                 |
| LF   | `pnpm --filter @book/api typecheck:scripts`               | 0    | pass                                                                                         |
| LF   | `pnpm --filter @book/api typecheck:integration:hardening` | 0    | pass                                                                                         |
| LF   | `pnpm format:check`                                       | 1    | 28 files flagged (18 `apps/api/src`, 7 `apps/api/scripts`, 1 `apps/api/test`, 2 docs)        |
| CRLF | `pnpm lint --force --continue`                            | 1    | types 1,586; web 25,156; api 80,098 errors + 26 warnings (datapoint only)                    |
| CRLF | `pnpm format:check`                                       | 1    | 717 files flagged (datapoint only)                                                           |

Line endings: 271 of 784 tracked files are CRLF in the working tree while the
index is LF (`git ls-files --eol`, `core.autocrlf=true`). Prettier's
`endOfLine: "lf"` therefore reports 40,149 `Delete ␍`-style errors in the
working tree. That is the known Windows failure and is a platform issue.

The failures that remain on LF are not line endings. See finding 1.

### 3.2 Unit, node and offline-evaluation suites (LF)

| Command                                                     | Exit | Result                                                                                                        |
| ----------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------- |
| `pnpm test` run 1 (CI env, see §5)                          | 1    | types 2/2; **web 51 failed / 769 passed (820), 9 of 51 files failed**; API did not complete (turbo aborted)   |
| `pnpm --filter @book/web test`, var unset                   | 0    | 51 files, 820 passed                                                                                          |
| `pnpm test` run 2 (var unset)                               | 1    | types 2/2; web 820/820; **API 1 failed / 2,632 passed / 3 skipped (2,636; 173 files)** plus 1 unhandled error |
| `vitest run scripts/inspect-interactive-experiment.spec.ts` | 0    | 27/27 in 35.9 s                                                                                               |
| `vitest run src/app.module.spec.ts`                         | 1    | 2/2 passed, **1 unhandled error**, exit 1                                                                     |
| `pnpm archive:clean:test`                                   | 0    | 6 pass, 0 fail                                                                                                |
| `pnpm test:launcher`                                        | 0    | 39 pass, 0 fail                                                                                               |
| `pnpm eval:story:offline`                                   | 0    | 30 PASS, 0 FAIL                                                                                               |
| `pnpm eval:interactive:offline`                             | 0    | 29 PASS, 0 FAIL                                                                                               |
| `pnpm eval:interactive:authoring:offline`                   | 0    | 42 PASS, 0 FAIL                                                                                               |

`archive:clean:test` and `test:launcher` are the tail of `pnpm test` and were
skipped by its `&&` chain after the API failure, so they were run separately.

### 3.3 Build, integration and browser suites (LF)

| Command                                              | Exit | Result                                                                                                                                  |
| ---------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV=production pnpm build`                     | 0    | 3 of 3 tasks                                                                                                                            |
| `pnpm test:infra:up` (WT root)                       | 0    | both containers healthy, container IDs unchanged                                                                                        |
| `pnpm --filter @book/api test:integration`           | 0    | migrations applied to the guarded DB; **26 files, 302 tests passed**, 92 s                                                              |
| `pnpm --filter @book/web test:e2e` (all specs)       | 0    | **54 passed, 0 failed** in 6.9 min: 40 `interactive.spec.ts` + 14 `storyme.smoke.spec.ts`; teardown reported "E2E fixtures cleaned up." |
| `pnpm --filter @book/web build` (production-job env) | 0    | pass                                                                                                                                    |
| `pnpm --filter @book/web test:e2e:production`        | 0    | 1 passed (11.7 s)                                                                                                                       |

Browser suite ran with `retries: 0` (the config enables a retry only when `CI`
is set, which it was not), so a pass is a first-attempt pass.

## 4. Local versus remote evidence

Read-only GitHub access (`gh`) was available. Nothing was pushed, dispatched or
rerun.

**No remote run exists for the audited SHA.** `gh run list --commit 3feb680…`
returned `[]`. The remote branch head is `a8276d0`, and `ci.yml` has no run on
this branch (it triggers only on `pull_request` and pushes to `main`/`develop`).

The most recent `ci.yml` run is an older commit, not the candidate:

| Item                        | Value                                                                                               |
| --------------------------- | --------------------------------------------------------------------------------------------------- |
| Run                         | https://github.com/AlexTikhon/ai-agent_StoryMe/actions/runs/38253171809                             |
| Commit                      | `dc5b31ea30eb9c624888f8fbf524eea1fcfc7294` (`main`), 2026-10-12T13:04Z                              |
| Relation                    | candidate differs by 4 Markdown files; application source is identical                              |
| Checks                      | **failure** at `Run pnpm lint`: `✖ 142 problems (116 errors, 26 warnings)`                          |
| Isolated integration        | **failure** at `test:integration`: `SESSION_BUSY` at `interactive-library.integration.spec.ts:73`   |
| Production browser smoke    | **failure** at `pnpm --filter @book/types build`: `TS5108 moduleResolution=node10 has been removed` |
| Interactive browser journey | success                                                                                             |

History across the 8 most recent `ci.yml` runs (2026-10-06 to 2026-10-12):
`Checks` failed 8 of 8; `Production browser smoke` failed 8 of 8;
`Isolated integration` failed 5 and passed 3. `Interactive browser journey`
appears only in the latest run.

Where local and remote agree: the lint failure. The remote count (142 / 116 / 26)
equals the LF snapshot count exactly, which establishes it as a reproducible
regression and not a local artifact.

Where they differ: integration passed 302/302 locally in one run but failed
remotely in 5 of 8 runs; production smoke passed locally and fails remotely
(finding 3).

Also observed on the branch head `a8276d0`: `migrate.yml`, `staging-backup.yml`
and `staging-monitor.yml` each produced a `push` run that concluded `failure`
with zero jobs. All three files are entirely commented out, which GitHub treats
as an invalid workflow. These are noise runs, not verification results.

## 5. Failed, unavailable and deferred checks

### Failed (reproducible on the candidate)

- `pnpm lint` — `@book/api`, 142 problems on LF (finding 1).
- `pnpm format:check` — 28 files on LF (not gated by CI; see finding 1).
- `pnpm test` in a clean environment — exits 1 even when all tests pass
  (finding 2).

### Failed, then classified

| First-run failure                                                                | Follow-up                                                | Classification                                                  |
| -------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------- |
| WT lint stopped at `@book/types`                                                 | Reran once with `--continue` to see all packages         | Platform: CRLF, plus the real API failures (finding 1)          |
| CRLF snapshot: 80,124 API lint problems                                          | Re-extracted with `core.autocrlf=false`                  | My method error, corrected; not a candidate defect              |
| Web unit: 51 failed (CI env had `NEXT_PUBLIC_API_URL=http://localhost:3001/api`) | One run with only that variable unset: 820/820           | Environment-sensitive tests (finding 2); not a logic regression |
| API unit: `inspect-interactive-experiment.spec.ts` timed out at 5 s              | Ran the file alone: 27/27 in 35.9 s                      | Intermittent / load-sensitive; passed in isolation              |
| API unit: unhandled rejection from `src/app.module.spec.ts`                      | Ran the file alone, clean env: 2/2 pass, 1 error, exit 1 | Deterministic in an environment without `.env` (finding 2)      |

Each of these was run once more, not retried until green. The original logs were
preserved before each rerun.

### Unavailable

- A remote run for the exact candidate SHA. None exists.
- The remote runner's TypeScript version in the production-smoke job. The log
  shows TS5108 but not the version.
- A Linux/Node 22 run. Local tests ran on Windows with Node 24.11.1.

### Deferred, not run

- `pnpm test:e2e:home`: its `finally` calls `infra-down`, which removes the
  pre-existing containers. The equivalent `infra-up` plus `test:e2e` was used.
- Paid or real-provider commands: `smoke:real-generation`, `smoke:cloud-storage`,
  `eval:story:openai`, `author:interactive` with paid mode,
  `experiment:interactive:authoring` in `openai` mode. `RUN_PAID_AI_EVALS=false`.
- `render:pdf`, `preflight:deploy`, `migrate:deploy`. None are in scope for a
  no-application-change audit, and `migrate:deploy` is forbidden here.
- Runtime tests executed directly in the working tree (see §2).
- Repeated runs to estimate flake rates. Every suite was run once.

## 6. Resource ownership and cleanup

Inventory before starting: ports 5433 (`running-tracker-postgres-1`) and 6379
(`youtube-clone-redis-1`) belong to other projects' containers, and 5432 was held
by a non-Docker process (PID 8368, not identified). None were used. The two StoryMe guarded containers
existed in `Exited (255)` state; ports 3100, 4100, 3200, 5440 and 6380 were free.

| Resource                                           | Owner / origin                               | Action                                   | End state                         |
| -------------------------------------------------- | -------------------------------------------- | ---------------------------------------- | --------------------------------- |
| `storyme-integration-postgres-e2e-1` (`d3536392…`) | pre-existing, stopped; started by this audit | `pnpm test:infra:up`, then `docker stop` | `Exited (0)`, ID unchanged        |
| `storyme-integration-redis-e2e-1` (`2304e332…`)    | pre-existing, stopped; started by this audit | `pnpm test:infra:up`, then `docker stop` | `Exited (0)`, ID unchanged        |
| Other running containers (7)                       | not this audit's                             | untouched                                | still running                     |
| `C:\sm-iso` snapshot                               | created by this audit                        | removed                                  | gone                              |
| `C:\sm-prod` throwaway install                     | created by this audit                        | removed                                  | gone                              |
| Playwright API/web servers (4100, 3100, 3200)      | started by Playwright                        | stopped by Playwright                    | ports free                        |
| E2E fixtures in the guarded DB                     | created by suite                             | removed by its global teardown           | tmpfs data also discarded on stop |
| Session scratchpad logs                            | this audit                                   | kept for the session, not in the repo    | temp directory                    |

Notes:

- `infra-down` was deliberately not used for cleanup: it runs
  `compose down -v --remove-orphans` and would have removed containers that
  pre-existed the audit. `docker stop` restores their prior stopped state.
- `wslrelay.exe` (PID 29248) briefly held 5440/6380 on `[::1]` after the stop. It
  is Docker Desktop's relay, not owned by this audit, and had released both
  ports on the next check.
- The only `prisma migrate deploy` ran against `127.0.0.1:5440/storyme_e2e`. The
  development database on 5433 and the Redis on 6379 were never contacted.
- Working-tree side effects are limited to gitignored build/lint caches. Final
  `git status` is clean.

## 7. Findings (ranked)

### 1. The API lint gate is red on LF, which hides every later CI step

`@book/api` lint fails with 116 errors and 26 warnings; `eslint src
--max-warnings 0` makes the warnings fatal. The remote `Checks` job reports the
identical `142 problems (116 errors, 26 warnings)`. `Checks` runs lint before
`pnpm test`, the three evaluations and the build, so none of those run in CI.

Evidence, almost entirely in the interactive authoring tooling
(`src/interactive/authoring/*`) plus three other source files:

- 115 `prettier/prettier` errors, concentrated in
  `apps/api/src/interactive/authoring/experiment-inspection.spec.ts` (23),
  `experiment.spec.ts` (23), `run-report-aggregate.spec.ts` (17),
  `run-report-input.spec.ts` (15), `experiment-manifest-input.ts` (8), plus
  `interactive/domain/engine.ts`, `interactive/playtest/runner.ts`,
  `interactive/presentation/presentation.ts`.
- 1 error `@typescript-eslint/no-unused-vars`:
  `experiment-inspection.spec.ts:31` (`ExperimentManifest`).
- 25 `no-explicit-any` warnings (largest: `run-report-input.spec.ts` 12,
  `experiment.spec.ts` 6, `run-report-aggregate.spec.ts` 3,
  `common/test-utils/authoring-run-fixtures.ts:78-79`) and one `no-control-regex`
  at `route-review.spec.ts:310`.
- `format:check` additionally flags 7 files in `apps/api/scripts`, 1 in
  `apps/api/test` and 2 docs that CI never checks (CI has no format step and
  `eslint src` does not cover them).

### 2. `pnpm test` fails in a clean environment, masked locally by `.env`

Two separate causes, both currently unobservable in CI because of finding 1:

- `apps/api/src/app.module.spec.ts` imports `AppModule`, which pulls in
  `EnvModule` (`env.module.ts:11-24`). With no `DATABASE_URL`, `REDIS_URL`,
  `JWT_SECRET` or `JWT_REFRESH_SECRET` the validation throws an unhandled
  rejection. Both tests pass but vitest exits 1. A developer's gitignored
  `apps/api/.env` supplies the values and hides it. The CI `checks` env sets
  none of them, so this is expected to fail there too (reproduced in a clean
  snapshot; not yet observed on a remote run).
- 51 tests in 9 web files (`src/lib/api/books.test.ts`, `interactive.test.ts`,
  `auth.test.ts`, `credits.test.ts`, `client.test.ts`, `billing.test.ts`,
  `asset-url.test.ts`, `app/dashboard/books/[id]/page.test.tsx`) assert a base
  URL of `http://localhost:4000` and fail when `NEXT_PUBLIC_API_URL` is
  `http://localhost:3001/api`, which `ci.yml` sets at workflow level. With that
  one variable unset the suite is 820/820.

### 3. The production browser smoke job cannot build in CI

`ci.yml` sets `NODE_ENV: production` at job level for `production-browser`.
`pnpm install --frozen-lockfile` then skips devDependencies, including the
`typescript ^5.5.4` that `@book/types` builds with, so `tsc` resolves to
whatever is on `PATH`. Failed 8 of 8 sampled remote runs at
`pnpm --filter @book/types build`.

Reproduced the mechanism locally in a throwaway copy: pnpm printed
"devDependencies: skipped because NODE_ENV is set to production", root
`typescript` was absent, and the build failed on `moduleResolution=node10`
(TS5107 with the machine's global TypeScript 6.0.2; the runner showed TS5108, so
its compiler version differs and is unknown). With devDependencies installed the
same smoke passes locally (1/1).

### 4. Remote integration is intermittently red; not reproduced locally

`Isolated integration` failed 5 of the last 8 runs. In the latest it failed with
`SESSION_BUSY` (503) from `InteractiveService.createSession` →
`translate` (`interactive.service.ts:645`, `interactive.errors.ts:36`) in
`test/integration/interactive-library.integration.spec.ts:73`. Locally the same
suite passed 26/26 files, 302/302 tests in one run. Only the latest failing log
was read, so whether all 5 failures are the same test is not established. One
passing local run cannot rule out a timing-dependent admission or lock race.

### 5. The cover endpoint returned HTTP 500 eight times during the browser suite

Eight `Unhandled exception on GET /api/books/:id/images/cover` entries were
logged across several `storyme.smoke.spec.ts` flows, on six distinct book ids
(one a seeded fixture). I did not map each entry to a specific test.
`http-exception.filter.ts:59` maps an unhandled exception to 500 and
logs only `errorName=Error`, so no message or stack is available. The handler
path is `getOrCreateCoverThumbnail` in `book-asset.service.ts:246-277` and
`renderCoverThumbnail`; the cause is not established. No test asserts the cover
route's status, so all 54 tests passed. Compounding this, no CI job runs
`storyme.smoke.spec.ts` (the 14 book/PDF flows); `ci.yml:111` runs only
`e2e/interactive.spec.ts`.

## 8. One best next task

**Make the CI `Checks` job pass from a clean checkout.** Do it in the order the
job runs: fix the 142 API lint problems (finding 1), then make `pnpm test`
deterministic without `.env` and without `NEXT_PUBLIC_API_URL` coupling
(finding 2), so evals and build become observable again. Findings 3 to 5 should
follow, but they cannot be confirmed or regressed against until this gate runs.

## 9. Limits of this audit

- Each suite ran once; the intermittency calls (timeout, remote integration) are
  bounded by that.
- Results are Windows / Node 24; CI is Linux / Node 22.
- The remote evidence is for `dc5b31e`, not the candidate, and covers only what
  that run reached.
- Runtime suites ran in a snapshot, not the working tree, for the credential
  reasons in §2. The tree was clean, so this changes no result's applicability.

---

## 10. Follow-up: Phase 16.2 repair (added after the audit)

Sections 1 to 9 above are the audit as written and are not amended. This section
records the repair of findings 1 and 2 only. Findings 3, 4 and 5 are deliberately
not addressed and remain open. Nothing was committed, pushed, deployed or
dispatched, and no paid, database or browser suite was run.

### 10.1 Failures reproduced before any change

Reproduced in a fresh `git -c core.autocrlf=false archive HEAD` snapshot (no
`.env`, `pnpm install --frozen-lockfile`) at `3feb680`:

| Check                                                              | Result                                                                                            |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `pnpm lint --force --continue`                                     | `@book/api` 142 problems (116 errors, 26 warnings); types and web pass; 2 of 3 tasks              |
| `pnpm format:check`                                                | 28 files flagged (18 `apps/api/src`, 7 `apps/api/scripts`, 1 `apps/api/test`, 2 `apps/api/docs`)  |
| `vitest run src/app.module.spec.ts`                                | 2 passed, 1 unhandled rejection (`DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET`) |
| `@book/web` tests, `NEXT_PUBLIC_API_URL=http://localhost:3001/api` | 9 of 51 files failed, 51 of 820 tests failed (769 passed)                                         |

After formatting only, the API lint was 27 items (1 error, 26 warnings): the
remaining 115 errors were all `prettier/prettier`.

### 10.2 What changed

- Prettier `--write` on exactly the 28 flagged files; `endOfLine: "lf"` kept, no
  repository-wide conversion. 21 of them (including 11 production `.ts` sources and
  the 2 docs) were changed by Prettier alone: each equals `prettier(HEAD)` and
  `prettier --debug-check` (which compares ASTs) reported no difference. The other
  7 also carry the hand edits below.
- `experiment-inspection.spec.ts`: the unused `ExperimentManifest` import is now
  used; the `Record<string, any>` alias is replaced by the production
  `ExperimentManifest` and `ManifestEntry` types, with `Object.assign` and `!`
  where a test deliberately corrupts a manifest.
- `authoring-run-fixtures.ts`: `mutateReport` takes a `JsonObject`; new `setAt`
  and `arrayAt` helpers fail loudly on a wrong fixture path. Callers in
  `run-report-input.spec.ts`, `run-report-aggregate.spec.ts`,
  `report-interactive-authoring.spec.ts` and `experiment-inspection.spec.ts` use
  them. Every adversarial mutation and assertion is unchanged.
- `experiment.spec.ts`: `readJson<T>` plus the production `ComparisonReport` and
  `ExperimentManifest` types; the `parsed as any` became a narrowing guard.
- `presentation.spec.ts`: the tamper callback is typed from the DTO.
- `route-review.spec.ts`: removed the unused `no-control-regex` suppression (the
  rule was not reporting).
- `app.module.spec.ts` mocks `./config/env.module` so the real
  `ConfigModule.forRoot` (which reads `.env` and rejects asynchronously) never
  runs there, and now also asserts EnvModule is the first import.
- New `config/env.module.spec.ts` captures the real `forRoot` options and
  exercises the production `validate` callback: missing and malformed
  configuration is rejected, a valid one is parsed with defaults.
- Web: new `src/test-support/fixture-api-base.ts` stubs
  `NEXT_PUBLIC_API_URL=http://localhost:4000/api` before the `API_BASE` module
  constants are evaluated; it is the first import of the 9 test files that
  assert `localhost:4000`. `lib/api/config.ts` and `config.test.ts` are untouched.

No lint rule, `--max-warnings`, exclusion, suppression, timeout, retry or skip
was changed. The only production-source edits are the Prettier-only ones above;
no production behavior was changed.

### 10.3 Verification, from a credential-free LF snapshot of the working tree

| Command                                                                                | Result                                                                                     |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `pnpm lint --force`                                                                    | exit 0, 3 of 3 tasks                                                                       |
| `pnpm format:check`                                                                    | exit 0                                                                                     |
| `pnpm typecheck --force`                                                               | exit 0, 4 of 4 tasks                                                                       |
| `typecheck:scripts`, `typecheck:integration:hardening`, web `typecheck`                | exit 0 each                                                                                |
| `pnpm exec turbo run test --force` (CI URL set)                                        | exit 0; types 2/2; web 820/820; API 174 files, 2,638 passed, 3 skipped, no unhandled error |
| `pnpm archive:clean:test`, `pnpm test:launcher`                                        | 6/6 and 39/39                                                                              |
| `@book/web test`, variable unset                                                       | 820/820                                                                                    |
| `eval:story:offline`, `eval:interactive:offline`, `eval:interactive:authoring:offline` | 30, 29 and 42 PASS, 0 FAIL                                                                 |
| `NODE_ENV=production pnpm build` (mock providers, home mode)                           | exit 0, 3 of 3 tasks                                                                       |
| `git diff --check`                                                                     | exit 0                                                                                     |

`pnpm test --force` itself is rejected by pnpm (`Unknown option: 'force'`), so the
three stages of the `test` script were run directly with `--force` on turbo.

### 10.4 Still open

- Findings 3, 4 and 5 (production-browser install, intermittent integration,
  cover-endpoint 500s) are untouched.
- The 5 s subprocess/import timeout seen in the audit did not reproduce in five
  full API runs (two alone, two at the same time, one under turbo beside the web
  suite). The slowest test without an explicit budget was
  `starts no work when imported` at about 3.0 to 3.7 s. No budget was added
  because nothing failed; it is the nearest candidate if the flake recurs. The
  two simultaneous runs shared `apps/api/tmp` and each failed 4 storage-spec
  tests from that collision; those are an artifact of running them together, not
  a defect, and are not counted as evidence.
- No tsconfig type-checks `*.spec.ts` (all exclude them), so spec typing is
  enforced by neither `typecheck` nor ESLint's non-type-aware rules. One existing
  excess-property error remains in `presentation.spec.ts` (`title` in the
  `scene` literal); it is outside this repair.
- This was a Windows / Node 24 run; no remote run exists for the repaired tree.
