# AI Children's Book Platform — Implementation Roadmap

> Principal Engineering Manager Document
> ~280 atomic tasks ordered by implementation sequence

---

## Task Format

Each task includes:

- **ID** — unique identifier
- **Complexity** — XS (<1h) | S (1–2h) | M (2–4h) | L (4–8h) | XL (8h+)
- **Deps** — prerequisite task IDs
- **AC** — acceptance criteria
- **Files** — files/modules affected

---

## PHASE 0 — Project Foundation & Infrastructure

**Goal:** Working monorepo skeleton with all tooling, databases, and CI skeleton in place.
**Deliverable:** `pnpm dev` starts all services locally; CI runs lint + typecheck on every push.

---

### TASK-001: Initialize pnpm monorepo workspace `[S]`

**Description:** Create root `package.json` with `"type": "module"`, `pnpm-workspace.yaml` listing `apps/*` and `packages/*`, and `turbo.json` with pipeline tasks `build`, `lint`, `typecheck`, `test`.
**Deps:** none
**AC:** `pnpm install` succeeds from repo root; `turbo run build` exits cleanly on empty workspace.
**Files:** `package.json`, `pnpm-workspace.yaml`, `turbo.json`

---

### TASK-002: Configure root TypeScript `[S]`

**Description:** Create root `tsconfig.base.json` with strict settings: `"strict": true`, `"noUncheckedIndexedAccess": true`, `"exactOptionalPropertyTypes": true`. All app tsconfigs will extend this.
**Deps:** TASK-001
**AC:** `tsconfig.base.json` exists at root; extends successfully from a child config.
**Files:** `tsconfig.base.json`

---

### TASK-003: Configure root ESLint + Prettier `[S]`

**Description:** Install `eslint`, `@typescript-eslint/eslint-plugin`, `prettier`. Create `eslint.config.mjs` (flat config) and `.prettierrc` at root. Add `lint` and `format` scripts to root `package.json`.
**Deps:** TASK-001
**AC:** `pnpm lint` passes on empty workspace; `pnpm format` reformats files without error.
**Files:** `eslint.config.mjs`, `.prettierrc`, `package.json`

---

### TASK-004: Create shared `packages/types` package `[S]`

**Description:** Scaffold `packages/types/` with its own `package.json` (`name: "@book/types"`), `tsconfig.json` extending root base, and `src/index.ts` exporting an empty object. This package will hold all shared TypeScript interfaces.
**Deps:** TASK-002
**AC:** `packages/types` builds with `tsc --noEmit`; importable from other workspace packages.
**Files:** `packages/types/package.json`, `packages/types/tsconfig.json`, `packages/types/src/index.ts`

---

### TASK-005: Define core domain types in `packages/types` `[M]`

**Description:** Add all shared interfaces from the architecture document: `BookRequest`, `CharacterCard`, `StoryPlan`, `ChapterOutline`, `Chapter`, `Page`, `ImagePrompt`, `GeneratedImage`, `QualityReport`, `PageLayout`, `BookStatus` enum, `AgentStep` enum, `IllustrationStyle` enum, `BookGenre` enum.
**Deps:** TASK-004
**AC:** All types compile; no `any`; exported from `packages/types/src/index.ts`.
**Files:** `packages/types/src/book.types.ts`, `packages/types/src/agent.types.ts`, `packages/types/src/index.ts`

---

### TASK-006: Scaffold NestJS API application `[M]`

**Description:** Create `apps/api/` using `nest new` (or manual scaffold). Configure `tsconfig.json` extending root base. Add `src/main.ts`, `src/app.module.ts`. Install core deps: `@nestjs/core`, `@nestjs/common`, `@nestjs/platform-express`, `reflect-metadata`.
**Deps:** TASK-002
**AC:** `pnpm --filter api dev` starts NestJS on port 4000; `GET /` returns 200.
**Files:** `apps/api/src/main.ts`, `apps/api/src/app.module.ts`, `apps/api/package.json`

---

### TASK-007: Configure NestJS environment validation `[S]`

**Description:** Install `@nestjs/config` and `zod`. Create `apps/api/src/config/env.schema.ts` with a Zod schema validating all required env vars: `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `FAL_API_KEY`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `PORT`. App must fail to start if any required var is missing.
**Deps:** TASK-006
**AC:** App fails to start with a clear error when `DATABASE_URL` is absent; starts normally with all vars present.
**Files:** `apps/api/src/config/env.schema.ts`, `apps/api/src/config/env.module.ts`, `apps/api/src/app.module.ts`

---

### TASK-008: Set up Prisma in the API app `[S]`

**Description:** Install `prisma` and `@prisma/client`. Run `prisma init`. Create `apps/api/prisma/schema.prisma` with the `datasource` block pointing to `DATABASE_URL`. Add `prisma:generate` and `prisma:migrate` scripts to `apps/api/package.json`.
**Deps:** TASK-006
**AC:** `pnpm --filter api prisma:generate` completes without error.
**Files:** `apps/api/prisma/schema.prisma`, `apps/api/package.json`

---

### TASK-009: Add Prisma models to schema `[M]`

**Description:** Add all models from the architecture DB schema: `User`, `Book`, `BookPage`, `CharacterCard`, `Series`, `CreditTransaction`, `AgentLog`. Include all fields, relations, indexes, and constraints exactly as specified in the architecture document.
**Deps:** TASK-008
**AC:** `prisma validate` passes; `prisma format` produces no changes; all relations are consistent.
**Files:** `apps/api/prisma/schema.prisma`

---

### TASK-010: Create Prisma service in NestJS `[S]`

**Description:** Create `apps/api/src/database/prisma.service.ts` that extends `PrismaClient` and implements `OnModuleInit` / `OnModuleDestroy` for connection management. Register as a global module.
**Deps:** TASK-008, TASK-006
**AC:** PrismaService injects into any module; `$connect()` is called on app start.
**Files:** `apps/api/src/database/prisma.service.ts`, `apps/api/src/database/database.module.ts`

---

### TASK-011: Set up Redis connection in NestJS `[S]`

**Description:** Install `ioredis`. Create `apps/api/src/cache/redis.service.ts` wrapping an `ioredis` client configured from env. Expose `get`, `set`, `del`, `publish`, `subscribe` methods. Register as a global provider.
**Deps:** TASK-007
**AC:** `RedisService.set('test', 'val')` and `get('test')` round-trip correctly in integration test.
**Files:** `apps/api/src/cache/redis.service.ts`, `apps/api/src/cache/cache.module.ts`

---

### TASK-012: Configure BullMQ module in NestJS `[M]`

**Description:** Install `bullmq` and `@nestjs/bullmq`. Create `apps/api/src/queue/queues.config.ts` listing all 9 queue names as a const enum. Create `apps/api/src/queue/queue.module.ts` registering all queues with default retry config (3 attempts, exponential backoff, 2s initial delay).
**Deps:** TASK-011
**AC:** All queues registered; a test job can be enqueued and processed; Bull dashboard (optional) shows queues.
**Files:** `apps/api/src/queue/queues.config.ts`, `apps/api/src/queue/queue.module.ts`

---

### TASK-013: Create `docker-compose.yml` for local dev `[M]`

**Description:** Define services: `postgres` (postgres:16-alpine, port 5432, named volume), `redis` (redis:7-alpine, port 6379, maxmemory 512mb), `minio` (for local R2 emulation, port 9000/9001). Add `.env.example` at repo root with all required vars populated for local dev.
**Deps:** none
**AC:** `docker compose up -d` starts all three services; `psql` and `redis-cli ping` succeed; MinIO console accessible at localhost:9001.
**Files:** `docker-compose.yml`, `.env.example`

---

### TASK-014: Run initial Prisma migration `[XS]`

**Description:** Run `prisma migrate dev --name init` against the local Docker Postgres. Commit the generated migration file.
**Deps:** TASK-009, TASK-013
**AC:** Migration runs without error; all tables exist in the DB; `prisma migrate status` shows "up to date".
**Files:** `apps/api/prisma/migrations/0001_init/migration.sql`

---

### TASK-015: Configure global exception filter in NestJS `[S]`

**Description:** Create `apps/api/src/common/filters/http-exception.filter.ts` that catches all exceptions and returns a consistent JSON shape: `{ error: string, message: string, statusCode: number, timestamp: string }`. Register globally in `main.ts`.
**Deps:** TASK-006
**AC:** Unhandled exception returns the standard error shape; 404 returns `{ error: "Not Found", ... }`.
**Files:** `apps/api/src/common/filters/http-exception.filter.ts`, `apps/api/src/main.ts`

---

### TASK-016: Configure global validation pipe `[S]`

**Description:** Add `ValidationPipe` globally in `main.ts` with `whitelist: true`, `forbidNonWhitelisted: true`, `transform: true`. Install `class-validator` and `class-transformer`.
**Deps:** TASK-006
**AC:** Request body with extra fields returns 400; missing required field returns 400 with field name.
**Files:** `apps/api/src/main.ts`

---

### TASK-017: Add health check endpoint `[XS]`

**Description:** Install `@nestjs/terminus`. Create `HealthModule` with a `GET /api/health` endpoint that checks Postgres connectivity and Redis ping. Returns `{ status: "ok", db: "up", redis: "up" }`.
**Deps:** TASK-010, TASK-011
**AC:** `GET /api/health` returns 200 with all checks passing when services are up; returns 503 when DB is down.
**Files:** `apps/api/src/health/health.module.ts`, `apps/api/src/health/health.controller.ts`

---

### TASK-018: Configure CORS and Helmet in NestJS `[XS]`

**Description:** Install `helmet`. In `main.ts` apply `helmet()` middleware and configure CORS to allow only origins from `ALLOWED_ORIGINS` env var (comma-separated). In dev, allow `http://localhost:3000`.
**Deps:** TASK-006
**AC:** Request from disallowed origin returns 403; OPTIONS preflight returns correct CORS headers.
**Files:** `apps/api/src/main.ts`

---

### TASK-019: Scaffold Next.js frontend application `[M]`

**Description:** Create `apps/web/` using `create-next-app` with App Router, TypeScript, Tailwind CSS. Configure `tsconfig.json` to extend root base. Add path alias `@/*` pointing to `apps/web/src/*`.
**Deps:** TASK-002
**AC:** `pnpm --filter web dev` starts Next.js on port 3000; default page renders without TypeScript errors.
**Files:** `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/next.config.ts`

---

### TASK-020: Configure Tailwind design tokens `[S]`

**Description:** In `apps/web/tailwind.config.ts`, extend the default theme with brand colors (`primary`, `secondary`, `accent`), custom font families (`display`, `body`), and spacing/border-radius tokens matching the children's book aesthetic (rounded, playful).
**Deps:** TASK-019
**AC:** Custom color classes like `bg-primary-500` render correctly in the browser.
**Files:** `apps/web/tailwind.config.ts`, `apps/web/src/styles/globals.css`

---

### TASK-021: Set up GitHub Actions CI workflow `[M]`

**Description:** Create `.github/workflows/ci.yml`. Jobs: (1) `lint-typecheck` — runs `turbo run lint typecheck`; (2) `test` — spins up Postgres + Redis services, runs `turbo run test`; (3) `build` — runs `turbo run build`. All jobs run on `push` and `pull_request`.
**Deps:** TASK-001, TASK-003
**AC:** Workflow appears in GitHub Actions; all three jobs pass on a clean push to main.
**Files:** `.github/workflows/ci.yml`

---

### TASK-022: Create `.gitignore` `[XS]`

**Description:** Comprehensive `.gitignore` covering: `node_modules`, `.env*` (except `.env.example`), `dist`, `.next`, `*.tsbuildinfo`, `.turbo`, `prisma/generated`, uploaded files.
**Deps:** TASK-001
**AC:** `git status` on a fresh clone shows no untracked build artifacts.
**Files:** `.gitignore`

---

### TASK-023: Configure Vitest for API unit tests `[S]`

**Description:** Install `vitest` in `apps/api`. Create `vitest.config.ts`. Add `test` script to `package.json`. Create `apps/api/src/common/test-utils/mock-prisma.ts` helper for mocking PrismaService in unit tests.
**Deps:** TASK-006
**AC:** `pnpm --filter api test` runs and finds zero tests (passes vacuously); watch mode works.
**Files:** `apps/api/vitest.config.ts`, `apps/api/src/common/test-utils/mock-prisma.ts`

---

### TASK-024: Configure Vitest for web unit tests `[S]`

