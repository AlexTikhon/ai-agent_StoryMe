# Backend Technical Design
## StoryMe — Implementation Reference for Senior Backend Engineers
**Version 1.0 | Backend Architecture Document**
**Prepared by: Principal Backend Architect | Date: June 2026**

> This document is the authoritative implementation guide for the StoryMe backend. It assumes familiarity with `ARCHITECTURE.md`, `PRD.md`, `UX_SPEC.md`, and `FRONTEND_DESIGN.md`. It does not repeat product decisions — it translates them into backend engineering decisions.
>
> **Audience:** Senior Backend Engineers beginning implementation.
>
> **Goal:** Eliminate every significant backend architectural decision before the first line of feature code is written.

---

# Table of Contents

1. [Frontend Expectations](#1-frontend-expectations)
2. [Architecture](#2-architecture)
3. [AI Pipeline](#3-ai-pipeline)
4. [Queues](#4-queues)
5. [Database](#5-database)
6. [Auth](#6-auth)
7. [Billing](#7-billing)
8. [PDF Generation](#8-pdf-generation)
9. [Storage](#9-storage)
10. [Observability](#10-observability)

---

# 1. Frontend Expectations

This section defines the contract between the backend and the Next.js BFF. It is the highest-priority section — the frontend cannot ship if any item here is broken or misspecified.

## 1.1 API Response Envelope

All API responses from the NestJS backend follow a consistent envelope. The BFF may flatten this before forwarding to the browser, but the NestJS→BFF contract is:

**Success:**
```json
{
  "data": { /* payload */ },
  "meta": {
    "requestId": "req_abc123",
    "timestamp": "2026-06-30T12:00:00Z"
  }
}
```

**Error:**
```json
{
  "error": {
    "code": "E02",
    "message": "Book generation failed",
    "field": null,
    "requestId": "req_abc123"
  }
}
```

**Validation error (422):**
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Validation failed",
    "fields": {
      "childName": "Name is required",
      "age": "Age must be between 2 and 12"
    },
    "requestId": "req_abc123"
  }
}
```

The frontend error handling layer maps `error.code` to localized user-facing messages. The `message` field is for developer logging only — it is never shown directly to users.

## 1.2 HTTP Status Code Contract

| Scenario | HTTP Status | Notes |
|---|---|---|
| Success (read) | 200 | Standard GET, no body omitted |
| Success (created) | 201 | POST that creates a resource |
| Success (async job started) | 202 | Book creation — job accepted |
| Success (no content) | 204 | DELETE, logout |
| Bad request / invalid format | 400 | Malformed JSON, missing required fields |
| Unauthenticated | 401 | No token or token expired |
| Forbidden (plan gate) | 403 | Valid auth, insufficient plan |
| Not found | 404 | Resource does not exist or is not owned by user |
| Conflict | 409 | Duplicate resource (duplicate email on signup) |
| Validation error | 422 | Field-level validation failures |
| Rate limited | 429 | With `Retry-After` header (seconds) |
| Server error | 500 | Unexpected; Sentry auto-notified |
| Gateway timeout (AI provider) | 504 | Upstream AI call timed out |

**Critical rule:** Never return a 200 with an error in the body. Status codes carry meaning and the BFF/frontend error interceptor depends on them.

## 1.3 Pagination Contract

All list endpoints use cursor-based pagination. No offset/limit pagination. Response shape:

```json
{
  "data": {
    "items": [ /* array of items */ ],
    "nextCursor": "eyJpZCI6InV1aWQiLCJjcmVhdGVkQXQiOiIyMDI2In0=",
    "hasMore": true,
    "total": 47
  }
}
```

- `nextCursor` is `null` when there are no more pages
- `total` is the total count of items matching the filter (not just this page) — used for dashboard display ("47 books")
- Cursor is an opaque base64-encoded string (never a raw ID or offset)
- Default page size: 20 items. Max page size: 100 items.
- Query params: `?cursor=<value>&limit=20`

## 1.4 Authentication Cookie Requirements

The BFF's token relay depends on these exact cookie properties:

| Property | Value |
|---|---|
| Name | `storyme_refresh` |
| HttpOnly | `true` |
| Secure | `true` (production); `false` (development) |
| SameSite | `Strict` |
| Path | `/api/auth` (scoped to auth routes only) |
| MaxAge | 604800 (7 days in seconds) |
| Domain | `.storyme.app` (includes BFF on `storyme.app`) |

The BFF reads this cookie server-side to call `/api/auth/refresh`. The cookie must never be readable by JavaScript (`HttpOnly: true`).

## 1.5 CORS Configuration

The NestJS API allows requests from:
- `https://storyme.app` (production)
- `https://staging.storyme.app`
- `http://localhost:3000` (development)

**CORS settings:**
```
Access-Control-Allow-Origin: [above origins, dynamically matched]
Access-Control-Allow-Credentials: true
Access-Control-Allow-Methods: GET, POST, PATCH, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization, X-Request-ID, X-CSRF-Token
Access-Control-Max-Age: 86400
```

The NestJS API does not set `Access-Control-Allow-Origin: *` — credentials are required.

## 1.6 Rate Limiting Headers

When rate-limited responses are returned, include:

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1719748800
Retry-After: 60
```

Rate limits:
- General API: 100 requests / minute per authenticated user
- Book creation: 5 requests / hour for free users; 20 / hour for paid
- Auth endpoints (login, signup): 10 requests / 15 minutes per IP
- Photo upload: 10 uploads / hour per user

## 1.7 Real-Time Event Contract (SSE / WebSocket)

The frontend subscribes to generation progress via SSE (see `FRONTEND_DESIGN.md §10`). The NestJS WebSocket server emits Socket.io events that the BFF converts to SSE.

**Socket.io event structure (`WsProgressEvent`):**

```typescript
interface WsProgressEvent {
  type: 'book:progress' | 'book:complete' | 'book:error' | 'page:ready';
  bookId: string;
  step?: string;               // current agent step name
  pageNumber?: number;         // set on 'page:ready' events
  pageImageUrl?: string;       // CDN URL of completed page image
  percentComplete?: number;    // 0–100
  error?: string;              // set on 'book:error'
  result?: BookResult;         // set on 'book:complete'
}
```

**Progress milestones** the frontend displays:

| Step | Label shown in UI | Approximate % |
|---|---|---|
| `char_build` | "Getting to know {childName}…" | 5% |
| `story_plan` | "Planning the adventure…" | 15% |
| `chapter_gen` | "Writing the story…" | 35% |
| `illust_plan` | "Imagining the illustrations…" | 45% |
| `image_gen` | "Painting the pages…" | 70% |
| `qa_review` | "Checking every detail…" | 85% |
| `layout` | "Laying out the book…" | 92% |
| `pdf_render` | "Almost ready…" | 98% |
| `complete` | "Your book is ready!" | 100% |

**`page:ready` event:** Emitted for each completed page image during `image_gen`. The frontend uses this to show a live preview of pages as they appear. This is what makes the cover preview visible at ~40% progress.

## 1.8 CDN URL Patterns

The frontend constructs CDN URLs using these patterns. They must remain stable across deployments:

| Asset | Pattern | Notes |
|---|---|---|
| Cover thumbnail | `cdn.storyme.app/books/{bookId}/cover-thumb.webp` | Public, no auth |
| Page image (reader) | `cdn.storyme.app/books/{bookId}/images/page-{NN}.webp` | Public, no auth |
| PDF download | Signed URL via `/api/books/{id}/download/pdf` | 24h expiry |
| Preview PDF | Signed URL via `/api/books/{id}/download/preview` | 24h expiry |

Page numbers in CDN paths are zero-padded to 2 digits: `page-01.webp`, `page-12.webp`, not `page-1.webp`.

## 1.9 Draft API (Wizard Restore)

The frontend calls a draft API to restore wizard progress for authenticated users. Contract:

```
GET    /api/books/draft           Returns the most recent incomplete draft, or null
PUT    /api/books/draft           Upserts the current wizard draft (called on each step completion)
DELETE /api/books/draft           Clears the draft (called after generation starts)
```

Draft payload is the full wizard `CreateBookRequest` (or partial — the server accepts partial and merges). The draft is identified by `userId` (one draft per user, not per child). Draft expires server-side after 30 days.

## 1.10 Idempotency

The following endpoints are idempotent via `Idempotency-Key` header:

- `POST /api/books` — prevents duplicate generation jobs if the browser retries
- `POST /api/billing/checkout` — prevents duplicate Stripe sessions
- `PATCH /api/books/:id/pages/:n/regen-*` — prevents double-regen on retry

The BFF sends a `client-generated UUID` as the `Idempotency-Key` header. The NestJS API stores the key in Redis with a 24-hour TTL. On duplicate key: return the original response (200/202) without executing the operation again.

---

# 2. Architecture

## 2.1 Application Components

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CLIENT LAYER                                    │
│   Next.js BFF (apps/web) — proxies auth, converts SSE, protects tokens      │
└──────────────────────────────┬──────────────────────────────────────────────┘
                               │ HTTP + WebSocket
                               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           GATEWAY / REVERSE PROXY                            │
│   Cloudflare (TLS, CDN, DDoS, rate limiting) → Nginx (internal routing)     │
└──────────────────────────────┬──────────────────────────────────────────────┘
                               │
              ┌────────────────┴────────────────┐
              │                                 │
              ▼                                 ▼
┌─────────────────────────┐      ┌──────────────────────────────┐
│  NestJS API Server      │      │  NestJS WebSocket Server     │
│  apps/api               │      │  (Socket.io, same process    │
│  Port 4000              │      │   or separate deployment)    │
│  REST endpoints         │      │  Port 4001                   │
│  Auth guards            │      │  Subscribes Redis pub/sub    │
│  Job submission         │      └──────────────────────────────┘
│  Admin endpoints        │
└─────────┬───────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          ORCHESTRATION + WORKER LAYER                        │
│                                                                               │
│  Book Orchestrator (NestJS service)  ←→  BullMQ Queues  ←→  Agent Workers  │
│  State machine per book                   (Redis-backed)   (Node.js procs)  │
└─────────────────────────────────────────────────────────────────────────────┘
          │                   │                   │
          ▼                   ▼                   ▼
┌──────────────┐   ┌──────────────────┐   ┌───────────────────────┐
│  PostgreSQL  │   │  Redis 7         │   │  Image Worker         │
│  (primary    │   │  - BullMQ data   │   │  (FastAPI, Python)    │
│  data store) │   │  - pub/sub       │   │  Port 8000            │
│              │   │  - rate limits   │   │  Wraps fal.ai API     │
│              │   │  - session cache │   └───────────────────────┘
│              │   │  - idempotency   │
└──────────────┘   └──────────────────┘
```

## 2.2 NestJS Application Module Structure

```
apps/api/src/
│
├── main.ts                    # Bootstrap: NestJS app + WebSocket adapter + Swagger
├── app.module.ts              # Root module — imports all feature modules
│
├── modules/
│   ├── auth/                  # JWT, refresh, OAuth, guards
│   │   ├── auth.module.ts
│   │   ├── auth.controller.ts
│   │   ├── auth.service.ts
│   │   ├── strategies/
│   │   │   ├── jwt.strategy.ts
│   │   │   ├── refresh.strategy.ts
│   │   │   └── google.strategy.ts
│   │   └── guards/
│   │       ├── jwt-auth.guard.ts
│   │       └── roles.guard.ts
│   │
│   ├── books/                 # Book CRUD, job submission
│   │   ├── books.module.ts
│   │   ├── books.controller.ts
│   │   ├── books.service.ts
│   │   └── dto/
│   │       ├── create-book.dto.ts      # Zod schema + class-validator decorators
│   │       └── book-status.dto.ts
│   │
│   ├── orchestrator/          # Book generation state machine
│   │   ├── orchestrator.module.ts
│   │   ├── orchestrator.service.ts    # State transitions, job dispatch
│   │   └── book-state.machine.ts      # XState or manual FSM
│   │
│   ├── agents/                # Agent worker implementations
│   │   ├── agents.module.ts
│   │   ├── base-agent.ts              # Abstract base class
│   │   ├── char-builder/
│   │   ├── story-planner/
│   │   ├── chapter-writer/
│   │   ├── illust-prompt/
│   │   ├── char-consistency/
│   │   ├── image-gen/
│   │   ├── qa-review/
│   │   ├── layout/
│   │   └── pdf-render/
│   │
│   ├── billing/               # Stripe integration
│   │   ├── billing.module.ts
│   │   ├── billing.controller.ts
│   │   ├── billing.service.ts
│   │   └── stripe-webhook.handler.ts
│   │
│   ├── storage/               # R2 + CDN abstraction
│   │   ├── storage.module.ts
│   │   └── storage.service.ts
│   │
│   ├── realtime/              # WebSocket gateway
│   │   ├── realtime.module.ts
│   │   └── progress.gateway.ts        # Socket.io gateway
│   │
│   ├── series/                # Book series management
│   ├── characters/            # Character card management
│   ├── credits/               # Credit balance and transactions
│   ├── notifications/         # Email notifications (SES/SendGrid)
│   ├── admin/                 # Admin-only endpoints
│   └── draft/                 # Wizard draft persistence
│
├── common/
│   ├── filters/
│   │   ├── http-exception.filter.ts   # Normalizes all errors to envelope format
│   │   └── validation.filter.ts
│   ├── interceptors/
│   │   ├── logging.interceptor.ts     # Structured request/response logging
│   │   ├── response-transform.interceptor.ts  # Wraps all responses in envelope
│   │   └── idempotency.interceptor.ts
│   ├── guards/
│   │   └── plan-gate.guard.ts         # Checks user.plan for feature access
│   ├── pipes/
│   │   └── zod-validation.pipe.ts     # Validates DTOs using Zod schemas
│   └── decorators/
│       ├── current-user.decorator.ts
│       └── require-plan.decorator.ts
│
├── config/
│   ├── env.ts                 # Zod-validated environment config
│   ├── database.config.ts
│   ├── redis.config.ts
│   └── stripe.config.ts
│
└── prisma/
    ├── schema.prisma
    └── migrations/
```

## 2.3 Request Lifecycle

```
HTTP Request
    │
    ▼
Cloudflare (TLS termination, rate limiting, DDoS)
    │
    ▼
Nginx (reverse proxy to NestJS :4000)
    │
    ▼
NestJS Global Middleware:
  1. Helmet (security headers)
  2. CORS
  3. Request ID injection (X-Request-ID header)
  4. Request logging start
    │
    ▼
NestJS Guards (in order):
  1. JwtAuthGuard (validates Bearer token → populates req.user)
  2. RolesGuard (checks req.user.role for admin-only routes)
  3. PlanGateGuard (checks req.user.plan for paid-only features)
    │
    ▼
NestJS Pipes:
  1. ZodValidationPipe (validates body/query against Zod schema)
    │
    ▼
Controller method
    │
    ▼
Service layer (business logic)
    │
    ▼
NestJS Interceptors (post-processing):
  1. ResponseTransformInterceptor (wraps result in { data: ... } envelope)
  2. LoggingInterceptor (records response time, status)
    │
    ▼
HTTP Response
```

All exceptions are caught by the global `HttpExceptionFilter` and `ValidationExceptionFilter`, which normalize them to the error envelope defined in §1.1.

## 2.4 Dependency Injection Architecture

NestJS's DI container manages all services. Key rules:
- Services are `@Injectable()` and registered in their feature module
- The `AppModule` imports all feature modules
- Circular dependencies are forbidden; if detected during development, it signals a module boundary violation that must be resolved by restructuring
- External clients (Prisma, Redis, Stripe SDK, fal.ai SDK) are wrapped in NestJS providers registered in their respective config modules and injected where needed

## 2.5 Environment Validation

All environment variables are validated on startup via Zod:

```
DATABASE_URL              PostgreSQL connection string
REDIS_URL                 Redis connection string
JWT_SECRET                Min 64-char random string
JWT_REFRESH_SECRET        Min 64-char random string (different from JWT_SECRET)
ANTHROPIC_API_KEY         sk-ant-...
OPENAI_API_KEY            sk-...
FAL_API_KEY               ...
GEMINI_API_KEY            ...
R2_ACCOUNT_ID             ...
R2_ACCESS_KEY             ...
R2_SECRET_KEY             ...
R2_BUCKET_NAME            ai-children-books-prod
CDN_BASE_URL              https://cdn.storyme.app
STRIPE_SECRET_KEY         sk_live_... / sk_test_...
STRIPE_WEBHOOK_SECRET     whsec_...
STRIPE_PRICE_SINGLE       price_...
STRIPE_PRICE_MONTHLY      price_...
STRIPE_PRICE_ANNUAL       price_...
SENDGRID_API_KEY          ...
APP_URL                   https://storyme.app
CORS_ORIGINS              https://storyme.app,https://staging.storyme.app
```

The app throws on startup if any required variable is missing or invalid. Undefined variables are never silently ignored.

---

# 3. AI Pipeline

## 3.1 Pipeline Overview

The AI pipeline is a directed acyclic graph of 9 agents. Each agent is a worker that consumes a BullMQ job, calls one or more AI APIs, and writes its output to PostgreSQL. The next agent in the pipeline reads that output from the database.

```
CreateBookRequest
       │
       ▼
[1] CharacterBuilderAgent     → CharacterCard + visualAnchor
       │
       ▼
[2] StoryPlannerAgent         → StoryPlan (title, chapters, scenes)
       │
       ▼
[3] ChapterWriterAgent ×N     → Chapter[] (runs in parallel per chapter)
       │
       ▼
[4] IllustrationPromptAgent ×P → ImagePrompt[] (parallel per page)
       │
       ▼
[5] CharacterConsistencyAgent → EnrichedImagePrompt[] (single pass, all pages)
       │
       ▼
[6] ImageGenerationAgent ×P   → GeneratedImage[] (parallel, rate-limited)
       │
       ▼
[7] QualityReviewAgent        → QualityReport[] (pass | regen flags)
       │          │
       │    [regen loop, max 2 retries per page]
       ▼
[8] LayoutAgent               → PageLayout[] (per page JSON spec)
       │
       ▼
[9] PDFRenderAgent            → book.pdf + cover.png (uploaded to R2)
       │
       ▼
    COMPLETE
```

**Failure isolation:** Any single agent failure triggers a retry for that agent only (not the full pipeline). After the configured number of retries, the book is marked `failed` and the user is notified. No credits are charged on failure.

## 3.2 Agent Base Class

All agents extend `BaseAgent` which provides:
- Structured logging (agent name, book ID, step, duration, token usage, cost)
- OpenTelemetry span creation for distributed tracing
- Retry budget tracking (reads from the job's attempt count)
- Output schema validation via Zod (throws `AgentOutputValidationError` if the LLM returns malformed JSON)
- Agent output persistence (writes result to the appropriate JSONB column in `books`)

```typescript
abstract class BaseAgent<TInput, TOutput> {
  abstract name: AgentStep
  abstract schema: ZodSchema<TOutput>
  abstract execute(input: TInput, ctx: AgentContext): Promise<TOutput>

  async run(job: Job<AgentJob<TInput>>): Promise<TOutput>
    // 1. Start OTel span
    // 2. Call this.execute()
    // 3. Validate output against this.schema
    // 4. Persist output to DB
    // 5. Publish progress event to Redis pub/sub
    // 6. End OTel span
    // throws on validation failure → BullMQ retries
}
```

## 3.3 Agent 1 — CharacterBuilderAgent

**Model:** Claude Sonnet 4.6
**Input:** `CreateBookRequest`
**Output:** `CharacterCard` + `visualAnchor: string`

**Critical output — the visualAnchor:**
A single dense string, 50–80 words, that describes the child visually in image-prompt-ready language. Example:
> `"Emma, a cheerful 6-year-old girl with curly red hair adorned with small freckles across her nose, bright green eyes, wearing blue denim dungarees over a yellow striped shirt and yellow rain boots, always smiling"`

This string is prepended verbatim to every image prompt in the book. It is the primary mechanism for character visual consistency. It must be:
- Free of subjective adjectives ("beautiful", "cute") — those bias image models
- Rich in objective visual detail (colors, textures, clothing, accessories)
- Grammatically structured as a noun phrase, not a sentence
- Language-agnostic (always in English, regardless of book language)

**Prompt structure:**
The system prompt instructs Claude to extract and normalize visual attributes from the parent's input (may be approximate: "brown hair" → "medium-brown straight hair reaching the shoulders"). Cultural context from name and language is used to ensure the character does not default to a Western appearance when the input suggests otherwise.

## 3.4 Agent 2 — StoryPlannerAgent

**Model:** Claude Opus 4.8 with extended thinking (budget: 5000 tokens)
**Input:** `CreateBookRequest` + `CharacterCard`
**Output:** `StoryPlan`

```typescript
interface StoryPlan {
  title: string
  synopsis: string        // 3–5 sentences; used on book cover
  chapters: ChapterOutline[]
  educationalTheme: string
  moralArc: string
  targetFleischKincaidGrade: number  // age - 4
  illustratableScenes: string[]      // one per page spread
}

interface ChapterOutline {
  chapterNumber: number
  title: string
  summary: string        // 2–3 sentences
  scenes: SceneOutline[]
  emotionalBeat: string  // the emotional tone of this chapter
}
```

**Extended thinking rationale:** Story coherence requires planning the full arc before committing to any chapter. Extended thinking allows Claude to reason through the narrative structure, identify potential plot holes, and ensure the educational goal is organically embedded before producing the final structured output. Cost impact: +$0.04/book.

**Output validation:** The Zod schema ensures:
- `chapters.length` matches `bookLength / avgPagesPerChapter`
- `illustratableScenes.length` equals `bookLength` (one scene per page)
- `targetFleischKincaidGrade` is between 0 and 8

## 3.5 Agent 3 — ChapterWriterAgent

**Model:** Claude Sonnet 4.6
**Input per worker:** `ChapterOutline` + `CharacterCard` + `previousChapterSummary: string`
**Output per worker:** `Chapter`
**Parallelism:** All chapters run concurrently (separate BullMQ jobs per chapter)

```typescript
interface Chapter {
  chapterNumber: number
  pages: Page[]
  nextChapterHandoffSummary: string  // 200-token summary for context chaining
}

interface Page {
  pageNumber: number
  textContent: string        // the page text (50–100 words per page)
  readingLevel: number       // Flesch-Kincaid grade level
  illustrableSceneHint: string  // brief scene description for prompt generator
}
```

**Context window management:**
Each ChapterWriter worker receives only:
1. A fixed system prompt (~500 tokens)
2. The character card (~300 tokens)
3. The story plan (chapter outline only, ~400 tokens)
4. The previous chapter's handoff summary (~200 tokens, never the full text)

This keeps the context under 2000 input tokens per worker, making parallelism economical.

**Reading level enforcement:**
After the agent produces text, a post-processing step calculates the Flesch-Kincaid grade level using the `flesch-kincaid` npm package. If the score exceeds `targetFleischKincaidGrade + 1`, a simplification prompt is sent to Claude Haiku (cheaper model) to revise the text. This retry does not count toward the agent's failure retry budget.

## 3.6 Agent 4 — IllustrationPromptGeneratorAgent

**Model:** Claude Sonnet 4.6
**Input per worker:** `Page` + `CharacterCard` + `IllustrationStyle` + `ColorPalette`
**Output per worker:** `ImagePrompt`
**Parallelism:** All pages concurrently

```typescript
interface ImagePrompt {
  pageNumber: number
  sceneDescription: string     // what is happening
  characterPosition: string    // where the character is in the frame
  emotionalTone: string        // facial expression and body language
  environment: string          // setting, lighting, time of day
  styleTokens: string[]        // consistent style tags ["children's book illustration", "watercolor", ...]
  negativePrompt: string       // what to avoid (violence, scary elements, adult content)
  aspectRatio: string          // "2:3" for portrait pages, "3:2" for spread
}
```

**Style token catalog:**
Style tokens are sourced from a curated catalog keyed on the user's selected `IllustrationStyle`:
- `watercolor`: `["watercolor illustration", "soft brushstrokes", "translucent washes", "children's picture book", "warm palette"]`
- `comic`: `["bold outlines", "flat colors", "comic book style", "vibrant", "energetic composition"]`
- `3d_cartoon`: `["3D render", "Pixar style", "subsurface scattering", "soft lighting", "expressive faces"]`
- `pencil_sketch`: `["pencil illustration", "hand-drawn", "textured paper", "cozy atmosphere"]`

## 3.7 Agent 5 — CharacterConsistencyAgent

**Model:** Claude Sonnet 4.6
**Input:** All `ImagePrompt[]` (entire book, single batch)
**Output:** `ImagePrompt[]` with `visualAnchor` injected and cross-prompt inconsistencies resolved

**Two-layer strategy:**

Layer 1 (prompt injection): Prepend `CharacterCard.visualAnchor` to every `sceneDescription` field. Format is fixed: `"{visualAnchor}, [scene description continues]"`

Layer 2 (cross-prompt audit): Send all prompts to Claude in a single call with the instruction to identify and correct any descriptions of the character that contradict the `visualAnchor`. Common errors caught: incorrect hair color, wrong clothing item, different eye color. The model returns a diff of corrections only (not the full prompt array) to minimize token usage.

**Phase 2 — LoRA enhancement:**
When a user has uploaded a reference photo and a LoRA has been trained (see §3.8 image generation agent), the `CharacterCard.loraWeights` path is injected into all prompts as a model identifier token. This is a configuration change to the prompt template, not a structural change to the agent.

## 3.8 Agent 6 — ImageGenerationAgent

**Model:** fal.ai → Flux 1.1 Pro (primary); DALL-E 3 (fallback)
**Input per worker:** `EnrichedImagePrompt`
**Output per worker:** `GeneratedImage`
**Parallelism:** Rate-limited to 50 requests/minute via BullMQ rate limiter
**Queue:** `agent:image-gen` with concurrency=10 and rate limit config

```typescript
interface GeneratedImage {
  pageNumber: number
  r2Key: string           // r2://books/{bookId}/images/page-{NN}.png
  cdnUrl: string          // https://cdn.storyme.app/books/{bookId}/images/page-{NN}.webp
  seed: bigint            // stored for deterministic regen
  modelVersion: string    // "flux-1.1-pro" or "dall-e-3"
  generationMs: number
}
```

**fal.ai call parameters:**
```json
{
  "model": "fal-ai/flux/dev",
  "prompt": "{visualAnchor}, {sceneDescription}",
  "negative_prompt": "{negativePrompt}",
  "image_size": "portrait_4_3",
  "num_inference_steps": 28,
  "guidance_scale": 3.5,
  "seed": "{randomly generated, stored for regen}"
}
```

**Fallback logic:**
1. Call fal.ai
2. If fal.ai returns an error or times out (>30s): call DALL-E 3 via OpenAI API
3. If both fail: mark page as `image_failed`; QA agent may force regen

**Image post-processing (after generation):**
1. Download raw PNG from fal.ai
2. Upload original PNG to R2: `books/{bookId}/images/page-{NN}.png`
3. Convert to WebP at 90% quality using Sharp (Node.js image processing)
4. Upload WebP to R2: `books/{bookId}/images/page-{NN}.webp` (CDN delivery)
5. Emit `page:ready` WebSocket event with CDN URL

**Each completed page image emits a `page:ready` event immediately** — the frontend starts showing images as they complete, not when the entire book is done.

## 3.9 Agent 7 — QualityReviewAgent

**Model:** Claude Sonnet 4.6 (text review) + GPT-4o Vision (image review)
**Input:** `Page` + `GeneratedImage` (image fetched from CDN as base64)
**Output per page:** `QualityScore`

```typescript
interface QualityScore {
  pageNumber: number
  passed: boolean
  scores: {
    ageAppropriateness: number   // 0–10
    characterConsistency: number // 0–10
    textImageAlignment: number   // 0–10
    readingLevel: number         // 0–10
  }
  flags: ('regenerate_image' | 'regenerate_text' | 'regenerate_both')[]
  notes: string
}
```

**QA thresholds:**
- `ageAppropriateness < 7` → `regenerate_image` (mandatory — safety critical)
- `characterConsistency < 6` → `regenerate_image`
- `textImageAlignment < 5` → `regenerate_image`
- `readingLevel < 6` → `regenerate_text`

**Regen loop:**
Pages that fail QA are re-queued into the appropriate agent queue (`agent:image-gen` or `agent:chapter-write`). Maximum 2 re-attempts per page per type (image or text). After 2 failed regen attempts, the page is marked `partial` and the book proceeds to layout with a placeholder. The user is notified that one page may look different.

**Safety gate:** `ageAppropriateness < 5` on any page → entire book fails, no delivery. This threshold is not configurable and not overridable.

## 3.10 Agent 8 — LayoutAgent

**Model:** Claude Haiku 4.5 (cheap — layout is deterministic, not creative)
**Input:** `Page` + `GeneratedImage` + `CharacterCard.targetAgeGroup`
**Output:** `PageLayout`

```typescript
interface PageLayout {
  pageNumber: number
  template: LayoutTemplate        // 'full-bleed' | 'text-bottom' | 'text-top' | 'text-side'
  imageRegion: BoundingBox        // percentage-based
  textRegion: BoundingBox
  fontFamily: string              // from book language + age lookup table
  fontSize: number                // pt units
  lineHeight: number
  textColor: string               // hex
  backgroundDecoration?: string   // r2 key of decorative border SVG
}
```

**Layout template selection rules:**
- Pages 1, 3: `full-bleed` (dramatic opening spreads)
- Even pages (reader-right): `text-bottom` (image above text)
- Odd pages (reader-left): `text-side` (image right, text left)
- Final page: `full-bleed` (climax moment)
- Pages with >80 words: `text-side` (more horizontal space for text)
- Pages with <30 words: `full-bleed` (let the image breathe)

**Font selection by age:**
- Age 2–4: Andika, 24pt, 1.8 line height
- Age 5–7: Plus Jakarta Sans, 18pt, 1.6 line height
- Age 8–10: Plus Jakarta Sans, 14pt, 1.5 line height
- Age 11–12: Lora, 13pt, 1.5 line height
- RTL languages (Arabic, Hebrew — Phase 3): Scheherazade New, with layout mirrored

## 3.11 Agent 9 — PDFRenderAgent

See Section 8 (PDF Generation) for the full specification.

## 3.12 Pipeline State Machine

The Orchestrator tracks book state via a finite state machine. Legal transitions:

```
created → char_build → story_plan → chapter_gen → illust_plan
       → image_gen → qa_review → layout → pdf_render → complete

Any state → failed         (after all retries exhausted)
Any state → partial        (some pages failed, book still delivered)
```

State is persisted in `books.status`. The Orchestrator listens to BullMQ job completion events and advances the state. This means the pipeline resumes correctly after a worker crash (BullMQ preserves job data in Redis until acknowledged).

## 3.13 LLM Provider Fallback Chain

```
Primary: Claude claude-sonnet-4-6 (story, prompts, QA text)
       ↓ (on 429 or 5xx)
Fallback: GPT-4o (same tasks)
       ↓ (on GPT-4o failure)
Emergency: Claude Haiku 4.5 (degraded quality, story tasks only)
           + flag book as generated_degraded
```

```
Primary: fal.ai → Flux 1.1 Pro (image generation)
       ↓ (on error or timeout)
Fallback: OpenAI → DALL-E 3
       ↓ (on DALL-E failure)
Mark page as image_failed → QA regen attempt
```

All provider calls are wrapped in a `ProviderClient` abstraction that handles the fallback chain, records which provider was used in `agent_logs`, and updates `books.ai_model_versions`.

## 3.14 Cost Tracking

Every AI API call records its token/image count and USD cost in `agent_logs`. After pipeline completion, the Orchestrator aggregates all agent logs for the book and writes the total to `books.total_cost_usd`. This drives the cost dashboard in `/api/admin/stats`.

**Approximate per-book cost targets (32-page book):**
| Agent | Model | Estimated Cost |
|---|---|---|
| CharacterBuilder | Claude Sonnet | $0.01 |
| StoryPlanner | Claude Opus + thinking | $0.06 |
| ChapterWriter × 8 | Claude Sonnet | $0.08 |
| IllustPromptGen × 32 | Claude Sonnet | $0.05 |
| CharConsistency | Claude Sonnet | $0.02 |
| ImageGen × 32 | Flux 1.1 Pro | $0.32 |
| QualityReview × 32 | Claude Sonnet + GPT-4o Vision | $0.15 |
| LayoutAgent × 32 | Claude Haiku | $0.01 |
| PDFRender | Server compute only | $0.00 |
| **Total** | | **~$0.70** |

---

# 4. Queues

## 4.1 Queue Topology

All queues are backed by Redis 7 via BullMQ. The queue names are the canonical identifiers used in code — never use string literals outside of the queue name constants file.

```typescript
// common/constants/queues.ts
export const QUEUES = {
  ORCHESTRATE: 'book:orchestrate',
  CHAR_BUILD:  'agent:char-build',
  STORY_PLAN:  'agent:story-plan',
  CHAPTER_WRITE: 'agent:chapter-write',
  ILLUST_PROMPT: 'agent:illust-prompt',
  IMAGE_GEN:   'agent:image-gen',
  QA_REVIEW:   'agent:qa-review',
  LAYOUT:      'agent:layout',
  PDF_RENDER:  'agent:pdf-render',
  NOTIFICATIONS: 'notifications',
} as const
```

## 4.2 Worker Concurrency

| Queue | Workers | Concurrency per Worker | Total Concurrency |
|---|---|---|---|
| `book:orchestrate` | 1 | 10 | 10 |
| `agent:char-build` | 2 | 5 | 10 |
| `agent:story-plan` | 2 | 3 | 6 |
| `agent:chapter-write` | 4 | 5 | 20 |
| `agent:illust-prompt` | 4 | 5 | 20 |
| `agent:image-gen` | 4 | 3 | 12 (rate-limited to 50/min) |
| `agent:qa-review` | 4 | 3 | 12 |
| `agent:layout` | 4 | 3 | 12 |
| `agent:pdf-render` | 2 | 2 | 4 (memory-intensive) |
| `notifications` | 1 | 10 | 10 |

These are the Phase 1 values. Phase 2 Kubernetes autoscaling is driven by queue depth (HPA on `bullmq_queue_depth` custom metric).

## 4.3 Job Priority Levels

```typescript
enum JobPriority {
  HIGH = 1,     // User-triggered: page regen, retry after failure
  NORMAL = 5,   // New book creation
  LOW = 10,     // Batch operations, admin re-runs
}
```

BullMQ processes higher-priority jobs first within a queue. A page regen requested by a user while their book is already generating will jump ahead of other books' jobs in that queue.

## 4.4 Retry Policy

All queues share a base retry policy:

```typescript
const BASE_RETRY_POLICY = {
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 2000,   // 2s, 4s, 8s
  },
  removeOnComplete: {
    age: 3600,     // keep completed jobs for 1 hour
    count: 1000,   // keep last 1000 completed jobs
  },
  removeOnFail: {
    age: 86400,    // keep failed jobs for 24 hours (for debugging)
  },
}
```

**Per-queue overrides:**

| Queue | Attempts | Backoff delay | Reason |
|---|---|---|---|
| `agent:image-gen` | 5 | 5000ms | fal.ai transient failures are common |
| `agent:pdf-render` | 2 | 10000ms | memory-intensive; don't retry too fast |
| `notifications` | 3 | 1000ms | user-facing; fail fast, don't delay |

## 4.5 Rate Limiting (Image Gen Queue)

The `agent:image-gen` queue is rate-limited at the BullMQ level:

```typescript
const imageGenRateLimit = {
  max: 45,           // slightly under fal.ai limit (50/min) for safety margin
  duration: 60000,   // 1 minute window
}
```

Jobs that exceed the rate limit are held in the queue (not dropped or failed). BullMQ automatically spaces them across the time window. Multiple fal.ai API keys can be used in a round-robin to increase effective throughput.

## 4.6 Dead Letter Queue

After all retry attempts are exhausted, the job does not disappear — BullMQ moves it to the failed state (visible in Bull Board). The Orchestrator listens to the `job:failed` event and:
1. Updates `books.status` → `failed`
2. Writes the error to `books.error_message`
3. Refunds credits to `users.credits`
4. Records in `credit_transactions` with `reason: 'refund_generation_failure'`
5. Publishes `book:error` WebSocket event
6. Enqueues a notification job for the failure email

## 4.7 Job Data Structure

All jobs follow this envelope:

```typescript
interface AgentJob<T = unknown> {
  bookId: string
  userId: string
  step: AgentStep
  input: T
  priority: JobPriority
  traceId: string        // OpenTelemetry trace context for correlation
  attempt: number        // current attempt number (starts at 1)
  idempotencyKey?: string
}
```

The `traceId` propagates through all agents' OpenTelemetry spans, creating a single distributed trace for the entire book generation pipeline.

## 4.8 Bull Board

Bull Board (the BullMQ admin UI) is deployed at `/admin/queues` behind admin auth. It shows:
- Queue depth (waiting, active, completed, failed counts) in real time
- Individual job inspection (input data, output, error, retry history)
- Manual retry of failed jobs
- Manual deletion of jobs

Access is restricted to `users.role = 'admin'`.

## 4.9 Graceful Shutdown

Workers listen to `SIGTERM` (sent by Kubernetes during pod shutdown):
1. Stop accepting new jobs from the queue
2. Let active jobs complete (or fail naturally) — up to 30 seconds grace period
3. If jobs are still running after 30s: BullMQ marks them as stalled; they'll be picked up by another worker on restart
4. Close DB and Redis connections cleanly

`keepJobsInQueue` ensures stalled jobs are re-queued automatically by BullMQ's stall check (runs every 30s).

---

# 5. Database

## 5.1 Technology Choices

- **PostgreSQL 16** — primary data store
- **Prisma ORM** — type-safe client, schema-driven migrations, codegen
- **PgBouncer** — connection pooling (production) — PostgreSQL max_connections is not infinite
- **pgvector extension** — for Phase 2 character embedding similarity search

## 5.2 Complete Schema

```sql
-- ─────────────────────────────────────────────
-- USERS & AUTH
-- ─────────────────────────────────────────────
CREATE TABLE users (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email            TEXT UNIQUE NOT NULL,
  password_hash    TEXT,                -- null for OAuth-only users
  name             TEXT,
  locale           TEXT NOT NULL DEFAULT 'en',
  timezone         TEXT NOT NULL DEFAULT 'UTC',

  -- OAuth
  oauth_provider   TEXT,               -- 'google' | 'apple' | null
  oauth_id         TEXT,

  -- Plan & credits
  plan             TEXT NOT NULL DEFAULT 'free',
  -- plan enum: 'free' | 'pay_per_book' | 'family' | 'annual' | 'educator'
  credits          INTEGER NOT NULL DEFAULT 3,
  credits_updated_at TIMESTAMPTZ DEFAULT now(),

  -- Account status
  role             TEXT NOT NULL DEFAULT 'user',  -- 'user' | 'admin'
  email_verified   BOOLEAN NOT NULL DEFAULT false,
  deactivated_at   TIMESTAMPTZ,                   -- soft delete for GDPR

  -- Preferences
  notification_email_on_completion BOOLEAN NOT NULL DEFAULT true,
  notification_email_marketing     BOOLEAN NOT NULL DEFAULT false,

  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_oauth ON users(oauth_provider, oauth_id)
  WHERE oauth_provider IS NOT NULL;

-- ─────────────────────────────────────────────
-- REFRESH TOKENS (stored for rotation + revocation)
-- ─────────────────────────────────────────────
CREATE TABLE refresh_tokens (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash       TEXT NOT NULL UNIQUE,   -- bcrypt hash of the actual token
  family           UUID NOT NULL,          -- reuse detection: family rotates together
  expires_at       TIMESTAMPTZ NOT NULL,
  revoked_at       TIMESTAMPTZ,            -- null = active
  ip_address       INET,
  user_agent       TEXT,
  created_at       TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_refresh_tokens_user_id ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_family ON refresh_tokens(family);

-- ─────────────────────────────────────────────
-- CHILD PROFILES
-- ─────────────────────────────────────────────
CREATE TABLE child_profiles (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  nickname         TEXT,
  age              INTEGER NOT NULL CHECK (age BETWEEN 2 AND 12),
  pronouns         TEXT NOT NULL DEFAULT 'they/them',
  avatar_config    JSONB,                  -- AvatarBuilderConfig
  photo_r2_key     TEXT,                   -- optional uploaded photo
  birthday         DATE,                   -- for birthday reminder feature
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_child_profiles_user_id ON child_profiles(user_id);

-- ─────────────────────────────────────────────
-- BOOKS
-- ─────────────────────────────────────────────
CREATE TABLE books (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  child_profile_id UUID REFERENCES child_profiles(id) ON DELETE SET NULL,

  -- Status
  status           TEXT NOT NULL DEFAULT 'created',
  -- status enum: created | char_build | story_plan | chapter_gen | illust_plan
  --              | image_gen | qa_review | layout | pdf_render | complete | failed | partial

  -- Request (input snapshot — never mutated after creation)
  request          JSONB NOT NULL,         -- CreateBookRequest

  -- Agent outputs (JSONB for schema flexibility during development)
  character_card   JSONB,
  story_plan       JSONB,
  chapters         JSONB,                  -- Chapter[]
  image_prompts    JSONB,                  -- ImagePrompt[]
  quality_report   JSONB,                  -- QualityScore[]
  page_layouts     JSONB,                  -- PageLayout[]

  -- Result
  title            TEXT,                   -- extracted from StoryPlan after story_plan step
  pdf_r2_key       TEXT,
  pdf_url          TEXT,                   -- CDN URL (permanent)
  preview_pdf_url  TEXT,                   -- First 3 pages, watermarked
  cover_url        TEXT,
  page_count       INTEGER,

  -- Paywall
  is_paid          BOOLEAN NOT NULL DEFAULT false,
  paid_at          TIMESTAMPTZ,
  stripe_payment_intent_id TEXT,

  -- Share
  share_token      TEXT UNIQUE,            -- public share URL token
  is_public        BOOLEAN NOT NULL DEFAULT false,

  -- Metadata
  generation_time_ms   INTEGER,
  total_cost_usd       DECIMAL(10, 6),
  ai_model_versions    JSONB,             -- {story: "claude-sonnet-4-6", image: "flux-1.1-pro"}
  generated_degraded   BOOLEAN DEFAULT false,  -- true if fallback model was used

  error_message    TEXT,
  retry_count      INTEGER DEFAULT 0,
  draft_expires_at TIMESTAMPTZ,           -- set when status = draft

  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_books_user_id ON books(user_id);
CREATE INDEX idx_books_status ON books(status);
CREATE INDEX idx_books_user_status ON books(user_id, status);
CREATE INDEX idx_books_share_token ON books(share_token) WHERE share_token IS NOT NULL;

-- ─────────────────────────────────────────────
-- BOOK PAGES (granular, for per-page regen)
-- ─────────────────────────────────────────────
CREATE TABLE book_pages (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id          UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  page_number      INTEGER NOT NULL,

  text_content     TEXT,
  reading_level    DECIMAL(3,1),

  image_prompt     JSONB,                  -- EnrichedImagePrompt
  image_r2_key     TEXT,                   -- original PNG
  image_url        TEXT,                   -- CDN WebP URL
  image_seed       BIGINT,                 -- for deterministic regen

  layout_spec      JSONB,                  -- PageLayout

  qa_passed        BOOLEAN,
  qa_scores        JSONB,                  -- QualityScore
  regen_count      INTEGER DEFAULT 0,

  -- Bookmarks (stored denormalized per-page per-user via books.bookmarks JSONB)
  -- See books table; no separate bookmarks table needed at this scale

  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now(),

  UNIQUE(book_id, page_number)
);
CREATE INDEX idx_book_pages_book_id ON book_pages(book_id);

-- ─────────────────────────────────────────────
-- CHARACTER CARDS (reusable across series)
-- ─────────────────────────────────────────────
CREATE TABLE character_cards (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  child_profile_id UUID REFERENCES child_profiles(id) ON DELETE SET NULL,
  name             TEXT NOT NULL,
  card             JSONB NOT NULL,         -- CharacterCard
  visual_anchor    TEXT NOT NULL,          -- canonical prompt fragment
  lora_weights     TEXT,                   -- R2 key to LoRA weights (Phase 2)
  lora_trained_at  TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_character_cards_user_id ON character_cards(user_id);

-- ─────────────────────────────────────────────
-- BOOK SERIES
-- ─────────────────────────────────────────────
CREATE TABLE series (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  character_card_id UUID REFERENCES character_cards(id) ON DELETE SET NULL,
  book_ids         UUID[] NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_series_user_id ON series(user_id);

-- ─────────────────────────────────────────────
-- CREDIT TRANSACTIONS
-- ─────────────────────────────────────────────
CREATE TABLE credit_transactions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id),
  book_id          UUID REFERENCES books(id) ON DELETE SET NULL,
  amount           INTEGER NOT NULL,       -- negative = deduct; positive = add
  balance_after    INTEGER NOT NULL,       -- snapshot of balance after transaction
  reason           TEXT NOT NULL,
  -- reason enum: 'book_creation' | 'regen_page' | 'refund_generation_failure'
  --              | 'purchase' | 'subscription_grant' | 'promotional_grant' | 'admin_adjustment'
  stripe_payment_id TEXT,
  created_at       TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_credit_tx_user_id ON credit_transactions(user_id);
CREATE INDEX idx_credit_tx_book_id ON credit_transactions(book_id);

-- ─────────────────────────────────────────────
-- SUBSCRIPTIONS
-- ─────────────────────────────────────────────
CREATE TABLE subscriptions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_customer_id    TEXT NOT NULL,
  stripe_subscription_id TEXT UNIQUE,
  plan             TEXT NOT NULL,          -- matches users.plan
  status           TEXT NOT NULL,          -- 'active' | 'past_due' | 'cancelled' | 'trialing'
  current_period_start TIMESTAMPTZ,
  current_period_end   TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN DEFAULT false,
  cancelled_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now(),

  UNIQUE(user_id)                          -- one active subscription per user
);
CREATE INDEX idx_subscriptions_stripe_customer ON subscriptions(stripe_customer_id);

-- ─────────────────────────────────────────────
-- AGENT AUDIT LOG
-- ─────────────────────────────────────────────
CREATE TABLE agent_logs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id          UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  agent            TEXT NOT NULL,          -- agent name
  step             TEXT NOT NULL,          -- pipeline step
  provider         TEXT,                   -- 'anthropic' | 'openai' | 'fal-ai' | 'gemini'
  model            TEXT,                   -- model name used
  duration_ms      INTEGER,
  tokens_input     INTEGER,
  tokens_output    INTEGER,
  cost_usd         DECIMAL(10, 6),
  attempt          INTEGER NOT NULL DEFAULT 1,
  status           TEXT NOT NULL,          -- 'success' | 'error' | 'retry'
  error            TEXT,
  trace_id         TEXT,                   -- OTel trace ID for correlation
  created_at       TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_agent_logs_book_id ON agent_logs(book_id);
CREATE INDEX idx_agent_logs_trace_id ON agent_logs(trace_id);
CREATE INDEX idx_agent_logs_created_at ON agent_logs(created_at DESC);

-- ─────────────────────────────────────────────
-- BOOK BOOKMARKS (denormalized into user_book_state)
-- ─────────────────────────────────────────────
CREATE TABLE user_book_states (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id          UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  last_page        INTEGER NOT NULL DEFAULT 1,
  bookmarks        INTEGER[] NOT NULL DEFAULT '{}',
  updated_at       TIMESTAMPTZ DEFAULT now(),

  UNIQUE(user_id, book_id)
);

-- ─────────────────────────────────────────────
-- IDEMPOTENCY KEYS (short-lived, in Redis is better — but DB fallback)
-- ─────────────────────────────────────────────
-- Handled in Redis (TTL 24h), not PostgreSQL.
-- See §4 Queues for implementation.
```

## 5.3 Index Strategy

Beyond the indexes defined in the schema, these compound indexes matter for query performance:

```sql
-- Dashboard: get all books for a user, ordered by creation date
CREATE INDEX idx_books_user_created ON books(user_id, created_at DESC)
  WHERE status != 'failed';

-- Admin: find books by status and date range
CREATE INDEX idx_books_status_created ON books(status, created_at DESC);

-- Credit ledger: user balance calculation (sum of all transactions)
CREATE INDEX idx_credit_tx_user_created ON credit_transactions(user_id, created_at DESC);

-- Agent cost reporting: aggregate by date
CREATE INDEX idx_agent_logs_date ON agent_logs(DATE(created_at), agent);
```

## 5.4 JSONB Column Access Patterns

JSONB columns store agent outputs. Common access patterns:

```sql
-- Get book title from story_plan JSONB
SELECT story_plan->>'title' FROM books WHERE id = $1;

-- Get all page text content for a book
SELECT text_content FROM book_pages WHERE book_id = $1 ORDER BY page_number;

-- Get specific quality score
SELECT qa_scores->'scores'->>'characterConsistency'
FROM book_pages WHERE book_id = $1 AND page_number = $2;
```

GIN indexes on JSONB columns are not added at Phase 1. Add them if specific JSONB field searches are needed.

## 5.5 Soft Deletion

Users are never hard-deleted on request — they are soft-deleted (GDPR right-to-be-forgotten requires data erasure, but we comply by clearing PII, not by deleting rows):

On account deletion:
1. Set `users.deactivated_at = now()`
2. Null out `users.email`, `users.name`, `users.password_hash`, `users.oauth_id` (replace with `REDACTED_{userId}`)
3. Delete all `child_profiles` (PII)
4. Set `books.request` JSONB PII fields to null (child name, appearance)
5. Delete from `refresh_tokens`
6. Cancel active subscription in Stripe
7. Keep `books` rows for financial audit purposes (credit_transactions, payment records)

## 5.6 Migrations

All schema changes go through Prisma migrations:

```bash
# Development
npx prisma migrate dev --name add_user_locale

# Production (CI/CD)
npx prisma migrate deploy
```

**Migration rules:**
- Never drop a column in the same migration that removes it from code — remove code in deploy N, remove column in deploy N+1 (backward compatibility window)
- Always add columns as nullable or with a default value (no `NOT NULL` without a default on existing tables)
- Every migration must have a rollback plan documented in a comment at the top of the migration file

## 5.7 Connection Pooling

**Development:** Direct Prisma connection (no pooler)

**Production:** PgBouncer in transaction pooling mode:
```
min_pool_size = 5
max_pool_size = 100
pool_mode = transaction
server_idle_timeout = 600
```

NestJS app connects to PgBouncer, not PostgreSQL directly. Prisma is configured to use PgBouncer with `?pgbouncer=true` in the connection string.

---

# 6. Auth

## 6.1 Token Architecture

```
Access Token (JWT):
  Algorithm:  HS256
  Secret:     JWT_SECRET (64+ char random string)
  Lifetime:   15 minutes
  Payload:    { sub: userId, email, plan, role, iat, exp }
  Storage:    Browser memory only (AuthStore, never localStorage)
  Transport:  Authorization: Bearer <token>

Refresh Token:
  Algorithm:  Random 64-byte hex string (not a JWT)
  Storage:    HttpOnly Secure cookie (browser); bcrypt hash in refresh_tokens table
  Lifetime:   7 days
  Cookie:     storyme_refresh; Path=/api/auth; SameSite=Strict; HttpOnly; Secure
```

## 6.2 Registration Flow

```
POST /api/auth/register { email, password, name }

1. Validate email format and password strength (min 8 chars, 1 uppercase, 1 number)
2. Check email uniqueness → 409 if taken
3. Hash password with bcrypt (rounds: 12)
4. Create user record (plan: 'free', credits: 3)
5. Send verification email (email_verified: false initially)
6. Generate access token + refresh token
7. Store hashed refresh token in refresh_tokens table
8. Set refresh cookie
9. Return { accessToken, user: UserProfile }

Note: User can use the app immediately. Email verification is required
only for certain actions (e.g., changing subscription email).
```

## 6.3 Login Flow

```
POST /api/auth/login { email, password }

1. Find user by email → 401 if not found (generic message — don't leak email existence)
2. Check password_hash with bcrypt.compare()
3. If no password_hash (OAuth user): return 401 with message "Please sign in with Google/Apple"
4. Issue access token + refresh token
5. Set refresh cookie
6. Return { accessToken, user: UserProfile }

Rate limit: 10 login attempts per 15 minutes per IP address
After 10 failures: 429 with Retry-After: 900
```

## 6.4 Refresh Token Rotation

```
POST /api/auth/refresh
  Cookie: storyme_refresh=<token>

1. Extract token from cookie
2. Hash it with bcrypt and look up in refresh_tokens table
3. If not found → 401 (token already used or never existed)
4. If found and revoked_at IS NOT NULL → REUSE DETECTED:
   a. Revoke ALL tokens in the same family (the entire chain is compromised)
   b. Return 401 with message "Session expired, please sign in again"
5. If found and expired_at < now() → 401
6. Mark the old token as revoked (set revoked_at = now())
7. Generate new refresh token + access token
8. Store new hashed refresh token in same family
9. Set new refresh cookie
10. Return { accessToken, user: UserProfile }
```

**Token family:** When a user first logs in, a UUID is generated as the `family` ID. All subsequent refresh tokens for that session belong to the same family. If a compromised token is replayed (reuse detected), the entire family is revoked, forcing re-authentication. This stops refresh token theft even after the attacker has used the token once.

## 6.5 Google OAuth Flow

```
GET /api/auth/google
  → Redirect to Google OAuth consent screen

GET /api/auth/google/callback?code=...
  1. Exchange code for Google user profile
  2. Look up user by (oauth_provider='google', oauth_id=googleId)
  3. If not found: create user (email_verified=true, no password_hash)
  4. If found: proceed to token issuance
  5. Issue access token + refresh token
  6. Redirect to /oauth/callback?accessToken=<token>&user=<encoded>
     (short-lived query param; BFF page immediately moves to memory store and clears URL)
```

Apple Sign-In follows the same pattern. Apple provides `idToken` (a JWT); the backend verifies it with Apple's public keys before trusting the user identity.

## 6.6 JWT Validation Guard

The `JwtAuthGuard` is the primary auth mechanism. It:
1. Extracts the `Authorization: Bearer <token>` header
2. Verifies the JWT signature with `JWT_SECRET`
3. Checks expiry (`exp` claim)
4. Loads the user from `users` table using `sub` claim (full user object, not just the JWT payload — this ensures plan and role are always fresh, not stale)
5. Attaches the user to `req.user`

**Token payload vs. database freshness:**
The JWT payload contains `plan` and `role` as cached values. However, the `JwtAuthGuard` re-fetches the user from the database on every request. This adds ~1ms per request but ensures:
- Plan upgrades take effect immediately (no need to re-login)
- Account deactivation takes effect immediately
- Role changes are immediate

The database user is cached in Redis for 5 minutes by `userId` to avoid per-request DB hits under load.

## 6.7 Plan Gate Guard

The `PlanGateGuard` runs after `JwtAuthGuard` on routes that require a paid plan:

```typescript
@Get('download/pdf')
@RequirePlan('paid')  // custom decorator
@UseGuards(JwtAuthGuard, PlanGateGuard)
downloadPdf() { ... }
```

`PlanGateGuard` checks `req.user.plan` against the decorator's required plan. If the user's plan is insufficient, it returns 403 with `{ error: { code: 'PLAN_UPGRADE_REQUIRED', requiredPlan: 'paid' } }`.

Plan hierarchy for gate checks:
```
free < pay_per_book < family < annual = educator
```

## 6.8 Logout

```
POST /api/auth/logout
  Cookie: storyme_refresh=<token>

1. Extract token from cookie
2. Revoke it in refresh_tokens table (set revoked_at = now())
3. Clear the cookie (Max-Age=0)
4. Return 204 No Content

Note: The access token cannot be revoked (it's stateless).
It will naturally expire in ≤15 minutes.
The client clears it from memory immediately on logout.
```

## 6.9 Email Verification

When a user registers with email+password:
1. Generate a 64-byte hex verification token
2. Store it in Redis with key `email_verify:{token}` → `userId`, TTL 24 hours
3. Send email with link to `/verify-email/{token}`
4. On GET `/api/auth/verify-email/:token`:
   - Look up token in Redis
   - If found: set `users.email_verified = true`, delete Redis key
   - If not found or expired: 400 "Verification link expired"

## 6.10 Password Reset

1. POST `/api/auth/forgot-password { email }`
   - Always return 200 (don't confirm whether email exists — prevents email enumeration)
   - If user exists: generate token → store in Redis `password_reset:{token}` → `userId`, TTL 1 hour
   - Send reset email

2. POST `/api/auth/reset-password { token, newPassword }`
   - Look up token in Redis
   - If found: update `password_hash`, revoke all `refresh_tokens` for that user, delete Redis key
   - Return 200

---

# 7. Billing

## 7.1 Stripe Architecture

StoryMe uses Stripe for:
- One-time payments (single book purchase, $12.99)
- Subscriptions (Family $9.99/mo, Annual $79.99/yr, Educator $49.99/yr)
- Payment method management
- Apple Pay / Google Pay (via Stripe Payment Request Button)
- Subscription lifecycle (renewal, failure, cancellation)

The Stripe integration runs in the NestJS `BillingModule`. The frontend's BFF proxies billing calls to the NestJS API and never calls Stripe directly. The Stripe secret key never reaches the browser.

## 7.2 Stripe Product / Price IDs

These are configured in environment variables, not hardcoded:

```
STRIPE_PRICE_SINGLE      price_xxx   One-time, $12.99
STRIPE_PRICE_MONTHLY     price_xxx   Recurring monthly, $9.99
STRIPE_PRICE_ANNUAL      price_xxx   Recurring annual, $79.99
STRIPE_PRICE_EDUCATOR    price_xxx   Annual, $49.99
```

The Stripe Dashboard holds the canonical price definitions. Environment variables reference the IDs. Changing a price requires creating a new Price ID in Stripe and updating the environment variable — never modifying an existing Price ID.

## 7.3 Checkout Flow

**Single book purchase:**
```
POST /api/billing/checkout { priceId: 'price_single', bookId: '...' }

1. Get or create Stripe Customer for this user (store stripe_customer_id in subscriptions table)
2. Create Stripe PaymentIntent with:
   - amount: 1299 (cents)
   - currency: 'usd'
   - customer: stripeCustomerId
   - metadata: { userId, bookId, priceId }
   - idempotencyKey: clientProvidedKey
3. Return { clientSecret } to BFF
4. Frontend uses Stripe Elements to complete payment (never touches server again until webhook)
```

**Subscription checkout:**
```
POST /api/billing/checkout { priceId: 'price_monthly' }

1. Get or create Stripe Customer
2. Create Stripe Checkout Session (redirect-based, for complex subscription flows):
   - mode: 'subscription'
   - line_items: [{ price: priceId, quantity: 1 }]
   - success_url: https://storyme.app/dashboard?checkout=success
   - cancel_url: https://storyme.app/checkout
   - customer: stripeCustomerId
   - metadata: { userId }
3. Return { checkoutUrl } — frontend redirects to Stripe-hosted checkout
```

## 7.4 Stripe Webhook Handler

The webhook handler receives all Stripe events. The endpoint `/api/billing/webhook` is:
- Public (no auth guard) — Stripe calls it from their servers
- Protected by `stripe.webhooks.constructEvent()` signature verification using `STRIPE_WEBHOOK_SECRET`
- Idempotent — Stripe may deliver the same event multiple times

**Events handled:**

| Stripe Event | Action |
|---|---|
| `payment_intent.succeeded` | Mark book as paid (`books.is_paid = true`), grant download access |
| `payment_intent.payment_failed` | No action (user sees failure in Stripe Elements) |
| `checkout.session.completed` | For subscription: create `subscriptions` record, update `users.plan`, grant credits |
| `invoice.payment_succeeded` | Subscription renewal: confirm plan stays active, grant monthly credits |
| `invoice.payment_failed` | Update subscription status to `past_due`; send dunning email |
| `customer.subscription.deleted` | Subscription cancelled: revert user.plan to 'free' after period end |
| `customer.subscription.updated` | Plan change: update `subscriptions` and `users.plan` |

**Webhook processing is idempotent:** Each event has a Stripe `event.id`. On receipt:
1. Check Redis for key `stripe_event:{eventId}` — if exists, return 200 immediately (already processed)
2. Process the event
3. Set Redis key `stripe_event:{eventId}` with TTL 7 days
4. Return 200

Always return 200 to Stripe even on internal errors (otherwise Stripe retries for 3 days). Log the error to Sentry for investigation.

> **Correction (Phase E3 — the actual implementation):** the rest of this
> section (§7.4) describes an aspirational design that predates any real
> code and was never built as written — no Redis dedupe-by-`event.id`, no
> Sentry, and only `checkout.session.completed` for one-time purchases is
> handled (payment_intent/invoice/subscription events are unimplemented). The
> "always return 200 even on internal errors" guidance above is also
> **deliberately not followed**: the real webhook returns a non-2xx response
> on a genuine transient Stripe/DB failure so Stripe retries, and only
> acknowledges 200 once a grant is durably committed (or was already a
> no-op). See [apps/api/docs/credits.md, "Phase E3"](apps/api/docs/credits.md#phase-e3-stripe-checkout-credit-purchases-and-idempotent-webhooks)
> for what's actually implemented.

## 7.5 Credit System

Credits are consumed when:
- Book creation starts (not when it completes) → immediately deducted to prevent race conditions
- If generation fails: credits are refunded via a compensating transaction

Credit amounts:
- Free plan: 3 credits on registration (once, non-renewing)
- Pay-per-book: no credits; payment via Stripe at time of generation
- Family plan: 10 credits/month (granted on subscription renewal)
- Annual plan: 10 credits/month (granted on each monthly anniversary)
- Educator plan: 30 credits/month

Credit balance is in `users.credits`. All changes are transactional:
```sql
BEGIN;
UPDATE users SET credits = credits - 1 WHERE id = $userId AND credits >= 1;
INSERT INTO credit_transactions (user_id, book_id, amount, balance_after, reason)
  VALUES ($userId, $bookId, -1, (SELECT credits FROM users WHERE id = $userId), 'book_creation');
COMMIT;
```

If the `UPDATE` affects 0 rows (credits = 0), the transaction rolls back and the API returns 402 Payment Required.

## 7.6 Subscription Lifecycle

```
New subscriber:
  stripe checkout.session.completed
    → create subscriptions row
    → users.plan = 'family'
    → grant monthly credits

Monthly renewal:
  stripe invoice.payment_succeeded
    → subscriptions.current_period_start/end updated
    → grant monthly credits
    → send receipt email (optional)

Payment failure:
  stripe invoice.payment_failed
    → subscriptions.status = 'past_due'
    → in-app banner shown (frontend polls /api/billing/status)
    → Stripe Smart Retries (automatic — up to 4 retries over 3 weeks)

All retries fail:
  stripe customer.subscription.deleted
    → users.plan = 'free'
    → subscriptions.status = 'cancelled'
    → send "subscription cancelled" email

Voluntary cancellation:
  POST /api/billing/cancel
    → stripe.subscriptions.update(id, { cancel_at_period_end: true })
    → subscriptions.cancel_at_period_end = true
    → user retains plan until current_period_end
    → send "subscription cancelled, active until {date}" email
```

---

# 8. PDF Generation

## 8.1 Dual-PDF Strategy

StoryMe produces two distinct PDFs:

| PDF | Generator | Purpose | Resolution | Watermark |
|---|---|---|---|---|
| Preview PDF (3 pages) | PDFKit (server) | Paywall preview | Screen (72dpi) | Yes — large diagonal "Preview" |
| Full PDF (print-ready) | PDFKit (server) | Download / print-on-demand | 300dpi | No |
| Browser Preview | @react-pdf/renderer (client) | Instant in-reader preview | Screen | No |

The browser preview (React PDF) is for UI purposes only — it renders quickly in the browser using the same `PageLayout[]` data and does not require a server round-trip. The final downloadable PDF is always the server-rendered version.

## 8.2 Server PDF Renderer (PDFKit)

The `PDFRenderAgent` runs as a BullMQ worker in Node.js. It uses **PDFKit** (pure Node.js PDF generation) — no headless browser (Puppeteer/Playwright), no canvas, no external dependencies that need a display.

**Why PDFKit, not Puppeteer?**
Puppeteer renders HTML → PDF, which requires a full browser (Chromium) in the container. This uses ~1GB RAM per job. PDFKit renders directly to PDF primitives (text, image, paths) using ~100MB RAM per job. At PDF-render queue concurrency of 4, that is 400MB vs. 4GB — a significant infrastructure difference.

**Page rendering sequence per page:**
1. Set page dimensions (210mm × 148mm for A5, or 8.5in × 11in for US Letter — configured per request)
2. Draw background decoration (if any) — SVG border fetched from R2 asset library
3. Load page image from R2 (PNG, original resolution)
4. Embed image in the `imageRegion` bounding box from `PageLayout`
5. Set font (loaded from R2 asset library — embedded in PDF for proper rendering)
6. Render text content in the `textRegion` with the specified `fontSize`, `fontFamily`, `lineHeight`
7. For the dedication page: use Lora Italic, centered, with decorative top/bottom rules

**Book front matter:**
- Page 1: Full-bleed cover (cover.png)
- Page 2: Title page (title, author "Written for {childName}", subtitle)
- Page 3: Dedication (if provided)
- Pages 4+N: Story pages
- Final page: "The End" + StoryMe branding + share QR code (generated with qrcode npm package)

**Output:**
- Uploaded to R2 at `books/{bookId}/book.pdf`
- CDN URL stored in `books.pdf_url`
- Separate preview PDF (pages 1–3, watermarked) uploaded to `books/{bookId}/book-preview.pdf`

## 8.3 PDF Specifications

| Property | Screen PDF | Print PDF |
|---|---|---|
| Page size | 8.5in × 11in (US Letter) | 8.5in × 11in + 0.125in bleed |
| Resolution | 72dpi images (WebP) | 300dpi images (PNG original) |
| Color profile | sRGB | sRGB (CMYK conversion: Phase 3) |
| Fonts | Embedded (subset) | Fully embedded |
| File size | ~2–4MB | ~8–20MB |
| Compression | Level 9 | Level 6 |

**Why not CMYK at Phase 1?** CMYK conversion requires a color profile library (Little CMS or ImageMagick). This adds complexity and a large binary dependency to the PDF worker. Phase 1 targets digital delivery only; print-on-demand (Phase 2/3) will add CMYK conversion.

## 8.4 Font Embedding

Fonts are embedded in the PDF at render time. The font files are stored in R2 at `assets/fonts/`:
- `Plus-Jakarta-Sans-Regular.ttf`
- `Plus-Jakarta-Sans-Bold.ttf`
- `Lora-Regular.ttf`
- `Lora-Italic.ttf`
- `Andika-Regular.ttf` (for young readers)
- `Scheherazade-New-Regular.ttf` (Phase 3, RTL)

PDFKit subsetting (using `fontkit`) ensures only the Unicode characters used in the book are embedded, keeping file size manageable even for non-Latin scripts.

## 8.5 Page Image Embedding

Full-resolution PNG images from R2 are used in the print PDF (not WebP — PDFKit embeds PNGs natively). The image download from R2 during PDF rendering is the slowest step. Optimization:
- All page images are downloaded in parallel before rendering begins (not sequentially)
- Downloads use signed R2 URLs (internal, not CDN URLs — avoids CDN overhead)
- Progress is not reported during the PDF step (it's fast once images are downloaded)

## 8.6 Error Handling in PDF Render

If a page image is missing (failed to generate earlier):
- Render a placeholder image (a soft-colored rectangle with the StoryMe logo and "Illustration for page N")
- Continue rendering the rest of the book
- Mark `books.generated_degraded = true`
- Note this in the user-facing delivery email

The PDF is always delivered, even if one page is missing an illustration. Partial delivery is better than total failure.

---

# 9. Storage

## 9.1 Cloudflare R2 Bucket Structure

```
Bucket: ai-children-books-prod

books/
  {bookId}/
    cover.png                  # Original 1024×1536 PNG cover
    cover-thumb.webp           # 300×450 WebP thumbnail (CDN-served)
    book.pdf                   # Print-quality PDF (~8–20MB)
    book-preview.pdf           # First 3 pages, watermarked (~2MB)
    images/
      page-01.png              # Original PNG (full resolution, 2048px wide)
      page-01.webp             # Optimized WebP (CDN-served, 1024px wide)
      page-02.png
      page-02.webp
      ...
      page-32.png
      page-32.webp
    epub/                      # Phase 2
      book.epub

characters/
  {characterCardId}/
    reference.png              # Character reference sheet (generated)
    lora/                      # Phase 2
      weights.safetensors

assets/
  fonts/
    Plus-Jakarta-Sans-Regular.ttf
    Plus-Jakarta-Sans-Bold.ttf
    Lora-Regular.ttf
    Lora-Italic.ttf
    Andika-Regular.ttf
  decorations/
    border-stars.svg
    border-flowers.svg
    border-mountains.svg
    border-plain.svg
  templates/
    dedication-template.pdf    # Base dedication page template
```

## 9.2 Storage Service

The `StorageService` is the single abstraction for all R2 operations. No code outside this service calls the R2 SDK directly.

```typescript
class StorageService {
  async uploadBuffer(key: string, buffer: Buffer, contentType: string): Promise<void>
  async uploadStream(key: string, stream: Readable, contentType: string): Promise<void>
  async downloadBuffer(key: string): Promise<Buffer>
  async generateSignedUrl(key: string, expiresInSeconds: number): Promise<string>
  async deleteObject(key: string): Promise<void>
  async listObjects(prefix: string): Promise<string[]>
  async objectExists(key: string): Promise<boolean>

  // Helpers
  buildBookKey(bookId: string, filename: string): string
  buildCdnUrl(key: string): string     // CDN_BASE_URL + '/' + key
}
```

**R2 SDK configuration:**
```typescript
const s3Client = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY,
    secretAccessKey: R2_SECRET_KEY,
  },
})
```

R2 is S3-compatible, so the AWS SDK v3 S3Client works with the R2 endpoint.

## 9.3 Access Patterns

| Asset | Visibility | How served | Auth required |
|---|---|---|---|
| Cover thumbnail (webp) | Public | CDN direct | No |
| Page images (webp) | Public | CDN direct | No |
| Full PDF | Private | Signed URL (24h expiry) | Yes (ownership check) |
| Preview PDF (3 pages, watermarked) | Public | CDN or signed URL | No |
| Original PNG images | Private | Internal only (PDF rendering) | Service-to-service |
| LoRA weights | Private | Internal only | Service-to-service |
| Font assets | Private | Internal only (PDF rendering) | Service-to-service |

**Why are page images public?** The reader loads them directly from the CDN. Authentication for individual images would require a signed URL for every page on every read, adding server load and breaking CDN caching. The trade-off: images are technically accessible without auth if you know the URL pattern. This is acceptable because:
1. Book URLs (`/book/{bookId}`) require auth to discover
2. Shared books intentionally have public access
3. Thumbnails are not the paid deliverable (the PDF is)

**Why are PDFs private (signed URLs)?** PDFs are the paid deliverable. They are never served publicly from the CDN. Every download request goes through the API, which:
1. Verifies authentication
2. Verifies book ownership
3. Verifies `books.is_paid = true` (for paid tiers)
4. Generates a short-lived (24h) signed R2 URL
5. Returns the signed URL to the client (the client downloads directly from R2, not via our server)

## 9.4 Image Optimization Pipeline

After each image is received from fal.ai:

```
fal.ai returns URL → download PNG → Sharp processing → upload to R2

Sharp pipeline (per image):
1. Load PNG buffer
2. Resize to 2048px wide (preserving aspect ratio) — original is typically 4096px+
3. Save as PNG to R2 (original quality, for print PDF)
4. Resize to 1024px wide
5. Convert to WebP (quality: 88, effort: 4)
6. Save as WebP to R2 (for CDN delivery / reader)

Cover image variant:
7. Resize to 300×450px, WebP (quality: 80)
8. Save as cover-thumb.webp
```

All Sharp operations run in the `ImageGenerationAgent` worker after the fal.ai response. The agent does not complete its job until both PNG and WebP are uploaded to R2.

## 9.5 R2 Lifecycle and Cleanup

**Book deletion:**
When a user deletes a book (`DELETE /api/books/:id`), all R2 objects for that book are deleted:
1. List all objects with prefix `books/{bookId}/`
2. Delete all listed objects in a batch (R2 supports batch delete)
3. Delete the `books` record and cascade-delete `book_pages`

This is done synchronously in the delete request handler (not in a background job) because the user expects the book to be gone immediately.

**Failed generation cleanup:**
Books that fail generation leave partial R2 objects (some images were uploaded before failure). A nightly cleanup job (BullMQ scheduled job):
1. Find all `books` with `status = 'failed'` and `created_at < now() - 7 days`
2. Delete their R2 objects
3. Keep the DB record (for audit/cost analysis)

**Storage cost monitoring:**
Track total R2 object count and size in the admin stats endpoint. Alert if per-book average storage exceeds 100MB.

## 9.6 Photo Upload Flow

When a user uploads a reference photo in the wizard:

```
Browser → POST /api/upload/photo (BFF) → POST /api/upload/photo (NestJS)

1. BFF receives multipart upload (next.js route handler)
2. Forwards raw bytes to NestJS
3. NestJS validates:
   - File type: JPEG, PNG, HEIC only
   - File size: max 10MB
   - Image dimensions: min 200×200px
4. Run face detection (using Sharp + a simple CV check, or an external API)
   - If no face detected: 422 "No face detected — please upload a clear photo"
5. Resize to 512×512 (face crop, centered)
6. Upload to R2: characters/{userId}/reference-{timestamp}.png
7. Return { photoUrl: signedCdnUrl }
```

The signed URL is stored in the wizard draft and later in `child_profiles.photo_r2_key`.

---

# 10. Observability

## 10.1 Three Pillars

| Pillar | Tool | Purpose |
|---|---|---|
| Structured Logging | Winston + Loki (Grafana) | Request logs, agent logs, error logs |
| Metrics | Prometheus + Grafana | System health, business KPIs, queue depth |
| Distributed Tracing | OpenTelemetry + Grafana Tempo | End-to-end trace of book generation pipeline |
| Error Tracking | Sentry | Exceptions with stack traces and context |
| Uptime Monitoring | Checkly | Synthetic tests from multiple regions |

## 10.2 Structured Logging

**All logs are JSON-structured.** No unstructured log strings in production.

Log format:
```json
{
  "timestamp": "2026-06-30T12:00:00.000Z",
  "level": "info",
  "service": "api",
  "requestId": "req_abc123",
  "userId": "usr_xxx",
  "bookId": "bk_xxx",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "message": "Book generation started",
  "agent": "orchestrator",
  "duration_ms": 12
}
```

**Log levels:**
- `error`: Exceptions, failed operations, retries exhausted
- `warn`: Retries in progress, rate limits approaching, degraded fallback used
- `info`: Request start/end, agent start/complete, state transitions
- `debug`: Full request/response bodies (development only — never in production)

**What is always logged:**
- Every HTTP request: method, path, status, duration, userId, requestId
- Every agent run: agent name, bookId, step, duration, tokens used, cost, status
- Every queue job: queue name, jobId, bookId, attempt number, status
- Every retry: what failed, which attempt, backoff duration

**What is never logged:**
- Passwords or tokens (anywhere in any form)
- Full request/response bodies in production
- Personally identifiable information (child names, photos) — book IDs only

**Winston transport configuration (production):**
- Console (for container stdout → collected by Kubernetes log agent)
- Loki push (directly to Grafana Loki via HTTP transport)

## 10.3 Metrics

Metrics are emitted via OpenTelemetry Metrics SDK and scraped by Prometheus.

**System metrics (auto-instrumented by NestJS + OTel):**
- HTTP request rate, latency (p50, p95, p99), error rate
- Database query latency (via Prisma instrumentation)
- Redis latency

**Application metrics (custom, emitted by the application code):**

```
# Queue metrics (per queue)
bullmq_queue_depth{queue}          # jobs waiting
bullmq_active_jobs{queue}          # jobs currently processing
bullmq_completed_jobs_total{queue} # counter
bullmq_failed_jobs_total{queue}    # counter
bullmq_job_duration_seconds{queue} # histogram

# Generation pipeline metrics
books_generation_started_total
books_generation_completed_total
books_generation_failed_total
books_generation_duration_seconds  # histogram by book length
books_partial_delivery_total       # books delivered with ≥1 failed page

# AI provider metrics
ai_provider_calls_total{provider, model, agent}
ai_provider_errors_total{provider, model, agent, error_type}
ai_provider_latency_seconds{provider, model, agent}
ai_provider_tokens_total{provider, model, direction} # direction: input|output
ai_provider_cost_usd_total{provider, model}

# Business metrics
users_registered_total
books_paid_total
credits_consumed_total
stripe_revenue_usd_total
```

**Prometheus scrape config:**
```yaml
scrape_configs:
  - job_name: 'storyme-api'
    static_configs:
      - targets: ['api:4000']
    metrics_path: '/metrics'
```

## 10.4 Distributed Tracing

Every book generation creates a single distributed trace that spans all 9 agents. This is the primary debugging tool for pipeline failures.

**Trace structure:**
```
[Trace: book_abc123 generation]
│
├── [Span: POST /api/books] 12ms
├── [Span: Orchestrator.startPipeline] 5ms
├── [Span: CharBuilderAgent] 2400ms
│   └── [Span: anthropic.call] 2350ms
├── [Span: StoryPlannerAgent] 8200ms
│   └── [Span: anthropic.call (with thinking)] 8100ms
├── [Span: ChapterWriterAgent.Chapter1] 3100ms  ─┐
├── [Span: ChapterWriterAgent.Chapter2] 2900ms   │ parallel
├── [Span: ChapterWriterAgent.Chapter3] 3200ms  ─┘
├── [Span: IllustPromptAgent.pages 1-32]          # fanned out
│   ├── [Span: page-1] 800ms
│   ├── [Span: page-2] 750ms
│   └── ...
├── [Span: CharConsistencyAgent] 1200ms
├── [Span: ImageGenAgent.pages 1-32]              # parallel, rate-limited
│   ├── [Span: page-1] 8000ms (fal.ai call)
│   └── ...
├── [Span: QualityReviewAgent.pages 1-32]         # parallel
├── [Span: LayoutAgent.pages 1-32]                # parallel
└── [Span: PDFRenderAgent] 12000ms
    ├── [Span: download-images] 3000ms (parallel downloads)
    └── [Span: render-pdf] 9000ms
```

**Trace propagation:**
The `traceId` is generated when the book creation API request is received. It is:
1. Added to the BullMQ job data as `job.data.traceId`
2. Propagated via W3C Trace Context headers in all internal service-to-service calls
3. Stored in `agent_logs.trace_id` for SQL-level correlation
4. Returned in the API response as `meta.traceId` (for debug purposes)

**Grafana Tempo query for a book's full trace:**
```
{traceId="4bf92f3577b34da6a3ce929d0e0e4736"}
```

## 10.5 Error Tracking (Sentry)

**Sentry setup:**
```typescript
// main.ts
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
  tracesSampleRate: 0.1,      // 10% of traces sent to Sentry (rest go to Tempo)
  profilesSampleRate: 0.05,
  integrations: [
    new Sentry.Integrations.Http({ tracing: true }),
    new PrismaInstrumentation(),
  ],
  beforeSend(event) {
    // Strip PII from error context
    delete event?.user?.email
    delete event?.extra?.childName
    return event
  },
})
```

**What goes to Sentry:**
- All unhandled exceptions (NestJS global exception filter captures these)
- AI provider errors (when all retries are exhausted)
- Database errors
- R2 operation failures
- Stripe webhook processing failures

**Sentry alert rules:**
- Any `error` level event → Sentry issue created → Slack `#backend-alerts`
- Error rate >1% → PagerDuty page

## 10.6 Health Check Endpoints

```
GET /health                  # Overall health (used by Kubernetes liveness probe)
GET /health/ready            # Readiness (used by Kubernetes readiness probe)
GET /health/deep             # Deep health check (DB, Redis, R2, AI providers)
```

**Liveness probe** (`/health`):
Returns 200 if the process is running. Never fails unless the process is deadlocked.

**Readiness probe** (`/health/ready`):
Checks:
- PostgreSQL connection: `SELECT 1`
- Redis connection: `PING`
Returns 503 if either fails (Kubernetes removes the pod from load balancer rotation).

**Deep health check** (`/health/deep`):
- PostgreSQL: `SELECT 1`
- Redis: `PING`
- R2: `HeadObject` on a canary test object
- Anthropic API: simple 1-token completion
- fal.ai: `/health` endpoint
Returns full status JSON with each component's status and latency.

Deep health is not used by Kubernetes — it is used by Checkly for synthetic monitoring and on-call runbooks.

## 10.7 Alerting

**Alerting stack:** Prometheus Alertmanager → PagerDuty (P1) / Slack (P2/P3)

| Alert | Condition | Severity | Channel |
|---|---|---|---|
| API error rate high | HTTP 5xx rate > 1% for 5 minutes | P1 | PagerDuty |
| Book generation failure rate high | `books_generation_failed_total` rate > 5% of `books_generation_started_total` | P1 | PagerDuty |
| Queue depth critical | `bullmq_queue_depth{queue="agent:image-gen"} > 500` | P2 | Slack |
| AI provider errors | `ai_provider_errors_total` rate > 10% for any provider for 5 minutes | P2 | Slack |
| Database latency | p99 query latency > 500ms for 5 minutes | P2 | Slack |
| PDF generation stuck | `bullmq_active_jobs{queue="agent:pdf-render"}` unchanged for 15 minutes | P2 | Slack |
| Storage failures | R2 error rate > 1% | P1 | PagerDuty |
| Stripe webhook failures | `stripe_webhook_errors_total` rate > 0 | P2 | Slack |
| High memory (worker pods) | container memory > 80% of limit | P3 | Slack |

## 10.8 Admin Dashboard Metrics

The `/api/admin/stats` endpoint exposes business metrics for the admin dashboard:

```json
{
  "books": {
    "totalCreated": 12400,
    "completedToday": 340,
    "failedToday": 12,
    "inProgress": 45,
    "avgGenerationTimeMs": 180000
  },
  "revenue": {
    "totalUsd": 48200.00,
    "thisMonthUsd": 8400.00,
    "activeSubscriptions": 312
  },
  "pipeline": {
    "avgCostPerBook": 0.71,
    "totalAiCostUsd": 8800.00,
    "byProvider": {
      "anthropic": 4200.00,
      "fal-ai": 3800.00,
      "openai": 800.00
    }
  },
  "storage": {
    "totalObjectCount": 285000,
    "totalSizeGb": 420
  }
}
```

This endpoint is cached in Redis for 5 minutes (it aggregates expensive queries).

---

## Appendix A — Backend Engineer Checklist

Before any new API endpoint or service is merged:

- [ ] All error responses follow the error envelope from §1.1
- [ ] HTTP status codes match the contract in §1.2
- [ ] No `any` types in TypeScript
- [ ] Input validated with Zod at the controller layer
- [ ] Auth guard applied (or explicitly documented as public)
- [ ] Plan gate applied where feature requires paid plan
- [ ] Idempotency key handled for state-mutating operations
- [ ] Rate limiting applied where appropriate
- [ ] Structured log emitted for every significant operation
- [ ] OpenTelemetry span created for operations > 100ms
- [ ] All DB operations use parameterized queries (Prisma handles this, no raw SQL with interpolation)
- [ ] Secrets never logged
- [ ] PII never logged
- [ ] New metrics defined and emitted for business-relevant operations
- [ ] Webhook handlers are idempotent
- [ ] Stripe calls use idempotency keys

---

## Appendix B — Local Development Setup

```bash
# 1. Clone the monorepo
git clone git@github.com:storyme/app.git
cd app

# 2. Install dependencies
pnpm install

# 3. Copy environment file
cp apps/api/.env.example apps/api/.env
# Fill in AI API keys from team's secret manager

# 4. Start infrastructure
docker compose up -d postgres redis

# 5. Run migrations
cd apps/api && npx prisma migrate dev

# 6. Seed development data
npx prisma db seed

# 7. Start the API
pnpm dev:api                    # apps/api

# 8. Start the workers (in a separate terminal)
pnpm dev:workers               # runs all agent workers locally

# 9. Optional: start Bull Board
pnpm bull-board                # admin at http://localhost:3001/admin/queues
```

**Development AI keys:**
- Use `claude-haiku-4-5-20251001` as the default model in `.env.local` to reduce cost during development
- Use fal.ai dev tier (rate-limited but free)
- Development Stripe keys (`sk_test_...`) are safe to use in local testing

---

*Document version 1.0 — StoryMe Backend Technical Design*
*This document is the engineering contract. Changes require RFC + approval from the Principal Backend Architect.*
