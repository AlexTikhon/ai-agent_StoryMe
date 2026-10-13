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

---

## 11. Follow-up: Phase 16.3 repair of finding 3 (added after Phase 16.2)

Sections 1 to 10 above are not amended. This section records the repair of
finding 3 only (the `production-browser` job's dependency installation).
Findings 4 and 5 are deliberately untouched. Nothing was committed, pushed,
deployed or dispatched, no remote run was started or rerun, and no paid call,
database, API or credential was used.

### 11.1 Cause and change

`ci.yml` sets `NODE_ENV: production` at job level for `production-browser`, so
`pnpm install --frozen-lockfile` skips devDependencies, including the workspace
`typescript` and `@playwright/test`. Without a local compiler the `@book/types`
build runs whichever `tsc` is on `PATH`.

Change, one line in `.github/workflows/ci.yml`, job `production-browser` only:

```diff
-      - run: pnpm install --frozen-lockfile
+      - run: pnpm install --frozen-lockfile --prod=false
```

plus a three-line comment above it. `--frozen-lockfile` is kept and the lockfile
is unchanged. `NODE_ENV: production` stays at job level, so the web build and
`next start` (which the Playwright config also pins to production) are
unchanged. No dependency moved, no retry or skip was added, and the other jobs,
triggers, permissions, concurrency, action versions, Node 22, pnpm 9.4.0, the
15-minute timeout and the smoke assertions are untouched.

### 11.2 Method

Two fresh `git -c core.autocrlf=false archive HEAD` snapshots of
`162f2f4` at short paths (`C:\sm-163a` baseline, `C:\sm-163b` fixed). 787 files
each, no `.env` (only the tracked `.env.example` files). Every command ran with the
job's effective environment (workflow env overridden by job env, plus `CI=true`):
`NODE_ENV=production`, mock providers, `PRODUCT_MODE=home`,
`NEXT_PUBLIC_PRODUCT_MODE=home`, `NEXT_PUBLIC_API_URL=http://127.0.0.1:4100/api`,
`NEXT_PUBLIC_AUTH_MODE=jwt`. The developer workspace's `node_modules` were not
touched. The fixed snapshot's `ci.yml` is byte-identical to the working tree.

### 11.3 Results

| Step                                                 | Baseline (`C:\sm-163a`)                                                          | Fixed (`C:\sm-163b`)                                                  |
| ---------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` [`--prod=false`]    | exit 0, `+333`, "devDependencies: skipped because NODE_ENV is set to production" | exit 0, `+805`, `typescript 5.9.3`, eslint, prettier, turbo installed |
| `typescript` in root / `packages/types` / `apps/web` | absent in all three                                                              | resolves to `C:\sm-163b\node_modules\.pnpm\typescript@5.9.3`          |
| `@playwright/test` from `apps/web`                   | absent                                                                           | `1.62.0`, inside the snapshot                                         |
| `pnpm --filter @book/types build`                    | **exit 2**, global `tsc` 6.0.2: `TS5107 moduleResolution=node10 is deprecated`   | exit 0, `dist/` emitted, `pnpm exec tsc` = 5.9.3                      |
| `playwright install --with-deps chromium`            | not reached                                                                      | exit 0                                                                |
| `pnpm --filter @book/web build`                      | not reached                                                                      | exit 0, production build, 17 routes, `BUILD_ID` written               |
| `pnpm --filter @book/web test:e2e:production`        | not reached                                                                      | exit 0, 1 passed (12.3 s), no retry or flaky marker                   |

Compiler provenance: the fixed snapshot resolved TypeScript by `require.resolve`
from each package directory and by `pnpm exec`, both landing in the snapshot's
own `node_modules/.pnpm/typescript@5.9.3`. The machine's global `tsc` (6.0.2)
was still on `PATH` and was not used. The baseline failure is the same mechanism
the audit saw (finding 3); only the diagnostic code differs by compiler version.

Smoke run: Playwright's `webServer` starts `next start` with `NODE_ENV=production`
against the freshly built `.next` output on 127.0.0.1:3200. Nothing listened on
4100 (the configured API URL), no database or Redis was started, no `.env` and no
provider credential existed, and the spec blocks all script requests. It passed
with the three-line assertion set unchanged.

Workflow diff: both files parsed with `js-yaml` 4.3.0; a structural comparison
found exactly one differing value, `/jobs/production-browser/steps/3/run`.
`git diff --check` exit 0; Prettier 3.9.4 `--check` on the two changed files is
clean. All four jobs (`checks`, `integration`, `production-browser`,
`interactive-browser`) still parse.

### 11.4 Cleanup

| Resource                                                   | Action                            | End state                |
| ---------------------------------------------------------- | --------------------------------- | ------------------------ |
| `C:\sm-163a`, `C:\sm-163b`                                 | created by this repair, removed   | gone                     |
| Playwright `next start` on 3200                            | started and stopped by Playwright | no listener on 3200/4100 |
| Pre-existing `node` processes (17988, 26120, 27664, 31468) | untouched                         | same PIDs after the run  |
| Chromium in the user's Playwright cache                    | already present, no download      | unchanged                |

### 11.5 Limits

- Local verification only: Windows 11, Node v24.11.1 (CI uses Linux, Node 22,
  and `--with-deps` installs OS packages there; that flag is a no-op here).
  pnpm was 9.4.0, the same as CI.
- **No remote success is claimed.** No `ci.yml` run exists for a SHA containing
  this change; the last observed remote run (`dc5b31e`) failed this job with
  TS5108 before the fix. Remote confirmation requires a run for the exact SHA.
- The remote runner's compiler version remains unknown. The fix does not depend
  on it, because the job no longer falls back to a global compiler.
- Findings 4 (intermittent integration) and 5 (cover-endpoint 500s) are open.
  Finding 2's `NEXT_PUBLIC_API_URL` coupling was repaired in 16.2 and does not
  affect this job.

---

## 12. Follow-up: Phase 16.4 repair of finding 4 (added after Phase 16.3)

Scope: the remote integration failures of finding 4 (two `SESSION_BUSY` from
concurrent creation, one 30 s timeout at cap minus one). The defect is in the
test harness. Production code, lock/statement/transaction timeouts, pooling,
caller counts and assertions are unchanged. Finding 5 is untouched.

### 12.1 Cause

Hypothesis, stated before any change: the gate needs all `parties` transactions
queued and observes them through the same Prisma client, so a pool smaller than
`parties + 1` leaves the observer and some participants unable to get a
connection while the lock holder waits for the gate. **Confirmed.**

Mechanism, in order (6 callers):

1. Each caller opens an interactive transaction and keeps one pooled connection
   for its whole duration (`interactive.service.ts:139`).
2. One caller wins the owner's `FOR NO KEY UPDATE` (`:148`), reaches the gate and
   waits there with its transaction open. The other five hold connections while
   blocked on that lock.
3. The gate polls `pg_stat_activity` through the same client
   (`countBlockedAdmissions`). When the pool holds no more than 6 connections,
   every one is taken, so the observer queues for a connection.
4. The five blocked callers run `SET LOCAL lock_timeout = 2000ms`. They fail at
   about 2.05 s with `SESSION_BUSY`. The gate has seen one arrival and at most one
   blocked backend, and the failed callers will never arrive, so it cannot open.
5. The spin loop had no bound. Where the test collects with `Promise.all`
   (identical creation, library and catalogue) the first `SESSION_BUSY` rejects the
   test. Where it uses `Promise.allSettled` (cap minus one) nothing rejects, and
   the test waits for the 30 s test timeout.

Prisma's default pool is `physical cores * 2 + 1`. This machine reports 16
logical CPUs, so the default is large and the suite passes here. A small CI
runner gets a small default; the observed failure signature fits any default of
6 or less (5 on a 2-core runner). The runner's real value was not observed.

### 12.2 Evidence

All runs used the same six callers, the same service code and the same
disposable targets. Only the pool capacity changed.

**A. Instrumented diagnostic (snapshot only).** The tested client was tagged with
its own `application_name`; a separate two-connection admin client sampled
`pg_stat_activity` for it, so the measurement could not itself be starved. The
gate was bounded at 8 s.

| Scenario              | Pool | Outcomes                        | Gate             | Observer's slowest query | Peak backends |
| --------------------- | ---- | ------------------------------- | ---------------- | ------------------------ | ------------- |
| identical creation    | 4    | 5 `SESSION_BUSY`, gate deadline | never opened     | 4017 ms                  | 4             |
| identical creation    | 5    | 5 `SESSION_BUSY`, gate deadline | never opened     | 2016 ms                  | 5             |
| identical creation    | 6    | 5 `SESSION_BUSY`, gate deadline | never opened     | 2017 ms                  | 6             |
| identical creation    | 7    | 6 ok, 1 session                 | opened at 127 ms | 19 ms                    | 7             |
| identical creation    | 8    | 6 ok, 1 session                 | opened at 128 ms | 37 ms                    | 7             |
| cap minus one (cap 3) | 4    | 5 `SESSION_BUSY`, gate deadline | never opened     | 4015 ms                  | 4             |
| cap minus one (cap 3) | 5    | 5 `SESSION_BUSY`, gate deadline | never opened     | 2017 ms                  | 5             |
| cap minus one (cap 3) | 6    | 5 `SESSION_BUSY`, gate deadline | never opened     | 2018 ms                  | 6             |
| cap minus one (cap 3) | 7    | 1 ok, 5 `SESSION_LIMIT_REACHED` | opened at 154 ms | 21 ms                    | 7             |
| cap minus one (cap 3) | 8    | 1 ok, 5 `SESSION_LIMIT_REACHED` | opened at 166 ms | 20 ms                    | 7             |

The threshold is exactly `parties + 1`: seven backends at pools 7 and 8 are six
participants plus the observer. In every failing row the observer's first slow
query returned only after the waiters' 2 s `lock_timeout` had killed them, and
the failed callers settled at about 2.03 to 2.07 s, then 4 s and 6 s as the
queue drained.

**B. The real specs, real gate, unmodified harness.** A temporary patch in the
snapshot let the kit read its pool size from an environment variable.

| Pool | Result                         | Failures                                                                                                                                |
| ---- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| 5    | 3 failed, 29 passed (32 tests) | library identical creation `SESSION_BUSY`; library cap minus one `Test timed out in 30000ms`; catalogue explicit-version `SESSION_BUSY` |
| 7    | 32 passed                      | none                                                                                                                                    |

These are the three remote failures. The two `SESSION_BUSY` tests were reported
at about 10 s rather than 2 s; the cause of the extra time was not isolated (the
unbounded gate left the holder's transaction open into cleanup, whose 10 s
transaction timeout would explain it, but that was not verified).

### 12.3 What changed

| File                                                                  | Change                                                                             |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `apps/api/test/integration/fixtures/interactive-helpers.ts`           | explicit connection budget, scoped observer, bounded gate and barrier, `settleAll` |
| `apps/api/test/integration/interactive-library.integration.spec.ts`   | identical-creation test collects with `settleAll` instead of `Promise.all`         |
| `apps/api/test/integration/interactive-catalogue.integration.spec.ts` | identical explicit-version test collects with `settleAll` instead of `Promise.all` |
| `apps/api/test/integration/interactive-harness.integration.spec.ts`   | new: 4 tests pinning the budget formula and the bounded waits                      |
| `docs/interactive-verification.md`                                    | this section                                                                       |

Harness behaviour:

- The kit's client gets an explicit `connection_limit` (`KIT_CONNECTION_LIMIT`,
  16, overridable per kit) and a per-kit `application_name`. The URL is built
  only when `DATABASE_URL` equals the disposable URL exactly; otherwise the kit
  throws. `setup.ts` and the runner guards are untouched.
- `gatedService` throws at once if `parties + 1` exceeds the kit's budget, so a
  too-small pool is a clear error, not a hang.
- `countBlockedAdmissions` counts only backends with the kit's `application_name`
  (the participants) and excludes its own backend. It previously counted every
  waiting backend in the database. It is not filtered by owner row: each gated
  test races one owner on one kit, so the two coincide, and an owner filter
  would need the row's `ctid`.
- `AdmissionGate` and `Barrier` wait at most 8 s (`HARNESS_WAIT_TIMEOUT_MS`,
  below the 10 s transaction and 30 s test timeouts). The first failure is kept
  and every participant, present or later, rejects with it, so transactions roll
  back and release the lock. An error from the observer fails the gate instead
  of spinning.
- `settleAll` awaits every caller before reporting the first failure, so a failed
  assertion cannot leave operations running into cleanup. The cap-minus-one test
  already used `Promise.allSettled`.
- Unchanged: 6 callers in every race, every assertion (one session and one
  genesis event for identical commands; one admission and five
  `SESSION_LIMIT_REACHED` at cap minus one), and all production code.

### 12.4 Verification (local only)

Method: `git archive HEAD` of the clean tree, normalized to LF (784 files),
`pnpm install --frozen-lockfile --offline`, `prisma generate`, no `.env` anywhere
in the snapshot (0 found; the working tree's `apps/api/.env` was not opened).
The four changed files were then copied in. Targets: `docker-compose.e2e.yml`
under the project name `p164-itest` (postgres 16 on 5440, redis 7 on 6380) with
the runner's guards active. Windows 11, Node v24.11.1, pnpm 9.4.0, Prisma 5.22.0.

| Check                                                                   | Result                                    |
| ----------------------------------------------------------------------- | ----------------------------------------- |
| before the fix: library + catalogue specs at pool 5 (real gate)         | 3 failed, 29 passed (see 12.2 B)          |
| after the fix: harness + library + catalogue specs                      | 3 files, 36 passed                        |
| complete guarded integration suite, once                                | exit 0, 27 files, 306 tests passed        |
| `pnpm --filter @book/api test`                                          | exit 0, 174 files, 2638 passed, 3 skipped |
| `pnpm --filter @book/api typecheck`                                     | exit 0                                    |
| `pnpm --filter @book/api typecheck:integration:hardening`               | exit 0                                    |
| ad hoc `tsc` of helper + library + harness + catalogue specs            | exit 0                                    |
| `pnpm --filter @book/api lint`                                          | exit 0 (`--max-warnings 0`)               |
| ESLint `--max-warnings 0` and Prettier `--check` on the four test files | exit 0, clean                             |
| `git diff --check` on the working tree                                  | exit 0                                    |

The complete suite was 26 files / 302 tests in finding 4; the difference is the
new harness spec (+1 file, +4 tests). Neither `typecheck` nor
`typecheck:integration:hardening` includes the library or harness specs, which
is why they were checked ad hoc; `tsconfig.integration.json` was not changed.

### 12.5 Negative control

In the snapshot only, the admission lock in `createSession` was reduced to a
plain `SELECT id FROM users WHERE id = ...` (the `FOR NO KEY UPDATE` clause
removed), then the fixed harness was run on the same three specs:

| Result | Count | Detail                                                                                                                            |
| ------ | ----- | --------------------------------------------------------------------------------------------------------------------------------- |
| failed | 5     | both identical-creation tests, cap minus one (`expected length 1 but got 6`), the lock-timeout mapping test, the budget-race test |
| passed | 31    | unrelated tests                                                                                                                   |

Each failure took 25 to 140 ms: with no lock the gate opens on arrivals alone,
and nothing hangs. The file was restored from a copy and its SHA-256 matched the
original (`1cda9dd7391f4009af1ea4b11af243a2840030ca220a5833adaa01b25e404d47`).
The working tree's production code was never modified.

### 12.6 Cleanup

| Resource                                           | Action                          | End state                        |
| -------------------------------------------------- | ------------------------------- | -------------------------------- |
| compose project `p164-itest` (postgres, redis)     | created by this task, `down -v` | containers, volume, network gone |
| LF snapshot and diagnostic files in the scratchpad | created by this task, removed   | gone                             |
| Pre-existing containers, running and exited        | untouched                       | same names and status            |

### 12.7 Limits

- **No remote success is claimed.** No `ci.yml` run exists for a SHA containing
  this change. Remote confirmation requires a run for the exact SHA; because the
  failure was intermittent, one green run is weak evidence and several are
  needed.
- The CI runner's CPU count and Prisma default pool were not observed. The
  mechanism does not depend on them: the budget is now explicit, so the runner
  size no longer decides the outcome.
- Local run: Windows 11, Node 24, with Linux Postgres/Redis containers. Node 22
  on Linux was not used: the guards pin `127.0.0.1:5440/6380`, which a client
  container cannot reach without weakening them.
- Only the three named tests were shown to fail from this cause. The other
  failures behind finding 4's "5 of the last 8" were not read, so they may have
  a different cause.
- Finding 5 (cover-endpoint 500s) is open. `interactive-http` passed 40/40 in
  the complete run.

## 13. Follow-up: Phase 16.4.1 terminal harness deadlines (added after Phase 16.4)

Scope: review of the Phase 16.4 harness found three ways its deadlines could be
bypassed. Section 12.3 described the gate and barrier as bounded and failing
"for every participant"; that was stronger than the code, and sections 12.1 to
12.7 are left as written. Only test-harness files changed. Production code, the
explicit pool budget, the disposable-target guard, the scoped observation, the
caller counts and every race assertion are unchanged. Finding 5 (cover-endpoint
500s) is untouched.

### 13.1 Defects, each reproduced by a test before any change

| #   | Defect in the 16.4 harness                                      | Cause                                                                                          | Result against it          |
| --- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------- |
| 1   | `AdmissionGate.pass` stays pending when the observer never ends | the deadline was compared only after the observer returned, so the observer wait was unbounded | still `pending` after 25ms |
| 2   | an observation returning after the deadline opens the gate      | the deadline was checked only when the count was insufficient                                  | `fulfilled`                |
| 3   | `Barrier(2, 20)`: a second caller after expiry releases it      | each `wait()` raced one shared promise with its own timer; the release was not gated by expiry | `fulfilled`                |

Two further weaknesses surfaced while writing the tests:

- Each caller had its own deadline and its own polling loop, so one caller's
  observer failure left another caller pending on its own observation, and
  callers rejected with different `Error` instances rather than one decision.
- Every participant that reached the gate ran its own observer query, so by
  reading the code the number of concurrent observations was bounded by arrivals,
  not by the single connection `OBSERVER_CONNECTIONS` reserves. Not measured.

### 13.2 What changed

| File                                                                | Change                                                             |
| ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `apps/api/test/integration/fixtures/interactive-helpers.ts`         | shared terminal decision; `AdmissionGate` and `Barrier` rebuilt    |
| `apps/api/test/integration/interactive-harness.integration.spec.ts` | 10 new tests (9 on controlled timers, 1 against the real database) |
| `docs/interactive-verification.md`                                  | this section                                                       |

Behaviour:

- One deadline per gate or barrier, started by its first participant. For the
  gate it covers every wait on the lock observer.
- Opening or failing is terminal and first-wins. Every pending caller and every
  later caller receives that same decision; for failure, the same `Error` object.
  A late arrival cannot open a failed barrier or gate, and arrivals after the
  decision are not counted.
- The gate observes through one shared loop with at most one observation in
  flight. A result that arrives after the decision is discarded; a rejection that
  arrives after it is consumed and dropped, so it cannot become an unhandled
  rejection. An observer error before the decision fails the gate for everyone.
- The deadline timer and the poll timer are cleared when the decision is made.
  Nothing polls after a failure.
- The deadline message reports the last completed observation (or `unobserved`)
  and says when an observation was still in flight at expiry.
- `settleAll` is unchanged. Every gated race still collects its callers with
  `settleAll` or `Promise.allSettled`, so a failed gate rejects the started
  transactions, they roll back, and they have settled before `cleanup()` runs.

Timeout is not cancellation. Expiry stops the harness waiting for the observer's
query; it does not stop the query. A `Promise.race`-style bound cannot cancel
Prisma work and this code does not try to: the abandoned `pg_stat_activity` read
keeps its pooled connection until it returns, and its result is ignored. The
read is a short catalogue query, but whether Prisma or Postgres cancels it on
disconnect was not verified.

### 13.3 Failing first

The new timer tests were run against the 16.4 helpers (same snapshot, same
runner configuration) before the helpers were changed.

| Test                                                                      | Against the 16.4 harness           |
| ------------------------------------------------------------------------- | ---------------------------------- |
| observer never settles: every gate participant rejects within the bound   | failed: `pending`                  |
| observation returns after the deadline: gate does not open                | failed: `fulfilled`                |
| sufficient observation resolves after expiration: gate stays failed       | failed: `pending`                  |
| observer rejection after expiration: ignored, no unhandled rejection      | failed: `pending`                  |
| observer failure while another observation is pending: one shared failure | failed: second caller `pending`    |
| `Barrier(2, 20)`: a caller after expiry is rejected, not released         | failed: `fulfilled`                |
| pending and later barrier callers receive the one expiry failure          | failed: distinct `Error` instances |
| gate opening clears deadline and poll timers                              | passed (guard)                     |
| barrier completing clears its deadline timer                              | passed (guard)                     |

Result: 7 failed, 2 passed. The two timer-cleanup tests also passed on the old
code; they guard the new implementation, whose extra poll timer must not leak.
The unhandled-rejection test turned red on its state assertion (the gate had not
expired), not on the unhandled-rejection check, so that check is a guard rather
than a demonstrated detector.

The tenth new test runs two real callers through a gate that can never open
(3 parties, 2 callers, 300 ms bound) and requires both to reject, no session to
be written and no kit backend left `idle in transaction`. It pins the
settle-before-cleanup behaviour. It was not run against the 16.4 implementation.

### 13.4 Verification (local only)

Method: `git archive HEAD` normalized to LF, with the five working-tree files
that differ from HEAD overlaid (the phase 16.4 harness work is still
uncommitted), `pnpm install --frozen-lockfile --offline`, `prisma generate`,
`@book/types` built. No `.env` in the snapshot (none found); the working tree's
`apps/api/.env` was not opened. Targets: `docker-compose.e2e.yml` under the
project name `p1641-itest`, with the runner's guards active. The tested helper
and spec files were hash-compared with the working tree afterwards (identical
after LF normalization).

| Check                                                                         | Result                                    |
| ----------------------------------------------------------------------------- | ----------------------------------------- |
| harness spec, timer tests only, 16.4 helpers                                  | 7 failed, 2 passed (13.3)                 |
| harness spec, timer tests only, new helpers                                   | 9 passed                                  |
| harness + library + catalogue specs, guarded runner                           | 3 files, 46 passed                        |
| same three specs, repeated three more times                                   | 46 passed each time                       |
| all `interactive-*` integration specs, guarded runner                         | 9 files, 163 passed                       |
| `pnpm --filter @book/api test`                                                | exit 0, 174 files, 2638 passed, 3 skipped |
| `pnpm --filter @book/api typecheck`                                           | exit 0                                    |
| `pnpm --filter @book/api typecheck:integration:hardening`                     | exit 0                                    |
| ad hoc `tsc` of helper + harness + library + catalogue specs                  | exit 0                                    |
| `pnpm --filter @book/api lint`                                                | exit 0 (`--max-warnings 0`)               |
| ESLint `--max-warnings 0` and Prettier `--check` on the four test files + doc | exit 0, clean                             |

The complete 27-file integration suite was not rerun for this change; the nine
interactive files were, because `Barrier` is shared by `interactive-concurrency`.
`typecheck` and `typecheck:integration:hardening` do not include the library or
harness specs, which is why they were also checked ad hoc;
`tsconfig.integration.json` was not changed.

### 13.5 Negative control

In the snapshot only, `FOR NO KEY UPDATE` was removed from the two admission
statements in `interactive.service.ts` that end the clause (3 occurrences
became 1), then the gated specs were run with the new harness:

| Result | Count | Detail                                                                                                                        |
| ------ | ----- | ----------------------------------------------------------------------------------------------------------------------------- |
| failed | 5     | both identical-creation tests, cap minus one, lock-timeout mapping, the minimum-budget race: the same five as in section 12.5 |
| passed | 41    | unrelated tests                                                                                                               |

The file was restored from a copy and its SHA-256 matched. The working tree's
production code was never modified.

### 13.6 Cleanup

| Resource                                         | Action                          | End state                           |
| ------------------------------------------------ | ------------------------------- | ----------------------------------- |
| compose project `p1641-itest` (postgres, redis)  | created by this task, `down -v` | containers, volume, network gone    |
| LF snapshot and install log in the scratchpad    | created by this task, removed   | gone                                |
| `storyme-integration-*` and all other containers | untouched                       | same names and status, still exited |

### 13.7 Limits

- No remote success is claimed. Nothing was committed or pushed and no workflow
  ran; the CI runner's behaviour was not observed.
- Fake timers prove the deadline logic. They do not show how long a real
  Postgres observer query takes under load, only that its duration can no longer
  extend the gate's bound.
- The abandoned observer query is not cancelled (13.2), and its connection stays
  in the pool until it returns. If that query hung, a kit disconnect could wait
  on it. This was not observed and not tested.
- The unhandled-rejection assertion and the two timer-cleanup tests are guards
  that were green before the change, not demonstrated detectors (13.3).
- The real-database settle test and the 12.5/13.5 controls cover one service and
  one lock. Local run only: Windows 11, Node 24, Linux containers.
- Finding 5 (cover-endpoint 500s) is open and is the next task.

---

## 14. Follow-up: Phase 16.5 repair of finding 5 (added after Phase 16.4.1)

Sections 1 to 13 are left as written. Section 5 said the failing handler path
was `getOrCreateCoverThumbnail` and `renderCoverThumbnail`, and that the cause was
not established. **That attribution was wrong and is corrected here.** The
`cover` image id reads the original published asset; only `cover-thumb` calls
`getOrCreateCoverThumbnail`. Neither the thumbnail code nor storage was involved.

### 14.1 Established cause

The asset service succeeds. The 500 is raised afterwards, in Nest's Express
adapter, when the browser has already aborted the request.

1. The published-book reader requests `/images/cover` on mount and aborts that
   request when its effect re-runs (slide change, remount, development
   double-invoke). The client is then gone.
2. `BookAssetService.getPublishedImage` still resolves with the image bytes.
3. The controller returns `new StreamableFile(buffer)`.
   `ExpressAdapter.reply` calls `stream.pipeline(stream, response)` on a response
   that is already destroyed, which throws `ERR_STREAM_UNABLE_TO_PIPE`
   (`Cannot pipe to a closed or destroyed stream`) synchronously.
4. `HttpExceptionFilter` receives a plain `Error`, logs `Unhandled exception on
GET ... errorName=Error` and tries to write a 500 to a dead socket.

No user sees a failure: the cover the reader asked for was the one it had
already abandoned. The defect is a false 500 in logs and error accounting, and an
error response attempted on a destroyed socket.

What is inferred, not tested: that development-mode double-invoked effects are
the trigger in these runs. The abort itself is established (`req.aborted` and
`res.destroyed` were both true in the filter, headers not sent). A production
build, where every slide change or navigation also aborts, was not run.

### 14.2 Reproduction and mapping

Method: `git archive HEAD` with `core.autocrlf=false`, extracted to
`C:\sm-p165` (788 files; 3 binary files contain CR bytes, no text file does),
`pnpm install --frozen-lockfile --offline`, `prisma generate`, `@book/types`
built. No `.env` in the snapshot; the working tree's `apps/api/.env` was not
opened. The tree was clean at the start. Targets: `docker-compose.e2e.yml` under
project `p165-cover` (not the repo's `storyme-integration` project, whose exited
containers were left alone). Temporary instrumentation existed only in the
snapshot (a wrapper around `getPublishedImage` and extra fields in the filter)
and was removed before the fix was verified; both files were hash-compared with
`HEAD` afterwards.

`storyme.smoke.spec.ts`, retries off, two runs on unmodified `HEAD` code:

| Run | Result    | Unhandled `GET .../images/cover` 500s | Distinct books |
| --- | --------- | ------------------------------------- | -------------- |
| 1   | 14 passed | 8                                     | 5              |
| 2   | 14 passed | 7 (all `ERR_STREAM_UNABLE_TO_PIPE`)   | 4              |

Run 2 entries, mapped to Playwright test windows by timestamp and book id:

| Test                                                      | 500s | Book                   | Asset service result for that request |
| --------------------------------------------------------- | ---- | ---------------------- | ------------------------------------- |
| logs in, generates a mock book, and downloads its PDF     | 1    | generated, `complete`  | `cover: ok` (74-byte PNG)             |
| corrects page text and confirms one page-image regen      | 2    | generated, `complete`  | `cover: ok`                           |
| retries a failed book through the worker (seeded `...06`) | 1    | `complete` after retry | `cover: ok`                           |
| atomically replaces a successful publication              | 3    | generated, `complete`  | `cover: ok`                           |

In run 1 the same mechanism also hit the permanent-deletion test once (a race:
the reader's cover request was still in flight when the book was deleted). The
count differs between runs because the abort is timing dependent. The audit's
"one a seeded fixture" is the retry fixture `...06`, which is a real generation
by the time it is read; it is not one of the four publication fixtures.

Every throw inside `BookAssetService.getPublishedImage` in both runs was a
`NotFoundException` (404). None was a 500.

### 14.3 Incomplete fixtures, separately

The four publication fixtures (`...11` to `...14`) carry `bookPreview` and
`previewPdfUrl` but no image bytes. They resolve to the legacy namespace and the
key `<bookId>/cover` does not exist, so their cover and `cover-thumb` requests
return **404 `Published image not found in storage`** (run 1: 6 `cover` plus 9
`cover-thumb` entries, all 404). That is the existing contract and is a fixture
gap, not a production defect. It had hidden real regressions: no test asserted
that these books show a cover.

### 14.4 Regression, failing first

New file `apps/api/src/books/books.controller.published-image-http.spec.ts`
drives the real controller through Nest's Express adapter over HTTP, with a stub
`BooksService`. The abort test opens a request, destroys the client socket once
the handler has been reached, waits for the server-side close, then lets the
service resolve with a valid PNG.

| Test                                                                 | Unfixed controller                                                        | Fixed controller |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------- |
| client aborts before the cover is ready: no unhandled-exception log  | **failed**: `Unhandled exception on GET .../images/cover errorName=Error` | passed           |
| connected client gets 200, `image/png`, nosniff, no-store, decodable | passed                                                                    | passed           |
| missing/not-visible image keeps the 404 body                         | passed                                                                    | passed           |
| stale `edition` keeps 409 and forwards the edition                   | passed                                                                    | passed           |

Two harness errors of mine were fixed before this result was trusted, and are
not product findings: vitest's esbuild transform emits no `design:paramtypes`,
so Nest injected nothing (every test returned 500 until the constructor type was
declared in the spec), and a first instrumentation patch mangled a source file
through shell and `String.replace` escaping, so the API did not start.

### 14.5 What changed

| File                                                               | Change                                                                                                                              |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/books/books.controller.ts`                           | `getPublishedImage` returns `undefined` when `res.destroyed` after the service call (return type widened)                           |
| `apps/api/src/books/books.controller.published-image-http.spec.ts` | new, the four tests above                                                                                                           |
| `apps/api/scripts/e2e-fixtures.ts`                                 | seeds legacy-key `cover`, `page-1`, `back-cover` PNGs for the four publication fixtures; cleanup also removes `tmp/images/<bookId>` |
| `apps/web/e2e/storyme.smoke.spec.ts`                               | cover assertions below                                                                                                              |

Unchanged: publication pointers, ownership and edition checks, storage-key
validation, deletion fencing, `BookAssetService`, the exception filter, PDF
routes, CI workflows, dependencies, schema and all web application code.

Smoke assertions added: the cover route returns 200, `image/png`, non-empty bytes
and a PNG whose IHDR width and height are positive; the reader's
`Illustration for cover` image is visible with `naturalWidth > 0`, for a
generated book and for the complete, running, failed and cancelled fixtures; the
previous edition's cover stays served during an active regeneration, the new
edition is served afterwards and the replaced edition returns 409; a new test
checks anonymous 401, another user 404 and stale edition 409 with the
`PUBLISHED_EDITION_CHANGED` body; the deletion test asserts cover 200 before and
404 after.

### 14.6 Verification (local only)

| Check                                                                    | Result                                                                       |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| regression spec on unfixed controller                                    | 1 failed, 3 passed                                                           |
| regression + controller + asset-service specs, fixed                     | 3 files, 60 passed                                                           |
| `pnpm --filter @book/api test`                                           | exit 0, 175 files, 2642 passed, 3 skipped                                    |
| `pnpm --filter @book/api typecheck`                                      | exit 0                                                                       |
| `typecheck:scripts`, `typecheck:integration:hardening`                   | exit 0 each                                                                  |
| `pnpm --filter @book/api lint`                                           | exit 0 after one Prettier error in the new spec was fixed (first run exit 1) |
| `pnpm --filter @book/web typecheck` (includes the e2e spec), `lint`      | exit 0 each; ESLint on `e2e/storyme.smoke.spec.ts` clean                     |
| `pnpm format:check` in the snapshot                                      | flagged only 4 untracked `.diag/*.json` files of mine; no tracked file       |
| `git diff --check` (working tree)                                        | exit 0                                                                       |
| new assertions, fix applied, fixtures **not** seeded                     | 6 failed, 9 passed (see below)                                               |
| new assertions, fixtures seeded                                          | 15 passed, 0 unhandled exceptions                                            |
| complete `storyme.smoke.spec.ts`, guarded launcher, `--retries=0`, final | **15 passed** in 2.4 min, 0 unhandled exceptions, "E2E fixtures cleaned up." |

The 6 failures with unseeded fixtures: the four fixture reader tests (no
`<img>`, because the cover is a 404) and the refusal test (current-edition cover 404) are the incomplete-fixture evidence. The sixth, the generated-book test,
was my helper: the lazy-loaded illustration has no height until it nears the
viewport and the reader sits below the fold on that long page. The helper now
scrolls the reader into view first. That is not a product defect.

Not run, because nothing they cover changed: web unit tests and build (no web
application code changed; only an e2e spec), `render:pdf` (no PDF code changed),
the integration suite.

### 14.7 Cleanup

| Resource                                              | Action                              | End state                                            |
| ----------------------------------------------------- | ----------------------------------- | ---------------------------------------------------- |
| compose project `p165-cover` (postgres, redis)        | created by this task, `down -v`     | containers, volume, network gone                     |
| LF snapshot `C:\sm-p165` (incl. test results, logs)   | created by this task, removed       | gone                                                 |
| `storyme-integration-*` containers and other projects | untouched                           | same names and status, still exited                  |
| ports 5440, 6380, 4100, 3100                          | free at start                       | no listener; only `TIME_WAIT` sockets, which age out |
| working tree `apps/api/tmp`, `apps/api/.env`          | never used by any run, never opened | unchanged                                            |

### 14.8 Limits and what is still open

- No remote success is claimed. Nothing was committed, pushed or deployed and no
  workflow ran. Local only: Windows 11, Node 24, Linux containers.
- The browser suite cannot observe the server-side classification of an aborted
  request, because the client has already left. The API HTTP spec is the
  detector; the smoke assertions cover the served cover, the reader and the
  refusal contract. A deliberate E2E abort test was not added for that reason.
- `GET /api/books/:id/pdf/preview` returns a `StreamableFile` through the same
  adapter path and should have the same latent defect for aborted downloads. It
  was not reproduced and was not changed, to keep this phase to the demonstrated
  cause and to avoid touching PDF behavior. It is open.
- The `cover-thumb` route shares the controller guard but its abort case was not
  separately exercised.
- Finding 5 is repaired for `/images/*` aborts only. CI still does not run
  `storyme.smoke.spec.ts` (finding 5's second point); that is unchanged.
- Each suite ran once after the final change, except the smoke spec, which ran
  twice after it (15 passed each time). Timing-dependent aborts were not stress
  tested.

## 15. Follow-up: Phase 16.6 aborted PDF preview requests (added after Phase 16.5)

Sections 1 to 14 are left as written. Section 14.8 recorded that
`GET /api/books/:id/pdf/preview` returns a `StreamableFile` through the same
adapter path and "should have the same latent defect for aborted downloads", and
that it was not reproduced. **It is now reproduced and repaired.**

### 15.1 Established cause

Identical to 14.1 steps 3 and 4, on a different route.

1. `BooksController.getPreviewPdf` awaits `BooksService.getPreviewPdfBuffer`.
   The client can leave while that call is still pending.
2. The service resolves with the PDF bytes for a client that is gone.
3. The handler set headers and returned `new StreamableFile(buffer)` without
   looking at `res.destroyed`. `ExpressAdapter.reply` then calls
   `stream.pipeline(stream, response)` on a destroyed response, which throws
   `ERR_STREAM_UNABLE_TO_PIPE` synchronously.
4. `HttpExceptionFilter` receives a plain `Error` and logs
   `Unhandled exception on GET .../pdf/preview errorName=Error`.

`getPublishedImage` already had the guard from Phase 16.5; `getPreviewPdf` did
not. Neither the PDF service, storage, publication nor rendering is involved: the
read succeeds and the failure is raised afterwards, in the adapter.

What is established: the real-socket regression below fails on the unfixed
controller with exactly this log line. What is not established: that a browser
in normal use hits this route with aborts as often as `/images/cover`. The PDF
link is a user-initiated open or download, so aborts are plausibly less
frequent. The smoke suite was run only after the change, not before, so it
offers no before/after comparison for this route (see 15.5).

### 15.2 Regression, failing first

New file `apps/api/src/books/books.controller.pdf-preview-http.spec.ts` follows
`books.controller.published-image-http.spec.ts`: the real `BooksController`
through Nest's Express adapter over a real socket, a stub `BooksService`, the
real `HttpExceptionFilter`, `Logger.prototype.error` spied.

| Test                                                                        | Unfixed controller                                                       | Fixed controller |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------- |
| client aborts before the PDF is ready: no unhandled-exception log/rejection | **failed**: `Unhandled exception on GET .../pdf/preview errorName=Error` | passed           |
| connected client: 200, `application/pdf`, disposition, length, exact bytes  | passed                                                                   | passed           |
| missing or inaccessible PDF keeps the 404 body                              | passed                                                                   | passed           |
| not ready keeps the 409 body                                                | passed                                                                   | passed           |
| stale `edition` keeps 409 `PUBLISHED_EDITION_CHANGED`, forwards the edition | passed                                                                   | passed           |
| genuine service failure keeps the sanitized 500 and is still logged once    | passed                                                                   | passed           |

Unfixed run: 1 failed, 5 passed. The five that passed are the point: they show
the contracts the fix must not move were already being asserted.

The exact-bytes fixture contains bytes that are not valid UTF-8 (`0xe2 0xe3 0xcf
0xd3 0x00 0xff 0xfe`), so any text re-encoding on the way out would fail the
assertion. The sanitized-500 test asserts that neither the thrown message nor the
internal host name appears in the response body.

A unit test was added to `books.controller.spec.ts`: with `res.destroyed` true
the handler returns `undefined`, still calls the service once with the same
arguments, and sets no headers.

### 15.3 What changed

| File                                                           | Change                                                                                                               |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/books/books.controller.ts`                       | `getPreviewPdf` returns `undefined` when `res.destroyed` after the service call, before headers; return type widened |
| `apps/api/src/books/books.controller.pdf-preview-http.spec.ts` | new, the six tests above                                                                                             |
| `apps/api/src/books/books.controller.spec.ts`                  | one unit test for the destroyed-response branch                                                                      |
| `docs/interactive-verification.md`                             | this section                                                                                                         |

The production change is one guard and a return type:
`if (res.destroyed) return undefined;` placed after the `await` and before
`res.set(...)`. The route path, headers, `BookAssetService`, storage,
publication, deletion fencing, the exception filter, PDF rendering, generation,
CI, dependencies and web code are unchanged. The image guard is unchanged.

### 15.4 Abort timing covered, and not

Covered by the regression, in order:

1. The request has reached the handler and the stub service call is pending. No
   header has been written and no response byte has been sent.
2. The client socket is destroyed.
3. The server-side socket `close` event is awaited, then one `setImmediate` tick.
4. Only then does the stub service resolve, successfully, with the PDF bytes.
5. Two further ticks let the handler, adapter and filter settle, then the log
   and unhandled rejections are asserted empty.

Not covered:

- A client that leaves **after** headers were sent and while the body is being
  piped. Nothing was changed for that case; the guard is only before headers.
- A client that leaves before the handler is reached (guards, pipes).
- A close event arriving between the `res.destroyed` check and the adapter's
  `pipeline` call. This is reasoned, not tested: there is no I/O between the two
  (the handler returns, then the adapter replies), so a socket event cannot be
  delivered in that gap on a single thread.
- The service **rejecting** after an abort. The filter would then still try to
  write an error to a destroyed response; that is unchanged and was not touched.

### 15.5 Verification (local only)

All in a snapshot of the working tree (below), no `.env`, mock providers, local
storage.

| Check                                                            | Result                                                                        |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| PDF regression spec on the unfixed controller                    | 1 failed, 5 passed                                                            |
| PDF HTTP + image HTTP + `books.controller.spec.ts`, fixed        | 3 files, 43 passed (6 + 4 + 33)                                               |
| `pnpm --filter @book/api test`                                   | exit 0, 176 files, 2649 passed, 3 skipped                                     |
| `pnpm --filter @book/api typecheck`                              | exit 0                                                                        |
| `pnpm --filter @book/api lint` (`--max-warnings 0`)              | exit 0 after one Prettier error in the new spec was fixed (first run: exit 1) |
| `prettier --check` on the three touched TypeScript files         | clean after the same fix                                                      |
| `pnpm --filter @book/api render:pdf`                             | exit 0, 42,691 bytes                                                          |
| `storyme.smoke.spec.ts`, guarded disposable infra, `--retries=0` | **15 passed** in 2.1 min, exit 0                                              |
| API log of that smoke run                                        | 1,187 lines captured; 0 `Unhandled exception`, 0 `ERR_STREAM_UNABLE_TO_PIPE`  |
| `git diff --check` (working tree)                                | exit 0                                                                        |
| manual whitespace check of the untracked spec                    | no trailing whitespace, no tabs, LF, final newline                            |

The full-suite count is +1 file and +7 tests against 14.6 (175 files, 2642
passed): six HTTP tests and one unit test.

Not run, because nothing they cover changed: web unit tests, typecheck and build
(no web or shared-types change), `typecheck:scripts`, the integration suite, and
a root `pnpm format:check` (only the touched files and this section were
checked).

The smoke suite does include "logs in, generates a mock book, and downloads its
PDF", so the connected-client PDF path ran end to end through a browser. It does
not abort a PDF request, so its 0 is a no-regression result, not evidence for the
fix; the HTTP regression is the detector.

### 15.6 Method and cleanup

| Item                | What was done                                                                                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| snapshot            | `git ls-files -co --exclude-standard` of the working tree (790 files, includes the untracked spec, excludes ignored files) copied to `C:\sm-p166`; no `.env` present |
| line endings        | the working tree has 271 CRLF files from `autocrlf=true` (index is LF); 273 text files were normalized to LF **in the snapshot only**, matching the index            |
| install             | `pnpm install --frozen-lockfile --offline`, `prisma generate`, `@book/types` built                                                                                   |
| snapshot-only tweak | `stdout: 'pipe'` on the API `webServer` in `playwright.config.ts`, so the API log could be counted; not in the working tree                                          |
| infra               | `docker compose -p p166-pdf -f docker-compose.e2e.yml up -d --wait postgres-e2e redis-e2e`, the exact disposable targets (5440, 6380) the launcher allows            |

| Resource                                         | Action                          | End state                                 |
| ------------------------------------------------ | ------------------------------- | ----------------------------------------- |
| compose project `p166-pdf` (postgres, redis)     | created by this task, `down -v` | containers, volumes, network gone         |
| snapshot `C:\sm-p166` (incl. test results, logs) | created by this task, removed   | gone                                      |
| all other containers, networks and volumes       | untouched                       | list compared before and after: identical |
| ports 5440, 6380, 4100, 3100                     | free at start                   | no listener at the end                    |
| working tree `apps/api/.env`, `apps/api/tmp`     | never opened, never written     | unchanged                                 |

### 15.7 Limits and what is still open

- No remote success is claimed. Nothing was committed, pushed or deployed, and
  no workflow ran. Local only: Windows 11, Node 24, Linux containers.
- The Prettier error and the 29,245 `␍` lint errors seen on the way were both
  harness-side: the first was a real formatting slip in my new spec (fixed), the
  second was the CRLF working-tree copy (normalized in the snapshot).
- The abort case is deterministic in the HTTP spec, but it was run once after
  the final change and not stress tested.
- The `cover-thumb` abort case from 14.8 remains separately unexercised.
- Aborts during body streaming, and a service that rejects after an abort, are
  open (15.4).
- CI still does not run `storyme.smoke.spec.ts`; unchanged.

## 16. Follow-up: Phase 16.7 book/PDF browser smoke suite in CI (added after Phase 16.6)

Sections 1 to 15 are left as written. Section 15.7 ended with "CI still does not
run `storyme.smoke.spec.ts`". **CI is now configured to run it.** Remote success
is not verified (16.7).

### 16.1 What changed

| File                               | Change                                                          |
| ---------------------------------- | --------------------------------------------------------------- |
| `.github/workflows/ci.yml`         | one command in the `interactive-browser` job selects both specs |
| `docs/interactive-verification.md` | this section                                                    |

```
- run: pnpm --filter @book/web test:e2e e2e/interactive.spec.ts
+ run: pnpm --filter @book/web test:e2e e2e/interactive.spec.ts e2e/storyme.smoke.spec.ts
```

Both spec files are named explicitly. The directory is not selected, because
`e2e/` is shared with production smoke, which has its own configuration and job.

The YAML of `HEAD` and of the working tree were both parsed and compared
structurally. The only difference is the `run` string of step 8 of
`interactive-browser`. Job IDs and display names, triggers, permissions, action
and Node/pnpm versions, timeouts, the retry policy (set in
`playwright.config.ts`, not in the workflow), the `production-browser` job, the
failure-artifact upload and the unconditional `test:infra:down` are unchanged.
The step reuses the existing install, Prisma generation, shared-types build,
Chromium setup and guarded infrastructure.

### 16.2 Local execution of the combined command

Environment, as it actually was: Windows 11, **Node v24.11.1** (CI uses 22), pnpm
9.4.0, Docker Desktop with Linux containers, Playwright Chromium. Not Linux, not
Node 22.

| Item              | What was done                                                                                                                                                           |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| snapshot          | `git ls-files -co --exclude-standard` of the working tree (790 files, no `.env`) copied to `C:\sm-p167`; 273 CRLF text files normalized to LF in the snapshot only      |
| setup             | `pnpm install --frozen-lockfile --offline`, `prisma:generate`, `@book/types` build, `playwright install chromium` (no `--with-deps`, which is Linux apt packages)       |
| command           | `CI=true pnpm --filter @book/web test:e2e e2e/interactive.spec.ts e2e/storyme.smoke.spec.ts --retries=0 --reporter=list,json`                                           |
| reporter          | `list,json` replaces the config's `line,html` so per-spec counts could be read; reporters do not affect execution                                                       |
| snapshot-only     | `stdout: 'pipe'` on the API `webServer`, so the API log could be counted; not in the working tree                                                                       |
| infra             | `docker compose -p p167-ci -f docker-compose.e2e.yml up -d --wait postgres-e2e redis-e2e`: the exact disposable targets (5440, 6380). **Not** `pnpm test:infra:up/down` |
| providers/storage | the config's own: mock story, character and image providers, `console` email, local PDF and image storage                                                               |

`pnpm test:infra:up/down` use the compose project `storyme-integration`, which
already had two **exited** containers from earlier work. `down -v
--remove-orphans` would have deleted them, so a separate project name was used
with the same compose file. The consequence is that `test-infra-entry.mjs`'s own
target assertion was not exercised in this run. The Playwright API launcher
(`test-launcher.mjs api-e2e`) did run and applies its own disposable-target
check before migrating.

| Run | interactive.spec.ts | storyme.smoke.spec.ts         | Skipped | Retries | Duration | Exit  |
| --- | ------------------- | ----------------------------- | ------- | ------- | -------- | ----- |
| 1   | 40 of 40 passed     | **14 of 15 passed, 1 failed** | 0       | 0       | 6.0 min  | **1** |
| 2   | 40 of 40 passed     | 15 of 15 passed               | 0       | 0       | 5.6 min  | 0     |

Both specs were collected and executed in both runs (55 tests). The second run
was started only after the first failed, with no change to any file, to see
whether the failure repeats. It did not: **the failure is intermittent**, 1 of 2.

### 16.3 The failure (run 1)

Test: `storyme.smoke.spec.ts:234`, "cancels an active family generation without
requiring a credit charge". `getByRole('status')` never appeared within 15 s; the
page snapshot shows the book as `complete`.

What the trace and the API log show, in order:

1. `POST /books/:id/generate` returns 200.
2. `GET /books/:id/generation-progress` returns `{"status":"queued"}`.
3. `POST /books/:id/cancel` returns **409 `BOOK_NOT_IN_PROGRESS`** in 18 ms.
4. `worker_job_started` and `Starting generation pipeline` are logged **before**
   that 409 completes; the pipeline then finishes `complete` about a second
   later.

So the cancel was refused while the run was still active, and the run was not
cancelled.

Mechanism, from the code (`GenerationRunCoordinator.cancelGeneration`, lines
542 to 593 at `HEAD`, and `GenerationRunService.claim`):

1. Cancel reads the run as `queued` at fencing version N.
2. Its update is conditional on exactly `status: queued` and
   `fencingVersion: N`.
3. The worker's `claim` unconditionally sets `status: running` and increments
   `fencingVersion`. If it commits between 1 and 2, the cancel update matches
   zero rows.
4. The fallback re-reads the run and returns `already_cancelled` only for
   `cancelled`; anything else, including a still-**running** run, is reported as
   `not_in_progress`, which becomes 409 `BOOK_NOT_IN_PROGRESS`.

The comment on that fallback names two losing races, a concurrent cancellation
and a concurrent completion. A concurrent **claim** is a third, and it is the
likely one: it happens whenever Cancel is pressed in the first milliseconds
after Generate, which is what this test does.

What is established: the 409 body, the `queued` progress read just before it,
the log ordering, and a code path that produces exactly this outcome. What is
not: the interleaving itself was not instrumented, and the race was not
reproduced in isolation or with a deterministic test.

### 16.4 Reading of the result

- This is an API race, not a harness fault, and I could not show that it is an
  artifact of running the specs together. The failing test does not depend on the
  other spec's state. Whether running the two together changes how often it
  occurs is **not known**: the standalone smoke run in 15.5 passed 15 of 15, the
  combined runs are 1 failure in 2, and neither sample is large enough to say.
- It is also a user-facing behavior: Cancel pressed immediately after Generate
  can be refused with "not currently generating" while generation continues.
  How the web UI presents that 409 was not inspected beyond the page ending in
  `complete` with no cancellation message.
- With the workflow's existing retry policy (`retries: 1` under `CI`), a first
  attempt that loses this race would be retried and reported as **flaky**, not
  failed. That masks the defect rather than removing it, and a second loss would
  fail the job.
- Not done, by scope: the assertion was not weakened, no retry was added, and the
  coordinator was not changed. The fix belongs to a separate phase with a
  deterministic concurrency regression (cancel interleaved with claim) written
  first.

### 16.5 API log (both runs)

| Check                               | Run 1 | Run 2 |
| ----------------------------------- | ----- | ----- |
| `Unhandled exception`               | 0     | 0     |
| `ERR_STREAM_UNABLE_TO_PIPE`         | 0     | 0     |
| `ExceptionsHandler` / `ERROR` lines | 0     | 0     |
| HTTP 5xx                            | 0     | 0     |
| HTTP 409                            | 6     | 5     |
| `WARN`                              | 1     | 1     |

The sixth 409 in run 1 is the cancel refusal in 16.3. The other five were not
attributed to individual tests one by one; they are identical in number across
both runs and none was unhandled. The single `WARN` in both runs is "Retry for
book ... found no prior GenerationRun to copy input from", which is what the
retry test produces for its seeded failed fixture. 401 lines are unauthenticated
session restores before login. Nothing here is the abort defect of Phases 16.5
and 16.6.

### 16.6 Cleanup

| Resource                                      | Action                                 | End state                                                                                                      |
| --------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| compose project `p167-ci` (postgres, redis)   | created by this task, `down -v`        | containers, network, volumes gone                                                                              |
| snapshot `C:\sm-p167` (results, traces, logs) | created by this task, removed          | gone                                                                                                           |
| Playwright servers on 3100 and 4100           | started and stopped by Playwright      | no listener at the end                                                                                         |
| E2E fixtures                                  | removed by the suite's global teardown | "E2E fixtures cleaned up." in both runs                                                                        |
| all other containers, networks and volumes    | untouched                              | container list compared before and after: identical, including the two exited `storyme-integration` containers |
| `apps/api/.env`                               | never opened or read                   | unchanged                                                                                                      |

### 16.7 Static checks and limits

| Check                                         | Result                                                  |
| --------------------------------------------- | ------------------------------------------------------- |
| YAML parse and structural diff against `HEAD` | one changed string, the command above                   |
| `prettier --check .github/workflows/ci.yml`   | clean (on the LF snapshot copy)                         |
| `git diff --check`                            | exit 0                                                  |
| `actionlint`, `yamllint`                      | not installed; not installed for this task; **not run** |

- `ci.yml` keeps its UTF-8 BOM and the working tree's CRLF line endings (the
  index is LF). A `sed -i` under Git Bash silently stripped the CRs once and they
  were restored; the final diff is one line.
- No remote success is claimed. Nothing was committed, pushed or deployed, and
  no workflow ran. The result for the exact SHA needs an authorized run.
- Local only, on Node 24 and Windows, not the `ubuntu-latest`/Node 22 runner. Two
  runs is not a flake rate. Timing on a hosted runner may widen or narrow the
  race in 16.3.
- **The combined job is expected to be intermittently red or flaky until 16.3 is
  fixed.** Including the smoke suite is the intended change; the cancel race is
  what it exposes.

## 17. Follow-up: Phase 16.8 cancellation losing to a worker claim (added after Phase 16.7)

Sections 1 to 16 are left as written. Section 16.4 ended with "the fix belongs to
a separate phase with a deterministic concurrency regression (cancel interleaved
with claim) written first". This is that phase. The change is local and
uncommitted; **no remote confirmation exists** (17.8).

### 17.1 Cause, and one correction to 16.3

`GenerationRunCoordinator.cancelGeneration` read the run, then wrote
`status: cancelled` conditional on exactly the `status` and `fencingVersion` it
had read. `GenerationRunService.claim` moves `queued` to `running` and bumps
`fencingVersion`. A claim that commits between the read and the write makes the
write match zero rows. The fallback re-read returned `already_cancelled` only for
`cancelled`, so a run that was `running` became `not_in_progress`, which the API
maps to 409 `BOOK_NOT_IN_PROGRESS` while generation continued.

Correction to 16.3: it described the claim as `queued` to `running`. `claim`
also matches an already `running` run and bumps the fence again, which is what a
BullMQ redelivery does. The exact-fence write lost to that too, so the window was
wider than the one 16.3 named. Both are covered below.

### 17.2 Regression, failing first

Real PostgreSQL, in `generation-cancellation.integration.spec.ts`. The
cancellation runs through the real coordinator and real `$transaction`; a
test-side Proxy around `PrismaService` awaits a deferred barrier immediately
before `generationRun.updateMany`, the cancellation's single write to that table.
While it is held the test commits the competing operation through the unwrapped
client, then releases the barrier. No sleeps, no production hook, no change to
`GenerationRunService`.

| New test (8)                                                       | Before the change | After  |
| ------------------------------------------------------------------ | ----------------- | ------ |
| claim commits between read and write: run cancelled, one refund    | **fails**         | passes |
| the worker whose claim raced can no longer heartbeat or complete   | **fails**         | passes |
| re-claim of an already running run (redelivery) does not defeat it | **fails**         | passes |
| two cancellations both read `queued`, a claim commits: one applied | **fails**         | passes |
| refund failure after the claim raced still rolls everything back   | **fails**         | passes |
| completion between read and write wins: stays completed, no refund | passes (guard)    | passes |
| replacement run created in the gap is never cancelled              | passes (guard)    | passes |
| another user / soft-deleted book is `not_found`, run untouched     | passes (guard)    | passes |

Before the change: `Tests 5 failed | 14 passed (19)`. The failures are
`expected { kind: 'not_in_progress' } to match object { kind: 'applied', ... }`,
which is the defect, reproduced deterministically (the refund-rollback test fails
as "promise resolved { kind: 'not_in_progress' } instead of rejecting", because
the old code never reached the refund). The three guards pass on the old code by
design: they pin invariants that must not regress when the status filter is
widened.

### 17.3 What changed

| File                                                            | Change                                                        |
| --------------------------------------------------------------- | ------------------------------------------------------------- |
| `apps/api/src/agent/generation-run-coordinator.service.ts`      | the cancellation `where`, plus the comments that described it |
| `apps/api/src/agent/generation-run-coordinator.service.spec.ts` | two assertions updated, one `describe` of 7 unit tests added  |
| `.../generation-cancellation.integration.spec.ts`               | the regression above                                          |
| `docs/interactive-verification.md`                              | this section                                                  |

The production change is one condition:

```
-  status: run.status,
-  fencingVersion: run.fencingVersion,
+  status: { in: [queued, running] },
```

The write keeps `id`, `bookId` and `userId`, and still sets
`fencingVersion: { increment: 1 }`.

Why this is safe:

1. **Row-level exclusion.** PostgreSQL takes the row lock for an `UPDATE` and
   re-evaluates its `WHERE` against the latest committed version. Claim,
   cancellation and completion therefore serialize on the one run row; each
   loser re-evaluates against the winner's result.
2. **Claim first.** The row is `running`, still matches, and `increment` is
   applied to the current fence, so whichever delivery owns the run is fenced
   out. This is the case that used to fail.
3. **Cancellation first.** `claim`'s own `WHERE` is `status in (queued, running)`;
   it matches zero rows and returns `null`, as before.
4. **Completion or failure first.** The status is terminal, so nothing matches.
   The run is not overwritten, nothing is refunded, and the fallback re-read
   reports `not_in_progress`.
5. **Replacement run.** The target is the id read from `Book.activeRunId`, and
   the Book write still requires `activeRunId` to equal it. A retry run has a
   different id and is never matched.
6. **One refund.** Only the transition that changed the row proceeds to the
   Book, outbox and refund writes, and the refund amount still comes from the
   original charge row. The deterministic idempotency key stays as a second line.
7. **Atomicity** is unchanged: the same single transaction, so a failure at any
   later step rolls back the run write too (tested in 17.2).

What was removed is only a precondition that bound the user's intent to one
delivery's fence. Worker fencing itself is untouched: `claim`, `heartbeat`,
`completeRun` and the recovery paths are not modified.

### 17.4 Verification (local only)

Environment, as it was: Windows 11, **Node v24.11.1** (CI uses 22), pnpm 9.4.0,
Docker 29.7.2. Not Linux, not Node 22.

| Check                                                              | Result                                                    |
| ------------------------------------------------------------------ | --------------------------------------------------------- |
| cancellation + fencing + credit-charging integration specs         | 3 files, 59 tests passed                                  |
| cancellation spec repeated 5 times                                 | 19 of 19 each time                                        |
| complete guarded integration suite (`pnpm test:integration`, once) | 27 files, 324 tests passed                                |
| coordinator unit spec                                              | 49 passed                                                 |
| full API unit suite (`pnpm --filter @book/api test`)               | 176 files, 2656 passed, 3 skipped                         |
| `pnpm --filter @book/api typecheck`                                | exit 0                                                    |
| `pnpm --filter @book/api typecheck:integration:hardening`          | exit 0 (**does not include the cancellation spec**, 17.7) |
| `pnpm --filter @book/api lint`                                     | exit 0, `--max-warnings 0`                                |
| `prettier --check` on the three code files                         | one finding in my new test, fixed; clean after            |
| `git diff --check`                                                 | exit 0                                                    |

Method: `git ls-files -co --exclude-standard` of the working tree (790 files, no
`.env`) copied to `C:\sm-p168`; the 273 CRLF/mixed files normalized to LF in the
snapshot only; `pnpm install --frozen-lockfile --offline`, `prisma generate`,
`@book/types` build. Mock providers only; `apps/api/.env` was never opened or
read. The integration runner's own guard enforced the disposable PostgreSQL
(5440) and Redis (6380) targets and removes provider credentials from the child
environment. The infrastructure was started with the compose project `p168-ci`
and the same compose file, not `pnpm test:infra:up`, for the reason given in 16.2.

### 17.5 Browser: combined command

`CI=true pnpm --filter @book/web test:e2e e2e/interactive.spec.ts
e2e/storyme.smoke.spec.ts --retries=0 --reporter=list,json`, in the snapshot,
with `stdout: 'pipe'` added to the API `webServer` in the snapshot only (as in
16.2).

| interactive.spec.ts | storyme.smoke.spec.ts | Skipped | Retries | Flaky | Duration | Exit |
| ------------------- | --------------------- | ------- | ------- | ----- | -------- | ---- |
| 40 of 40 passed     | 15 of 15 passed       | 0       | 0       | 0     | 5.6 min  | 0    |

`storyme.smoke.spec.ts:234`, "cancels an active family generation without
requiring a credit charge", passed (4.0 s). The API log shows its cancellation
applied (`no matching charge CreditTransaction — cancelling as a legacy/unbilled
run`, then `No BullMQ job found for cancelled run`). "keeps a publication readable
after a cancelled regeneration" (`:318`) also passed.

API log, by the log's own `statusCode=` field (1373 requests):

| Check                                                                            | Count                                                            |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `Unhandled exception`, `ERR_STREAM_UNABLE_TO_PIPE`, `ExceptionsHandler`, `ERROR` | 0                                                                |
| HTTP 5xx                                                                         | 0                                                                |
| HTTP 409                                                                         | 5 (16.7: 6 in the failing run, 5 in the passing run)             |
| `WARN`                                                                           | 1, "Retry for book ... found no prior GenerationRun", as in 16.5 |

None of the five 409s falls in the second of the cancellation log lines above.
They were not attributed to individual tests, as in 16.5.

### 17.6 What the browser result does and does not show

- **The deterministic regression in 17.2 is the proof.** It reproduces the exact
  interleaving and fails on the old code.
- The browser pass is **one run**. The failure in 16.3 was intermittent, 1 of 2
  runs, and it was not established how often the interleaving occurs on this
  machine. A single pass does not show that the race is gone, and I did not
  instrument whether the claim race actually occurred inside this run.
- It does show that the combined command, with no retry, is green with the
  change, and that the cancellation path the smoke test exercises works end to
  end against the real API and queue.
- I did not weaken the assertion, add a retry, delay the worker or change the
  web app.

### 17.7 Limits and what is still open

- **No remote confirmation.** Nothing was committed, pushed or deployed and no
  workflow ran, so there is no SHA and no CI result. The `interactive-browser`
  job on the hosted runner (Linux, Node 22) is unverified.
- **Typecheck coverage gap, not new.** `tsconfig.integration.json` lists a fixed
  set of specs and omits the cancellation spec, and `src/**/*.spec.ts` is
  excluded everywhere, so the two green typechecks above did not cover my test
  code. I checked both specs with a temporary tsconfig in the snapshot: **no
  error in any new or changed line**. The cancellation spec has 6 errors in
  helpers that predate this phase (`createUserAndBook`, `createRun`, lines 94
  and 116 to 121) and the coordinator unit spec has 53 of the existing
  `DeepMockOf`/`jest.Mocked` class. None was changed; fixing them is a separate
  decision.
- **Behavior change.** Cancel pressed in the claim window used to return 409
  `BOOK_NOT_IN_PROGRESS` and now cancels. How the web UI had presented that 409
  was not inspected and nothing in `apps/web` changed.
- Provider calls already started by a claimed worker are not recalled; cancellation
  fences the worker's later writes, as before.
- Only the Prisma `updateMany` write is held in the regression. Interleavings at
  other points of the transaction (for example between the Book write and the
  refund) are covered only by the existing rollback test, not by new barriers.

### 17.8 Cleanup

| Resource                                    | Action                                                                                 | End state                                                                                                                                                                         |
| ------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| compose project `p168-ci` (postgres, redis) | created by this task, `down -v`                                                        | containers, network, volumes gone                                                                                                                                                 |
| snapshot `C:\sm-p168` (results, logs)       | created by this task; removal **blocked** by the tool harness, not retried another way | **still present, needs manual deletion**                                                                                                                                          |
| scratch logs and temp files                 | created by this task, removed                                                          | gone                                                                                                                                                                              |
| Playwright servers on 3100 and 4100         | started and stopped by Playwright                                                      | no listener at the end                                                                                                                                                            |
| E2E fixtures                                | removed by the suite's global teardown                                                 | "E2E fixtures cleaned up."                                                                                                                                                        |
| all other containers, networks and volumes  | untouched                                                                              | containers (24), networks (9), named volumes (12) and anonymous volumes (7) identical to the list taken before the run, including the two exited `storyme-integration` containers |
| `apps/api/.env`                             | never opened or read                                                                   | unchanged                                                                                                                                                                         |

The snapshot holds a pnpm install, Prisma client, Playwright results and logs.
It contains no `.env` and no credentials. It is outside the repository, so it
does not affect `git status`.

## 18. Follow-up: Phase 16.9 four-job verification of one snapshot (added after Phase 16.8)

Sections 1 to 17 are left as written. This phase changes no application code,
test, workflow, dependency, retry or timeout. It runs the four jobs of
`.github/workflows/ci.yml` against one source snapshot and records the result.
**Everything below is local evidence. No hosted CI result exists for this
candidate (18.7).**

### 18.1 Candidate identity

| Item                      | Value                                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Source SHA                | `6594ff869163a7ba639eb4f48df9f684cdda9359`, "fix: stop cancellation losing to a queued-to-running worker claim (phase 16.8)" |
| Branch                    | `docs/phase-15-1-interactive-case-study`; remote tip is `2f5324a`, so HEAD is 2 commits ahead and unpushed                   |
| Working tree              | clean (`git status` empty) at start; **no dirty-file manifest, no uncommitted source**                                       |
| Snapshot                  | `git ls-files -co --exclude-standard`, 790 files, copied to `C:\sm-p169`                                                     |
| Line endings              | 273 CRLF text files normalized to LF in the snapshot only; 0 CR left                                                         |
| Equivalence               | 790 of 790 identical to the working tree with CR stripped, 0 missing, 0 mismatched                                           |
| Snapshot content sha256   | `5a48a959b298e94e46c133830b97cd47d782ebdb8ee3bc8280eb09f1cc80f9c6` (sorted path + LF bytes)                                  |
| `pnpm-lock.yaml`          | sha256 `38f4ad18184ecc810aa79c5c999293b44f833d9ae5b0d0af357c82b4cb32c877`, identical in tree and snapshot                    |
| Credentials               | snapshot has no `.env` (two `.env.example` only); `apps/api/.env` was never opened, read or copied                           |
| OS / Node / pnpm / Docker | Windows 11 Home 10.0.26300 / **v24.11.1** / 9.4.0 / 29.7.2 (Docker Desktop, Linux containers, DB and Redis only)             |
| CI target                 | ubuntu-latest, Node 22, pnpm 9.4.0 (**not reproduced**)                                                                      |

One snapshot-only edit: before job 4, `stdout: 'pipe'` was added to the API
`webServer` in the snapshot's `apps/web/playwright.config.ts` so the API log could
be inspected (sha256 `C3B208EF…` to `2E42D93C…`). It is not in the working tree.
Jobs 1 to 3 ran before it was made.

Linux and Node 22 were looked for and not available: the only WSL distribution is
`docker-desktop`, and no Node version manager is installed. A runtime was not
downloaded and the loopback target guards were not loosened. **Linux and Node 22
are unverified.**

### 18.2 Method, and every deviation from `ci.yml`

| Item                | What was done                                                                                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| env                 | the workflow and per-job `env` blocks reproduced; `CI=true`; credential-like variable names scrubbed from the runner (one matched, a harness messaging token); all providers `mock` |
| turbo cache         | `TURBO_FORCE=true` instead of `--force`; every turbo task logged `cache bypass, force executing` and every summary `0 cached`                                                       |
| install             | `--frozen-lockfile --offline` (CI installs online); job 3 with `--prod=false` and `NODE_ENV=production`                                                                             |
| Playwright          | `playwright install chromium` without `--with-deps` (Linux apt packages); exit 0, browser already cached                                                                            |
| infrastructure      | compose project `p169-ci`, same `docker-compose.e2e.yml`, **not** `pnpm test:infra:up/down`, for the reason in 16.2; recreated empty before job 4                                   |
| retries / reporters | `--retries=0 --reporter=list,json` on jobs 3 and 4 (the config would retry once under `CI`); reporters do not change execution                                                      |
| isolation           | jobs ran sequentially in one snapshot; `apps/web/.next` and `apps/api/dist` removed before jobs 3 and 4; no job overlapped another                                                  |
| guards              | the integration runner and the `api-e2e` launcher applied their own 5440 / 6380 checks. `test-infra-entry.mjs`'s assertion was **not** exercised (compose project name)             |

Harness error, disclosed: the first launch of job 2 died before any step ran,
because PowerShell wrote a byte-order mark into the steps file and the runner
could not parse it. No test or command executed. The file was rewritten and job 2
was started once more. This is not a product result.

### 18.3 Four-job result

| Job                         | Commands run (exit)                                                                                                          | Result                                                                                                 | Time  |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----- |
| 1. Checks                   | install, prisma generate, types build, lint, typecheck, typecheck:scripts, test, 3 offline evals, build: **11 of 11 exit 0** | types 2 tests; web 51 files, 820 passed; api 176 files, 2656 passed, 3 skipped; launcher 39; archive 6 | 136 s |
| 2. Isolated integration     | install, prisma generate, types build, `test:integration`: **4 of 4 exit 0**                                                 | 27 files, 324 tests passed, 0 skipped, 0 failed; 38 migrations applied to `5440/storyme_e2e`           | 59 s  |
| 3. Production browser smoke | install `--prod=false`, types build, playwright install, web build, `test:e2e:production`: **5 of 5 exit 0**                 | 1 test passed, 0 skipped, 0 retries; production build compiled                                         | 26 s  |
| 4. Combined browser journey | install, prisma generate, types build, playwright install, both specs: **5 of 5 exit 0**                                     | `interactive.spec.ts` 40 of 40, `storyme.smoke.spec.ts` 15 of 15; 0 skipped, 0 flaky, 0 retries        | 257 s |

Offline evaluations in job 1: story 30 pass, interactive 29 pass, authoring 42
pass, 0 fail each. Lint ran with `--max-warnings 0`. The 3 skipped API unit tests
are the same 3 as in 17.4; they were not re-examined. The API unit log contains
`ERROR` lines from tests that exercise provider-failure and connection-refused
paths with mocked transports; the suite exited 0 and those lines were not
individually reviewed.

`storyme.smoke.spec.ts:234`, "cancels an active family generation without
requiring a credit charge", passed (3.0 s), as did `:318`, "keeps a publication
readable after a cancelled regeneration". Each of jobs 1 to 4 ran **once** with
the result above; nothing was rerun.

### 18.4 Browser API log (job 4)

By the log's own `statusCode=` field, 1377 requests:

| Check                                                                            | Count                                                                   |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `Unhandled exception`, `ERR_STREAM_UNABLE_TO_PIPE`, `ExceptionsHandler`, `ERROR` | 0                                                                       |
| HTTP 5xx                                                                         | 0                                                                       |
| HTTP 409                                                                         | 5 (as in 17.5; not attributed to individual tests, the log path is `/`) |
| HTTP 401 / 403 / 404                                                             | 315 / 40 / 15 (not attributed)                                          |
| HTTP 200 / 201 / 202 / 204 / 304                                                 | 851 / 84 / 1 / 11 / 55                                                  |
| `WARN`                                                                           | 1, "Retry for book ... found no prior GenerationRun", as in 16.5        |

Fixtures were seeded and the global teardown logged "E2E fixtures cleaned up."

### 18.5 What the typecheck configurations include

Specs changed since the audit follow-up commit `162f2f4`, against the files each
configuration actually lists (`tsc --listFilesOnly`, snapshot):

| Configuration                                                            | Files | `.spec.ts` files | In `ci.yml`? |
| ------------------------------------------------------------------------ | ----- | ---------------- | ------------ |
| `apps/api/tsconfig.json` (`typecheck`)                                   | 248   | 0                | yes          |
| `apps/api/tsconfig.scripts.json` (`typecheck:scripts`)                   | 272   | 0                | yes          |
| `apps/api/tsconfig.integration.json` (`typecheck:integration:hardening`) | 119   | 7                | **no**       |
| `apps/web/tsconfig.json` (`typecheck`)                                   | 146   | 3 e2e files      | yes          |

| Changed file                                                                             | Typechecked by                         |
| ---------------------------------------------------------------------------------------- | -------------------------------------- |
| `apps/web/e2e/storyme.smoke.spec.ts`                                                     | web `typecheck` (in CI)                |
| `apps/api/test/integration/interactive-catalogue.integration.spec.ts`                    | integration hardening only (not in CI) |
| `apps/api/test/integration/fixtures/interactive-helpers.ts`                              | integration hardening only (not in CI) |
| `generation-run-coordinator.service.spec.ts`                                             | **none**                               |
| `books.controller.spec.ts`, `.pdf-preview-http.spec.ts`, `.published-image-http.spec.ts` | **none**                               |
| `generation-cancellation.integration.spec.ts`                                            | **none**                               |
| `interactive-harness.integration.spec.ts`, `interactive-library.integration.spec.ts`     | **none**                               |

`typecheck:integration:hardening` was run once as extra evidence: exit 0. Seven
of the nine changed API specs and fixtures are therefore covered by no typecheck
that CI runs. That is a documented gap (17.7), separate from the runtime results
in 18.3: those specs executed and passed under Vitest, which does not typecheck.
The 6 and 53 pre-existing errors counted in 17.7 were not re-measured here.

### 18.6 Formatting and whitespace

| Check                                                         | Result                                               |
| ------------------------------------------------------------- | ---------------------------------------------------- |
| `pnpm format:check` (root, snapshot, LF; not a `ci.yml` step) | exit 0, "All matched files use Prettier code style!" |
| `git diff --check` and `git diff --cached --check`            | exit 0 and exit 0                                    |
| `git status` after the four jobs, before this section         | clean                                                |

The working tree itself was not formatted-checked: with `core.autocrlf=true` it
holds 273 CRLF files, and a check there would measure line endings, not style
(section 2).

### 18.7 Hosted CI, read-only

| Question                    | Answer                                                                                                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow run for `6594ff8`  | **none**                                                                                                                                                        |
| Pull request for the branch | none                                                                                                                                                            |
| Why                         | `ci.yml` triggers on `pull_request` and on push to `main`/`develop` only; a push to this branch ran `migrate`, `staging-backup` and `staging-monitor`, not `CI` |
| Latest hosted `ci.yml` run  | `main` at `dc5b31e` (2026-10-12), an ancestor of HEAD, 10 commits behind                                                                                        |
| Its job conclusions         | Checks **failure**, Isolated integration **failure**, Production browser smoke **failure**, Interactive browser journey success                                 |

Only job conclusions were read; the hosted logs were not. That run predates
phases 16.2 to 16.8 and says nothing about HEAD. The three `migrate` and
`staging-*` failures at `2f5324a` were not examined and are outside this gate.

### 18.8 Cleanup

| Resource                                             | Action                                                        | End state                                                                                                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| compose project `p169-ci` (postgres, redis, network) | created by this task, `down -v --remove-orphans`              | gone                                                                                                                                             |
| containers, networks, named volumes                  | untouched                                                     | 24, 9 and 19, identical IDs, names and states to the list taken before the run (only the "up for" age differs)                                   |
| `storyme-integration-*` exited containers            | pre-existing, untouched (`infra-down` not used)               | still `Exited (0)`, IDs `d3536392…` and `2304e332…`                                                                                              |
| Playwright servers on 3100, 3200, 4100               | started and stopped by Playwright                             | no listener on 3100, 3200, 4100, 5440, 6380                                                                                                      |
| snapshot `C:\sm-p169`                                | created by this task; removal **blocked** by the tool harness | **still present, needs manual deletion**; holds a pnpm install, Prisma client, build output and Playwright results, no `.env` and no credentials |
| `C:\sm-p168`                                         | left by Phase 16.8 (17.8), not created here                   | untouched, still present                                                                                                                         |
| scratch logs and step runner                         | session scratchpad, outside the repository                    | kept for the session                                                                                                                             |
| `apps/api/.env`                                      | never opened or read                                          | unchanged                                                                                                                                        |

Both snapshots are outside the repository and do not affect `git status`.

### 18.9 Remaining blockers and verdict

No gate failed. What is still open:

1. **No hosted confirmation.** The candidate is unpushed, has no pull request, and
   `ci.yml` has no trigger for a branch push. Until a hosted run exists for
   `6594ff8` or its pushed successor, the four jobs are unconfirmed on ubuntu.
2. **Linux and Node 22 unverified.** These results are Windows and Node 24.11.1,
   with `--offline` installs and without `--with-deps`.
3. **One run per job.** The 16.3 failure was intermittent (1 of 2) and this
   phase, like 17.5, shows one pass of the combined command, not the absence of
   the race.
4. **Test-typing gap** (18.5): seven changed API specs are in no CI typecheck.
5. **Last hosted `main` run was red** in three jobs (18.7); the cause was not
   read here and the later 16.x repairs are the likely, unproven, explanation.

**Verdict: all four `ci.yml` jobs pass locally against one snapshot of
`6594ff8` (Windows, Node 24.11.1). Not hosted-confirmed. This is not a
production-readiness, deployment or real-model-quality claim.**

One bounded next task: obtain the hosted result for the exact candidate. With the
owner's approval, push the branch and open a pull request so `ci.yml` runs, then
record the four job conclusions and, if any is red, diagnose from the hosted
logs without changing gates, retries or timeouts.

## 19. Follow-up: Phase 16.10 publication and hosted CI result (added after Phase 16.9)

Sections 1 to 18 are left as written. This section records what happened when the
Phase 16.9 candidate was published. It is evidence about one hosted run, not a fix:
Phase 16.10 changed no application code, test, workflow, dependency, retry or
timeout.

### 19.1 What was published

| Item                      | Value                                                                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Pull request              | #25, draft, `docs/phase-15-1-interactive-case-study` into `main` (`AlexTikhon/ai-agent_StoryMe`)                      |
| PR head SHA               | `d60155100f9831b91d2e24c455af1f38b3ea51b1`                                                                            |
| Base (`main`) SHA         | `dc5b31ea30eb9c624888f8fbf524eea1fcfc7294`, unchanged by the push                                                     |
| Merge SHA checked out     | `5d5c4ee107ef9163975f75959225fed07477b23d` ("Merge d601551 into dc5b31e"); the run fetched `refs/pull/25/merge` at it |
| Verified candidate        | `6594ff8`. `d601551` differs from it only in `docs/interactive-verification.md` (section 18, 182 added lines)         |
| Push                      | `2f5324a..d601551`, fast-forward, no force; the remote answered that the repository moved and the push followed it    |
| PR scope vs `main`        | 11 commits, 60 files; no dependency, lockfile, env or binary file; the only workflow file touched is `ci.yml`         |
| Workflows enabled by this | none; `migrate.yml`, `staging-backup.yml` and `staging-monitor.yml` are fully commented out and were not edited       |

### 19.2 The `ci.yml` run

Run 38367942805, event `pull_request`, attempt 1, started 08:14:45Z, completed
08:20:15Z, run head `d601551`, **conclusion failure**. It was triggered by the PR;
nothing was dispatched or rerun. Runner image `ubuntu-24.04` (release
`ubuntu24/20261004.327`), Node `v22.23.3`, pnpm 9.4.0, turbo 2.1.3.

| Job                         | Conclusion  | Time   | Hosted evidence                                                                                                                                                                   |
| --------------------------- | ----------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Checks                      | **failure** | 2m 20s | step `pnpm test` failed; web 50 of 51 files, 819 of 820 tests passed; evals and `pnpm build` skipped because the failing step stopped the job                                     |
| Isolated integration        | success     | 1m 19s | 27 files, 324 tests passed, 38 migrations applied; no skips                                                                                                                       |
| Production browser smoke    | success     | 56 s   | 1 test passed (4.0 s); no retry, flaky or skipped line                                                                                                                            |
| Interactive browser journey | success     | 5m 26s | 55 tests passed (4.5 m) in one worker: `interactive.spec.ts` and `storyme.smoke.spec.ts`; no retry, flaky or skipped line; only the failure-only artifact upload step was skipped |

Browser detail, from the hosted Playwright output: both browser jobs ended with
"N passed" and no "flaky", "retry" or "skipped" line; the 55 tests ran as
`[1/55]` to `[55/55]` with no repeated index. The interactive job's API log had 0
`Unhandled exception`, `ERR_STREAM_UNABLE_TO_PIPE` or `ExceptionsHandler` lines and
0 `statusCode=5xx` lines, and "E2E fixtures cleaned up." was printed. Passing on
the first attempt is what the log shows; it is one run, not a rate.

The failing test, from the Checks log (08:17:04Z):

```
FAIL src/app/dashboard/books/[id]/page.test.tsx > BookDetailPage > Polling > stops polling when status becomes complete
AssertionError: expected 5 to be 4 // Object.is equality
  page.test.tsx:2050:50
```

The Checks job's API unit tests were **not** established. Turbo started
`@book/api:test` and stopped it when `@book/web#test` failed ("Tasks: 2 successful,
4 total; Failed: @book/web#test"); the log has no API `Test Files` summary. The
three evals and the production build did not run, so job 1 says nothing about them
on Linux.

### 19.3 Push-triggered runs (workflow-file configuration, not CI jobs)

| Run         | Workflow                                | Event | Jobs | Conclusion                     |
| ----------- | --------------------------------------- | ----- | ---- | ------------------------------ |
| 38367926155 | `.github/workflows/migrate.yml`         | push  | 0    | failure, "workflow file issue" |
| 38367924392 | `.github/workflows/staging-backup.yml`  | push  | 0    | failure, "workflow file issue" |
| 38367922997 | `.github/workflows/staging-monitor.yml` | push  | 0    | failure, "workflow file issue" |

These are workflow-file configuration errors, not executable job failures: each run
has zero jobs, and every line of each file is commented out, so the file declares no
trigger or job. They also occurred at `2f5324a` and `a8276d0`. They are unrelated to
the failing `Checks` job and were not changed.

### 19.4 Pending and still unverified

| Item                                            | State                                                                                 |
| ----------------------------------------------- | ------------------------------------------------------------------------------------- |
| `Checks` on `5d5c4ee` or any successor          | **pending**; red because of the one web unit test above (diagnosed in section 20)     |
| API unit tests, 3 offline evals, build on Linux | **not run** in this hosted run; local results are Windows / Node 24 only (section 18) |
| Hosted run for a fixed candidate                | **pending**; nothing has been committed or pushed since `d601551`                     |
| PR #25                                          | still a draft, unmerged                                                               |

The three interactive jobs that passed hosted confirm the integration, production
browser and combined browser results of section 18 on Ubuntu 24.04 / Node 22.23.3
for this one run.

## 20. Follow-up: Phase 16.11 hosted terminal-polling test failure (added after Phase 16.10)

Sections 1 to 19 are left as written. This section diagnoses the one failing hosted
test from 19.2 and records the fix. **The fix is uncommitted and unpushed, and no
hosted run has seen it.** Everything below is local evidence on Windows / Node
24.11.1 unless stated.

### 20.1 The failure

`BookDetailPage > Polling > stops polling when status becomes complete` read the
number of every `fetch` call after the complete book rendered, dispatched `online`
inside one `act`, and required the count to be unchanged. On the hosted Linux run
the count rose from 4 to 5 (`expected 5 to be 4`, line 2050). Locally the same
test passed.

### 20.2 What the fifth request is

The test mounts with `NEXT_PUBLIC_ENABLE_DEVELOPER_DIAGNOSTICS` set, so the routed
`fetch` mock sees four kinds of request. In the instrumented local run, the
requests in order were:

| #   | Request                                    | Issued by                                                              |
| --- | ------------------------------------------ | ---------------------------------------------------------------------- |
| 1   | `GET /books/book-1`                        | initial load                                                           |
| 2   | `GET /books/book-1/generation-diagnostics` | diagnostics effect, status `layout`                                    |
| 3   | `GET /books/book-1/generation-progress`    | poll effect; reports `complete`                                        |
| 4   | `GET /books/book-1`                        | the one full-book read a terminal projection triggers                  |
| 5   | `GET /books/book-1/generation-diagnostics` | diagnostics effect re-run, because `book.status` changed to `complete` |

The fifth request is the **second diagnostics read**, a legitimate effect of the
status change. It is not a progress or book poll. Locally it was already issued
when the count was read (5 before and 5 after the `online` event). On the hosted
runner it was issued after the count was read, inside the `act`, so the baseline of
4 was captured before the diagnostics effect had flushed. The hosted log records
only the two counts, so the identity there is inferred from the local request
order, not logged.

Of the three candidates in the task: an extra progress/book poll was **not** what
failed (progress stayed at 1 and book reads at 2 in every passing run); a
legitimate diagnostics request after the terminal render **was** the fifth request;
an effect-cleanup ordering race **does** exist in the hook, was found while writing
the deterministic test, and is independent of the hosted failure (20.4).

### 20.3 Test change

- `page.test.tsx`: the broad count assertion is replaced in that one test. Requests
  are classified (`book`, `progress`, `diagnostics`, `image`, `other`). After the
  terminal render the test asserts progress reads = 1 and book reads = 2, waits
  explicitly for the second diagnostics read, holds its response back, then fires
  `online` and `visibilitychange` and advances 10 s of controlled `setTimeout`
  twice (before and after the late diagnostics response is released) and asserts
  the same counts and 0 unclassified requests. The global count is not changed from
  4 to 5, and no sleep, retry, timeout or diagnostics/image switch was added.
- `use-book-detail.test.ts`: a new `useBookDetail terminal polling` describe with
  deferred responses and fake `setTimeout`, so request order never depends on
  machine speed. 3 tests: no further progress/book read after the terminal book
  (with a late diagnostics response); no progress read from recovery events between
  applying the terminal book and effect cleanup; a non-terminal run still resumes
  polling after an online/visibility event.

### 20.4 A real hook defect, and its fix

The second hook test failed on the unmodified hook: 3 progress reads instead of 1.
Inside one `act` scope React had not yet rendered the update, so the old poll
effect and its `online`/`visibilitychange` listeners were still installed while the
hook already held the terminal book (the test asserts that precondition). The event
scheduled a poll; the poll sent a progress request for a finished run, and the
chain then rescheduled itself until the effect cleanup ran. In a browser the window
is the time between the promise continuation and React committing the update, so
the practical effect is at most a stray, aborted read; the test widens the window
by holding the render. It violates the invariant the task states, so it is fixed.

`use-book-detail.ts`: when the full-book read is accepted by `applyBook` **and** its
status is terminal, the poll loop sets `cancelled = true` at that moment. Single-
flight polling, abort on cleanup, the freshness checks and non-terminal recovery are
not changed. A stale or non-terminal book still leaves recovery exactly as before
(test 3).

Observation, not changed: if a terminal progress projection is followed by a book
read that is still non-terminal, the chain ends and only an online/visibility event
or a status change resumes it. That behavior predates this phase and is what test 3
pins.

### 20.5 The new tests detect a regression

Run in the snapshot only; the working tree was never modified for this.

| Variant                                                                             | Result                                                                                                                                                        |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unmodified hook, new hook tests                                                     | race test **failed**, `expected 3 to be 1`; the other two passed                                                                                              |
| Hook fix applied                                                                    | 13 of 13 hook tests pass; `books/` directory 203 of 203                                                                                                       |
| Regression: poll effect no longer returns on terminal status (`if (!book) return;`) | hook terminal test **failed** (`expected 2 to be 1`), race test **failed**, page test **failed** (`expected 7 to be 1`), 4 existing polling tests also failed |
| Regression removed (snapshot re-synced from the working tree)                       | passes again                                                                                                                                                  |

### 20.6 Checks run

Snapshot `C:\sm-p169` (the Phase 16.9 snapshot of `6594ff8`, no `.env`,
`apps/api/.env` never opened); the three web files were copied from the working tree
with CR removed. Its web tree matches the working tree except `playwright.config.ts`
(the documented snapshot-only `stdout: 'pipe'` edit) and one PNG that the
CR-stripping comparison altered. `NEXT_PUBLIC_API_URL=http://localhost:3001/api` as
in CI.

| Check                                                                          | Result                                                              |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| focused polling test, page test file, hook test file, whole `books/` directory | 203 of 203 passed; the directory run repeated 5 times, 5 of 5 green |
| `pnpm --filter @book/web test`                                                 | 51 files, **823 passed** (hosted had 820; +3 hook tests)            |
| `pnpm --filter @book/web typecheck`                                            | exit 0                                                              |
| `pnpm --filter @book/web lint` (`--max-warnings 0`)                            | exit 0                                                              |
| `prettier --check` on the three changed web files                              | exit 0                                                              |
| `pnpm --filter @book/web build` with `NODE_ENV=production`                     | route table produced, no error                                      |
| `git diff --check` in the working tree                                         | clean                                                               |

Not run: Linux / Node 22 (only Windows / Node 24.11.1 is available locally, the
same limit as section 18); the API unit tests, evals and integration and browser
jobs (no API or browser code changed). Local passes do not prove the hosted flake is
gone: the original failure also passed locally. What the deterministic tests add is
that the asserted behavior no longer depends on when passive effects flush.

### 20.7 Same-class risk left unchanged

These page tests also read a global `fetch` count right after a status render and
compare it after an `online` event or a timer advance, so each can see a diagnostics
re-read land late: `stops polling when status becomes failed`, `does not start
polling when status is already terminal on initial load`, and, with a status change
from a mutation response, `stops polling once the returned status is Cancelled`.
They passed in the hosted run. They were outside the named scope and are not
changed here.

### 20.8 State and next step

| Item         | State                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------- |
| Working tree | `use-book-detail.ts`, `use-book-detail.test.ts`, `page.test.tsx`, and this report (sections 19 and 20); uncommitted |
| PR #25       | draft, head `d601551`, unchanged; no commit, push, rerun, merge or deploy                                           |
| Hosted       | the fix has not run on Linux / Node 22                                                                              |

One bounded next task: commit the three web files and this report, push, and read
the resulting `pull_request` run. If the three same-class tests (20.7) are to be
hardened too, do it in that same commit with the same per-kind assertions, so one
hosted run covers them.

## 21. Follow-up: Phase 16.11.1 timing-sensitive request-count assertions (added after Phase 16.11)

Sections 1 to 20 are left as written, including the hosted evidence in 19. This
section hardens the three same-class tests named in 20.7 and a fourth in the same
family. **Test code only: `use-book-detail.ts` was not touched in this phase, and
nothing is committed, pushed or rerun.** Everything below is local evidence on
Windows / Node 24.11.1.

### 21.1 Assertions repaired

All four tests are in `page.test.tsx`. Each used to snapshot
`fetch.mock.calls.length` after a status render, fire one `online` event inside one
`act` with `await Promise.resolve()`, and require the total to be unchanged. That
fails when a legitimate diagnostics read lands between the snapshot and the
comparison (the failure class of 19.2), and for polling it proves little: the hook
polls through `setTimeout(0)`, which a microtask never reaches.

| Test                                                         | Before                                                      | After                                                                                                                                                                                                                |
| ------------------------------------------------------------ | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stops polling when status becomes failed`                   | total `fetch` count; one `online`; microtask                | progress and book counts only: 0 / 1 after load, 1 / 2 after the terminal tick, unchanged after 3 intervals of `online` + `visibilitychange`; the 2nd diagnostics read is held, released late, then 3 more intervals |
| `does not start polling when status is already terminal ...` | total `fetch` count; one `online`; microtask                | progress 0 and book 1 after load and after 3 intervals of events and timers; diagnostics and image reads are not counted, so they may arrive at any time                                                             |
| `stops polling once the returned status is Cancelled`        | total count; fake `setInterval` only; nested `act`; 2500 ms | `setTimeout` faked before render so the loop is live: one tick (progress 1), the cancel POST counted as its own kind (1), book reads stay 1, progress stays 1 after 3 intervals of events and timers                 |
| `stops fetching diagnostics once status becomes terminal`    | total count after one `act(Promise.resolve)`; one `online`  | the status-triggered diagnostics read is settled first (count is exactly 2 and the panel shows its `errorMessage`), then diagnostics stay at 2 and progress / book at 1 / 2 across 3 intervals of events and timers  |

Shared test helpers (same file, next to `requestKind` / `requestCount`, which are
reused rather than replaced): `requestKind` gained a `cancel` kind so the
cancellation POST is not an `other` request; `withControlledPollTimers` (fake
`setTimeout` / `clearTimeout` installed **before** render, `vi.useRealTimers()` in a
`finally`); `settle` (one `act` around `advanceTimersByTimeAsync(0)`);
`recoverAndElapse` (one `act` per interval: `online`, `visibilitychange`, then one
full 2500 ms); `expectPollingRequests`; and `holdDiagnosticsRequest` (the nth
diagnostics request is neither recorded nor answered until released, released in a
`finally`).

Design notes:

- The clock is installed before render, not after the terminal state as in the
  19/20 test, because a poll chain that survives a regression would otherwise hold a
  real timer scheduled before the fake clock existed and escape the advance.
- Inside `withControlledPollTimers` the tests do not use `waitFor` / `findBy*`:
  testing-library drains through the global `setTimeout`, which is faked there, and
  would hang. They assert synchronously after `settle()`. The cost is that each
  `settle()` encodes one hop (load, then poll tick); a change in the hook's pacing
  fails a test with an assertion, not a flake.
- No `act` is nested, and no sleep, retry, timeout or production-code change was
  added.

### 21.2 The broad count fails with a late legitimate request

In the snapshot only, two temporary tests ran the failed-status scenario with the
second diagnostics request deliberately held until after the count was taken:

| Assertion over the same scenario                     | Result                                                                |
| ---------------------------------------------------- | --------------------------------------------------------------------- |
| old: total `fetch` count unchanged                   | **failed**, `expected 5 to be 4` (the same message as the hosted run) |
| new: progress 1 and book 2 (diagnostics not counted) | passed                                                                |

The temporary tests were deleted; the snapshot test file was re-copied from the
working tree and is byte-identical (`cmp`).

### 21.3 Negative controls (snapshot only, restored)

Regression A: the poll effect guard in `use-book-detail.ts` changed from
`if (!book || !isGeneratingBookStatus(book.status)) return;` to
`if (!book) return;`, so terminal books poll. The four tests were run together:

| Test                                                      | Result under regression A                                               |
| --------------------------------------------------------- | ----------------------------------------------------------------------- |
| `stops polling when status becomes failed`                | **failed**: `{progress: 7, book: 2}`, expected `{progress: 1, book: 2}` |
| `does not start polling when ... already terminal ...`    | **failed**: `{progress: 6, book: 1}`, expected `{progress: 0, book: 1}` |
| `stops polling once the returned status is Cancelled`     | **failed**: `{progress: 7, book: 1}`, expected `{progress: 1, book: 1}` |
| `stops fetching diagnostics once status becomes terminal` | **failed**: `{progress: 8, book: 2}`, expected `{progress: 1, book: 2}` |

Regression B (A plus `void booksApi.getGenerationDiagnostics(id)` after
`setProgress(data)` in the poll): the diagnostics test failed on the diagnostics
count itself, `expected 4 to be 2`. B is synthetic, chosen to reach the diagnostics
assertion; no such code exists.

Both regressions were applied to `C:\sm-p169` only. The working-tree hook is the
Phase 16.11 version, and the snapshot hook was restored from it and compared with
`cmp`.

### 21.4 Checks run

Snapshot `C:\sm-p169` (no `.env`; `apps/api/.env` was never opened), the three web
files copied from the working tree. `NEXT_PUBLIC_API_URL=http://localhost:3001/api`
as in CI.

| Check                                                      | Result                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------- |
| page test file + hook test file, run 3 times               | 158 of 158 passed each time; no `act(...)` warning in the filtered output |
| `pnpm --filter @book/web test` (`pnpm test` in `apps/web`) | 51 files, **823 passed** (same count as 20.6: no test added or removed)   |
| `pnpm --filter @book/web typecheck`                        | exit 0                                                                    |
| `pnpm --filter @book/web lint` (`--max-warnings 0`)        | exit 0                                                                    |
| `prettier --check` on the three changed web files          | exit 0                                                                    |
| `pnpm --filter @book/web build`, `NODE_ENV=production`     | exit 0, route table produced                                              |
| `git diff --check` in the working tree                     | exit 0 (only the repository's LF/CRLF notices)                            |

Not run: Linux / Node 22; API unit tests, evals, integration and browser jobs (no
API or browser code changed). Passing locally did not predict the hosted failure in
19.2, so these results do not show that the hosted flake class is gone. They show
that the four assertions no longer depend on when passive effects or fetch
continuations flush, and that each fails when terminal polling is reintroduced.

### 21.5 Observation, not changed

`does not let a stale in-flight poll response overwrite an already-applied
cancellation` (same `polling interaction` describe) still installs only fake
`setInterval` / `clearInterval` in its `beforeEach` and then calls
`advanceTimersByTimeAsync(2500)`, which cannot reach the hook's `setTimeout` loop.
From reading the code (not instrumented), the test relies on the hook's first real
`setTimeout(0)` poll rather than on that advance. It was outside the named scope and
is left as is; the describe's `beforeEach` was kept for it.

### 21.6 State and next step

| Item         | State                                                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Working tree | `use-book-detail.ts`, `use-book-detail.test.ts`, `page.test.tsx` (this phase: `page.test.tsx`) and this report; uncommitted |
| PR #25       | draft, head `d601551`, unchanged; no commit, push, rerun, merge or deploy                                                   |
| Hosted       | neither the 16.11 fix nor these assertions have run on Linux / Node 22                                                      |

One bounded next task: commit the three web files and this report, push, and read
the resulting `pull_request` run; that single run covers 16.11 and 16.11.1.

## 22. Follow-up: Phase 16.12 hosted CI result for the polling fix (added after Phase 16.11.1)

Sections 1 to 21 are left as written. This section records what happened when the
Phase 16.11 and 16.11.1 changes were published and run on hosted CI. It is evidence
about one hosted run, not a fix: Phase 16.12 changed no application code, test,
workflow, dependency, retry or timeout. Statements in sections 20 and 21 that the
fix is "uncommitted and unpushed" are superseded by 22.1.

### 22.1 What was published

| Item                  | Value                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Commit                | `6fcf4cb8c1fa034ee0035789baf7d694cb36adda`, "fix: stop terminal book polling and stabilize endpoint request-count tests (phases 16.11-16.11.1)"               |
| Push                  | `d601551..6fcf4cb`, fast-forward, no force; the remote answered that the repository moved and the push followed it                                            |
| Contents              | exactly 4 files, 750 insertions, 49 deletions: `use-book-detail.ts` (+9/-1), `use-book-detail.test.ts`, `page.test.tsx`, this document (+348, additions only) |
| PR head SHA           | `6fcf4cb8c1fa034ee0035789baf7d694cb36adda`; PR #25 is still a draft, open, unmerged                                                                           |
| Base (`main`) SHA     | `dc5b31ea30eb9c624888f8fbf524eea1fcfc7294`, unchanged                                                                                                         |
| Merge SHA checked out | `b6bee27fa4fbf627dfc74e1cd3334a77d7221120`; the Checks job fetched it as `refs/remotes/pull/25/merge`                                                         |
| Pre-publish checks    | staged manifest was only the 4 files; `git diff --cached --check` clean; no untracked or generated files                                                      |

### 22.2 The `ci.yml` run

Run 38392021199, event `pull_request`, attempt 1, started 11:42:02Z, completed
11:46:25Z, run head `6fcf4cb`, **conclusion failure**. It was triggered by the PR;
nothing was dispatched or rerun. Runner image `ubuntu-24.04` (version
`20261004.327.1`), Node `v22.23.3`. URL:
`https://github.com/AlexTikhon/ai-agent_StoryMe/actions/runs/38392021199`.

| Job                         | Conclusion  | Time   | Hosted evidence                                                                                                                                |
| --------------------------- | ----------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Checks                      | **failure** | 2m 49s | step `pnpm test` failed: web all green, API 3 failed of 2659; the three evals and `pnpm build` were skipped by the failing step                |
| Isolated integration        | success     | 1m 06s | 27 files, 324 tests passed, 38 migrations applied; no skip line                                                                                |
| Production browser smoke    | success     | 1m 03s | 1 test passed (3.8 s) on 1 worker; no retry or flaky line                                                                                      |
| Interactive browser journey | success     | 4m 23s | 55 tests passed (3.4 m) on 1 worker: `interactive.spec.ts` and `storyme.smoke.spec.ts`; only the failure-only artifact upload step was skipped |

Browser detail, from the hosted Playwright output: both browser jobs ended with
"N passed" and no "flaky", "retry #" or "skipped" line; the 55 tests ran as
`[1/55]` to `[55/55]` with no repeated index. Lines containing the word "retry" are
test titles. The interactive job's API log had 0 `Unhandled exception`,
`ERR_STREAM_UNABLE_TO_PIPE` or `ExceptionsHandler` lines and 0 `statusCode=5xx`
lines, and "E2E fixtures cleaned up." was printed. Passing on the first attempt is
what the log shows; it is one run, not a rate.

Checks steps: install, `prisma:generate`, `types build`, `lint`, `typecheck` and
`typecheck:scripts` succeeded; `pnpm test` failed; `eval:story:offline`,
`eval:interactive:offline`, `eval:interactive:authoring:offline` and `pnpm build`
were **skipped, not run**. Their hosted result is therefore still unknown.

| `pnpm test` package | Files                | Tests                            | Skipped |
| ------------------- | -------------------- | -------------------------------- | ------- |
| `@book/types`       | 1 passed             | 2 passed                         | none    |
| `@book/web`         | 51 passed            | 823 passed                       | none    |
| `@book/api`         | 174 passed, 2 failed | 2656 passed, **3 failed** (2659) | none    |

### 22.3 The formerly failing terminal-polling test

Passed on hosted Linux / Node 22.23.3. `page.test.tsx` reported 145 tests passed
(9.97 s) and `use-book-detail.test.ts` 13 tests passed (0.6 s); web as a whole
passed 51 of 51 files and 823 of 823 tests, against 819 of 820 in section 19.2. The
hosted reporter prints passing tests per file, not per name, so the evidence for
`Polling > stops polling when status becomes complete` is the passing file, not a
named line. No test in either file failed, retried or was skipped.

### 22.4 The failing Checks step: three API script tests

All three failures are in `@book/api` and none touches polling:

| Spec                                             | Test                                                                               | Assertion                      |
| ------------------------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------ |
| `scripts/experiment-interrupt.spec.ts`           | `leaves a checkpoint that keeps the first result, marks the second unresolved ...` | line 210, `expected 1 to be 0` |
| `scripts/inspect-interactive-experiment.spec.ts` | `inspects a complete experiment from the repository root`                          | line 351, `expected 1 to be 0` |
| `scripts/inspect-interactive-experiment.spec.ts` | `inspects an interrupted checkpoint from the API package and exits 0`              | line 367, `expected 1 to be 0` |

Each spawns the real `pnpm` entry point `inspect:interactive:experiment` with
`spawnSync` and passes the manifest path wrapped in literal double quotes
(`"${path}"` in a template string), with `shell: process.platform === 'win32'`. On
Windows the shell strips those quotes. On Linux `shell` is `false`, so the quote
characters are delivered to the CLI as part of the path.

Local reproduction of the mechanism (Windows, `pnpm --silent
inspect:interactive:experiment --manifest ...` against a file that exists): the plain
path is read and judged on its content, while the same path wrapped in literal
quotes is reported as `MANIFEST_UNREADABLE`, exit 1. That is the call the Linux
runner makes. The hosted log shows only the status mismatch; the child's stdout and
stderr were not printed, so the Linux cause is **inferred from the reproduction, not
observed in the hosted log**.

Consequences:

- This is the first hosted Linux run in which the API unit tests reached completion.
  Section 19.2 could not establish them because the web failure stopped the job.
  The defect is a Linux-only test-harness defect that was always present; it is not
  caused by the polling change.
- A fourth test, "fails through pnpm for an inconsistent bundle" in
  `inspect-interactive-experiment.spec.ts` (line 373, quoted path at line 379), uses
  the same quoting and **passed** on Linux for the wrong reason: `MANIFEST_UNREADABLE` is also
  `INVALID` and non-zero, so it does not prove the inconsistent-bundle path there. A
  fix should not leave it relying on that.
- `experiment-interactive-authoring.spec.ts` was not affected: it joins its
  arguments through its own `quote` helper and runs with `shell: true` on every
  platform, so quoting and shell agree on Linux as well.

### 22.5 Push-triggered runs (workflow-file configuration, not CI jobs)

| Run         | Workflow                                | Event | Jobs | Conclusion                   |
| ----------- | --------------------------------------- | ----- | ---- | ---------------------------- |
| 38392016664 | `.github/workflows/migrate.yml`         | push  | 0    | failure, workflow file issue |
| 38392015085 | `.github/workflows/staging-backup.yml`  | push  | 0    | failure, workflow file issue |
| 38392018129 | `.github/workflows/staging-monitor.yml` | push  | 0    | failure, workflow file issue |

Same classification as 19.3: each run has zero jobs because the files are fully
commented out. They are configuration errors, not executable CI failures, and are
unrelated to the failing `Checks` job. They were not changed.

### 22.6 State and next step

| Item                                       | State                                                |
| ------------------------------------------ | ---------------------------------------------------- |
| Terminal-polling fix on hosted Linux       | **verified** for this one run (web 823 of 823)       |
| Isolated integration, both browser jobs    | **verified green** on `6fcf4cb` / merge `b6bee27`    |
| `Checks` job                               | **red**: 3 API script tests (22.4)                   |
| Three offline evals, `pnpm build` on Linux | **not run**; skipped by the failing `pnpm test` step |
| PR #25                                     | still a draft, unmerged                              |

One bounded next task: make the manifest argument in the four spawning tests
(`experiment-interrupt.spec.ts` line 200; `inspect-interactive-experiment.spec.ts`
lines 347, 363 and 379) consistent with the `shell` option, so literal quotes are
added only when a shell will strip them (for example by quoting only when
`process.platform === 'win32'`), and make the test at line 373 prove a readable but
inconsistent manifest. Do not change assertions about exit codes, timeouts, retries
or workflow settings. Verify with a hosted run, since the failure does not
reproduce on Windows.

## 23. Follow-up: Phase 16.13 API script tests passed quoted paths to a shell-less pnpm (added after Phase 16.12)

Sections 1 to 22 are left as written. This section records the repair of the three
hosted failures classified in 22.4. It changes test code only: two specs, one new
shared test helper and its type declaration. No application code, workflow,
dependency, timeout, retry or assertion about exit codes changed.

### 23.1 Diagnosis

Hosted run 38392021199 failed `@book/api` at `experiment-interrupt.spec.ts:210` and
`inspect-interactive-experiment.spec.ts:351` and `:367`, each `expected 1 to be 0`.
All three spawn the real pnpm entry point with `spawnSync`, `shell:
process.platform === 'win32'`, and a manifest path wrapped in literal double quotes.

- With a shell (Windows) the shell removes the quotes before the CLI sees the path.
- Without one (Linux) the quote characters are delivered to the CLI as part of the
  filename, so the file "does not exist" and the CLI reports `MANIFEST_UNREADABLE`,
  exit 1.

The repository already owns the right primitive: `scripts/pnpm-invocation.mjs`
`resolvePnpmInvocation` returns `{ command, args, shell: false }` on every platform
and passes argument-array values through untouched. The repair reuses it instead of
adding a second platform-resolution path.

### 23.2 What changed

| File                                                      | Change                                                                                                                                               |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/scripts/pnpm-spawn.fixture.ts` (new)            | `spawnPnpm(args, { cwd, env, timeout })`: `resolvePnpmInvocation`, then `spawnSync` with the returned `shell: false`; no resolution logic of its own |
| `apps/api/scripts/pnpm-invocation.d.ts` (new)             | ambient types for the plain-JavaScript `.mjs` (`tsconfig.scripts.json` has no `allowJs`; without it `typecheck:scripts` fails with TS7016)           |
| `apps/api/scripts/experiment-interrupt.spec.ts`           | uses `spawnPnpm`; the manifest argument is the raw path                                                                                              |
| `apps/api/scripts/inspect-interactive-experiment.spec.ts` | uses `spawnPnpm`; the two plain tests pass the raw path; the old combined test is split in two (below)                                               |

`cwd`, the `OPENAI_API_KEY: ''` environment override, the 120 s / 180 s spawn
timeouts and the 150 s / 200 s test timeouts are unchanged. The resolver receives
the same `env` that is given to the child, so `npm_execpath` set by a pnpm parent is
honoured.

The old test "fails through pnpm for an inconsistent bundle and a usage error" is
now two tests, so usage-error coverage stands alone:

1. **Inconsistent bundle at a path with spaces.** The bundle is cloned into
   `a directory with spaces/`. A positive control inspects that exact readable path
   first and must be `VALID`, `COMPLETE`, no issues, exit 0. Then
   `completeness.completed` is set to 1 and the same path must give a non-zero exit,
   `status: 'INVALID'`, an issue `{ code: 'COMPLETENESS_MISMATCH' }`, and **no**
   `{ code: 'MANIFEST_UNREADABLE' }`. The bundle's file hashes and mtimes must be
   unchanged by the inspection.
2. **Usage error through pnpm.** Non-zero exit and an empty stdout, as before.

### 23.3 Red evidence (old invocation, before the fix)

Windows cannot show the Linux failure directly, because there the old shell strips
the quotes. The reproduction therefore keeps the old quoted argument and removes only
the shell, by routing it through the resolver. That is exactly the Linux call.

| Step                                                                               | Result                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Quoted argument, no shell, both specs                                              | 3 failed, 25 passed: `experiment-interrupt` and the two inspect pnpm tests, each `expected 1 to be 0`; the hosted failures reproduced                                                                                               |
| Same run, old "inconsistent bundle" test                                           | **passed**, which is the hosted false positive                                                                                                                                                                                      |
| Throwaway probe in the snapshot (mutated bundle, quoted vs raw path, then removed) | quoted: `exit=1 status=INVALID issues=[{"code":"MANIFEST_UNREADABLE"}]`; raw: `exit=1 status=INVALID issues=[{"code":"COMPLETENESS_MISMATCH"}]`; the original assertions (`status !== 0`, `status === 'INVALID'`) accepted **both** |
| New strengthened test, still quoted                                                | failed at its positive control (`expected 1 to be 0`); with the original assertions only, it would have passed                                                                                                                      |

So the original test could not tell "the inconsistency was detected" from "the file
could not be found".

### 23.4 Local validation

Credential-free snapshot `C:\sm-p169` (no `.env`, no `.git`). Before the overlay its
`apps/api`, root `scripts/`, `pnpm-lock.yaml` and both `package.json` files were
diffed against the working tree ignoring CRs: the only differences were the four
files above. `apps/api/.env` was not read or loaded. Windows 11, Node 24.

| Check                                                                     | Result                                                                                                              |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `experiment-interrupt.spec.ts` + `inspect-interactive-experiment.spec.ts` | 2 files, 29 tests passed (1 + 28)                                                                                   |
| `node --test scripts/pnpm-invocation.test.mjs`                            | 15 passed                                                                                                           |
| `pnpm test:launcher`                                                      | 39 passed                                                                                                           |
| `pnpm --filter @book/api test`                                            | 176 files passed; 2657 passed, 3 skipped (2660), exit 0                                                             |
| `@book/api typecheck`, `typecheck:scripts`                                | clean                                                                                                               |
| Prettier `--check` on the 4 files                                         | clean (one wrapping fixed after the first run)                                                                      |
| ESLint on the 4 files                                                     | 1 error and 3 warnings, identical on the `HEAD` versions of the two specs: not introduced here; CI lints `src` only |
| `git diff --check`                                                        | clean on the staged manifest (`git diff --cached --check`)                                                          |

The 3 skips are Windows file-symlink privilege skips in
`claim-artifact-local-walk.spec.ts`; the hosted run reported none skipped. The hosted
API total should be 2660 (2659 plus the one new test). No database or browser suite
was run: the change is test-only and those suites do not touch it.

### 23.5 What this does not show

- **Not run on Linux.** The Linux behaviour is reproduced by removing the shell on
  Windows, not observed on a Linux runner. Section 24 holds the hosted result.
- The resolver is the only change to how pnpm is found. On Linux with `npm_execpath`
  set (as under `pnpm test`) it runs the real pnpm CLI through `process.execPath`; if
  `npm_execpath` is absent it falls back to `pnpm` on `PATH`.
- `exits 1 for inconsistent input and 2 for a usage error` (script process, same
  file) has the same weak `INVALID`-only assertion. It already passes the raw path to
  `node` and so is not affected by quoting; it was left unchanged to keep this phase
  to the reported failures.
- `experiment-interactive-authoring.spec.ts` still quotes through its own `quote`
  helper with `shell: true`; section 22.4 found it consistent and it was not touched.

## 24. Follow-up: Phase 16.13 hosted CI result for the script-test repair (added after Phase 16.13)

Sections 1 to 23 are left as written. This section records what hosted CI did with
commit `f50c9c3`. It is evidence about one naturally triggered run; no workflow was
dispatched or rerun, and nothing in the repository was changed for it.

### 24.1 What ran

| Item             | Value                                                                                                                             |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Commit           | `f50c9c333f90143325c54e06c118a9e61030fe6b`, "fix: pass raw manifest paths to a shell-less pnpm in API script tests (phase 16.13)" |
| Push             | `6fcf4cb..f50c9c3`, fast-forward, no force                                                                                        |
| Run              | `38396021924`, workflow `CI`, event `pull_request`, conclusion **success**                                                        |
| Merge SHA tested | `2c9f9890d97bc135896d95aa492f92e81d549a3a` (`f50c9c3` merged into `main` at `dc5b31ea30eb9c624888f8fbf524eea1fcfc7294`)           |
| Runner           | hosted Linux, Node v22.23.3                                                                                                       |
| PR #25           | still a draft, open, unmerged, `MERGEABLE`                                                                                        |

### 24.2 The four jobs

| Job                         | Job id         | Conclusion  | Duration |
| --------------------------- | -------------- | ----------- | -------- |
| Checks                      | `115291316798` | **success** | 2 m 11 s |
| Interactive browser journey | `115291316467` | **success** | 5 m 21 s |
| Production browser smoke    | `115291316881` | **success** | 58 s     |
| Isolated integration        | `115291317055` | **success** | 1 m 26 s |

### 24.3 Checks reached the offline evaluations and the build

Every step succeeded: install, `prisma:generate`, `types build`, `lint`,
`typecheck`, `typecheck:scripts`, `pnpm test`, `eval:story:offline`,
`eval:interactive:offline`, `eval:interactive:authoring:offline` and `pnpm build`.
This is the first hosted run in which the three evals and the build executed; in
section 22.2 they were skipped.

| `pnpm test` package | Files      | Tests                 | Skipped |
| ------------------- | ---------- | --------------------- | ------- |
| `@book/types`       | 1 passed   | 2 passed              | none    |
| `@book/web`         | 51 passed  | 823 passed            | none    |
| `@book/api`         | 176 passed | 2660 passed (of 2660) | none    |

The API total is the 2659 of section 22.2 plus the one test added in 23.2. The
turbo build reported `3 successful, 3 total` (1 cached). The eval steps printed
`PASS` lines for their valid and adversarial cases and exited 0.

### 24.4 The formerly failing tests

All three passed on Linux, with the raw path:

| Spec                                             | Test                                                                  | Hosted time |
| ------------------------------------------------ | --------------------------------------------------------------------- | ----------- |
| `scripts/experiment-interrupt.spec.ts`           | whole file (1 test)                                                   | 5.6 s       |
| `scripts/inspect-interactive-experiment.spec.ts` | `inspects a complete experiment from the repository root`             | 7.4 s       |
| `scripts/inspect-interactive-experiment.spec.ts` | `inspects an interrupted checkpoint from the API package and exits 0` | 7.8 s       |

The strengthened `reports the completeness mismatch of an inconsistent bundle at a
path with spaces and leaves it unchanged` and the separate `fails through pnpm for a
usage error with nothing on stdout` also passed; the file reported 28 of 28 tests.
This confirms on Linux the mechanism inferred in 22.4 and 23.1: the literal quotes
were the cause (the Linux call already ran without a shell).

### 24.5 Browser and integration jobs

| Job                         | Result                                                         | Skips, retries, flaky                                                                                              |
| --------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Interactive browser journey | Playwright `55 passed (4.5m)`, 1 worker, `[1/55]` to `[55/55]` | none: no skipped, flaky or retry marker in the log; the failure-only artifact upload step was skipped, as designed |
| Production browser smoke    | Playwright `1 passed (3.0s)`                                   | none                                                                                                               |
| Isolated integration        | 27 files, 324 tests passed                                     | none                                                                                                               |

The interactive job's API log had 0 `Unhandled exception`,
`ERR_STREAM_UNABLE_TO_PIPE`, `ExceptionsHandler` or `statusCode=5xx` lines and
printed "E2E fixtures cleaned up." once. All three passed on the first attempt,
which is what one run shows, not a rate.

### 24.6 Push-triggered runs (workflow-file configuration, not CI jobs)

| Run           | Workflow                                | Event | Conclusion                   |
| ------------- | --------------------------------------- | ----- | ---------------------------- |
| `38396014832` | `.github/workflows/migrate.yml`         | push  | failure, workflow file issue |
| `38396016392` | `.github/workflows/staging-backup.yml`  | push  | failure, workflow file issue |
| `38396018099` | `.github/workflows/staging-monitor.yml` | push  | failure, workflow file issue |

Same classification as 19.3 and 22.5: zero jobs each, because the files are fully
commented out. They were not changed.

### 24.7 State

| Item                                                     | State                                                                      |
| -------------------------------------------------------- | -------------------------------------------------------------------------- |
| `Checks`, evals, build, both browser jobs, integration   | **green** on `f50c9c3` / merge `2c9f9890`, one run                         |
| API script-test quoting defect (22.4)                    | **resolved** on hosted Linux                                               |
| Weak `INVALID`-only assertion in the script-process test | unchanged, see 23.5; not a failure                                         |
| Three commented-out push workflows                       | still report zero-job failures; unrelated to the CI jobs                   |
| PR #25                                                   | draft, unmerged; nothing deployed, no paid model call, no production write |

There are no remaining CI blockers on this commit. Merging, any deployment and the
workflow-file clean-up are separate decisions that were not made here.