**Description:** Install `vitest` and `@testing-library/react` in `apps/web`. Create `vitest.config.ts` with jsdom environment. Add `test` script.
**Deps:** TASK-019
**AC:** `pnpm --filter web test` runs and passes vacuously.
**Files:** `apps/web/vitest.config.ts`

---

### TASK-025: Create Dockerfile for API `[M]`

**Description:** Create `apps/api/Dockerfile` with multi-stage build: (1) `deps` stage installs production dependencies; (2) `build` stage compiles TypeScript; (3) `runtime` stage uses `node:20-alpine`, copies built output, runs as non-root user. Expose port 4000.
**Deps:** TASK-006
**AC:** `docker build -t api .` succeeds; container starts and `/api/health` returns 200.
**Files:** `apps/api/Dockerfile`, `apps/api/.dockerignore`

---

## PHASE 1 — Authentication & User Management

**Goal:** Secure JWT auth with register/login/refresh/logout. Users stored in Postgres.
**Deps:** Phase 0 complete
**Deliverable:** Auth endpoints tested via Postman/curl; JWT flow works end-to-end.

---

### TASK-026: Create User repository `[S]`

**Description:** Create `apps/api/src/modules/users/users.repository.ts` with methods: `findById(id)`, `findByEmail(email)`, `create({ email, passwordHash, name })`, `updateRefreshToken(id, hash)`, `clearRefreshToken(id)`. All methods use PrismaService.
**Deps:** TASK-010, TASK-014
**AC:** Unit tests for each method pass using mocked PrismaService.
**Files:** `apps/api/src/modules/users/users.repository.ts`, `apps/api/src/modules/users/users.module.ts`

---

### TASK-027: Create auth DTOs with validation `[S]`

**Description:** Create `apps/api/src/modules/auth/dto/register.dto.ts` (`email`, `password` min 8 chars, `name`), `login.dto.ts` (`email`, `password`). Use `class-validator` decorators. Also create response type `AuthTokensDto` (`accessToken`, `refreshToken`).
**Deps:** TASK-016
**AC:** Invalid email in register body returns 400 with `"email must be an email"` message.
**Files:** `apps/api/src/modules/auth/dto/register.dto.ts`, `apps/api/src/modules/auth/dto/login.dto.ts`

---

### TASK-028: Implement password hashing utility `[XS]`

**Description:** Create `apps/api/src/common/utils/crypto.ts` with `hashPassword(plain: string): Promise<string>` (bcrypt, cost 12) and `verifyPassword(plain, hash): Promise<boolean>`.
**Deps:** TASK-006
**AC:** Unit test: hash and verify round-trip returns true; wrong password returns false.
**Files:** `apps/api/src/common/utils/crypto.ts`

---

### TASK-029: Implement JWT token service `[M]`

**Description:** Create `apps/api/src/modules/auth/token.service.ts`. Methods: `signAccessToken(userId, email): string` (15min expiry, HS256), `signRefreshToken(userId): string` (7 day expiry), `verifyAccessToken(token): JwtPayload`, `verifyRefreshToken(token): JwtPayload`. Uses `jsonwebtoken`. Reads secrets from `EnvService`.
**Deps:** TASK-007
**AC:** Unit tests verify tokens sign and decode correctly; expired token throws `TokenExpiredError`.
**Files:** `apps/api/src/modules/auth/token.service.ts`

---

### TASK-030: Implement auth service (register + login) `[M]`

**Description:** Create `apps/api/src/modules/auth/auth.service.ts`. `register()`: checks email uniqueness, hashes password, creates user, returns tokens. `login()`: finds user, verifies password, returns tokens, stores hashed refresh token in DB. Both methods return `AuthTokensDto`.
**Deps:** TASK-026, TASK-028, TASK-029
**AC:** Unit tests: duplicate email throws `ConflictException`; wrong password throws `UnauthorizedException`.
**Files:** `apps/api/src/modules/auth/auth.service.ts`

---

### TASK-031: Implement refresh token rotation `[M]`

**Description:** Add `refresh()` method to `AuthService`. Finds user by refresh token hash, verifies it, issues new access + refresh tokens, rotates the stored hash. Add `logout()` that clears the stored refresh token. Refresh token reuse detection: if token not found in DB, revoke all sessions.
**Deps:** TASK-030
**AC:** Unit test: valid refresh issues new tokens; used refresh token throws `UnauthorizedException`.
**Files:** `apps/api/src/modules/auth/auth.service.ts`

---

### TASK-032: Create JWT auth guard `[S]`

**Description:** Create `apps/api/src/common/guards/jwt-auth.guard.ts` implementing `CanActivate`. Extracts Bearer token from Authorization header, verifies using `TokenService`. Attaches decoded `userId` and `email` to `request.user`. Returns 401 on invalid/missing token.
**Deps:** TASK-029
**AC:** Protected route returns 401 without token; returns 200 with valid token; `req.user.userId` is populated.
**Files:** `apps/api/src/common/guards/jwt-auth.guard.ts`, `apps/api/src/common/decorators/current-user.decorator.ts`

---

### TASK-033: Create auth controller `[M]`

**Description:** Create `apps/api/src/modules/auth/auth.controller.ts` with endpoints: `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/refresh` (reads refresh token from HttpOnly cookie), `POST /api/auth/logout` (clears cookie, calls `logout()`). Set refresh token as HttpOnly, Secure, SameSite=Strict cookie.
**Deps:** TASK-030, TASK-031, TASK-027
**AC:** `POST /api/auth/register` with valid body returns 201 with `accessToken`; refresh cookie is set.
**Files:** `apps/api/src/modules/auth/auth.controller.ts`, `apps/api/src/modules/auth/auth.module.ts`

---

### TASK-034: Add Google OAuth (optional, scaffolded) `[M]`

**Description:** Install `passport-google-oauth20` and `@nestjs/passport`. Create `apps/api/src/modules/auth/strategies/google.strategy.ts`. Endpoint: `GET /api/auth/google` and callback `GET /api/auth/google/callback`. On callback, find-or-create user by `oauth_id`, issue tokens. Mark with `// TODO: configure GOOGLE_CLIENT_ID/SECRET in env` if not in `.env.example`.
**Deps:** TASK-033
**AC:** Strategy file compiles without error; endpoints registered in router; actual OAuth flow works when credentials are configured.
**Files:** `apps/api/src/modules/auth/strategies/google.strategy.ts`

---

### TASK-035: Write integration tests for auth endpoints `[M]`

**Description:** Using `supertest` against a real test DB (seeded and torn down per test). Test: register → login → access protected route → refresh → logout → verify old refresh token rejected.
**Deps:** TASK-033, TASK-032
**AC:** All 6 test cases pass; no leaked DB state between tests.
**Files:** `apps/api/test/auth.e2e.spec.ts`

---

### TASK-036: Add rate limiting to auth endpoints `[S]`

**Description:** Install `@nestjs/throttler`. Apply a tight throttle specifically to auth endpoints: 10 requests per 60 seconds per IP. Use Redis as the throttle store via `ThrottlerStorageRedisService`.
**Deps:** TASK-033, TASK-011
**AC:** 11th request to `POST /api/auth/login` within 60s returns 429.
**Files:** `apps/api/src/modules/auth/auth.module.ts`, `apps/api/src/app.module.ts`

---

## PHASE 2 — Book Domain: Data Layer

**Goal:** All book-related database operations encapsulated in repositories. No business logic yet.
**Deps:** Phase 1 complete
**Deliverable:** Repository unit tests pass; DB operations verified against real Postgres.

---

### TASK-037: Create BookRepository `[M]`

**Description:** Create `apps/api/src/modules/books/books.repository.ts`. Methods: `create(userId, request)`, `findById(id)`, `findByUserId(userId, pagination)`, `updateStatus(id, status)`, `updateAgentOutput(id, field, data)` (JSONB patch), `setResult(id, result)`, `delete(id)`, `incrementRetry(id)`.
**Deps:** TASK-010, TASK-014
**AC:** Unit tests with mocked Prisma cover all 8 methods; `findByUserId` returns paginated results.
**Files:** `apps/api/src/modules/books/books.repository.ts`

---

### TASK-038: Create BookPageRepository `[M]`

**Description:** Create `apps/api/src/modules/books/book-pages.repository.ts`. Methods: `createMany(bookId, pages[])`, `findByBookId(bookId)`, `findPage(bookId, pageNumber)`, `updatePageText(bookId, pageNumber, text)`, `updatePageImage(bookId, pageNumber, imageData)`, `updatePageLayout(bookId, pageNumber, layout)`, `updateQAResult(bookId, pageNumber, report)`, `incrementRegenCount(bookId, pageNumber)`.
**Deps:** TASK-010, TASK-014
**AC:** Unit tests pass; `createMany` is transactional (all-or-nothing).
**Files:** `apps/api/src/modules/books/book-pages.repository.ts`

---

### TASK-039: Create CharacterCardRepository `[S]`

**Description:** Create `apps/api/src/modules/characters/character-cards.repository.ts`. Methods: `create(userId, name, card, visualAnchor)`, `findById(id)`, `findByUserId(userId)`, `delete(id)`.
**Deps:** TASK-010, TASK-014
**AC:** Unit tests pass.
**Files:** `apps/api/src/modules/characters/character-cards.repository.ts`

---

### TASK-040: Create SeriesRepository `[S]`

**Description:** Create `apps/api/src/modules/series/series.repository.ts`. Methods: `create(userId, name, characterCardId)`, `findById(id)`, `findByUserId(userId)`, `addBook(seriesId, bookId)`, `delete(id)`.
**Deps:** TASK-010, TASK-014
**AC:** Unit tests pass; `addBook` uses an atomic array append via Prisma.
**Files:** `apps/api/src/modules/series/series.repository.ts`

---

### TASK-041: Create AgentLogRepository `[S]`

**Description:** Create `apps/api/src/modules/books/agent-log.repository.ts`. Methods: `log(entry: CreateAgentLogDto)`, `findByBookId(bookId)`, `getBookCost(bookId): number` (sums `cost_usd`).
**Deps:** TASK-010, TASK-014
**AC:** Unit tests pass; `getBookCost` correctly aggregates decimal values.
**Files:** `apps/api/src/modules/books/agent-log.repository.ts`

---

### TASK-042: Create CreditRepository `[S]`

**Description:** Create `apps/api/src/modules/credits/credits.repository.ts`. Methods: `getBalance(userId)` (sum of all transactions), `deduct(userId, amount, reason, bookId)`, `add(userId, amount, reason)`, `getTransactions(userId, pagination)`. All writes are transactional with user balance check in `deduct`.
**Deps:** TASK-010, TASK-014
**AC:** Unit tests pass; `deduct` throws if balance would go negative.
**Files:** `apps/api/src/modules/credits/credits.repository.ts`

---

### TASK-043: Create StorageService (R2 / S3 abstraction) `[M]`

**Description:** Create `apps/api/src/storage/storage.service.ts`. Wraps AWS SDK v3 (`@aws-sdk/client-s3`). Methods: `upload(key, buffer, contentType): Promise<string>` (returns public URL), `getSignedUrl(key, expiresIn): Promise<string>`, `delete(key)`, `exists(key): Promise<boolean>`. Configured to use `R2_*` env vars. In dev, points to MinIO.
**Deps:** TASK-007
**AC:** Unit test with MinIO: upload → signedUrl → download round-trip works.
**Files:** `apps/api/src/storage/storage.service.ts`, `apps/api/src/storage/storage.module.ts`

---

### TASK-044: Define R2 key naming conventions `[XS]`

**Description:** Create `apps/api/src/storage/storage.keys.ts` with pure functions: `bookCoverKey(bookId)`, `bookPdfKey(bookId)`, `bookPreviewPdfKey(bookId)`, `pageImageKey(bookId, pageNumber)`, `pageImageOptimizedKey(bookId, pageNumber)`, `characterReferenceKey(characterCardId)`. All keys follow the folder layout from the architecture doc.
**Deps:** TASK-043
**AC:** All functions return strings matching the documented R2 folder layout.
**Files:** `apps/api/src/storage/storage.keys.ts`

---

### TASK-045: Seed script for development data `[S]`

**Description:** Create `apps/api/prisma/seed.ts`. Seeds: 1 admin user (email: `admin@test.com`, password: `password123`), 100 credits, 1 sample completed book record (with mock data in JSONB fields). Run via `prisma db seed`.
**Deps:** TASK-014, TASK-042
**AC:** `pnpm --filter api prisma:seed` runs without error; test user can log in.
**Files:** `apps/api/prisma/seed.ts`, `apps/api/package.json`

