# Local verification (`pnpm verify:local`)

One command runs the repository's checks locally in one of three profiles. Each profile is
independent, runs its steps one at a time, stops scheduling steps after the first failure, and
ends with a summary of what ran, what failed, and what this run did not verify.

```bash
pnpm verify:local                          # same as --profile offline
pnpm verify:local --profile offline
pnpm verify:local --profile integration    # needs Docker
pnpm verify:local --profile browser        # needs Docker and Playwright Chromium
```

`--profile=<name>` also works. Any other argument, a repeated `--profile`, or an unknown
profile is rejected with exit status `2` before anything runs.

## Profiles

| Profile       | Runs                                                                                                                                                                                                                                                                                                                                                        | Needs                                                                         |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `offline`     | Prisma client generation, `@book/types` build, `pnpm lint`, `pnpm typecheck`, `pnpm --filter @book/api typecheck:scripts`, `pnpm test`, `pnpm eval:story:offline`                                                                                                                                                                                           | `pnpm install` only. No Docker, no network                                    |
| `integration` | Ownership preflight, Prisma client, `@book/types` build, disposable PostgreSQL/Redis, the complete API integration suite (`apps/api/scripts/run-integration-tests.mjs`), teardown                                                                                                                                                                           | Docker running; ports `5440`, `6380` free                                     |
| `browser`     | Ownership preflight, Chromium launch probe, Prisma client, `@book/types` build, disposable PostgreSQL/Redis, `e2e/storyme.smoke.spec.ts` through `apps/web/playwright.config.ts`, then the [recovery journey](recovery-demo.md) through `apps/web/playwright.recovery.config.ts`, fixture cleanup, teardown, a check that ports `4100`/`3100` were released | Docker running; Chromium installed; ports `5440`, `6380`, `4100`, `3100` free |

The `offline` profile is the CI `Checks` job without `pnpm build`. Production builds are not
part of `verify:local`. The Docker profiles do not rerun the offline checks.

Run verification on the Node.js 24 baseline declared in `.nvmrc` (also used by CI and the API
Docker image). The API image check is separate from `verify:local`:

```bash
docker build -f apps/api/Dockerfile -t storyme-api:local .
pnpm smoke:api-image            # optional image argument; default storyme-api:local
```

It runs one network-less, read-only container and checks only the image: Node major version,
non-root user, API/worker entrypoints, Prisma client construction plus query-engine load, a Sharp
transform and the embedded PDF fonts. It does not contact a database or establish that a deployed
application works.

`pnpm smoke:release` runs that image check and then goes further, on disposable infrastructure.
It runs the API and a separate worker from the same image with `NODE_ENV=production`, against
PostgreSQL, Redis and a local S3 emulator. It then generates and retrieves one complete mock book.
See [release-smoke.md](release-smoke.md).

In the `browser` profile, Playwright's own configuration migrates the database, seeds the
synthetic fixtures, starts the API and the web app, and removes the fixtures in its global
teardown. `verify:local` runs the same scoped fixture cleanup again afterwards, so a cancelled
or crashed run does not leave synthetic book folders under `apps/api/tmp`. It does not start
`pnpm demo:local`.

The recovery journey runs only after the other journeys pass, on the same disposable
PostgreSQL/Redis. It starts its own API and web servers, whose mock image provider fails once
on purpose, so the ordinary journeys never see that failure. See
[recovery-demo.md](recovery-demo.md).

## Environment

Every child process gets an inherited environment with credentials and service targets removed
(the same filter `pnpm demo:local` uses), plus explicit settings:

- all profiles: `NODE_ENV=test`, mock story/character/image providers, `RUN_PAID_AI_EVALS=false`;
- `offline`: `NEXT_PUBLIC_API_URL=http://localhost:3001/api`, matching CI;
- `integration` and `browser`: the exact disposable targets
  `127.0.0.1:5440/storyme_e2e` and `127.0.0.1:6380/15`, revalidated by the test launcher before
  any infrastructure command runs;
- `browser`: the API's credential settings pinned to inert values, so `apps/api/.env` cannot
  fill them back in.

`verify:local` prints its disposable Compose project name, never credentials, and never edits `.env` files. Non-credential
values in `apps/api/.env` can still reach the integration suite through the API's config loader,
as they do when you run `pnpm --filter @book/api test:integration` directly.

## Infrastructure ownership

Each verifier invocation chooses a fresh `storyme-verify-<16 hexadecimal digits>` Compose
project. It prints that name and forwards it through `STORYME_TEST_COMPOSE_PROJECT` to startup
and teardown. Inherited project names are discarded. The infrastructure entrypoint accepts only
this name format or the legacy `storyme-integration` default; arbitrary project names are rejected
before any process starts.

Before the `integration` or `browser` profile changes anything, it checks that its ports are free
and that its own Compose project has no containers. If either is taken, the profile reports
`UNAVAILABLE` and exits non-zero. It never stops, resets, or attaches to the other session.
Stopped containers in `storyme-integration` no longer block verification. A running demo or test
still blocks it through the fixed ports: run profiles sequentially, not concurrently.

