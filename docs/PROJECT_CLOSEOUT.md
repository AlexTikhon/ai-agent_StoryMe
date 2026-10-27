# Project closeout

Development of StoryMe is paused as of 2026-10-27. This is a local handoff record, not a
release: nothing was deployed, tagged or published.

**Status: not fully verified.** Every suite passed except the offline profile's fresh
`pnpm test`, which failed twice on load-sensitive unit-test timeouts
([open finding](#open-finding-import-test-timeouts)). The Docker-backed suites passed only
outside their `verify:local` wrappers, which were unavailable on this machine.

## Candidate

| Item              | Value                                                                                                                                                                                                                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Revision          | `8aac9f8` on branch `closeout/demo-local`, based on `main` at `fd870ef`                                                                                                                                                                                                                      |
| Remote state      | `origin/closeout/demo-local` is at `7778431`; `8aac9f8` and this step's documentation are local only. No pull request is open.                                                                                                                                                               |
| Source under test | Clean tracked tree at the start. During the runs only `README.md` and `docs/*.md` changed, and no package reads them. **No uncommitted source changes were tested.**                                                                                                                         |
| Environment       | Windows 11 Home 10.0.26300, Git Bash, Node 24.11.1, pnpm 9.4.0, Turbo 2.1.3, Docker 29.7.2, Playwright Chromium                                                                                                                                                                              |
| Settings          | Mock story, character and image providers; `RUN_PAID_AI_EVALS=false`; inherited credentials and service targets removed by `verifyEnvironments()` from [verify-local.mjs](../scripts/verify-local.mjs); browser runs with API credentials pinned to inert values. No `.env` file was edited. |
| Time              | 2026-10-27, 18:41 to 19:11 (+01:00)                                                                                                                                                                                                                                                          |

## Completed closeout steps

| Step | Commit               | Result                                                                                        |
| ---- | -------------------- | --------------------------------------------------------------------------------------------- |
| 1    | `1626e7a`            | `pnpm demo:local`: one-command disposable mock demo ([local-demo.md](local-demo.md))          |
| 2    | `c4f3616`            | `pnpm verify:local` profiles and LF policy ([local-verification.md](local-verification.md))   |
| 3    | `78ed466`, `8c027a7` | Browser recovery journey: failure, retry, cancellation ([recovery-demo.md](recovery-demo.md)) |
| 4    | `afd5d6e`            | Dashboard navigation landmark, current-page marking, skip link                                |
| 5    | `7778431`            | `pnpm demo:capture` showcase and the 320px wizard fix ([demo-showcase.md](demo-showcase.md))  |
| 6    | `8aac9f8`            | [Generation case study](generation-case-study.md)                                             |
| 7    | uncommitted          | This record, the README entry point, and case-study corrections                               |

## Verification

Run one at a time, in this order. Logs were kept outside the repository and are not committed.

| #   | Command                                                                                                             | Result                  | Counts and evidence scope                                                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `pnpm verify:local --profile offline`                                                                               | exit 0, **cached**      | All 11 Turbo tasks were cache hits (lint 3, typecheck 4, test 4), replayed from an earlier run that day, so they are **not** fresh results. Ran fresh: Prisma client, types build, `typecheck:scripts`, `archive:clean:test` 6/6, `test:launcher` 105/105, story eval 30/30, interactive eval 29/29, authoring eval 42/42. |
| 2   | `TURBO_FORCE=true pnpm verify:local --profile offline`                                                              | **FAIL, exit 1**        | 0 cached. Lint, typecheck and script typecheck passed. `@book/types` 2/2, `@book/web` 842/842. `@book/api`: 2673 passed, 3 skipped, **1 failed** (`inspect-interactive-experiment.spec.ts`, "starts no work when imported", 5000 ms timeout). Evals not run after the failure.                                             |
| 3   | same as 2, repeated once to characterize the failure                                                                | **FAIL, exit 1**        | Same counts, but a **different** test failed: `experiment-interactive-authoring.spec.ts`, "starts no work, installs no handlers…", 5020 ms.                                                                                                                                                                                |
| 4   | `pnpm --filter @book/api test` alone, with the offline environment (diagnostic, not a profile)                      | exit 0                  | 176 files, 2674 passed, 3 skipped. The three affected import tests took 2.1 to 4.7 s.                                                                                                                                                                                                                                      |
| 5   | `pnpm verify:local --profile integration`                                                                           | **UNAVAILABLE**, exit 1 | Refused at the ownership probe: stopped, unrelated `storyme-integration` containers exist. Nothing was started or stopped.                                                                                                                                                                                                 |
| 6   | `pnpm verify:local --profile browser`                                                                               | **UNAVAILABLE**, exit 1 | Same refusal. The Chromium probe passed.                                                                                                                                                                                                                                                                                   |
| 7   | Underlying integration suite on temporary Compose project `storyme-closeout7-185718`                                | PASS, exit 0            | `launchTestCommand('integration')` with `verifyEnvironments().integration`: 38 migrations applied, 27 files, 324/324 tests, 0 skipped.                                                                                                                                                                                     |
| 8   | Underlying browser journeys on a fresh recreation of the same project                                               | PASS, exit 0            | `pnpm --filter @book/web test:e2e e2e/storyme.smoke.spec.ts e2e/interactive.spec.ts` with `verifyEnvironments().browser`: 58/58 passed, 0 skipped, 0 flaky, no retries. Includes the three dashboard-navigation tests.                                                                                                     |
| 9   | Underlying recovery journey, same infrastructure                                                                    | PASS, exit 0            | `pnpm --filter @book/web test:e2e:recovery`: 1/1.                                                                                                                                                                                                                                                                          |
| 10  | Fixture cleanup and port check                                                                                      | PASS                    | `pnpm --filter @book/api e2e:cleanup` exit 0; ports `4100`/`3100` released.                                                                                                                                                                                                                                                |
| 11  | `pnpm build --force` with `NODE_ENV=production`, Home Edition, JWT, `NEXT_PUBLIC_API_URL=http://127.0.0.1:4100/api` | PASS, exit 0            | 3/3 tasks, 0 Turbo cache hits. Next.js compiled in under a second, reusing its own `.next/cache`.                                                                                                                                                                                                                          |
| 12  | `pnpm --filter @book/web test:e2e:production`, same settings, against that build                                    | PASS, exit 0            | 1/1: the statically rendered landing page from `next start` on port `3200`, with scripts blocked and no API.                                                                                                                                                                                                               |
| 13  | Showcase manifests, before and after teardown                                                                       | PASS                    | See [Showcase materials](#showcase-materials).                                                                                                                                                                                                                                                                             |

**Wrapper versus underlying suite.** Rows 5 and 6 are wrapper results. Rows 7 to 10 ran the
same commands with the verifier's own environments and launch helpers, but outside its
ownership preflight. The temporary Compose project was started and removed by hand from the
same `docker-compose.e2e.yml`, on the same ports and targets, and the Prisma client and types
build were not repeated: row 1 had run them fresh at the same revision. Rows 7 to 10 are
therefore underlying-suite passes, **not** passes of `verify:local --profile integration` or
`--profile browser`.

Rows 11 and 12 are a local production build and smoke test. They are **not deployment
evidence**. No hosted CI exists for the closeout commits: CI runs only on pull requests and on
pushes to `main` and `develop`. The last hosted green run is `38396021924` on `f50c9c3`
([§24](interactive-verification.md#24-follow-up-phase-1613-hosted-ci-result-for-the-script-test-repair-added-after-phase-1613)).

## Open finding: import-test timeouts

- **Trigger:** a fresh `pnpm test` (Turbo runs the API and web suites in parallel) on this
  Windows machine. Failed 2 of 2 forced runs; a cached replay from an earlier run passed.
- **Tests:** "starts no work … when imported" in
  [inspect-interactive-experiment.spec.ts](../apps/api/scripts/inspect-interactive-experiment.spec.ts),
  [experiment-interactive-authoring.spec.ts](../apps/api/scripts/experiment-interactive-authoring.spec.ts)
  and [report-interactive-authoring.spec.ts](../apps/api/scripts/report-interactive-authoring.spec.ts).
  Each one calls `vi.resetModules()` and dynamically imports a CLI module under vitest's
  default 5000 ms timeout.
- **Evidence:** with the API suite running alone (row 4), the three tests took 2.1, 4.5 and
  4.7 s; under the parallel run they exceeded 5 s. The sibling test in
  [review-interactive-routes.spec.ts](../apps/api/scripts/review-interactive-routes.spec.ts)
  passes `30_000` and did not fail. The same spec passed 3 of 3 times on its own.
- **Assessment:** a test-timing defect, not an application defect. The tests' assertions never
  failed. **Not fixed in this step.** The likely fix is the sibling's explicit timeout on the
  three tests, followed by a fresh `TURBO_FORCE=true pnpm verify:local --profile offline`.

## Showcase materials

Two complete runs exist under `artifacts/demo-showcase/`: `20261027T150924Z-432fd2` and
`20261027T150958Z-72563d`. Both have `status: complete`, 35 of 35 validations, and 16 of 16
artifacts (3 PDFs, 13 screenshots) whose size and SHA-256 match the manifest. Every PDF starts
with `%PDF-` and ends with `%%EOF`. They were checked again after all test infrastructure was
removed. The only manifest names without a file are `books[].suggestedFilename`, which records
the browser's suggested download name, not a saved file.

`artifacts/` is ignored by Git and was not regenerated. **If this working tree is discarded,
copy both run directories, including `manifest.json`, to storage outside the repository
first**, then recompute the hashes as in
[demo-showcase.md §4](demo-showcase.md#4-check-the-artifacts).

Both manifests record `git.head` `afd5d6e` with `trackedChanges: true`: the capture code was
uncommitted then and was later committed as `7778431`.

## Reproduce

From the repository root, in Git Bash:

```bash
pnpm install --frozen-lockfile
pnpm --filter @book/web exec playwright install chromium

# Fresh offline checks: force Turbo so cached replays do not count
TURBO_FORCE=true pnpm verify:local --profile offline

# Docker profiles: need free ports 5440, 6380, 4100, 3100 and no storyme-integration containers
pnpm verify:local --profile integration
pnpm verify:local --profile browser

# Local production build and smoke
export NODE_ENV=production PRODUCT_MODE=home NEXT_PUBLIC_PRODUCT_MODE=home \
  AUTH_MODE=jwt NEXT_PUBLIC_AUTH_MODE=jwt NEXT_PUBLIC_API_URL=http://127.0.0.1:4100/api
pnpm build --force
pnpm --filter @book/web test:e2e:production
```

## Known limitations

- **Providers.** Every run here and in the closeout used deterministic mock providers.
  Real-model story, image and authoring quality, error rates and cost are unmeasured. No paid
  call or experiment has been run.
- **Deployment.** No deployment is verified. The production smoke covers only the static
  landing page. The `migrate`, `staging-backup` and `staging-monitor` workflows failed in 0 s
  on the last push of this branch (`gh run list --branch closeout/demo-local`).
- **Failure coverage.** The recovery journey shows a mock provider failure, a retry and a
  cancellation. Worker crash, lost Redis job and database outage are covered only by
  in-process integration tests that simulate takeover and redelivery.
- **Diagnostics provenance.** `GET /books/:id/generation-diagnostics` reports `imageFailures`
  and `resume` from the published edition, and `providerUsage` falls back to that snapshot when
  the newest run has no ledger
  ([details](recovery-demo.md#published-diagnostics-vs-current-run-telemetry)).
- **Showcase.** Mock text and placeholder illustrations; a visible Next.js dev badge; the
  completed-book page shows raw illustration prompts; ASCII download names (the Russian book
  downloads as `storyme-book.pdf`, `Łódka` becomes `dka`); structural PDF checks only;
  Chromium only; about three captures per hour per demo session
  ([details](demo-showcase.md#5-limitations)).
- **Local artifacts.** The permanent-deletion journey leaves empty directories under
  `apps/api/tmp/books/<id>` and `apps/api/tmp/images/books/<id>` that `e2e:cleanup` cannot
  find once the book row is gone. Observed in row 8; no files remained.
- **Interactive.** One scenario is published, under a documented legacy exception; the others
  are unapproved fixtures. An approval record is an attestation, not a signature
  ([limits](interactive-case-study.md#7-current-limits)).
- **Verification gaps.** The open finding above, and the Docker wrappers were unavailable here.

## Cleanup

- Temporary Compose project `storyme-closeout7-185718`: created, removed and recreated once
  between the integration and browser phases, then removed with its volumes and network. No
  containers or networks remain.
- The stopped `storyme-integration` containers were neither reused nor removed. They still
  block the Docker wrappers; remove them only after confirming they are stale.
- Ports `5440`, `6380`, `4100`, `3100` and `3200` were free afterwards.
- `apps/api/tmp` matches its state before the browser run. The empty directories from the
  deletion journey were removed with `rmdir`.
- No `.env` file, tracked source file or generated artifact was changed. The build outputs
  (`dist/`, `.next/`) are ignored.

## Return to the project

1. **Prerequisites:** Node.js 20 or newer, pnpm 9.4.0, Docker running, then
   `pnpm install --frozen-lockfile` and the Playwright Chromium install above.
2. **Safe environment:** `docker ps -a --filter label=com.docker.compose.project=storyme-integration`.
   If containers are listed and no demo or test session of yours is running, remove them with
   `pnpm test:infra:down`. Confirm ports `5440`, `6380`, `4100`, `3100` are free.
3. **Verify:** the commands in [Reproduce](#reproduce). Expect the open finding until it is
   fixed.
4. **Demo:** `pnpm demo:local`, then open `http://127.0.0.1:3100`
   ([local-demo.md](local-demo.md)).
5. **Capture:** with the demo running, `pnpm demo:capture` in a second terminal
   ([demo-showcase.md](demo-showcase.md)).

## Future priorities (deferred, not started)

1. Give the three import tests the sibling's explicit timeout, then rerun a fresh offline
   profile until it passes.
2. Open a pull request for `closeout/demo-local` so hosted CI runs all four jobs on the
   closeout commits.
3. A bounded, explicitly approved real-provider evaluation, to replace the "unmeasured"
   statements with data.