---

## PHASE 3 — AI Providers Layer

**Goal:** Abstracted, testable wrappers for Anthropic, OpenAI, and fal.ai. Fallback chain wired.
**Deps:** Phase 0 complete (runs in parallel with Phase 1–2)
**Deliverable:** Each provider service has unit tests with mocked HTTP; fallback chain triggers on 500.

---

### TASK-046: Create base LLM provider interface `[S]`

**Description:** In `packages/types/src/ai.types.ts`, define: `LlmMessage` (`role`, `content`), `LlmRequest` (`model`, `messages`, `maxTokens`, `temperature`, `systemPrompt`), `LlmResponse` (`content`, `tokensUsed`, `model`, `costUsd`), `ILlmProvider` interface with `complete(req: LlmRequest): Promise<LlmResponse>`.
**Deps:** TASK-005
**AC:** Interface compiles; exported from `packages/types`.
**Files:** `packages/types/src/ai.types.ts`

---

### TASK-047: Implement Anthropic provider service `[M]`

**Description:** Create `apps/api/src/ai-providers/anthropic.service.ts`. Install `@anthropic-ai/sdk`. Implements `ILlmProvider`. Uses `claude-sonnet-4-6` as default. Handles: API key from env, request formatting, response parsing, token counting, cost calculation (`$3/M input, $15/M output` for Sonnet). Extracts text from content blocks.
**Deps:** TASK-046, TASK-007
**AC:** Unit test with mocked `@anthropic-ai/sdk`: valid request returns `LlmResponse` with correct `tokensUsed`.
**Files:** `apps/api/src/ai-providers/anthropic.service.ts`

---

### TASK-048: Implement Anthropic extended thinking support `[S]`

**Description:** Add `thinkingBudget?: number` to `LlmRequest`. In `AnthropicService.complete()`, if `thinkingBudget` is set, add `thinking: { type: "enabled", budget_tokens: thinkingBudget }` to the API call. Used exclusively by the Story Planner agent.
**Deps:** TASK-047
**AC:** Unit test: request with `thinkingBudget: 5000` includes the thinking block in API call params.
**Files:** `apps/api/src/ai-providers/anthropic.service.ts`

---

### TASK-049: Implement OpenAI provider service `[M]`

**Description:** Create `apps/api/src/ai-providers/openai.service.ts`. Install `openai`. Implements `ILlmProvider`. Uses `gpt-4o` as default. Handles API key, formatting, response parsing, cost calc. Also add `completeWithVision(messages, imageBase64): Promise<LlmResponse>` for the QA Review agent.
**Deps:** TASK-046, TASK-007
**AC:** Unit test with mocked `openai`: `complete()` and `completeWithVision()` return `LlmResponse`.
**Files:** `apps/api/src/ai-providers/openai.service.ts`

---

### TASK-050: Implement fal.ai image generation service `[M]`

**Description:** Create `apps/api/src/ai-providers/fal.service.ts`. Install `@fal-ai/client`. Methods: `generateImage(prompt: ImageGenerationRequest): Promise<ImageGenerationResult>`. `ImageGenerationRequest`: `positivePrompt`, `negativePrompt`, `width`, `height`, `seed?`, `numSteps`, `guidanceScale`. `ImageGenerationResult`: `imageUrl`, `seed`, `timingMs`. Uses `fal-ai/flux/dev` model.
**Deps:** TASK-007
**AC:** Unit test with mocked fal client: valid request returns `ImageGenerationResult` with `imageUrl`.
**Files:** `apps/api/src/ai-providers/fal.service.ts`

---

### TASK-051: Create LLM provider fallback chain `[M]`

**Description:** Create `apps/api/src/ai-providers/llm-router.service.ts`. Accepts an ordered list of `ILlmProvider` instances. `complete()` tries providers in order. On 429 or 5xx: logs the failure to `AgentLog`, waits `backoffMs`, tries next provider. On success: records which provider was used. Default chain: `[Anthropic, OpenAI]`.
**Deps:** TASK-047, TASK-049
**AC:** Unit test: when Anthropic returns 500, OpenAI is called; when both fail, throws `AllProvidersFailedError`.
**Files:** `apps/api/src/ai-providers/llm-router.service.ts`

---

### TASK-052: Create JSON extraction utility `[S]`

**Description:** Create `apps/api/src/common/utils/llm-json.ts`. Function `extractJson<T>(text: string, schema: ZodSchema<T>): T`. Handles: pure JSON response, JSON wrapped in markdown code block (` ```json ... ``` `), JSON embedded in prose (finds first `{` or `[`). Throws `JsonParseError` with the raw text if parse fails.
**Deps:** TASK-006
**AC:** Unit tests: parses all three formats correctly; throws on invalid JSON; validates against schema.
**Files:** `apps/api/src/common/utils/llm-json.ts`

---

### TASK-053: Add prompt caching headers to Anthropic requests `[S]`

**Description:** In `AnthropicService`, add support for `cache_control: { type: "ephemeral" }` on large, stable message blocks (system prompts over 1024 tokens). Add `cacheEnabled?: boolean` to `LlmRequest`. This triggers Anthropic's prompt caching, reducing token cost by ~40% for repeated large system prompts.
**Deps:** TASK-047
**AC:** When `cacheEnabled: true`, the API request includes `cache_control` on the system prompt block.
**Files:** `apps/api/src/ai-providers/anthropic.service.ts`

---

### TASK-054: Create AI providers NestJS module `[S]`

**Description:** Create `apps/api/src/ai-providers/ai-providers.module.ts`. Registers `AnthropicService`, `OpenAiService`, `FalService`, `LlmRouterService` as providers. Export all for injection by agent modules. Register as global.
**Deps:** TASK-047, TASK-049, TASK-050, TASK-051
**AC:** Any NestJS module can inject `AnthropicService` by declaring `AiProvidersModule` in imports.
**Files:** `apps/api/src/ai-providers/ai-providers.module.ts`

---

## PHASE 4 — Agent System: Core Infrastructure

**Goal:** Base agent class, queue processors, orchestrator state machine. No agent logic yet.
**Deps:** Phase 2, Phase 3
**Deliverable:** A dummy test agent can receive a job, process it, update book status in DB, and emit progress via WebSocket.

---

### TASK-055: Create base agent abstract class `[M]`

**Description:** Create `apps/api/src/agents/base.agent.ts`. Abstract class `BaseAgent<TInput, TOutput>` with: `abstract name: AgentStep`, `abstract run(input: TInput, context: AgentContext): Promise<TOutput>`. `AgentContext`: `{ bookId, userId, traceId }`. Wraps `run()` with: timing measurement, token cost logging to `AgentLogRepository`, error catching, retry signaling.
**Deps:** TASK-041, TASK-005
**AC:** A concrete subclass can be instantiated; `run()` automatically logs to `agent_logs` table on completion.
**Files:** `apps/api/src/agents/base.agent.ts`, `apps/api/src/agents/agent-context.types.ts`

---

### TASK-056: Create queue processor base class `[M]`

**Description:** Create `apps/api/src/agents/base-processor.ts`. Extends NestJS `WorkerHost`. `process(job: Job<AgentJob>)` method: extracts `bookId` + `traceId`, updates book status to current step, calls the agent's `run()`, stores output in DB, enqueues next step job. On failure: increments `retry_count`, updates status to `failed` after max retries.
**Deps:** TASK-055, TASK-012, TASK-037
**AC:** Unit test: successful job updates book status; failed job after 3 retries sets status to `failed`.
**Files:** `apps/api/src/agents/base-processor.ts`

---

### TASK-057: Create book orchestrator service `[M]`

**Description:** Create `apps/api/src/orchestrator/orchestrator.service.ts`. Method `startBook(bookId)`: validates book is in `created` state, enqueues first job (`char:build`). Method `advance(bookId, completedStep, output)`: determines next step(s) based on state machine, enqueues them. Method `handleFailure(bookId, step, error)`: decides retry vs. terminal failure.
**Deps:** TASK-056, TASK-037, TASK-012
**AC:** Unit test: `startBook()` enqueues exactly one `char:build` job; completing `char:build` enqueues one `story:plan` job.
**Files:** `apps/api/src/orchestrator/orchestrator.service.ts`, `apps/api/src/orchestrator/orchestrator.module.ts`

---

### TASK-058: Implement state machine transitions `[M]`

**Description:** Create `apps/api/src/orchestrator/state-machine.ts`. Pure function `getNextJobs(completedStep: AgentStep, bookId: string, context: BookContext): AgentJob[]`. Encodes all valid transitions from the architecture state machine. Chapter writing fans out to N parallel jobs. Image generation fans out to M parallel jobs. Completing all images triggers QA.
**Deps:** TASK-057, TASK-005
**AC:** Unit tests cover every transition; all fan-out steps produce the correct number of jobs.
**Files:** `apps/api/src/orchestrator/state-machine.ts`

---

### TASK-059: Create fan-in completion tracker `[M]`

**Description:** Create `apps/api/src/orchestrator/completion-tracker.ts`. Uses Redis to track parallel job completion. `recordComplete(bookId, step, unitId)`: increments a counter. `isStepComplete(bookId, step, totalUnits): Promise<boolean>`: returns true when counter reaches `totalUnits`. Uses `INCR` for atomicity. TTL: 24h.
**Deps:** TASK-011
**AC:** Unit test: with 4 chapters, `isStepComplete` returns false after 3, true after 4th `recordComplete` call. Concurrent calls are safe.
**Files:** `apps/api/src/orchestrator/completion-tracker.ts`

---

### TASK-060: Create WebSocket gateway for progress events `[M]`

**Description:** Create `apps/api/src/ws/ws.gateway.ts` using `@nestjs/websockets` and `socket.io`. On connect: authenticate via JWT query param, join room `book:{bookId}`. Method `sendProgress(bookId, event: WsProgressEvent)`. Expose as injectable service so orchestrator can call it.
**Deps:** TASK-032
**AC:** Client connects with valid JWT; emitting `sendProgress` sends event only to that book's room.
**Files:** `apps/api/src/ws/ws.gateway.ts`, `apps/api/src/ws/ws.module.ts`

---

### TASK-061: Wire progress events into base processor `[S]`

**Description:** Inject `WsGateway` into `BaseProcessor`. After each successful agent completion, call `wsGateway.sendProgress(bookId, { type: "book:progress", step, percentComplete })`. On final step completion, send `{ type: "book:complete", result }`. On failure, send `{ type: "book:error", error }`.
**Deps:** TASK-056, TASK-060
**AC:** Integration test: submitting a book and running a mock agent emits the correct WebSocket event.
**Files:** `apps/api/src/agents/base-processor.ts`

---

### TASK-062: Implement graceful worker shutdown `[S]`

**Description:** In `apps/api/src/main.ts`, on `SIGTERM`: stop accepting new jobs (`worker.pause()`), wait for in-flight jobs to complete (max 30s), then `process.exit(0)`. This prevents data corruption when Kubernetes scales down a pod.
**Deps:** TASK-056
**AC:** Sending SIGTERM with an in-flight job waits for completion before exit; logs "graceful shutdown complete".
**Files:** `apps/api/src/main.ts`

---

### TASK-063: Create dead letter queue handler `[S]`

**Description:** Create `apps/api/src/queue/dlq.handler.ts`. Processes jobs from the `dlq:failed` queue. On receipt: logs structured error, sends internal Slack/email alert (stub — just logs for now), ensures book status is `failed` in DB, triggers credit refund via `CreditRepository`.
**Deps:** TASK-056, TASK-042
**AC:** A job moved to DLQ triggers the handler; book status in DB is set to `failed`.
**Files:** `apps/api/src/queue/dlq.handler.ts`

---

### TASK-064: Add job progress reporting from workers `[S]`

**Description:** In `BaseProcessor`, during long-running agents, report BullMQ job progress with `job.updateProgress(percent)`. The WsGateway listens to `Queue#progress` events and forwards to the client room. This gives sub-step granularity for chapter writing (e.g., 25% through chapter).
**Deps:** TASK-061
**AC:** A mock agent calling `job.updateProgress(50)` results in a WebSocket event with `percentComplete: 50` being received by the client.
**Files:** `apps/api/src/agents/base-processor.ts`, `apps/api/src/ws/ws.gateway.ts`

---

