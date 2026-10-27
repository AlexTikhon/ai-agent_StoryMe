# StoryMe

StoryMe is a pnpm/Turborepo monorepo with two supported products:

- **Interactive illustrated stories.** A signed-in reader plays a branching
  detective story in the browser: each choice is validated and applied by a
  deterministic, versioned engine; progress is stored per account and can be
  resumed after a reload; scenes are accompanied by local SVG artwork. One
  scenario, "The Last Delivery", is published. A separate offline authoring
  workflow can draft further scenarios with a model, validates them
  mechanically, and stops at review artifacts: nothing is published without a
  human decision recorded in source control. No language model runs during play.
- **Personalized children's books.** Fill in a child's name, age, language and
  a theme; a durable queued pipeline (PostgreSQL, outbox, BullMQ/Redis worker)
  produces a short illustrated story and a downloadable PDF, with retry,
  cancellation and a published edition that survives a failed regeneration.

Development is paused. **[docs/PROJECT_CLOSEOUT.md](docs/PROJECT_CLOSEOUT.md)**
records the verified candidate, what was and was not verified, and how to return
to the project.

## Run the demo

Needs Node.js ≥ 20, pnpm 9, Docker running, and ports `5440`, `6380`, `4100`,
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
- [Interactive demo](docs/interactive-demo.md): the reader and the offline
  authoring workflow (Windows PowerShell).
- [Recovery demo](docs/recovery-demo.md): a browser journey through a provider
  failure, a retry and a cancellation.

All demos use deterministic mock providers. They show the product and pipeline
working, not real-model quality.

## Verify

```bash
pnpm verify:local --profile offline       # lint, typecheck, unit tests, offline evals
pnpm verify:local --profile integration   # API integration suite on disposable PostgreSQL/Redis
pnpm verify:local --profile browser       # browser journeys + recovery journey
```

The Docker profiles report `UNAVAILABLE`, and change nothing, if their ports or
the `storyme-integration` Compose project are already in use. Production builds
are not part of `verify:local`; the production browser smoke is
`pnpm --filter @book/web build` followed by
`pnpm --filter @book/web test:e2e:production`. See
[local-verification.md](docs/local-verification.md) and the exact commands in
[PROJECT_CLOSEOUT.md](docs/PROJECT_CLOSEOUT.md#reproduce).

## Engineering case studies

Each claim links to the code and tests behind it:

- [Book generation pipeline](docs/generation-case-study.md): scheduling and the
  outbox, fencing, checkpoints and reuse, publication, provider budgets.
- [Interactive stories](docs/interactive-case-study.md): the engine, lost-response
  recovery, bounded authoring and the human approval boundary.

## Documentation

- [CURRENT_PRODUCT.md](docs/CURRENT_PRODUCT.md) is the source of truth for
  implemented behavior, routes, providers, storage and the
  [implemented/unimplemented boundary](docs/CURRENT_PRODUCT.md#implemented-and-unimplemented).
- Implementation notes: [generation pipeline](apps/api/docs/local-generation-pipeline.md),
  [credits and billing](apps/api/docs/credits.md), [PDF rendering](apps/api/docs/pdf-rendering.md),
  [interactive engine](apps/api/docs/interactive-engine.md),
  [interactive authoring](apps/api/docs/interactive-authoring.md),
  [auth](docs/auth-architecture.md), [privacy and local data](docs/LOCAL_DATA_AND_PRIVACY.md).
- Deployment notes, not verified by the closeout:
  [deployment-readiness.md](docs/deployment-readiness.md),
  [staging-operations.md](docs/staging-operations.md),
  [private-demo-deploy.md](docs/private-demo-deploy.md).
- The root [PRD](PRD.md), [API specification](API_SPEC.md),
  [architecture](ARCHITECTURE.md), [backend](BACKEND_DESIGN.md) and
  [frontend](FRONTEND_DESIGN.md) designs, [UX specification](UX_SPEC.md),
  [design system](DESIGN_SYSTEM.md) and [roadmap](ROADMAP.md) are historical
  references, not implementation contracts.

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

- Every demonstration and verification used mock providers. Real-model story,
  image and authoring quality, error rates and cost are unmeasured; no paid
  experiment has been run.
- No deployment is verified. A local production build and smoke test is not
  deployment evidence.
- Recovery from a real worker crash, Redis loss or database outage is not
  demonstrated end to end; those paths are covered by in-process integration
  tests only.
- Generation diagnostics mix the published edition and the newest run
  ([details](docs/recovery-demo.md#published-diagnostics-vs-current-run-telemetry)).
- One interactive scenario is published; the others are unapproved fixtures.

The full list is in [PROJECT_CLOSEOUT.md](docs/PROJECT_CLOSEOUT.md#known-limitations).

## Repository layout

- `apps/api` (`@book/api`): NestJS API and generation worker, Prisma/PostgreSQL.
- `apps/web` (`@book/web`): Next.js frontend and Playwright journeys.
- `packages/types` (`@book/types`): types shared between API and web.
- `scripts/`: the demo, verification and test-infrastructure launchers.
