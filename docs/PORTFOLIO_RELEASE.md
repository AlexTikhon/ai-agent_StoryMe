# StoryMe portfolio release handoff — 2026-11-21

This is the current handoff. It supersedes [PAUSE_HANDOFF.md](PAUSE_HANDOFF.md) (2026-11-05)
and [PROJECT_CLOSEOUT.md](PROJECT_CLOSEOUT.md) (2026-10-27), which are kept as historical
records of earlier repository states.

**Status: the agreed scope is complete on local evidence; hosted CI confirmation is pending.**
This is a local portfolio release, not a production release. Nothing was pushed, tagged or
published by this work and no paid provider call was made. Deployment of this revision was not
performed or verified. The hosted CI runs for `67b5ef7` and `64e0a10` failed; this commit
diagnoses and repairs that failure and verifies the repair locally on Linux and Windows, but no
hosted run covers it yet ([details](#resolved-finding-linux-sample-book-navigation)).

## Product scope

StoryMe creates personalized illustrated children's books: ages 1–12, English, Russian or
Polish, 4–12 pages with the child as the hero, a cartoon storybook illustration per page, an
authenticated in-browser reader and a downloadable PDF. Users can cancel and retry generation,
correct page text, regenerate one illustration or the whole book, and permanently delete a book.
A public, hand-curated `/sample-book` shows a complete book and PDF without an account.
[CURRENT_PRODUCT.md](CURRENT_PRODUCT.md) is the source of truth for behavior.

### Completion criteria

| Criterion                                                               | State             |
| ----------------------------------------------------------------------- | ----------------- |
| One product: personalized children's books; other formats retired       | Done in `8bfe58b` |
| Published edition and latest generation attempt reported separately     | Done in `86cc6f2` |
| Release checks and runtime stable on the Node 24 baseline               | Done in `59174b3` |
| Public, curated sample book with a PDF, no API needed                   | Done in `67b5ef7` |
| Production containers (API + separate worker) publish a complete book   | Done in `64e0a10` |
| Accurate README, case study, screenshot and handoff; fresh verification | This commit       |
| Linux production-browser failure diagnosed, repaired and verified       | This commit       |

## Commit sequence

Six commits follow the baseline `7b7d661` (docs: freeze StoryMe after outbox reliability
verification):

| #   | Commit      | Subject                                                     |
| --- | ----------- | ----------------------------------------------------------- |
| 1   | `8bfe58b`   | refactor: focus StoryMe exclusively on children's books     |
| 2   | `86cc6f2`   | fix: separate published book and generation-run diagnostics |
| 3   | `59174b3`   | fix: stabilize release checks and runtime                   |
| 4   | `67b5ef7`   | feat: add a public children's sample book                   |
| 5   | `64e0a10`   | test: verify production containers publish a complete book  |
| 6   | this commit | fix: finalize portfolio verification and release handoff    |

This commit updates documentation, adds one synthetic screenshot
(`docs/images/sample-book.png`), and contains one targeted repair: it synchronizes the anchor
navigation steps of `apps/web/e2e-production/sample-book.production.spec.ts` and adds a
failure-only Playwright artifact upload to the existing Production browser smoke CI job. It
changes no application code, package script or dependency.

## Restart the demo

Prerequisites: Node.js 24 (`.nvmrc`; verified with 24.11.1), pnpm 9.4.0, Docker with Compose
v2.23 or later, Playwright Chromium for browser checks, and free ports `5440`, `6380`, `4100`,
`3100` (and `3200` for the production web smoke).

```bash
git status --short --branch
git log --oneline 7b7d661..HEAD          # six commits
pnpm install --frozen-lockfile
pnpm demo:local                          # open http://127.0.0.1:3100; Ctrl+C tears down
```

`demo:local` uses mock providers, Home mode and the legacy `storyme-integration` Compose name,
and refuses to start over an existing stack. The public sample is at `/sample-book`. To run the
checks, use the commands in [Fresh verification](#fresh-verification), one at a time. Never
reset an unknown database; read [outbox-operations.md](outbox-operations.md) before migrating an
existing environment.

## Fresh verification

| Item        | Value                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source      | `64e0a10`, clean tracked tree at the start. During the runs only Markdown under `README.md`/`docs/` changed and `docs/images/sample-book.png` was added; no package reads them. No uncommitted source was tested.                                                                                                                                                                                                                              |
| Environment | Windows 11 Home 10.0.26300, Git Bash, Node 24.11.1, pnpm 9.4.0, Turbo 2.1.3, Docker 29.7.2 with Compose 5.4.0, Playwright 1.62.0 Chromium, Next.js 16.3.3                                                                                                                                                                                                                                                                                      |
| Settings    | Mock story, character and image providers; `RUN_PAID_AI_EVALS=false`; disposable PostgreSQL, Redis and S3 emulator only. The wrappers strip inherited credentials and service targets and edit no `.env`; a local, untracked `apps/api/.env` exists, and its non-credential values can reach the integration suite through the API config loader ([details](local-verification.md#environment)). The release smoke reads no repository `.env`. |
| Time        | 2026-11-21, 17:59 to 18:10 UTC                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Logs        | Kept locally under the ignored `artifacts/final-verification/`; not committed                                                                                                                                                                                                                                                                                                                                                                  |

Checks ran one at a time, in this order. They record the run at `64e0a10`, before the repair,
as it was. The later runs of the repaired test are in
[Repair verification](#repair-verification).

### Local unit, integration and browser

| Command                                                | Outcome                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TURBO_FORCE=true pnpm verify:local --profile offline` | PASS. Turbo: 0 of 11 tasks from cache. Lint (zero warnings allowed), typecheck and API script typecheck passed. Unit tests: types 2; API 1851 passed, 2 skipped (134 files; file-symlink cases that need elevated privileges on Windows); web 511 (36 files); archive 6; launcher 151. Offline story eval 30/30, 0 external calls. |
| `pnpm verify:local --profile integration`              | PASS. 20 files, 170 tests. All 39 migrations applied to disposable PostgreSQL. Owned project `storyme-verify-b076db738044fa00` started and torn down.                                                                                                                                                                              |
| `pnpm verify:local --profile browser`                  | PASS. 21 Chromium journeys, then 1 recovery journey (failure, retry, cancellation), no retries. Owned project `storyme-verify-a465e53a8a71b777`; fixture cleanup, teardown and port release passed.                                                                                                                                |
| Production workspace build (below)                     | PASS for `@book/types`, `@book/api` and `@book/web` built directly by pnpm. `pnpm -r` also ran the root `turbo run build`, which was a full Turbo cache replay. Next.js reused its existing `.next/cache`.                                                                                                                         |
| `pnpm --filter @book/web test:e2e:production`          | PASS. 14/14 against `next start` on port 3200: landing page, retired routes, and the sample book at 320px, 390px and desktop, with JavaScript off and with JavaScript on and every API request blocked. Static pages only; not an authenticated production-stack test.                                                             |

The production build used the documented Home/JWT settings:

```bash
NODE_ENV=production PRODUCT_MODE=home NEXT_PUBLIC_PRODUCT_MODE=home \
NEXT_PUBLIC_AUTH_MODE=jwt NEXT_PUBLIC_API_URL=http://127.0.0.1:4100/api \
  pnpm -r --workspace-concurrency=1 build
```

### Local production-container runtime

| Command              | Outcome                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm smoke:release` | PASS, all 10 steps. The API image build reused Docker's layer cache (6.1 s); base images were already pulled. Project `storyme-release-3fab1b2d490a3101`: migrations from the image, API with worker disabled, run queued with only the API, separate worker published the edition, 6 decodable PNGs and a 6-page PDF retrieved, `401`/cross-account refusals, identical bytes after restarting both containers, 8 objects in the emulated bucket. Cleanup verified. |

### Repair verification

The repair changes only `sample-book.production.spec.ts` and the CI workflow, so the
application build is the same source as above. Logs, the failing trace and the diagnostic probes
are kept locally under the ignored `artifacts/final-verification/repair/`; the probes were never
added to the repository.

| Item      | Value                                                                                                                                                                                                                                                    |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source    | `58e6543` with the repair applied: the container received the committed tree through `git archive`, then the repaired spec                                                                                                                               |
| Linux     | Owned container `storyme-linux-repro` from `mcr.microsoft.com/playwright:v1.62.0-noble`: Ubuntu 24.04.4 LTS (as `ubuntu-latest`), Node 24.18.0, pnpm 9.4.0, Playwright 1.62.0, Chrome for Testing 151.0.7922.34 headless shell. Steps mirror the CI job. |
| Windows   | Windows 11 Home 10.0.26300, Node 24.11.1, pnpm 9.4.0, Playwright 1.62.0                                                                                                                                                                                  |
| Retries   | Disabled (`--retries=0`, overriding the CI setting of 1) for every run below                                                                                                                                                                             |
| Time      | 2026-11-21, about 20:00 to 20:45 UTC                                                                                                                                                                                                                     |
| Hosted CI | Not run. No workflow was triggered and nothing was pushed                                                                                                                                                                                                |

| Run                                                                     | Outcome                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux, unrepaired spec, fresh build, CI settings (`CI=true`, 1 retry)   | **Reproduced**: 11 passed, the same 3 no-JavaScript tests failed on both attempts with the CI signatures (`element is not stable`, `detached`, timeouts)                                                                                |
| Linux, first repair attempt (wait only after each jump)                 | Rejected: full suite 13 then 14 of 14, and 14 of 15 on a 5× repeat of the no-JavaScript test; the trace placed the miss at the first click, before any jump. This led to the wait before the first click and the fonts-loaded condition |
| Linux, final repair, `sample-book` spec with `--repeat-each=5`          | PASS, 60 of 60                                                                                                                                                                                                                          |
| Linux, final repair, `.next` deleted and rebuilt, full suite, run 1     | PASS, 14 of 14 (20:35:32 to 20:36:25 UTC)                                                                                                                                                                                               |
| Linux, final repair, same build, full suite, run 2 (consecutive)        | PASS, 14 of 14 (20:36:25 to 20:37:17 UTC)                                                                                                                                                                                               |
| Windows, final repair, `.next` deleted and rebuilt, full suite          | PASS, 14 of 14                                                                                                                                                                                                                          |
| `pnpm --filter @book/web lint`, `typecheck`, `test`; ESLint on the spec | PASS. Typecheck includes the spec; unit tests 511 in 36 files                                                                                                                                                                           |
| `actionlint` 1.7.12 on `.github/workflows/ci.yml`                       | PASS                                                                                                                                                                                                                                    |

### Documentation checks

Re-run after the repair.

| Check                                           | Outcome                                                               |
| ----------------------------------------------- | --------------------------------------------------------------------- |
| `pnpm format:check`                             | PASS, repository-wide                                                 |
| `git diff --check`                              | PASS, including the new files                                         |
| Local links and heading anchors in changed docs | PASS, 157 local targets in the six Markdown files this commit changes |

### Curated sample

`/sample-book` and its PDF are hand-written and hand-drawn, not pipeline output. The production
web smoke above checks it, and `docs/images/sample-book.png` was captured from the same local
production build (`next start`, 1280×860, API requests blocked). It is evidence that the static
page renders, not of generation quality.

### Mock-provider generation

Every generated book in the browser journeys, the recovery journey and the release smoke came
from deterministic mock providers. They show that scheduling, execution, publication and
retrieval work. They say nothing about real-model output. `pnpm demo:capture` was not rerun for
this commit.

### Hosted CI

Not run for this commit, which exists only locally, so no hosted run covers the repair.
`origin/main` was already at `64e0a10` before this work began; these results were read from
GitHub Actions and were not triggered here. They are kept as they were.

| Commit               | CI run        | Result                                                                                                                                                                                                                                                                                                                                           |
| -------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `86cc6f2`            | `44918708937` | Success. Separate `staging-backup.yml` and `migrate.yml` runs failed at start with a workflow-file error; `59174b3` moved those files to [inactive-workflows](inactive-workflows/README.md).                                                                                                                                                     |
| `8bfe58b`, `59174b3` | none          | No run of their own.                                                                                                                                                                                                                                                                                                                             |
| `67b5ef7`            | `44927716358` | **Failure.** Production browser smoke failed the same 3 of 14 tests as below; the other four jobs passed.                                                                                                                                                                                                                                        |
| `64e0a10`            | `44932764719` | **Failure.** Checks, Isolated integration, Book browser journeys and API container image (which runs `release-smoke.mjs` on the CI-built image) passed. Production browser smoke failed 3 of 14: the no-JavaScript full-sample test at 320px, 390px and desktop timed out or failed `toBeInViewport` during anchor navigation, on both attempts. |

The hosted failure did not reproduce on Windows, where the same 14 tests passed above. It did
reproduce on Linux; the cause and repair are in
[Resolved finding](#resolved-finding-linux-sample-book-navigation). Hosted CI stays red for
those commits until a run that includes the repair succeeds.

### Real-provider, cloud and deployment

Deployment of this revision was not performed or verified. No paid provider call, real AWS S3
or Cloudflare R2 bucket, hosted environment or registry push was used. The staging environment
described in [staging-operations.md](staging-operations.md) is a historical record; its current
state was not checked.

### Cleanup

All invocation-owned containers, networks and volumes (`storyme-verify-*`,
`storyme-release-*`) were removed, the release smoke deleted its temporary Compose
configuration, and the screenshot server was stopped. Ports `5440`, `6380`, `4100`, `3100`,
`3200` and `3300` were free afterwards. Unrelated pre-existing containers, including stopped
legacy `storyme-integration` ones, were left untouched. After the repair verification, the
owned `storyme-linux-repro` container and its `storyme-linux-repro-pnpm` volume were removed and
no `next start` or Playwright process remained; the pulled Playwright image was kept.

## Resolved finding: Linux sample-book navigation

**Symptom.** On GitHub's Linux runners, `sample-book.production.spec.ts` "reads the whole sample,
navigates and downloads the PDF" failed at 320px, 390px and desktop with JavaScript disabled, on
both attempts, in CI runs for `67b5ef7` and `64e0a10`. In `expectAnchorNavigation`, the "Next:
Page 4" click reported `element is not stable`, then `detached`, until the 30 s timeout; on
desktop the back-cover heading stayed at viewport ratio 0 after its fragment changed.

**Cause: test synchronization, not application behavior.** The global
`html { scroll-behavior: smooth }` (`apps/web/src/styles/globals.css`) makes Chromium on Linux
animate every native fragment jump for about 0.5 to 0.9 s; Windows headless Chromium jumps at
once, which is why Windows passed. In addition, the layout was still changing when the test began
navigating: right after load `document.fonts.status` was `loading`, the layout above Page 3 grew
by 87 px by the time fonts and images had loaded, and the scroll position jumped by up to 116 px
0.3 to 0.9 s after a scroll made without waiting. In the failing trace the first click started
about 0.9 s after the test began. The test treated "the URL hash changed and any part of the
heading is visible" as "navigation finished", so its next click, focus or key press aimed at a
moving target. Once that first attempt missed,
Playwright 1.62.0's retries scrolled with `element.scrollIntoView({ block, inline })` and no
`behavior`, which inherits the smooth scrolling: each retry restarted an animation and checked
the target before it arrived, so the action never recovered.

**Evidence.** The failure reproduced on Linux with the CI steps and versions (3 of 14, same
signatures, both attempts). A scroll-position probe showed animated jumps on Linux, with
JavaScript off and on, and instant ones on Windows. With assets loaded, every jump settled with its
heading 17 px from the top (the `scroll-mt-4` offset), so native anchor navigation works without
JavaScript. A trace of a remaining failure after a first, narrower repair showed the miss at the
first click, while the layout was still settling.

**Repair.** `expectAnchorNavigation` waits before its first click and after every jump until an
observable condition holds: `document.fonts.status` is `loaded` and `scrollY` is unchanged
between two samples 100 ms apart. It now also checks that the keyboard-activated jump brings
Page 3 into view. No test was skipped, no viewport assertion removed, no force-click, fixed sleep,
retry or timeout change added, and no JavaScript navigation injected; both viewport loops and the
JavaScript-enabled, API-unavailable pass are unchanged. The Production browser smoke job now
uploads `apps/web/test-results/` (traces, screenshots, `error-context.md`) on failure, kept for
3 days. Application code, including the smooth-scroll style, is unchanged.

**Status.** Verified locally on Linux and Windows ([Repair verification](#repair-verification)).
Not yet confirmed by hosted CI.

## Known limitations

1. **Real models are unmeasured.** Every demonstration and check used mock providers.
   Story and illustration quality, refusal and error rates, latency and cost with OpenAI are
   unknown. Quality checks are structural heuristics, not content-safety, likeness or
   visual-consistency guarantees.
2. **Deployment not verified.** Deployment of this revision was not performed or verified.
   [staging-operations.md](staging-operations.md) records a staging environment and its
   runbook; that is historical documentation, and the environment's current state and the
   revision it runs were not checked. For this revision, ingress, TLS, proxy trust (`main.ts`
   trusts one hop), DNS, email delivery, secrets, backups and restore are unverified, as are the
   steps in [deployment-readiness.md](deployment-readiness.md) and
   [private-demo-deploy.md](private-demo-deploy.md).
3. **Cloud storage.** The `s3` drivers are verified only against a local SeaweedFS S3 gateway.
   Real S3/R2 needs the manual
   [cloud storage smoke](../apps/api/docs/cloud-storage-smoke-test.md), which was not run.
4. **Delivery and recovery.** Delivery is at least once and provider execution is not exactly
   once. A Redis job lost after dispatch is not re-sent; recovery fails the run and the user
   retries. Outbox retries have no exhaustion state, and quarantined events need manual,
   reviewed handling ([outbox-operations.md](outbox-operations.md)). Worker crash, Redis loss
   and database outage are covered by in-process tests, not by killing real processes.
5. **Storage orphans.** A superseded worker's in-flight storage write can land under its own
   claim and needs separate cleanup.
6. **Hosted CI is unconfirmed.** It is red on `67b5ef7` and `64e0a10`. The cause is
   diagnosed and repaired in this commit and the repair passes locally on Linux and Windows
   ([resolved finding](#resolved-finding-linux-sample-book-navigation)), but there is no hosted
   run for this commit, so hosted CI is not known to be green.
7. **Retired storage.** The Prisma schema keeps the retired `InteractiveSession`/`SessionEvent`
   tables so migration history and existing rows are preserved; nothing uses them
   ([details](CURRENT_PRODUCT.md#retired-interactive-stories)).
8. **No license.** The repository has no license file; licensing is an owner decision.

## Freeze

The six-commit plan ends here, and no further feature work is planned. The freeze is
provisional on one item: a hosted CI run that includes this commit has not happened. If that
run fails, the freeze does not hold until it is fixed. Push, deployment, real-provider
evaluation, cloud storage verification, licensing and publication are owner decisions outside
this scope, and each would need its own explicit task.