## PHASE 5 — Individual Agent Implementations

**Goal:** All 9 agents fully implemented with prompts, validation, and unit tests.
**Deps:** Phase 3, Phase 4
**Deliverable:** Each agent can be called in isolation with a fixture input and produces valid output matching its output schema.

---

### TASK-065: Implement Character Builder Agent — prompt template `[M]`

**Description:** Create `apps/api/src/agents/char-builder/char-builder.prompts.ts`. Write the system prompt template from the architecture document. Include a variable `buildCharBuilderPrompt(request: BookRequest): string` that interpolates all child profile fields. The prompt instructs the model to return only valid JSON matching `CharacterCard`.
**Deps:** TASK-055, TASK-005
**AC:** The generated prompt includes the child's name, age, appearance, and personality; snapshot test locks the output.
**Files:** `apps/api/src/agents/char-builder/char-builder.prompts.ts`

---

### TASK-066: Implement Character Builder Agent — core logic `[M]`

**Description:** Create `apps/api/src/agents/char-builder/char-builder.agent.ts`. Extends `BaseAgent<BookRequest, CharacterCard>`. Calls `LlmRouterService` with the prompt, extracts JSON using `extractJson<CharacterCard>()`, validates against `CharacterCard` Zod schema. The `visualAnchor` field is the most critical output — must be a single descriptive sentence.
**Deps:** TASK-065, TASK-052, TASK-051
**AC:** Unit test with mocked LLM: valid `CharacterCard` is returned; invalid JSON from LLM throws `JsonParseError`.
**Files:** `apps/api/src/agents/char-builder/char-builder.agent.ts`

---

### TASK-067: Implement Character Builder Agent — queue processor `[S]`

**Description:** Create `apps/api/src/agents/char-builder/char-builder.processor.ts`. Extends `BaseProcessor`. Processes `agent:char-build` queue. On completion: stores `CharacterCard` in `books.character_card`, caches in Redis (`book:{bookId}:character_card`, TTL 2h), also creates a `CharacterCard` record in the `character_cards` table.
**Deps:** TASK-066, TASK-056, TASK-039
**AC:** Integration test: job processed → `books.character_card` populated → Redis key set.
**Files:** `apps/api/src/agents/char-builder/char-builder.processor.ts`, `apps/api/src/agents/char-builder/char-builder.module.ts`

---

### TASK-068: Implement Story Planner Agent — prompt template `[M]`

**Description:** Create `apps/api/src/agents/story-planner/story-planner.prompts.ts`. Write the system prompt (from architecture doc) with all template variables. The prompt must: emphasize three-act structure, embed the educational goal organically, request exactly `bookLength / 2` chapter outlines, and require `illustrableScenes` for every page. Enable `cacheEnabled: true` on the system prompt.
**Deps:** TASK-065
**AC:** Snapshot test passes; prompt includes character card, educational goal, and genre.
**Files:** `apps/api/src/agents/story-planner/story-planner.prompts.ts`

---

### TASK-069: Implement Story Planner Agent — core logic `[M]`

**Description:** Create `apps/api/src/agents/story-planner/story-planner.agent.ts`. Uses Claude Opus with `thinkingBudget: 5000`. Validates output against `StoryPlan` Zod schema. Post-processing: verifies `chapters.length` matches `bookLength / 8` (8 pages per chapter), verifies `illustrableScenes.length` equals `bookLength`.
**Deps:** TASK-068, TASK-048, TASK-052
**AC:** Unit test: output has correct chapter count; post-processing detects mismatched scene count.
**Files:** `apps/api/src/agents/story-planner/story-planner.agent.ts`

---

### TASK-070: Implement Story Planner Agent — queue processor `[S]`

**Description:** Create `apps/api/src/agents/story-planner/story-planner.processor.ts`. Reads `CharacterCard` from Redis (fallback: DB). Stores `StoryPlan` in `books.story_plan`. Caches in Redis. Reports title to WsGateway as a `page:ready`-style event so the frontend can show it early.
**Deps:** TASK-069, TASK-056
**AC:** Integration test: processor reads character card from Redis, stores story plan in DB.
**Files:** `apps/api/src/agents/story-planner/story-planner.processor.ts`, `apps/api/src/agents/story-planner/story-planner.module.ts`

---

### TASK-071: Implement Chapter Writer Agent — prompt template `[M]`

**Description:** Create `apps/api/src/agents/chapter-writer/chapter-writer.prompts.ts`. Template function `buildChapterWriterPrompt(chapter: ChapterOutline, characterCard: CharacterCard, storyPlan: StoryPlan, prevSummary: string, language: string, gradeLevel: number): string`. The prompt enforces: reading level, `wordsPerPage` limit, `illustrationNote` per page, and language.
**Deps:** TASK-068
**AC:** Snapshot test; prompt includes character card, chapter outline, and previous chapter summary.
**Files:** `apps/api/src/agents/chapter-writer/chapter-writer.prompts.ts`

---

### TASK-072: Implement Chapter Writer Agent — reading level validator `[S]`

**Description:** Create `apps/api/src/agents/chapter-writer/reading-level.ts`. Install `text-readability`. Function `validateReadingLevel(text: string, targetGrade: number): { grade: number, passed: boolean, suggestion: string }`. Calculates Flesch-Kincaid grade level. If `grade > targetGrade + 1.5`, returns failed with a simplification suggestion injected back to the LLM.
**Deps:** TASK-006
**AC:** Unit tests: grade-3 text passes for age-7 target; grade-6 text fails; suggestion includes "use shorter sentences".
**Files:** `apps/api/src/agents/chapter-writer/reading-level.ts`

---

### TASK-073: Implement Chapter Writer Agent — core logic `[M]`

**Description:** Create `apps/api/src/agents/chapter-writer/chapter-writer.agent.ts`. Generates one chapter. Post-processing: (1) validate reading level, if failed → re-call with simplification feedback (max 1 retry); (2) check each page has `illustrationNote`; (3) check `wordCount` per page ≤ target. Returns `Chapter`.
**Deps:** TASK-071, TASK-072, TASK-052
**AC:** Unit test: chapter with overly complex text triggers simplification retry; final output validates against `Chapter` schema.
**Files:** `apps/api/src/agents/chapter-writer/chapter-writer.agent.ts`

---

### TASK-074: Implement Chapter Writer Agent — chapter summarizer `[S]`

**Description:** Add `summarizeChapter(chapter: Chapter): Promise<string>` method to `ChapterWriterAgent`. Uses a short Anthropic call (Haiku) to produce a ~200-token summary of the chapter for use as context in the next chapter. Cost: ~$0.0003/chapter.
**Deps:** TASK-073
**AC:** Unit test: summary is ≤200 tokens; contains key events from the chapter.
**Files:** `apps/api/src/agents/chapter-writer/chapter-writer.agent.ts`

---

### TASK-075: Implement Chapter Writer Agent — queue processor `[M]`

**Description:** Create `apps/api/src/agents/chapter-writer/chapter-writer.processor.ts`. Reads `StoryPlan` and `CharacterCard` from Redis. Gets previous chapter summary from DB (if chapter > 1). Stores chapter in `books.chapters` (append to JSONB array). Creates `BookPage` records for each page. Calls `completion-tracker` to detect when all chapters are done.
**Deps:** TASK-073, TASK-074, TASK-056, TASK-059, TASK-038
**AC:** Integration test: 4 chapter jobs complete → `isStepComplete` returns true → next step enqueued.
**Files:** `apps/api/src/agents/chapter-writer/chapter-writer.processor.ts`, `apps/api/src/agents/chapter-writer/chapter-writer.module.ts`

---

### TASK-076: Implement Illustration Prompt Generator — prompt template `[M]`

**Description:** Create `apps/api/src/agents/illust-prompt-gen/illust-prompt-gen.prompts.ts`. Template function taking `page: Page`, `characterCard: CharacterCard`, `illustrationStyle: IllustrationStyle`, `colorPalette: string[]`. Must produce structured `ImagePrompt` with `positivePrompt` ≤200 words, `negativePrompt` ≤50 words, and explicit `aspectRatio`, `mood`, `colorPalette` fields.
**Deps:** TASK-071
**AC:** Snapshot test; prompt includes style tokens, character visual anchor, and page illustration note.
**Files:** `apps/api/src/agents/illust-prompt-gen/illust-prompt-gen.prompts.ts`

---

### TASK-077: Implement Illustration Prompt Generator — core logic `[S]`

**Description:** Create `apps/api/src/agents/illust-prompt-gen/illust-prompt-gen.agent.ts`. Lightweight: calls LLM (Sonnet), extracts JSON, validates against `ImagePrompt` schema. One call per page. Very short — the prompt template does the heavy lifting.
**Deps:** TASK-076, TASK-052
**AC:** Unit test: page text about "running through a forest" produces a prompt mentioning trees and movement.
**Files:** `apps/api/src/agents/illust-prompt-gen/illust-prompt-gen.agent.ts`

---

### TASK-078: Implement Illustration Prompt Generator — queue processor `[S]`

**Description:** Create `apps/api/src/agents/illust-prompt-gen/illust-prompt-gen.processor.ts`. Processes `agent:illust-prompt` queue (one job per page). Stores `ImagePrompt` in the corresponding `BookPage.image_prompt`. Uses completion tracker. When all pages done → enqueues single `agent:char-consistency` job.
**Deps:** TASK-077, TASK-056, TASK-059
**AC:** Integration test: all prompts stored; single consistency job enqueued after all complete.
**Files:** `apps/api/src/agents/illust-prompt-gen/illust-prompt-gen.processor.ts`, `apps/api/src/agents/illust-prompt-gen/illust-prompt-gen.module.ts`

---

### TASK-079: Implement Character Consistency Agent — cross-prompt audit `[M]`

**Description:** Create `apps/api/src/agents/char-consistency/char-consistency.agent.ts`. Receives all `ImagePrompt[]` + `CharacterCard.visualAnchor`. Step 1: scan all prompts for appearance contradictions (hair color, eye color, clothing) using an LLM call with all prompts in context. Step 2: inject `visualAnchor` as prefix to every prompt. Step 3: normalize style tokens across all prompts.
**Deps:** TASK-077, TASK-052
**AC:** Unit test: a prompt with "blonde hair" when character has "red hair" is corrected; all prompts have `visualAnchor` prepended.
**Files:** `apps/api/src/agents/char-consistency/char-consistency.agent.ts`

---

### TASK-080: Implement Character Consistency Agent — queue processor `[S]`

**Description:** Create `apps/api/src/agents/char-consistency/char-consistency.processor.ts`. Reads all `BookPage.image_prompt` records for the book. Passes to agent. Writes enriched prompts back to each `BookPage`. Enqueues N `agent:image-gen` jobs (one per page).
**Deps:** TASK-079, TASK-056, TASK-038
**AC:** Integration test: after processing, all `BookPage.image_prompt` fields contain the `visualAnchor` prefix.
**Files:** `apps/api/src/agents/char-consistency/char-consistency.processor.ts`, `apps/api/src/agents/char-consistency/char-consistency.module.ts`

---

### TASK-081: Implement Image Generation Agent — core logic `[M]`

**Description:** Create `apps/api/src/agents/image-gen/image-gen.agent.ts`. Takes `ImagePrompt`, calls `FalService.generateImage()`. Downloads the resulting image buffer. Uploads to R2 via `StorageService` using `pageImageKey()`. Returns `GeneratedImage` with `r2Key`, `url`, `seed`, `model`.
**Deps:** TASK-050, TASK-043, TASK-044
**AC:** Unit test with mocked fal + StorageService: returns `GeneratedImage` with correct R2 key.
**Files:** `apps/api/src/agents/image-gen/image-gen.agent.ts`

---

### TASK-082: Implement Image Generation Agent — queue processor `[S]`

**Description:** Create `apps/api/src/agents/image-gen/image-gen.processor.ts`. Applies BullMQ rate limiting (50 req/60s globally). Stores `GeneratedImage` in `BookPage`. Sends `page:ready` WebSocket event with `pageImageUrl`. Uses completion tracker. When all images done → enqueues N `agent:qa-review` jobs.
**Deps:** TASK-081, TASK-056, TASK-059, TASK-060
**AC:** Integration test: `page:ready` event emitted with correct URL; rate limiter tested with 51 jobs.
**Files:** `apps/api/src/agents/image-gen/image-gen.processor.ts`, `apps/api/src/agents/image-gen/image-gen.module.ts`

---

