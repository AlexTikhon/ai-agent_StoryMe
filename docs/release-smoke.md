# Production-container release smoke (`pnpm smoke:release`)

One command checks that the built API image works as a release artifact. It runs the API
and a separate generation worker as production containers, with PostgreSQL, Redis and
S3-compatible storage. One synthetic four-page children's book goes through the whole
system, and the command checks the published artifacts over HTTP.

This is local release verification. It deploys nothing, pushes no image, calls no paid
provider and writes to no existing environment.

```bash
pnpm smoke:release                            # build apps/api/Dockerfile, then run
pnpm smoke:release -- --image storyme-api:ci  # reuse an image that is already built
node scripts/release-smoke.mjs --image <tag>  # same, without pnpm (what CI runs)
```

## Prerequisites

- Docker Engine running Linux containers, with Docker Compose v2.23 or later (inline
  `configs`). Docker Desktop on Windows and macOS works.
- Node.js 24 (`.nvmrc`). The script uses only Node built-ins, so it does not need
  `pnpm install`.
- Network access the first time, to pull `node:24-alpine` (image build),
  `postgres:16-alpine`, `redis:7-alpine` and `chrislusf/seaweedfs:4.01`.

No ports need to be free. The API is published on a loopback port that Docker chooses.

## What one run does