The Docker ownership query is asynchronous, has a 15-second timeout and a 64 KiB output limit.
A hung Docker CLI is terminated and reported as unavailable before any preparation or mutation.
This deadline covers the ownership query, not Compose startup/teardown or the test suites.

Teardown runs only for what this invocation started:

- disposable PostgreSQL/Redis are torn down whenever this run began starting them, including
  after a failed or partial start;
- fixture cleanup and the port check run only if this run started the browser suite;
- a step with nothing to clean is shown as `NOT RUN` with the reason.

A teardown failure makes an otherwise passing run fail. It never replaces the exit status of an
earlier failure. Every teardown step is attempted even if an earlier one fails. If containers
remain, use the exact project printed by the failed run, as described below. The default
`pnpm test:infra:down` targets the legacy stack and cannot clean a verifier's stack.

For example, in PowerShell, replace the example name with the failed run's project:

```powershell
$env:STORYME_TEST_COMPOSE_PROJECT = 'storyme-verify-0123456789abcdef'
pnpm test:infra:down
Remove-Item Env:STORYME_TEST_COMPOSE_PROJECT
```

## Summary and exit status

The summary has one row per step: status, duration, step, command, and a reason for anything
that did not pass.

| Status        | Meaning                                                                                               |
| ------------- | ----------------------------------------------------------------------------------------------------- |
| `PASS`        | The step ran and succeeded.                                                                           |
| `FAIL`        | The step ran and failed, or was interrupted. The reason gives the exit status/signal.                 |
| `UNAVAILABLE` | A prerequisite is missing or owned by someone else: Docker, Chromium, a port, or the Compose project. |
| `NOT RUN`     | Not scheduled after an earlier failure or cancellation, or nothing to clean up.                       |

All read-only preflight probes run even when one of them fails, so a missing Docker and a
missing Chromium are reported together. Nothing after the probes runs.

Exit status:

- `0` when every step and every cleanup passed;
- the failing command's own exit status for the first failure (`128 + signal number` if it was
  killed by a signal);
- `1` for `UNAVAILABLE`, for a command that could not be started, or for a cleanup failure;
- `2` for rejected arguments;
- `130` (Ctrl+C) or `143` (`SIGTERM`) for a cancelled run.

The summary ends with **Not verified by this run**: every step that did not pass, followed by
what the profile never covers (other profiles, production builds, real/paid providers).

## Missing prerequisites

`verify:local` never installs dependencies or browsers.

- **`Docker is not available`**: start Docker Desktop (or the daemon) and wait until
  `docker ps` works.
- **`Chromium cannot launch`**: install it yourself with
  `pnpm --filter @book/web exec playwright install chromium` (add `--with-deps` on Linux).
- **`port(s) … already in use`** or **`"storyme-verify-…" already has … container(s)`**:
  another session owns the disposable resources. Stop your active session first. For a crashed
  verifier, inspect the printed project and use the scoped cleanup command above.

## Cancellation

Press Ctrl+C once. `verify:local` stops the step that is running (the whole process tree it
owns), skips the remaining steps, runs the teardown for what it started, prints the summary
with `CANCELLED`, and exits non-zero. A second Ctrl+C does not interrupt teardown. If the
terminal is closed or the process is killed without Ctrl+C, teardown cannot run. Use
the printed project name with the scoped cleanup command above, and see the demo guide's notes
on leftover files under `apps/api/tmp`.

## Windows working trees

The repository stores text with LF line endings, and Prettier (`endOfLine: "lf"`, enforced in
`pnpm lint` through the ESLint Prettier rule) requires LF. The root `.gitattributes` makes
checkouts match: `* text=auto eol=lf` checks text out as LF on every platform, overriding a local
`core.autocrlf=true`. Binary assets (images, fonts, PDFs) are marked `binary` and never
converted. Windows command scripts (`*.cmd`, `*.bat`) keep CRLF.

A checkout made before `.gitattributes` existed keeps its CRLF files until Git rewrites them, so
`Lint` fails with `Delete ␍` (`prettier/prettier`) on files whose committed content is clean.
`verify:local` reports that as a failure. It never reformats, normalizes, or otherwise writes
source files.

To repair an existing checkout without discarding edits, convert only CRLF line endings in the
files Git stores as LF. From Git Bash, at the repository root:

```bash
git ls-files --eol \
  | awk -F'\t' '$1 ~ /^i\/lf +w\/crlf/ { print $2 }' \
  | grep -v '/prisma/migrations/' \
  | while IFS= read -r file; do sed -i 's/\r$//' "$file"; done
```

- This changes only carriage returns at line ends. Local edits, encoding, and any BOM stay
  as they are. Do not run `git checkout`, `git reset --hard`, or `git stash` for this.
- `prisma/migrations` is skipped because Prisma checksums migration files. A database that was
  migrated from CRLF copies could then report them as modified. Converting them is not needed
  for any check.
- `git diff` shows no content change for converted files that you had not edited. `git status`
  may still list them as modified, because the index still records their old CRLF size. Staging
  them adds no content.

## Tests

The verifier's behavior is covered with injected process and probe fakes in
`scripts/verify-local.test.mjs`, part of `pnpm test:launcher`. Those tests are not
infrastructure verification. Only a real `--profile integration` or `--profile browser` run
verifies the Docker-backed paths.