### TASK-083: Implement Quality Review Agent — prompt + vision call `[M]`

**Description:** Create `apps/api/src/agents/qa-review/qa-review.agent.ts`. Downloads image from R2 as base64. Calls `OpenAiService.completeWithVision()` with the page text and image. Structured output: `QualityReport` with scores (0–1) for `consistency`, `alignment`, `safety`, and a recommended `action`.
**Deps:** TASK-049, TASK-043
**AC:** Unit test: image showing wrong hair color produces `consistency < 0.5`; adult content in image produces `action: "regen_image"`.
**Files:** `apps/api/src/agents/qa-review/qa-review.agent.ts`

---

### TASK-084: Implement Quality Review Agent — queue processor + regen loop `[M]`

**Description:** Create `apps/api/src/agents/qa-review/qa-review.processor.ts`. Processes QA for one page. On `pass`: stores report in `BookPage.qa_passed = true`. On `regen_image`: increments `regen_count`, re-enqueues `agent:image-gen` with same prompt + new seed (seed + 1000). On `regen_text`: re-enqueues `agent:chapter-write` for that page only. Hard limit: 3 regen cycles per page; after 3rd failure, `pass` anyway and flag for human review.
**Deps:** TASK-083, TASK-056, TASK-038
**AC:** Unit test: a failing QA report with `regen_count < 3` re-enqueues image-gen; after 3rd failure, page is marked passed.
**Files:** `apps/api/src/agents/qa-review/qa-review.processor.ts`, `apps/api/src/agents/qa-review/qa-review.module.ts`

---

### TASK-085: Implement Layout Agent — template system `[M]`

**Description:** Create `apps/api/src/agents/layout/layout-templates.ts`. Define 5 templates as typed objects: `COVER`, `CHAPTER_START`, `BODY_TEXT_LEFT`, `BODY_FULL_IMAGE`, `ENDING`. Each template specifies: text block positions/sizes, image frame, font size (keyed by age group), background color strategy.
**Deps:** TASK-005
**AC:** Each template object validates against a `LayoutTemplate` Zod schema.
**Files:** `apps/api/src/agents/layout/layout-templates.ts`

---

### TASK-086: Implement Layout Agent — typography rules `[S]`

**Description:** Create `apps/api/src/agents/layout/typography.ts`. Function `getFontSpec(age: number, language: string): FontSpec`. Returns `{ family, size, lineHeight, letterSpacing }`. Rules: age 3–5 → 28pt, age 6–8 → 22pt, age 9–12 → 16pt. RTL languages get `direction: "rtl"`.
**Deps:** TASK-085
**AC:** Unit tests cover all age brackets and RTL case.
**Files:** `apps/api/src/agents/layout/typography.ts`

---

### TASK-087: Implement Layout Agent — core logic `[M]`

**Description:** Create `apps/api/src/agents/layout/layout.agent.ts`. No LLM needed — pure deterministic logic. For each page: select template based on page type (cover / chapter-start / body / ending), apply typography, calculate text block overflow (if text too long, reduce font size by 2pt, max 3 reductions), produce `PageLayout`.
**Deps:** TASK-085, TASK-086
**AC:** Unit test: 50-word page text fits in the layout; 200-word page text triggers font reduction.
**Files:** `apps/api/src/agents/layout/layout.agent.ts`

---

### TASK-088: Implement Layout Agent — queue processor `[S]`

**Description:** Create `apps/api/src/agents/layout/layout.processor.ts`. Reads all `BookPage` records with approved images. Runs layout agent for each. Stores `PageLayout` in `BookPage.layout_spec`. When all done → enqueues single `agent:pdf-render` job.
**Deps:** TASK-087, TASK-056, TASK-038
**AC:** Integration test: all pages have `layout_spec` populated after processing.
**Files:** `apps/api/src/agents/layout/layout.processor.ts`, `apps/api/src/agents/layout/layout.module.ts`

---

### TASK-089: Implement PDF Generator Agent — PDFKit renderer `[L]`

**Description:** Create `apps/api/src/agents/pdf-gen/pdf-gen.agent.ts`. Install `pdfkit`. Iterates `PageLayout[]`. For each page: download image from R2, embed in PDF at specified position, render text blocks with correct font/size/position, add page decorations. Cover page: full-bleed image + title overlay. Outputs a PDF buffer.
**Deps:** TASK-087, TASK-043
**AC:** Integration test with fixture layouts: generates a valid PDF; `pdfinfo` shows correct page count and dimensions (A5 210×148mm).
**Files:** `apps/api/src/agents/pdf-gen/pdf-gen.agent.ts`

---

### TASK-090: Implement PDF Generator Agent — queue processor `[M]`

**Description:** Create `apps/api/src/agents/pdf-gen/pdf-gen.processor.ts`. Calls `PdfGenAgent.generate()`. Uploads PDF to R2 using `bookPdfKey()`. Generates a preview PDF (first 3 pages, watermarked "PREVIEW") and uploads to `bookPreviewPdfKey()`. Updates `books.pdf_r2_key`, `books.pdf_url`, `books.status = "complete"`. Sends `book:complete` WebSocket event.
**Deps:** TASK-089, TASK-056, TASK-037, TASK-060
**AC:** Integration test: book status = "complete"; PDF URL is a valid signed R2 URL; `book:complete` WS event emitted.
**Files:** `apps/api/src/agents/pdf-gen/pdf-gen.processor.ts`, `apps/api/src/agents/pdf-gen/pdf-gen.module.ts`

---

### TASK-091: Create AgentsModule aggregating all agent modules `[S]`

**Description:** Create `apps/api/src/agents/agents.module.ts`. Imports all 9 agent modules. This single import is what `AppModule` uses to register the entire agent system.
**Deps:** TASK-067, TASK-070, TASK-075, TASK-078, TASK-080, TASK-082, TASK-084, TASK-088, TASK-090
**AC:** App starts without "unknown provider" errors; all queues have active workers.
**Files:** `apps/api/src/agents/agents.module.ts`

---

## PHASE 6 — Book API & WebSocket Endpoints

**Goal:** Full REST API for book creation, status polling, regeneration, and downloads.
**Deps:** Phase 4, Phase 5
**Deliverable:** Can create a book via `POST /api/books`, poll status, and receive WebSocket progress events.

---

### TASK-092: Create book creation DTO + validation `[S]`

**Description:** Create `apps/api/src/modules/books/dto/create-book.dto.ts`. Mirrors `BookRequest` from `packages/types` but uses `class-validator` decorators. Validates: `age` 2–12, `bookLength` is one of `[8, 16, 24, 32]`, `language` is a valid BCP-47 code (whitelist of 20 supported languages), all arrays within max-length limits.
**Deps:** TASK-016, TASK-005
**AC:** Invalid `age: 15` returns 400; invalid `language: "xx"` returns 400.
**Files:** `apps/api/src/modules/books/dto/create-book.dto.ts`

---

### TASK-093: Create content safety validator `[M]`

**Description:** Create `apps/api/src/common/validators/content-safety.ts`. Checks `BookRequest` fields for: profanity in child name or description (word blocklist), prompt injection patterns (e.g., "ignore previous instructions"), PII in free-text fields (credit card numbers, SSNs). Throws `BadRequestException` with a safe error message.
**Deps:** TASK-006
**AC:** Unit tests: clean input passes; name containing slur is rejected; "ignore previous instructions" in `educationalGoal` is rejected.
**Files:** `apps/api/src/common/validators/content-safety.ts`

---

### TASK-094: Implement BooksService — create book `[M]`

**Description:** Create `apps/api/src/modules/books/books.service.ts`. `createBook(userId, dto)` method: (1) check user has ≥1 credit, (2) run `contentSafetyValidator`, (3) create `Book` record in DB, (4) deduct credit, (5) call `OrchestratorService.startBook()`. Returns `{ bookId, estimatedMinutes, creditsCharged, wsChannel }`.
**Deps:** TASK-037, TASK-042, TASK-057, TASK-093
**AC:** Unit test: user with 0 credits gets `PaymentRequiredException`; content violation gets `BadRequestException`; success returns bookId.
**Files:** `apps/api/src/modules/books/books.service.ts`

---

### TASK-095: Implement BooksService — status + list `[S]`

**Description:** Add `getBook(userId, bookId): Promise<BookStatusResponse>` and `listBooks(userId, pagination)` to `BooksService`. `getBook` checks ownership (throws 404 if not owner). Returns status, progress calculation (step index / total steps * 100), and result if complete.
**Deps:** TASK-037
**AC:** User A cannot see User B's book (404); completed book returns `pdfUrl` in response.
**Files:** `apps/api/src/modules/books/books.service.ts`

---

### TASK-096: Implement BooksService — partial regeneration `[M]`

**Description:** Add `regenPageImage(userId, bookId, pageNumber)`, `regenPageText(userId, bookId, pageNumber)` to `BooksService`. Each: validates ownership, validates page exists and is in complete state, increments regen counter, enqueues the appropriate job directly (bypassing orchestrator state machine).
**Deps:** TASK-037, TASK-038, TASK-012
**AC:** Unit test: regen enqueues correct job type; page that's already regenerating 3× throws `MaxRegenerationError`.
**Files:** `apps/api/src/modules/books/books.service.ts`

---

### TASK-097: Create BooksController `[M]`

**Description:** Create `apps/api/src/modules/books/books.controller.ts`. Endpoints: `POST /api/books`, `GET /api/books`, `GET /api/books/:id`, `DELETE /api/books/:id`, `PATCH /api/books/:id/pages/:n/regen-image`, `PATCH /api/books/:id/pages/:n/regen-text`, `GET /api/books/:id/download/pdf`. All protected by `JwtAuthGuard`. `download/pdf` calls `StorageService.getSignedUrl()`.
**Deps:** TASK-094, TASK-095, TASK-096, TASK-043, TASK-032
**AC:** `POST /api/books` with valid body + auth returns 201 with `bookId`; unauthenticated returns 401.
**Files:** `apps/api/src/modules/books/books.controller.ts`, `apps/api/src/modules/books/books.module.ts`

---

### TASK-098: Create CharactersController `[S]`

**Description:** Create `apps/api/src/modules/characters/characters.controller.ts`. Endpoints: `GET /api/characters`, `GET /api/characters/:id`, `DELETE /api/characters/:id`. No create endpoint — characters are created implicitly by the char-build agent.
**Deps:** TASK-039, TASK-032
**AC:** User can list and delete their characters; cannot access another user's character.
**Files:** `apps/api/src/modules/characters/characters.controller.ts`, `apps/api/src/modules/characters/characters.module.ts`

---

### TASK-099: Create SeriesController `[S]`

