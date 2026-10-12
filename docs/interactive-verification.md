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