| Step                                | What happens                                                                                                                                                                                                                                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Docker prerequisites                | `docker version` and `docker compose version`. If either fails, the run reports `UNAVAILABLE` (exit 3) and starts nothing.                                                                                                                                                                                         |
| Build API image                     | `docker build -f apps/api/Dockerfile -t storyme-api:release-smoke .`, skipped with `--image`.                                                                                                                                                                                                                      |
| Native-dependency image smoke       | The existing `scripts/api-image-smoke.mjs`: Node major, non-root user, entrypoints, Prisma engine, Sharp, PDF fonts.                                                                                                                                                                                               |
| Disposable PostgreSQL, Redis and S3 | A new Compose project `storyme-release-<16 hex>`. Data lives on `tmpfs`, and only the internal network connects the services.                                                                                                                                                                                      |
| Database identity                   | From the release image, Prisma connects with the exact `DATABASE_URL` the application will use. The run refuses to continue unless the database and role are the ones generated for this run and the database has no tables.                                                                                       |
| Migrations                          | `prisma migrate deploy` from the release image, as a one-off container, before any application container starts. It must report that migrations were applied.                                                                                                                                                      |
| S3 bucket                           | The image's AWS SDK creates the bucket for this run, using the generated access key.                                                                                                                                                                                                                               |
| API container                       | `node dist/main` with `ENABLE_GENERATION_WORKER=false`. It is ready when `GET /api/health` returns 200. The run then inspects the container: non-root UID, PID 1 is `node dist/main`, `NODE_ENV=production`, no mounts, the image's own healthcheck kept, and a single port published on `127.0.0.1`.              |
| Book journey                        | Described in the next section.                                                                                                                                                                                                                                                                                     |
| Artifacts stored in S3              | The bucket must hold at least seven objects for the book: six images and the PDF.                                                                                                                                                                                                                                  |
| Cleanup                             | Always runs: `docker compose -p <project> -f <generated compose.json> down --volumes --remove-orphans`, then a check that no container, network or volume labelled with this project remains. The generated Compose directory is deleted only if both succeed (see [Cleanup and recovery](#cleanup-and-recovery)). |

### The book journey

1. Register two synthetic accounts (`*@release-smoke.storyme.test`) through
   `POST /api/auth/register`. A login before verification must still be refused with
   `EMAIL_NOT_VERIFIED`.
2. Run one SQL `UPDATE` in this run's disposable database. It marks exactly those two
   addresses verified and must affect exactly two rows. The smoke adds no application
   endpoint and changes no verification rule.
3. Log both accounts in through `POST /api/auth/login` (JWT mode).
4. Create one four-page book from fixed synthetic content.
5. Call `GET /api/books/:id/generation-estimate`, which must report
   `providerMode: "mock"`. Generation is never scheduled otherwise.
6. With only the API running, call `POST /api/books/:id/generate`. Then check:
   - the outbox row is `dispatched`;
   - its run ID is waiting in the BullMQ `book-generation` queue in Redis;
   - `generation-progress` reports `queued` on three polls about two seconds apart.
7. Start the worker container (`node dist/worker`, with Docker's healthcheck disabled
   because it has no HTTP server). It is ready when it logs
   `Generation worker started`. The run inspects it with the same posture checks as
   the API, and also checks that it has no healthcheck and publishes no ports.
8. Poll `generation-progress` until the run reaches `complete`, with a 180-second limit.
   A `failed` or `cancelled` run fails the smoke and prints its bounded diagnostics. The
   book must then report `status: complete`, a `publishedEdition` and four pages.
9. Fetch the cover, `page-1` to `page-4` and the back cover from
   `GET /api/books/:id/images/:imageId`, and the PDF from
   `GET /api/books/:id/pdf/preview`:
   - each image is served as `image/png` and decoded fully: signature, chunk CRCs, zlib
     stream, and the scanline layout its header declares;
   - the PDF has six page objects and a page-tree count of six, at least one embedded
     font file, and at least six image XObjects whose streams inflate.
10. Request each artifact without a token (it must return 401) and with the second
    user's token (403 or 404, and never the artifact's bytes).
11. Restart the API and worker containers. The infrastructure is not touched.
12. Log in again. The book must report the same published edition, and every artifact
    must return bytes with the same SHA-256 as before the restart.

The smoke never uses the curated public sample book.

## What it proves

- The image built from `apps/api/Dockerfile` boots both roles in production mode. Each
  role runs as a non-root user, from the compiled `dist/` entrypoints, with no source
  mount.
- The production guards accept `s3` storage for both images and PDFs. The prohibition
  on `local` storage in production is unchanged, and the smoke does not set it.
- The image can apply every migration to an empty PostgreSQL database.
- Scheduling commits the run and its outbox event. The API's dispatcher publishes the
  run to BullMQ, and nothing consumes it until the separate worker starts.
- The worker generates and publishes a complete book with mock providers. It writes the
  images and the PDF to S3 storage that the API container reads back.
- The existing authenticated routes serve valid PNGs and a six-page PDF, and refuse
  anonymous and cross-account reads.
- Published editions and artifact bytes survive an application restart.

## What it does not prove

- **Real cloud storage.** SeaweedFS's S3 gateway emulates S3 locally. It checks SigV4
  credentials, but it is not AWS S3 or Cloudflare R2. Use the manual
  [cloud storage smoke](../apps/api/docs/cloud-storage-smoke-test.md) for a real bucket.
  MinIO images are no longer publicly pullable, which is why SeaweedFS is used.
- **Real-model quality.** All three providers are mock, and paid evaluations are
  disabled.
- **Hosted ingress.** The host client calls the API directly on loopback, so TLS,
  reverse-proxy trust, DNS and platform health routing are not exercised.
- **Cross-site refresh cookies and the web app.** Only the access-token flow is
  exercised.
- **Deployment.** Nothing is pushed or deployed.

The production email provider stays `console`. The API logs an error at boot that
verification emails will not be delivered, and that is expected here.

## Isolation and credentials

- Each run generates its project name, database name, role and password, bucket, S3 key
  pair, JWT secrets and account passwords. All of them are hexadecimal, and the script
  never prints them.
- The Compose file is generated as JSON in a private temporary directory, which is also
  the Compose project directory. No `.env` file from the repository is read. Containers
  receive only the variables the script sets.
- The Docker CLI gets an allowlisted environment: `PATH`, OS and profile variables, and
  `DOCKER_*`. Inherited provider keys, `AWS_*`, `DATABASE_URL`, `COMPOSE_*` and similar
  variables are dropped.
- The script refuses any Compose project name that does not match
  `storyme-release-<16 hex>`. It never touches `storyme-integration`,
  `storyme-verify-*`, the development stack or other Docker resources.

## Exit status

| Status  | Meaning                                                                       |
| ------- | ----------------------------------------------------------------------------- |
| `0`     | Every step passed and cleanup was verified.                                   |
| `1`     | A step failed, or cleanup was incomplete or unverified (see the summary).     |
| `2`     | Invalid arguments. Nothing ran.                                               |
| `3`     | Docker or Docker Compose is unavailable. Nothing started. Not a test failure. |
| `128+n` | Interrupted by a signal (130 for Ctrl+C). Cleanup still ran.                  |

Docker commands, readiness waits and polling all have time limits. On failure, the run
prints `docker compose ps` and the last 80 log lines of the API, worker and S3 services
before teardown.

## Cleanup and recovery

Cleanup runs after success, after failure and after Ctrl+C/SIGTERM. The script ignores
a second signal during cleanup. However, Ctrl+C also reaches the Docker child process
directly, especially on Windows, so a repeated Ctrl+C can still interrupt
`compose down`. The built image (`storyme-api:release-smoke`) and pulled
base images are kept.

The generated Compose directory (`<system temp>/storyme-release-<id>-*/compose.json`)
is deleted only when cleanup is verified: `compose down` exited 0 and the
enumeration of containers, networks and volumes labelled with the project
succeeded and found none. Deleting it is the last cleanup action. If `compose down`
fails, times out or is interrupted, resources remain, the enumeration fails, or
cleanup crashes, the directory is kept. A process killed outright (for example
`kill -9`) also leaves it behind.

When the directory is kept, the summary reports `Cleanup INCOMPLETE` with the reason
and prints:

- the kept `compose.json` as an absolute path;
- a copyable recovery command with the exact project name and an explicit `-f`, so
  it does not depend on the working directory and cannot pick up the repository's
  development `docker-compose.yml`;
- the three `docker ... ls -q --filter label=com.docker.compose.project=<project>`
  commands that must print nothing afterwards;
- the kept directory, which you can delete only after that teardown succeeds and
  nothing remains.

Paths are double-quoted on Windows (PowerShell and cmd, including paths with spaces)
and single-quoted for POSIX shells elsewhere. For example, on Windows:

```powershell
docker compose -p storyme-release-<id> -f "C:\Users\<you>\AppData\Local\Temp\storyme-release-<id>-XXXXXX\compose.json" down --volumes --remove-orphans
```

If teardown is verified but only deleting the directory fails, the summary says so
without a recovery command. The directory holds only that run's disposable
credentials, so you can delete it by hand.

To find projects left behind by a killed process, list them, then recover each one
with its kept `compose.json` as above:

```bash
docker ps -a --filter label=com.docker.compose.project --format '{{.Label "com.docker.compose.project"}}' | grep '^storyme-release-' | sort -u
```

## CI

The `API container image` job builds `storyme-api:ci` once. It runs the existing
`api-image-smoke.mjs` and then `node scripts/release-smoke.mjs --image storyme-api:ci`
on that image. The job uses no registry, deployment or provider credentials.

The orchestration's ownership, failure, interruption and cleanup behaviour is covered by
`scripts/release-smoke.test.mjs`, which is part of `pnpm test:launcher`.