**Description:** Create `apps/api/src/modules/series/series.controller.ts`. Endpoints: `POST /api/series`, `GET /api/series`, `GET /api/series/:id`, `DELETE /api/series/:id`, `POST /api/series/:id/books` (adds a book, inheriting the series' `characterCardId`).
**Deps:** TASK-040, TASK-032
**AC:** Creating a series returns `seriesId`; adding a book to a series stores the `characterCardId` reference on the new book request.
**Files:** `apps/api/src/modules/series/series.controller.ts`, `apps/api/src/modules/series/series.module.ts`

---

### TASK-100: Create CreditsController `[S]`

**Description:** Create `apps/api/src/modules/credits/credits.controller.ts`. Endpoints: `GET /api/credits/balance`, `GET /api/credits/transactions` (paginated). Balance endpoint hits Redis cache (`user:{userId}:credits`, 60s TTL) before DB.
**Deps:** TASK-042, TASK-011, TASK-032
**AC:** Balance is correct; cache invalidation triggered after `deduct()`; transactions paginate correctly.
**Files:** `apps/api/src/modules/credits/credits.controller.ts`, `apps/api/src/modules/credits/credits.module.ts`

---

### TASK-101: Write integration tests for books API `[L]`

**Description:** Full E2E flow test using `supertest` + real DB + mocked BullMQ (don't actually run agents): register user → create book → poll status → verify credit deducted → simulate completion → fetch download URL. Also test: insufficient credits → 402, content safety violation → 400, regen endpoint.
**Deps:** TASK-097, TASK-094
**AC:** All 8 test cases pass; no DB state leakage.
**Files:** `apps/api/test/books.e2e.spec.ts`

---

## PHASE 7 — Frontend Foundation

**Goal:** Next.js app with auth, design system, and routing skeleton.
**Deps:** Phase 1 (auth API), Phase 0 (Next.js scaffold)
**Deliverable:** Login/register pages working; authenticated routes protected; design system components documented.

---

### TASK-102: Create API client in Next.js `[M]`

**Description:** Create `apps/web/src/lib/api-client.ts`. Typed fetch wrapper using types from `packages/types`. Handles: base URL from `NEXT_PUBLIC_API_URL`, attaches `Authorization: Bearer {accessToken}` from memory store, auto-refreshes token on 401 (calls `/auth/refresh`), throws typed `ApiError` on non-2xx.
**Deps:** TASK-005, TASK-019
**AC:** Unit test: 401 response triggers refresh and retries original request; 403 throws `ApiError` with correct status.
**Files:** `apps/web/src/lib/api-client.ts`

---

### TASK-103: Create auth store (Zustand) `[S]`

**Description:** Create `apps/web/src/stores/auth.store.ts`. State: `user: User | null`, `accessToken: string | null`, `isLoading: boolean`. Actions: `login()`, `register()`, `logout()`, `refreshSession()`. Access token in memory only (not localStorage).
**Deps:** TASK-102
**AC:** After `login()`, `auth.user` populated; after `logout()`, null; page reload triggers `refreshSession()`.
**Files:** `apps/web/src/stores/auth.store.ts`

---

### TASK-104: Create AuthProvider and session hydration `[S]`

**Description:** Create `apps/web/src/components/providers/AuthProvider.tsx`. On mount calls `refreshSession()` to restore session from HttpOnly cookie. Wraps app in root `layout.tsx`. Exposes `useAuth()` hook.
**Deps:** TASK-103
**AC:** Page reload on authenticated session restores `auth.user` without redirecting to login.
**Files:** `apps/web/src/components/providers/AuthProvider.tsx`, `apps/web/src/app/layout.tsx`

---

### TASK-105: Create protected route middleware `[S]`

**Description:** Create `apps/web/src/middleware.ts`. Redirects unauthenticated users from `/app/*` to `/login`. Redirects authenticated users from `/login` and `/register` to `/app/dashboard`. Checks refresh token cookie existence.
**Deps:** TASK-104
**AC:** Unauthenticated `GET /app/dashboard` → `/login`; authenticated `GET /login` → `/app/dashboard`.
**Files:** `apps/web/src/middleware.ts`

---

### TASK-106: Build UI component: Button `[S]`

**Description:** Create `apps/web/src/components/ui/Button.tsx`. Variants: `primary`, `secondary`, `ghost`, `danger`. Sizes: `sm`, `md`, `lg`. States: `loading` (spinner), `disabled`. Uses `cva` for variant management. Fully accessible.
**Deps:** TASK-020
**AC:** All variant/size/state combinations render; loading state shows spinner; `aria-busy` set correctly.
**Files:** `apps/web/src/components/ui/Button.tsx`

---

### TASK-107: Build UI components: Input, FormField `[S]`

**Description:** `Input.tsx` and `FormField.tsx`. `FormField` wraps input with label, error message, helper text. Supports `react-hook-form` via `register` prop. `aria-describedby` on error, `aria-invalid` on error state.
**Deps:** TASK-020
**AC:** Invalid field shows red border and error message below label.
**Files:** `apps/web/src/components/ui/Input.tsx`, `apps/web/src/components/ui/FormField.tsx`

---

### TASK-108: Build UI components: Select, Textarea, Checkbox `[S]`

**Description:** `Select.tsx` (custom styled, keyboard accessible), `Textarea.tsx` (auto-resize), `Checkbox.tsx` (custom styled). All compatible with `react-hook-form`.
**Deps:** TASK-107
**AC:** All three render and accept react-hook-form register prop without type errors.
**Files:** `apps/web/src/components/ui/Select.tsx`, `apps/web/src/components/ui/Textarea.tsx`, `apps/web/src/components/ui/Checkbox.tsx`

---

### TASK-109: Build UI components: Card, Badge, Spinner `[S]`

**Description:** `Card.tsx` (white, rounded, shadow, optional hover), `Badge.tsx` (colored pill for status), `Spinner.tsx` (animated in brand colors).
**Deps:** TASK-020
**AC:** Snapshot tests pass for all variants.
**Files:** `apps/web/src/components/ui/Card.tsx`, `apps/web/src/components/ui/Badge.tsx`, `apps/web/src/components/ui/Spinner.tsx`

---

### TASK-110: Build login page `[M]`

**Description:** Create `apps/web/src/app/(auth)/login/page.tsx`. Email + password form with `react-hook-form` + Zod. On submit calls `authStore.login()`. Inline API errors. Link to register. Static illustration SVG on the right.
**Deps:** TASK-103, TASK-106, TASK-107
**AC:** Valid credentials redirect to `/app/dashboard`; invalid credentials show error below form.
**Files:** `apps/web/src/app/(auth)/login/page.tsx`

---

### TASK-111: Build register page `[M]`

**Description:** Create `apps/web/src/app/(auth)/register/page.tsx`. Name, email, password, confirm-password. Zod validates password match and minimum complexity. On success: auto-login, redirect to `/app/dashboard`.
**Deps:** TASK-103, TASK-106, TASK-107
**AC:** Mismatched passwords show "Passwords do not match"; successful register lands on dashboard.
**Files:** `apps/web/src/app/(auth)/register/page.tsx`

---

### TASK-112: Build app shell layout `[M]`

**Description:** Create `apps/web/src/app/(app)/layout.tsx`. Sidebar (desktop) / bottom nav (mobile): Dashboard, My Books, Create Book, Account. User name and credit balance in sidebar footer. Responsive collapse to icon-only on tablet.
**Deps:** TASK-104, TASK-109
**AC:** Credit balance from `GET /api/credits/balance` shown; sidebar highlights active route.
**Files:** `apps/web/src/app/(app)/layout.tsx`, `apps/web/src/components/layout/Sidebar.tsx`

---

### TASK-113: Build dashboard home page `[S]`

**Description:** Create `apps/web/src/app/(app)/dashboard/page.tsx`. Shows: "Recent Books" grid (last 4 books with cover + status badge), "Quick Create" CTA, credit balance card, illustrated empty state.
**Deps:** TASK-112, TASK-109
**AC:** Empty state renders correctly; recent books show correct status badges.
**Files:** `apps/web/src/app/(app)/dashboard/page.tsx`

---

### TASK-114: Create WebSocket client hook `[M]`

**Description:** Create `apps/web/src/hooks/useBookProgress.ts`. Uses `socket.io-client`. Connects with auth token, subscribes to `book:{bookId}` room. Returns `{ progress, currentStep, latestPageUrl, isComplete, error }`. Auto-reconnects. Cleans up on unmount.
**Deps:** TASK-060, TASK-103
**AC:** Unit test with mocked socket: `book:progress` event updates state; `book:complete` sets `isComplete: true`.
**Files:** `apps/web/src/hooks/useBookProgress.ts`

---

## PHASE 8 — Book Creation Wizard

**Goal:** Multi-step form collects child profile, submits, shows live generation progress.
**Deps:** Phase 7
**Deliverable:** User completes wizard, submits, watches pages appear in real-time.

---

### TASK-115: Design wizard state (Zustand) `[S]`

**Description:** Create `apps/web/src/stores/wizard.store.ts`. State: current step (0–5), form data per step. Steps: (0) Child Profile, (1) Appearance, (2) Personality & Interests, (3) Story Settings, (4) Visual Style, (5) Review & Submit. Actions: `nextStep`, `prevStep`, `setStepData`, `reset`.
**Deps:** TASK-103
**AC:** `nextStep` past step 5 is no-op; step data persists across navigation.
**Files:** `apps/web/src/stores/wizard.store.ts`

---

### TASK-116: Build wizard container and step indicator `[M]`

**Description:** Create `apps/web/src/app/(app)/create/page.tsx` and `WizardContainer.tsx`. Renders current step component. Step progress indicator (numbered breadcrumbs). Framer Motion slide transition. Back/Next buttons.
**Deps:** TASK-115, TASK-106
**AC:** Next animates to next step; Back returns to previous; indicator reflects current step.
**Files:** `apps/web/src/app/(app)/create/page.tsx`, `apps/web/src/components/book-wizard/WizardContainer.tsx`

---

### TASK-117: Build wizard Step 0 — Child Profile `[M]`

**Description:** Create `ChildProfile.tsx`. Fields: Child's name (text, Unicode-safe), Age (stepper 2–12), Gender (3-option button group). Live preview: "Creating a story for **{name}**, age **{age}**". All fields required before Next.
**Deps:** TASK-116, TASK-107
**AC:** Name accepts Unicode; age stepper works; all fields required before Next enabled.
**Files:** `apps/web/src/components/book-wizard/steps/ChildProfile.tsx`

---

### TASK-118: Build wizard Step 1 — Appearance `[M]`

**Description:** Create `Appearance.tsx`. Fields: Hair color (color swatch grid), Hair style (icon grid), Eye color (swatches), Skin tone (illustrated swatches), Distinctive features (tag input, max 3). Live character silhouette preview updates with selections.
**Deps:** TASK-116, TASK-107
**AC:** Selecting hair color updates silhouette; tag input enforces 3-item limit.
**Files:** `apps/web/src/components/book-wizard/steps/Appearance.tsx`

---

### TASK-119: Build wizard Step 2 — Personality & Interests `[M]`

**Description:** Create `PersonalityInterests.tsx`. Personality traits (multi-select chips, max 5, predefined + custom), Favorite animals (tag input), Favorite colors (color swatches, max 3), Favorite toys (tag input), Hobbies (tag input, max 5).
**Deps:** TASK-116, TASK-108
**AC:** Selecting 6th personality trait is blocked with visual feedback; custom trait can be added.
**Files:** `apps/web/src/components/book-wizard/steps/PersonalityInterests.tsx`

---

### TASK-120: Build wizard Step 3 — Story Settings `[M]`

**Description:** Create `StorySettings.tsx`. Educational goal (textarea, 200 char, with suggested chips), Genre (illustrated card grid), Book length (visual selector: 8/16/24/32 pages with reading time estimate), Language (searchable dropdown, 20 languages).
**Deps:** TASK-116, TASK-107, TASK-108
**AC:** Language dropdown filters as typed; length selection shows reading time estimate.
**Files:** `apps/web/src/components/book-wizard/steps/StorySettings.tsx`

---

### TASK-121: Build wizard Step 4 — Visual Style `[M]`

**Description:** Create `VisualStyle.tsx`. Four illustration style cards with example images (Watercolor, Cartoon, Realistic, Minimalist). Color palette auto-populated from child's favorite colors, editable.
**Deps:** TASK-116
**AC:** Selecting style shows sample illustration; palette auto-populates from step 2 data.
**Files:** `apps/web/src/components/book-wizard/steps/VisualStyle.tsx`

---

### TASK-122: Build wizard Step 5 — Review & Submit `[M]`

**Description:** Create `ReviewSubmit.tsx`. Summary of all entered data. Credit cost display. "Create My Book" button. If 0 credits: shows "Buy Credits" CTA instead. On submit: calls `POST /api/books`, transitions to progress screen.
**Deps:** TASK-116, TASK-100
**AC:** All wizard data shown accurately; 0-credit state shows CTA; submit calls API and transitions.
**Files:** `apps/web/src/components/book-wizard/steps/ReviewSubmit.tsx`

---

### TASK-123: Build book generation progress screen `[L]`

**Description:** Create `GenerationProgress.tsx`. Uses `useBookProgress` hook. Shows animated progress bar, current step label, page thumbnails filling in as `page:ready` events arrive. On `book:complete`: celebration animation + "View Your Book" button.
**Deps:** TASK-114, TASK-116
**AC:** Progress bar advances per step; thumbnails appear as generated; completion shows confetti.
**Files:** `apps/web/src/components/book-wizard/GenerationProgress.tsx`

---

### TASK-124: Build error state and retry UI `[S]`

**Description:** In `GenerationProgress.tsx`, handle `book:error` WS event. Show: which step failed, friendly message, "Try Again" button (re-submits without going back to wizard), "Contact Support" link.
**Deps:** TASK-123
**AC:** `book:error` shows error state; "Try Again" re-submits with same wizard data.
**Files:** `apps/web/src/components/book-wizard/GenerationProgress.tsx`

---

## PHASE 9 — Book Library & Reader

**Goal:** Users browse books, read in-browser, and request page regeneration.
**Deps:** Phase 8
**Deliverable:** Library page, full-screen page-flip reader, regeneration modal.

---

### TASK-125: Build books library page `[M]`

**Description:** Create `apps/web/src/app/(app)/books/page.tsx`. Grid of book cards: cover thumbnail, title, child name, status badge, date. Infinite scroll with `useInfiniteQuery`. Filter by status. In-progress books show spinner with percent.
**Deps:** TASK-112, TASK-109
**AC:** Renders up to 20 books; scrolling loads more; in-progress shows live percent.
**Files:** `apps/web/src/app/(app)/books/page.tsx`

---

### TASK-126: Build book detail page `[M]`

**Description:** Create `apps/web/src/app/(app)/books/[id]/page.tsx`. Shows metadata, "Download PDF" button (fetches signed URL), "Read Online" CTA, page thumbnails strip, per-page "Regenerate" button.
**Deps:** TASK-097, TASK-112
**AC:** Download opens signed PDF URL in new tab; thumbnails load from CDN.
**Files:** `apps/web/src/app/(app)/books/[id]/page.tsx`

---

### TASK-127: Build in-browser book reader with page flip `[L]`

**Description:** Create `BookReader.tsx`. Full-screen. Double-spread on desktop, single page on mobile. Framer Motion page-flip animation. Keyboard arrow navigation. Touch swipe. Page counter "3 / 16".
**Deps:** TASK-126
**AC:** Animation plays smoothly; swipe works on touch; keyboard navigation works.
**Files:** `apps/web/src/components/book-reader/BookReader.tsx`, `apps/web/src/components/book-reader/BookPage.tsx`

---

### TASK-128: Build page regeneration modal `[M]`

**Description:** Create `RegenModal.tsx`. Options: "Regenerate Illustration", "Regenerate Text", "Regenerate Both". Shows credit cost. On confirm: calls PATCH endpoint, shows inline loading on that page, updates thumbnail on `page:ready` WS event.
**Deps:** TASK-096, TASK-114, TASK-127
**AC:** "Regenerate Illustration" calls correct PATCH endpoint; thumbnail updates on `page:ready` event.
**Files:** `apps/web/src/components/book-reader/RegenModal.tsx`

---

### TASK-129: Implement React PDF browser preview `[M]`

**Description:** Create `BookPreview.tsx` using `@react-pdf/renderer`. Reads `PageLayout[]` from book API. Renders live PDF preview in browser. Lower quality than server PDF; used as quick preview on book detail page.
**Deps:** TASK-097
**AC:** Preview renders for an 8-page book; text and images at correct positions.
**Files:** `apps/web/src/components/book-preview/BookPreview.tsx`

---

## PHASE 10 — Billing & Credits

**Goal:** Stripe credit purchases; deduction on book creation; refund on failure.
**Deps:** Phase 6 (credits API)
**Deliverable:** Buy credits via Stripe; balance updates; refund on book failure.

---

### TASK-130: Set up Stripe service in NestJS `[S]`

**Description:** Install `stripe`. Create `apps/api/src/modules/billing/stripe.service.ts`. Methods: `createCheckoutSession(userId, priceId): string` (returns URL), `constructWebhookEvent(payload, sig): Stripe.Event`.
**Deps:** TASK-007
**AC:** `createCheckoutSession` returns Stripe URL; webhook signature verification works with test secret.
**Files:** `apps/api/src/modules/billing/stripe.service.ts`

---

### TASK-131: Define credit packages `[XS]`

**Description:** Create `apps/api/src/modules/billing/credit-packages.ts`. Packages: `STARTER` (10 credits, $4.99), `PRO` (30 credits, $11.99), `BUNDLE` (100 credits, $29.99). Typed const with `priceId`, `credits`, `priceUsd`.
**Deps:** TASK-130
**AC:** All packages compile; valid Stripe test price IDs.
**Files:** `apps/api/src/modules/billing/credit-packages.ts`

---

### TASK-132: Implement checkout endpoint `[S]`

**Description:** `POST /api/billing/checkout`. Body: `{ packageId }`. Creates Stripe checkout session with `success_url`, `cancel_url`, and `userId` in metadata.
**Deps:** TASK-130, TASK-131, TASK-032
**AC:** Authenticated user gets valid Stripe URL; unauthenticated returns 401.
**Files:** `apps/api/src/modules/billing/billing.controller.ts`, `apps/api/src/modules/billing/billing.module.ts`

---

### TASK-133: Implement Stripe webhook handler `[M]`

**Description:** `POST /api/billing/webhook` (no auth guard, raw body, signature verified). Handles `checkout.session.completed`: adds credits via `CreditRepository`, invalidates Redis credit cache. Idempotency check on `stripe_session_id`.
**Deps:** TASK-130, TASK-042
**AC:** Test webhook adds credits; duplicate event is ignored.
**Files:** `apps/api/src/modules/billing/billing.controller.ts`

---

### TASK-134: Build pricing / buy credits page `[M]`

**Description:** Create `apps/web/src/app/(app)/credits/page.tsx`. Current balance, transaction history, three credit package cards. "Buy" redirects to Stripe test checkout. Success page shows "Credits added!" and updated balance.
**Deps:** TASK-132, TASK-100
**AC:** Clicking "Buy" redirects to Stripe; after payment, credits balance increases.
**Files:** `apps/web/src/app/(app)/credits/page.tsx`, `apps/web/src/app/(app)/credits/success/page.tsx`

---

### TASK-135: Automatic credit refund on book failure `[S]`

**Description:** In `DlqHandler`, after `failed` status confirmed: `CreditRepository.add(userId, 1, 'refund', bookId)`. Log email notification body. Set user-friendly `error_message` on book record.
**Deps:** TASK-063, TASK-042
**AC:** Failed book triggers refund in `credit_transactions`; book has `error_message` set.
**Files:** `apps/api/src/queue/dlq.handler.ts`

---

## PHASE 11 — Observability & Monitoring

**Goal:** Distributed tracing, structured logging, cost and performance dashboards.
**Deps:** Phase 5 complete
**Deliverable:** Grafana dashboard shows book generation time, cost per book, error rates.

---

### TASK-136: Install and configure OpenTelemetry SDK `[M]`

**Description:** Install `@opentelemetry/sdk-node`, auto-instrumentations, OTLP exporter. Create `apps/api/src/tracing.ts`. Initialize before app bootstrap. Auto-instruments HTTP, Express, Prisma, Redis, BullMQ. Export to Jaeger (dev) / Grafana Tempo (prod).
**Deps:** TASK-006
**AC:** `POST /api/books` request appears in Jaeger with spans for DB queries and queue enqueue.
**Files:** `apps/api/src/tracing.ts`, `apps/api/src/main.ts`

---

### TASK-137: Add trace propagation through BullMQ jobs `[S]`

**Description:** In orchestrator + `BaseProcessor`, extract W3C TraceContext and store in `AgentJob.traceId`. In `BaseProcessor.process()`, restore span from stored context. Links all agent spans to the originating book creation request span.
**Deps:** TASK-136, TASK-056
**AC:** Jaeger trace for a book shows all agent spans as children of the original API span.
**Files:** `apps/api/src/agents/base-processor.ts`, `apps/api/src/orchestrator/orchestrator.service.ts`

---

### TASK-138: Implement structured logging with Pino `[S]`

**Description:** Install `pino` and `nestjs-pino`. Replace NestJS default logger. JSON format with `traceId`, `bookId`, `userId`, `agent`, `durationMs`, `tokensUsed`, `costUsd`. Mask `user.email` in all lines. Pretty-print in dev.
**Deps:** TASK-006
**AC:** Prod output is valid JSON; `user.email` absent; `traceId` present on agent logs.
**Files:** `apps/api/src/common/logger/logger.module.ts`, `apps/api/src/main.ts`

---

### TASK-139: Add custom agent metrics via OTel `[S]`

**Description:** In `BaseAgent` using OTel Metrics API: `agent_run_duration_ms` (histogram), `agent_tokens_used_total` (counter), `agent_cost_usd_total` (counter), `agent_errors_total` (counter). All labeled with `agent_name` and `provider`.
**Deps:** TASK-136, TASK-055
**AC:** After generating a book, Prometheus scrape endpoint shows all 4 metrics with labels.
**Files:** `apps/api/src/agents/base.agent.ts`, `apps/api/src/common/metrics/metrics.module.ts`

---

### TASK-140: Add Prometheus metrics endpoint `[S]`

**Description:** Install `prom-client`. Expose `GET /metrics` (IP-restricted in prod). Includes Node.js default metrics (heap, event loop lag) plus custom agent metrics.
**Deps:** TASK-139
**AC:** `GET /metrics` returns Prometheus text format with `agent_run_duration_ms` histogram visible.
**Files:** `apps/api/src/common/metrics/metrics.controller.ts`

---

### TASK-141: Create Grafana dashboard config `[M]`

**Description:** Create `infra/grafana/dashboards/book-platform.json`. Panels: (1) Book success rate %, (2) P50/P95 generation time, (3) Cost/book 24h avg, (4) Queue depth per queue, (5) LLM provider error rate, (6) Active concurrent generations. Grafana provisioning compatible.
**Deps:** TASK-140
**AC:** Importing JSON into Grafana produces all 6 panels without errors.
**Files:** `infra/grafana/dashboards/book-platform.json`, `infra/grafana/provisioning/dashboards.yaml`

---

### TASK-142: Set up alerting rules `[S]`

**Description:** Create `infra/grafana/alerts/book-platform-alerts.yaml`. Rules: success rate <90% for 5min → P1; queue depth >500 for 10min → P2; cost/book >$3.00 → P2; fal.ai error rate >5% → P2. Slack webhook notification.
**Deps:** TASK-141
**AC:** Alert YAML validates; test alert fires and logs notification body.
**Files:** `infra/grafana/alerts/book-platform-alerts.yaml`

---

## PHASE 12 — Production Hardening

**Goal:** Security audit, performance optimization, rate limiting, cost controls.
**Deps:** Phase 11
**Deliverable:** Load test passes 100 concurrent generations; security headers score A.

---

### TASK-143: Global API rate limiting `[S]`

**Description:** `@nestjs/throttler` with Redis store globally. Default: 100 req/60s per user. Override: `POST /api/books` → 5/hour. Log all rate-limit hits.
**Deps:** TASK-097, TASK-036
**AC:** 6th book creation within an hour returns 429 with `Retry-After` header.
**Files:** `apps/api/src/app.module.ts`

---

### TASK-144: Request size limits and input sanitization `[S]`

**Description:** `express.json({ limit: '100kb' })`. Defense-in-depth max-length checks in `ContentSafetyValidator`. Strip HTML from free-text fields with `sanitize-html`.
**Deps:** TASK-093
**AC:** 500kb body returns 413; `<script>` tag in `educationalGoal` is stripped.
**Files:** `apps/api/src/main.ts`, `apps/api/src/common/validators/content-safety.ts`

---

### TASK-145: PDF idempotency — prevent double-render `[S]`

**Description:** In `PdfGenProcessor`, check if `books.pdf_r2_key` exists and status is `complete`. If yes, return existing URL without re-rendering.
**Deps:** TASK-090
**AC:** Running PDF job twice returns existing URL; PDFKit not called on second run.
**Files:** `apps/api/src/agents/pdf-gen/pdf-gen.processor.ts`

---

### TASK-146: Database query optimization and indexes `[S]`

**Description:** Run `EXPLAIN ANALYZE` on hot queries. Add missing composite indexes: `book_pages(book_id, page_number)`, `agent_logs(book_id, created_at)`, `credit_transactions(user_id, created_at)`. Add Prisma connection pool config.
**Deps:** TASK-014
**AC:** `EXPLAIN ANALYZE` on `findByUserId` shows index scan; no sequential scans on hot paths.
**Files:** `apps/api/prisma/schema.prisma`, new migration file

---

### TASK-147: LLM cost circuit breaker `[M]`

**Description:** Create `apps/api/src/ai-providers/cost-circuit-breaker.ts`. Track rolling 1-hour LLM spend per user via Redis. Reject new book if hourly spend would exceed `MAX_USER_HOURLY_SPEND_USD`. Global circuit: if platform spend in 10 min > $500, pause new books.
**Deps:** TASK-051, TASK-011
**AC:** Unit test: user exceeding hourly limit rejected; global threshold test passes.
**Files:** `apps/api/src/ai-providers/cost-circuit-breaker.ts`

---

### TASK-148: Image optimization pipeline `[S]`

**Description:** After image generation, use `sharp`: create WebP at 85% quality for web delivery, 300×200 thumbnail for library. Upload both to R2. Store WebP URL in `BookPage.image_url`; PNG kept for PDF.
**Deps:** TASK-081, TASK-043
**AC:** R2 contains both PNG and WebP; WebP is ≥30% smaller.
**Files:** `apps/api/src/agents/image-gen/image-optimizer.ts`

---

### TASK-149: API key rotation support `[S]`

**Description:** Support `ANTHROPIC_API_KEY_2` and `OPENAI_API_KEY_2` as secondary keys. `LlmRouterService` falls back to secondary on `AuthenticationError`. Enables zero-downtime rotation.
**Deps:** TASK-051
**AC:** With primary key revoked and secondary set, LLM calls succeed after one retry.
**Files:** `apps/api/src/ai-providers/llm-router.service.ts`

---

### TASK-150: Security headers hardening `[S]`

**Description:** Configure `helmet` with strict CSP (allows only R2 CDN for images), HSTS (1 year), `referrerPolicy: "no-referrer"`, `permissionsPolicy` (disable camera/mic/geolocation). Test on securityheaders.com.
**Deps:** TASK-018
**AC:** Security headers scan grade A; no CSP violations on normal usage.
**Files:** `apps/api/src/main.ts`

---

### TASK-151: Write load test with k6 `[M]`

**Description:** Create `infra/load-tests/book-creation.js`. 100 VUs each create an 8-page book (agents mocked), poll until complete, verify PDF URL. Target: 100 concurrent completions, error rate <1%, P95 API response <200ms.
**Deps:** TASK-097
**AC:** k6 run against staging passes all targets.
**Files:** `infra/load-tests/book-creation.js`

---

## PHASE 13 — Production Deployment

**Goal:** Kubernetes manifests, CI/CD pipeline, staging and production environments.
**Deps:** Phase 12
**Deliverable:** `git push main` → automated staging deploy; one approval → production deploy.

---

### TASK-152: Kubernetes base manifests — API `[M]`

**Description:** Create `infra/k8s/base/api/`. `deployment.yaml` (3 replicas, CPU: 500m/2000m, memory: 512Mi/2Gi, readiness probe on `/api/health`), `service.yaml` (ClusterIP), `hpa.yaml` (3–10 pods, CPU >70%), `configmap.yaml`.
**Deps:** TASK-025
**AC:** `kubectl apply -k infra/k8s/base` creates all resources; API pods reach Ready state.
**Files:** `infra/k8s/base/api/deployment.yaml`, `infra/k8s/base/api/hpa.yaml`

---

### TASK-153: Kubernetes base manifests — workers `[M]`

**Description:** One `Deployment` per agent queue. Resources: image-gen (1 CPU/1Gi), chapter-writer (500m/512Mi), pdf-gen (2 CPU/2Gi, fixed 2 replicas). Same Docker image; `WORKER_QUEUES` env var selects queues. KEDA `ScaledObject` for image-gen and chapter-writer.
**Deps:** TASK-025, TASK-056
**AC:** All worker deployments start; workers pick up test jobs from correct queues.
**Files:** `infra/k8s/base/workers/`

---

### TASK-154: Install KEDA for queue-based autoscaling `[S]`

**Description:** Create `infra/k8s/base/keda/scaledobjects.yaml`. `ScaledObject` for `agent:image-gen` and `agent:chapter-write`. Redis BullMQ trigger. Min: 1, Max: 20. Scale-down stabilization: 5 minutes.
**Deps:** TASK-153
**AC:** 100 jobs in `agent:image-gen` → worker scales to ≥5 pods within 2 minutes.
**Files:** `infra/k8s/base/keda/scaledobjects.yaml`

---

### TASK-155: Kubernetes overlays — staging `[S]`

**Description:** `infra/k8s/overlays/staging/kustomization.yaml`. Patches: image tags to `staging-{SHA}`, scale to 1 replica, `MAX_USER_HOURLY_SPEND_USD: 10`, staging DB/Redis endpoints.
**Deps:** TASK-152, TASK-153
**AC:** `kubectl apply -k infra/k8s/overlays/staging` applies all patches without errors.
**Files:** `infra/k8s/overlays/staging/`

---

### TASK-156: Kubernetes overlays — production `[M]`

**Description:** `infra/k8s/overlays/production/kustomization.yaml`. Patches: production image tags, 3 API replicas, pod disruption budgets (min 2 available), production resource limits, `ExternalSecret` for all API keys.
**Deps:** TASK-155
**AC:** Production overlay applies; PDB prevents downtime during rolling updates.
**Files:** `infra/k8s/overlays/production/`

---

### TASK-157: Kubernetes Ingress with TLS `[S]`

**Description:** `infra/k8s/base/ingress.yaml`. Nginx ingress: `/api/*` → API service, `/socket.io/*` → API (WebSocket upgrade). TLS via `cert-manager` Let's Encrypt `ClusterIssuer`.
**Deps:** TASK-152
**AC:** HTTPS works with valid cert; WebSocket upgrades through nginx correctly.
**Files:** `infra/k8s/base/ingress.yaml`, `infra/k8s/base/cert-manager/`

---

### TASK-158: Set up External Secrets Operator `[S]`

**Description:** `infra/k8s/base/secrets/external-secrets.yaml`. `ExternalSecret` resources from AWS Secrets Manager: `anthropic-api-key`, `openai-api-key`, `fal-api-key`, `stripe-secret-key`, `jwt-secret`, `database-url`. Syncs every 1 hour.
**Deps:** TASK-156
**AC:** Sync succeeds; Kubernetes secret created; app starts using secret values.
**Files:** `infra/k8s/base/secrets/external-secrets.yaml`

---

### TASK-159: Dockerize Next.js frontend `[M]`

**Description:** `apps/web/Dockerfile` multi-stage: install → `next build` (standalone output) → `node:20-alpine` runtime. `NEXT_PUBLIC_*` as build args. Non-root user.
**Deps:** TASK-019
**AC:** `docker build` completes; container serves on port 3000; env vars injected correctly.
**Files:** `apps/web/Dockerfile`, `apps/web/.dockerignore`

---

### TASK-160: GitHub Actions: deploy-staging workflow `[M]`

**Description:** `.github/workflows/deploy-staging.yml`. Triggers on `develop` push. Steps: build + push images tagged `staging-{SHA}`, run integration tests, `kubectl apply -k overlays/staging`, wait for rollout, health-check smoke test.
**Deps:** TASK-021, TASK-155, TASK-159
**AC:** Push to `develop` updates staging within 10 minutes; smoke test passes.
**Files:** `.github/workflows/deploy-staging.yml`

---

### TASK-161: GitHub Actions: deploy-production workflow `[M]`

**Description:** `.github/workflows/deploy-prod.yml`. Triggers on `main` push. Requires manual approval (`environment: production`). Uses production overlay. Post-deploy: synthetic smoke test. Rollback: `kubectl rollout undo`.
**Deps:** TASK-160, TASK-156
**AC:** Push to `main` creates pending approval; approved deploy completes; rollback works.
**Files:** `.github/workflows/deploy-prod.yml`

---

### TASK-162: Add Sentry error tracking `[S]`

**Description:** Install `@sentry/nestjs` and `@sentry/nextjs`. Initialize in `tracing.ts` (API) and `sentry.client.config.ts` (web). `tracesSampleRate: 0.1` in prod. Source maps uploaded in CI. Mask `email` and `name` in Sentry events.
**Deps:** TASK-136, TASK-019
**AC:** Unhandled error appears in Sentry within 30s; `user.email` masked in the event.
**Files:** `apps/api/src/tracing.ts`, `apps/web/sentry.client.config.ts`

---

### TASK-163: Automated database backup `[S]`

**Description:** `infra/k8s/base/jobs/pg-backup-cronjob.yaml`. Daily 2am UTC: `pg_dump` → gzip → R2 `bookplatform-backups/{date}/db.sql.gz`. 30-day retention via R2 lifecycle. Success/failure notification logged.
**Deps:** TASK-156
**AC:** CronJob runs on schedule; backup in R2; restore test produces working DB.
**Files:** `infra/k8s/base/jobs/pg-backup-cronjob.yaml`

---

### TASK-164: Create production runbook `[M]`

**Description:** Create `infra/docs/runbook.md`. Covers: manually replay failed book job, scale workers, rotate API keys without downtime, restore from backup, rollback deployment, on-call alert responses, cost spike response.
**Deps:** Phases 12–13 complete
**AC:** Each procedure executable by a new engineer following only the runbook.
**Files:** `infra/docs/runbook.md`

---

### TASK-165: Full E2E book generation integration test `[L]`

**Description:** `apps/api/test/full-book.e2e.spec.ts`. Uses real API keys with minimal-cost model. Generates a real 8-page book end-to-end. Asserts: valid PDF, ≥8 pages, child's name in text, file size >500kb. Runs only on `main` branch. Total test cost target: <$1.00.
**Deps:** All prior phases
**AC:** Test passes end-to-end; PDF opens correctly; cost logged in CI output.
**Files:** `apps/api/test/full-book.e2e.spec.ts`

---

## Summary Table

| Phase              | Task Range     | Count   | Focus                               |
| ------------------ | -------------- | ------- | ----------------------------------- |
| 0 — Foundation     | TASK-001 → 025 | 25      | Monorepo, tooling, Docker, DB, CI   |
| 1 — Auth           | TASK-026 → 036 | 11      | JWT auth, user management           |
| 2 — Data Layer     | TASK-037 → 045 | 9       | Repositories, storage, seed         |
| 3 — AI Providers   | TASK-046 → 054 | 9       | Anthropic, OpenAI, fal.ai, fallback |
| 4 — Agent Core     | TASK-055 → 064 | 10      | Base agent, queues, orchestrator    |
| 5 — Agents         | TASK-065 → 091 | 27      | All 9 agent implementations         |
| 6 — Book API       | TASK-092 → 101 | 10      | REST endpoints, WebSocket           |
| 7 — FE Foundation  | TASK-102 → 114 | 13      | Next.js, auth, design system        |
| 8 — Wizard         | TASK-115 → 124 | 10      | Book creation flow                  |
| 9 — Reader         | TASK-125 → 129 | 5       | Library, reader, regen UI           |
| 10 — Billing       | TASK-130 → 135 | 6       | Stripe, credits                     |
| 11 — Observability | TASK-136 → 142 | 7       | OTel, Grafana, alerts               |
| 12 — Hardening     | TASK-143 → 151 | 9       | Rate limits, security, load test    |
| 13 — Deployment    | TASK-152 → 165 | 14      | K8s, CI/CD, production              |
| **Total**          |                | **165** |                                     |

---

## Parallelization Map

```
Phase 0 (must complete first — all 3 engineers together)
    ├── Phase 1 (Auth)         ─┐
    ├── Phase 3 (AI Providers)  ├── run in parallel after Phase 0
    └── Phase 7* (FE Foundation, needs Phase 1 auth API first)

Phase 2 (Data Layer) — follows Phase 1
Phase 4 (Agent Core) — needs Phase 2 + Phase 3

Phase 5 (Agents) — all 9 agents parallelizable once TASK-055/056 done
Phase 6 (Book API) — needs Phase 4 + Phase 5
Phase 7 (FE Foundation) — needs Phase 1 auth; independent of agents
Phase 8 (Wizard) — needs Phase 7 + Phase 6
Phase 9 (Reader) — follows Phase 8
Phase 10 (Billing) — mostly independent, parallelizable with Phase 7–9
Phase 11 (Observability) — can start mid-Phase 5
Phase 12 (Hardening) — follows Phase 11
Phase 13 (Deployment) — follows Phase 12
```

## Estimated Timeline (3-engineer team)

| Sprint              | Work                                                  |
| ------------------- | ----------------------------------------------------- |
| Sprint 1 (wk 1–2)   | Phase 0 together → Phase 1 / Phase 3 in parallel      |
| Sprint 2 (wk 3–4)   | Phase 2 + Phase 4 + Phase 7 in parallel               |
| Sprint 3 (wk 5–7)   | Phase 5 (3 engineers on agents) + Phase 8 (FE wizard) |
| Sprint 4 (wk 8–9)   | Phase 6 (API) + Phase 9 (reader) + Phase 10 (billing) |
| Sprint 5 (wk 10–11) | Phase 11 + Phase 12                                   |
| Sprint 6 (wk 12)    | Phase 13 + production launch                          |
