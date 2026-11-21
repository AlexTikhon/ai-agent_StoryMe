# StoryMe

StoryMe creates personalized children's illustrated books. A parent enters a
child's name and age (1–12), a theme, a language (English, Russian or Polish)
and, optionally, a lesson and a reference photo. A durable queued pipeline
(PostgreSQL, outbox, BullMQ/Redis worker) writes an age-appropriate story of
4–12 pages with the child as the hero, illustrates every page in a cartoon
storybook style, and publishes it to an authenticated in-browser reader and a
downloadable PDF. Generation supports cancellation and retry, a completed book
can have a page's text corrected or one page's illustration regenerated, and a
published edition survives a failed regeneration. Books can be permanently
deleted.

That is the whole product. A separate branching detective-story reader and its
offline scenario-authoring tools were retired in November 2026; see
[What was retired](docs/CURRENT_PRODUCT.md#retired-interactive-stories).

Development is paused. **[docs/PAUSE_HANDOFF.md](docs/PAUSE_HANDOFF.md)** records
the 2026-11-05 outbox hardening, architecture review, verification and restart steps.
[PROJECT_CLOSEOUT.md](docs/PROJECT_CLOSEOUT.md) preserves the earlier closeout evidence;
both predate the retirement and describe the repository as it was then.

## Run the demo

Needs Node.js 24 (see `.nvmrc`), pnpm 9.4.0, Docker running, and ports `5440`, `6380`, `4100`,
`3100` free.

```bash
pnpm install
pnpm demo:local      # disposable stack, mock providers; open http://127.0.0.1:3100
pnpm demo:capture    # in a second terminal: EN/RU/PL books, PDFs, screenshots, manifest
```

`demo:local` prints the synthetic sign-in when it is ready and removes its
containers and synthetic data on Ctrl+C. `demo:capture` writes to the ignored
`artifacts/demo-showcase/` directory, which teardown does not touch.

- [Local demo](docs/local-demo.md): the one-command demo and the manual setup.
- [Showcase capture](docs/demo-showcase.md): output, checks and a recording script.
- [Recovery demo](docs/recovery-demo.md): a browser journey through a provider
  failure, a retry and a cancellation.

All demos use deterministic mock providers. They show the product and pipeline
working, not real-model quality.

## Verify

```bash
pnpm verify:local --profile offline       # lint, typecheck, unit tests, offline story eval
pnpm verify:local --profile integration   # API integration suite on disposable PostgreSQL/Redis
pnpm verify:local --profile browser       # browser journeys + recovery journey
```

The Docker profiles use a fresh `storyme-verify-<random>` Compose project per run.
They report `UNAVAILABLE`, and change nothing, if their ports or that project
are already in use. Stopped `storyme-integration` containers do not block them. Production builds
are not part of `verify:local`; the production browser smoke is
`pnpm --filter @book/web build` followed by
`pnpm --filter @book/web test:e2e:production`. See
[local-verification.md](docs/local-verification.md) and the exact commands in
[PROJECT_CLOSEOUT.md](docs/PROJECT_CLOSEOUT.md#reproduce).

## Engineering case study

[Book generation pipeline](docs/generation-case-study.md): scheduling and the
outbox, fencing, checkpoints and reuse, publication, provider budgets. Each claim
links to the code and tests behind it.

## Documentation

- [CURRENT_PRODUCT.md](docs/CURRENT_PRODUCT.md) is the source of truth for
  implemented behavior, routes, providers, storage and the
  [implemented/unimplemented boundary](docs/CURRENT_PRODUCT.md#implemented-and-unimplemented).
- Implementation notes: [generation pipeline](apps/api/docs/local-generation-pipeline.md),
  [credits and billing](apps/api/docs/credits.md), [PDF rendering](apps/api/docs/pdf-rendering.md),
  [auth](docs/auth-architecture.md), [privacy and local data](docs/LOCAL_DATA_AND_PRIVACY.md).
- Deployment notes, not verified by the closeout:
  [deployment-readiness.md](docs/deployment-readiness.md),
  [staging-operations.md](docs/staging-operations.md),
  [private-demo-deploy.md](docs/private-demo-deploy.md).
- The root [PRD](PRD.md), [API specification](API_SPEC.md),
  [architecture](ARCHITECTURE.md), [backend](BACKEND_DESIGN.md) and
  [frontend](FRONTEND_DESIGN.md) designs, [UX specification](UX_SPEC.md),
  [design system](DESIGN_SYSTEM.md) and [roadmap](ROADMAP.md) are historical
  references, not implementation contracts. Where they propose other formats
  (audio, video, games, print, branching stories), those ideas are out of scope.

## Environment

Copy `.env.example` to `apps/api/.env` for manual runs
([setup](docs/local-demo.md#3-configure-environment)); `demo:local` and
`verify:local` need no `.env` and never edit one.

- **Auth.** `AUTH_MODE` (API) and `NEXT_PUBLIC_AUTH_MODE` (web) are `jwt`
  (default; email/password, JWT access token, rotating `HttpOnly` refresh cookie)
  or `dev` (local-only header identity). They must match, or every request 401s.
- **Product mode.** `PRODUCT_MODE` and `NEXT_PUBLIC_PRODUCT_MODE` are `home`
  (default; generation costs no credits, purchase UI hidden) or `demo` (credit
  charges and Stripe Checkout, disabled unless `STRIPE_BILLING_ENABLED=true`).
- **Providers.** `STORY_GENERATION_PROVIDER`, `CHARACTER_PROFILE_PROVIDER` and
  `IMAGE_GENERATION_PROVIDER` default to `mock`. `openai` needs `OPENAI_API_KEY`
  and costs money per call.
- **Storage.** `PDF_STORAGE_DRIVER` and `IMAGE_STORAGE_DRIVER` default to `local`
  (`apps/api/tmp/`); `s3`/`r2` are exercised only by the manual
  `smoke:cloud-storage` script ([guide](apps/api/docs/cloud-storage-smoke-test.md)).
  The PDF preview endpoint is always `GET /api/books/:id/pdf/preview`.
- **Web build.** `pnpm --filter @book/web build` runs in production mode and
  requires `NEXT_PUBLIC_API_URL` ending in `/api`; it never falls back to
  localhost. `NEXT_PUBLIC_ENABLE_DEVELOPER_DIAGNOSTICS=true` is for trusted
  developer builds only.

## Current limitations

- Every demonstration and verification used mock providers. Real-model story
  and image quality, error rates and cost are unmeasured; no paid experiment has
  been run.
- Automated checks are structural and heuristic. They do not establish
  comprehensive content safety, photo likeness or visual consistency.
- No deployment is verified. A local production build and smoke test is not
  deployment evidence.
- Recovery from a real worker crash, Redis loss or database outage is not
  demonstrated end to end; those paths are covered by in-process integration
  tests only.
- The Prisma schema still defines the retired `InteractiveSession`/`SessionEvent`
  storage so existing rows and migration history are preserved; nothing uses it
  ([details](docs/CURRENT_PRODUCT.md#retired-interactive-stories)).

The full list is in [PROJECT_CLOSEOUT.md](docs/PROJECT_CLOSEOUT.md#known-limitations).

## Repository layout

- `apps/api` (`@book/api`): NestJS API and generation worker, Prisma/PostgreSQL.
- `apps/web` (`@book/web`): Next.js frontend and Playwright journeys.
- `packages/types` (`@book/types`): types shared between API and web.
- `scripts/`: the demo, verification and test-infrastructure launchers.
