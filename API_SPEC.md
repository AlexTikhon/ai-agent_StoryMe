# API Specification

## StoryMe — HTTP, SSE, Webhook & Contract Reference

**Version 1.0 | June 2026**
**Prepared by: Staff API Architect | Authoritative engineering contract**

> This document is the single source of truth for all API surfaces in the StoryMe platform. It governs the contract between the Next.js frontend, the Next.js BFF layer, the NestJS backend, workers, Stripe webhooks, the AI generation system, the public shared reader, and future mobile clients. Do not implement endpoints that deviate from this spec without an RFC.

---

## Table of Contents

1. [API Design Principles](#1-api-design-principles)
2. [Base URLs & Versioning](#2-base-urls--versioning)
3. [Common Headers](#3-common-headers)
4. [Common Response Envelope](#4-common-response-envelope)
5. [Global Error Codes](#5-global-error-codes)
6. [Authentication API](#6-authentication-api)
7. [User API](#7-user-api)
8. [Child Profiles API](#8-child-profiles-api)
9. [Wizard Draft API](#9-wizard-draft-api)
10. [Upload API](#10-upload-api)
11. [Books API](#11-books-api)
12. [Book Pages API](#12-book-pages-api)
13. [Generation API](#13-generation-api)
14. [SSE Event Specification](#14-sse-event-specification)
15. [Reader API](#15-reader-api)
16. [PDF & Download API](#16-pdf--download-api)
17. [Sharing API](#17-sharing-api)
18. [Billing API](#18-billing-api)
19. [Credits API](#19-credits-api)
20. [Stripe Webhooks](#20-stripe-webhooks)
21. [Notifications API](#21-notifications-api)
22. [Dashboard API](#22-dashboard-api)
23. [Admin API](#23-admin-api)
24. [API DTO Catalog](#24-api-dto-catalog)
25. [Validation Rules](#25-validation-rules)
26. [Rate Limits](#26-rate-limits)
27. [Authorization Matrix](#27-authorization-matrix)
28. [Idempotency Rules](#28-idempotency-rules)
29. [OpenAPI Readiness](#29-openapi-readiness)
30. [Contract Testing Plan](#30-contract-testing-plan)
31. [Architecture Alignment Notes](#31-architecture-alignment-notes)

---

## 1. API Design Principles

### 1.1 REST Conventions

StoryMe follows REST conventions with pragmatic deviations where REST is a poor fit.

- **Resources are nouns, plural**: `/books`, `/child-profiles`, `/share-links`
- **HTTP verbs carry semantic meaning**:
  - `GET` — read, never mutates state
  - `POST` — create a resource or trigger an action
  - `PATCH` — partial update (never `PUT` for partial updates)
  - `DELETE` — remove a resource
- **Action endpoints** (non-CRUD) use `POST` with a verb noun under the resource: `POST /books/{bookId}/cancel`, `POST /books/{bookId}/regenerate`
- **Nested resources** go two levels deep maximum: `/books/{bookId}/pages/{pageNumber}`. Deeper nesting moves to a flat resource with filter params.
- **HTTP status codes carry meaning**. Never return `200` with an error in the body. See §1.4.

### 1.2 Resource Naming

| Rule                               | Correct                      | Wrong                       |
| ---------------------------------- | ---------------------------- | --------------------------- |
| Plural nouns                       | `/books`                     | `/book`                     |
| Kebab-case                         | `/child-profiles`            | `/childProfiles`            |
| IDs in path for specific resources | `/books/{bookId}`            | `/getBook?id=...`           |
| Actions as POST sub-resources      | `POST /books/{id}/cancel`    | `DELETE /books/{id}/cancel` |
| Filters as query params            | `GET /books?status=complete` | `GET /books/complete`       |

### 1.3 Versioning

The API is versioned at the URL path level: `/v1/`. The current version is `v1`.

**Versioning policy:**

- A new version (`v2`) is only introduced for breaking changes.
- Additive changes (new fields, new endpoints, new optional parameters) are non-breaking and do not require a version bump.
- Deprecated fields are kept for a minimum 6-month deprecation window, marked with `@deprecated` in OpenAPI schema.
- Version `v1` will remain supported for 12 months after `v2` ships.
- Clients must send the version in the URL path. No version negotiation via headers.

### 1.4 HTTP Status Codes

| Scenario                     | Status | Usage                                                |
| ---------------------------- | ------ | ---------------------------------------------------- |
| Success — read               | 200    | GET, HEAD responses                                  |
| Success — created            | 201    | POST that creates a persisted resource               |
| Success — async job accepted | 202    | `POST /books` — generation job enqueued              |
| Success — no content         | 204    | DELETE, logout, PATCH with no return body            |
| Bad request                  | 400    | Malformed JSON, missing required fields, type errors |
| Unauthenticated              | 401    | No token, expired token, invalid token               |
| Forbidden                    | 403    | Valid auth, insufficient plan or role                |
| Not found                    | 404    | Resource does not exist or is not visible to caller  |
| Conflict                     | 409    | Duplicate resource (email already registered)        |
| Validation error             | 422    | Field-level validation failures (Zod rejection)      |
| Rate limited                 | 429    | With `Retry-After` header                            |
| Server error                 | 500    | Unexpected; Sentry notified automatically            |
| Gateway timeout              | 504    | Upstream AI provider timed out                       |

**Critical rule**: Never return `200` with an error body. The BFF error interceptor and frontend `apiClient` depend on status codes for routing to error handlers.

### 1.5 Response Envelopes

All NestJS responses are wrapped in a consistent envelope. The BFF forwards this envelope to the browser unchanged for most endpoints. See §4 for exact shapes.

- Success: `{ data: T, meta: { requestId, timestamp } }`
- Error: `{ error: { code, message, requestId } }`
- Validation error: `{ error: { code: "VALIDATION_ERROR", fields: Record<string, string>, requestId } }`
- Paginated list: `{ data: { items: T[], nextCursor, hasMore, total }, meta }`

### 1.6 Pagination

All list endpoints use **cursor-based pagination**. Offset pagination is not used anywhere.

- Query params: `?cursor=<opaque>&limit=20`
- `cursor` is an opaque base64-encoded string — never a raw ID or numeric offset
- Default `limit`: 20. Maximum `limit`: 100
- `nextCursor` is `null` when no more pages exist
- `total` reflects the full count matching the filter, not just the current page
- Sort order is stable across cursor pages (default: `created_at DESC`)

### 1.7 Idempotency

State-mutating operations support idempotency via the `Idempotency-Key` header. See §28 for the full ruleset.

- The BFF generates a UUID v4 client-side and sends it as `Idempotency-Key`
- The NestJS API stores processed keys in Redis with a 24-hour TTL
- On duplicate key: return the original cached response without re-executing

### 1.8 Authentication

All authenticated endpoints require a JWT access token:

```
Authorization: Bearer <accessToken>
```

- Access tokens are JWTs, 15-minute expiry, signed with `HS256`
- Refresh tokens are opaque 64-byte hex strings, stored as bcrypt hashes in the DB
- Refresh tokens are sent and returned via `HttpOnly Secure SameSite=Strict` cookie only
- The BFF handles token relay; the browser never manages the refresh cookie directly
- Public endpoints (share viewer, preview, plans list) require no auth

### 1.9 Authorization & Ownership

Every resource access enforces ownership at the service layer, not only at the route guard level.

**Rules:**

- A user may only read or mutate resources they own (`user_id` match)
- Returning a `404` (not `403`) when a resource exists but is not owned by the caller prevents resource enumeration
- Shared resources (share link viewer) have explicit access grants checked before any data is returned
- Admin role bypasses ownership checks but requires explicit `@Roles('admin')` guard
- Plan-gating returns `403` with `PLAN_UPGRADE_REQUIRED` error code

### 1.10 Rate Limiting

Rate limits are enforced at two layers: Cloudflare (IP-based) and NestJS (user-based via Redis sliding window). See §26 for full rate limit table.

Rate limit response headers are always included when limits are checked:

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 43
X-RateLimit-Reset: 1751280000
Retry-After: 37
```

### 1.11 Backward Compatibility

When adding fields to a response:

- New fields are always optional — existing clients must tolerate unknown fields
- Field removals require a deprecation period and version bump
- Enum values may be added to response enums; never removed without a version bump
- Query parameter changes are additive only

---

## 2. Base URLs & Versioning

### 2.1 URL Table

| Environment       | Frontend → BFF                    | BFF → NestJS API                     | Public CDN                        |
| ----------------- | --------------------------------- | ------------------------------------ | --------------------------------- |
| Production        | `https://storyme.app/api`         | `https://api.storyme.app/v1`         | `https://cdn.storyme.app`         |
| Staging           | `https://staging.storyme.app/api` | `https://staging-api.storyme.app/v1` | `https://cdn-staging.storyme.app` |
| Local development | `http://localhost:3000/api`       | `http://localhost:4000/v1`           | `http://localhost:4000/cdn`       |

### 2.2 Layer Boundary

```
Browser
  │  calls  →  https://storyme.app/api/{resource}       (Next.js BFF routes)
  │
BFF (Next.js Route Handlers)
  │  calls  →  https://api.storyme.app/v1/{resource}    (NestJS REST API)
  │  connects via Socket.io for SSE relay
  │
NestJS API
  │  pushes progress via Redis pub/sub → Socket.io
  │
Workers (BullMQ agents)
```

**Important:** The browser never calls `api.storyme.app` directly. All traffic flows through the BFF. The BFF:

- Attaches the access token (from memory/cookie) as `Authorization: Bearer`
- Manages the `HttpOnly` refresh cookie lifecycle
- Converts Socket.io progress events to SSE streams for the browser
- Proxies upload presign requests

### 2.3 CDN Boundary

Public CDN URLs are constructed by the frontend directly (no API call needed):

| Asset               | Pattern                                                |
| ------------------- | ------------------------------------------------------ |
| Cover thumbnail     | `cdn.storyme.app/books/{bookId}/cover-thumb.webp`      |
| Page image (reader) | `cdn.storyme.app/books/{bookId}/images/page-{NN}.webp` |
| Social card         | `cdn.storyme.app/books/{bookId}/social-card.png`       |

Page numbers are zero-padded to 2 digits: `page-01.webp`, `page-12.webp`.

PDFs and original PNGs are **never** served from the CDN. They require signed URLs from the API.

### 2.4 Stripe Webhook URL

Stripe sends webhooks to the NestJS API directly (not via BFF):

```
https://api.storyme.app/v1/webhooks/stripe
```

---

## 3. Common Headers

### 3.1 Request Headers

| Header             | Required                       | Direction       | Purpose                                         | Example                          |
| ------------------ | ------------------------------ | --------------- | ----------------------------------------------- | -------------------------------- |
| `Authorization`    | Required (authenticated)       | Client → Server | JWT Bearer token                                | `Bearer eyJhbGciOiJIUzI1NiJ9...` |
| `Content-Type`     | Required (with body)           | Client → Server | Body format                                     | `application/json`               |
| `X-Request-ID`     | Optional                       | Client → Server | Client-generated trace ID; returned in response | `req_01J8XK2M...`                |
| `Idempotency-Key`  | Required (idempotent ops)      | Client → Server | Prevents duplicate mutations                    | `idem_f47ac10b-58cc...`          |
| `X-CSRF-Token`     | Required (BFF state mutations) | Browser → BFF   | Double-submit CSRF protection for BFF routes    | `csrf_...`                       |
| `Accept-Language`  | Optional                       | Client → Server | Preferred locale for error messages             | `en-US`                          |
| `Stripe-Signature` | Required (webhook)             | Stripe → API    | Stripe HMAC signature                           | `t=1609459200,v1=...`            |

### 3.2 Response Headers

| Header                  | Direction       | Purpose                                                  | Example                                                                  |
| ----------------------- | --------------- | -------------------------------------------------------- | ------------------------------------------------------------------------ |
| `X-Request-ID`          | Server → Client | Echo of request ID (generated by server if not provided) | `req_01J8XK2M...`                                                        |
| `X-RateLimit-Limit`     | Server → Client | Max requests in window                                   | `100`                                                                    |
| `X-RateLimit-Remaining` | Server → Client | Remaining requests in window                             | `43`                                                                     |
| `X-RateLimit-Reset`     | Server → Client | Unix timestamp when window resets                        | `1751280000`                                                             |
| `Retry-After`           | Server → Client | Seconds until retry is safe (on 429)                     | `60`                                                                     |
| `Content-Type`          | Server → Client | Response body format                                     | `application/json`                                                       |
| `Set-Cookie`            | Server → Client | Refresh token (auth endpoints only)                      | `storyme_refresh=...; HttpOnly; Secure; SameSite=Strict; Path=/api/auth` |

### 3.3 CSRF Protection

The BFF implements double-submit cookie CSRF protection for all state-mutating routes (`POST`, `PATCH`, `DELETE`):

1. On page load the BFF sets a non-HttpOnly `storyme_csrf` cookie (readable by JS)
2. The frontend reads it and sends it as `X-CSRF-Token: <value>` on mutations
3. The BFF validates the header matches the cookie before proxying

The NestJS API is behind the BFF and does not need CSRF protection (it trusts only BFF's origin and Bearer tokens).

---

## 4. Common Response Envelope

### 4.1 Success Response

```typescript
interface ApiResponse<T> {
  data: T;
  meta: ResponseMeta;
}

interface ResponseMeta {
  requestId: string; // e.g. "req_01J8XK2MABCDEF"
  timestamp: string; // ISO 8601 UTC: "2026-06-30T12:00:00.000Z"
  traceId?: string; // OpenTelemetry trace ID (debug builds only)
}
```

**Example:**

```json
{
  "data": {
    "id": "bk_01J8XK2MABCDEF",
    "title": "Emma and the Magic Forest",
    "status": "complete"
  },
  "meta": {
    "requestId": "req_01J8XK2MABCDEF",
    "timestamp": "2026-06-30T12:00:00.000Z"
  }
}
```

### 4.2 Error Response

```typescript
interface ApiErrorResponse {
  error: ApiError;
}

interface ApiError {
  code: string; // Stable machine-readable error code (see §5)
  message: string; // Developer message — never shown to users directly
  requestId: string;
  field?: string; // Which field caused the error (single-field errors)
  details?: unknown; // Additional context (debug builds only)
}
```

**Example:**

```json
{
  "error": {
    "code": "BOOK_NOT_FOUND",
    "message": "Book bk_01J8XK2MABCDEF not found or not owned by caller",
    "requestId": "req_01J8XK2MABCDEF"
  }
}
```

### 4.3 Validation Error Response (422)

```typescript
interface ValidationErrorResponse {
  error: {
    code: 'VALIDATION_ERROR';
    message: 'Validation failed';
    requestId: string;
    fields: Record<string, string>; // field path → human-readable error
  };
}
```

**Example:**

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Validation failed",
    "requestId": "req_01J8XK2MABCDEF",
    "fields": {
      "childName": "Child name is required",
      "age": "Age must be between 2 and 12",
      "appearance.hairColor": "Hair color is required"
    }
  }
}
```

### 4.4 Paginated List Response

```typescript
interface PaginatedResponse<T> {
  data: {
    items: T[];
    nextCursor: string | null; // null when no more pages
    hasMore: boolean;
    total: number; // total items matching filter (not just this page)
  };
  meta: ResponseMeta;
}
```

**Example:**

```json
{
  "data": {
    "items": [{ "id": "bk_...", "title": "..." }],
    "nextCursor": "eyJpZCI6ImJrXzAxSjh4IiwiY3JlYXRlZEF0IjoiMjAyNiJ9",
    "hasMore": true,
    "total": 47
  },
  "meta": {
    "requestId": "req_01J8XK2MABCDEF",
    "timestamp": "2026-06-30T12:00:00.000Z"
  }
}
```

### 4.5 202 Accepted Response (Async Jobs)

Used by `POST /v1/books` and other endpoints that enqueue async work:

```typescript
interface AsyncJobAcceptedResponse {
  data: {
    jobId: string; // Same as bookId for generation jobs
    bookId: string;
    estimatedMinutes: number;
    sseUrl: string; // SSE endpoint to subscribe for progress
    pollUrl: string; // Polling fallback endpoint
  };
  meta: ResponseMeta;
}
```

---

## 5. Global Error Codes

All error codes are stable strings. The frontend maps these to localized user messages. The `message` field in the response is for developer logging only.

### 5.1 Auth Errors

| Code                        | HTTP | Developer Message                            | User Meaning                           | Retryable          |
| --------------------------- | ---- | -------------------------------------------- | -------------------------------------- | ------------------ |
| `AUTH_TOKEN_MISSING`        | 401  | No Bearer token provided                     | Please sign in                         | No                 |
| `AUTH_TOKEN_EXPIRED`        | 401  | Access token has expired                     | Session expired, refreshing...         | Yes (auto-refresh) |
| `AUTH_TOKEN_INVALID`        | 401  | JWT signature verification failed            | Please sign in again                   | No                 |
| `AUTH_REFRESH_MISSING`      | 401  | Refresh cookie not present                   | Session expired                        | No                 |
| `AUTH_REFRESH_EXPIRED`      | 401  | Refresh token past expiry                    | Please sign in again                   | No                 |
| `AUTH_REFRESH_REUSE`        | 401  | Token family reuse detected — possible theft | Your session was revoked for security  | No                 |
| `AUTH_INVALID_CREDENTIALS`  | 401  | Email or password incorrect                  | Invalid email or password              | No                 |
| `AUTH_OAUTH_EMAIL_CONFLICT` | 409  | Email registered with different provider     | Account exists with Google/Apple login | No                 |
| `AUTH_EMAIL_NOT_VERIFIED`   | 403  | Email address not yet verified               | Please verify your email               | No                 |
| `AUTH_ACCOUNT_DEACTIVATED`  | 403  | Account has been deactivated                 | Contact support                        | No                 |
| `AUTH_PASSWORD_NOT_SET`     | 401  | OAuth user has no password                   | Sign in with Google/Apple              | No                 |

### 5.2 Validation Errors

| Code                        | HTTP | Developer Message                  | User Meaning                 | Retryable        |
| --------------------------- | ---- | ---------------------------------- | ---------------------------- | ---------------- |
| `VALIDATION_ERROR`          | 422  | Field validation failed            | See `fields` map for details | Yes (fix inputs) |
| `VALIDATION_SCHEMA_ERROR`   | 400  | Request body does not match schema | Invalid request format       | No               |
| `VALIDATION_CONTENT_POLICY` | 422  | Input failed content safety check  | Please revise your input     | Yes (fix input)  |

### 5.3 Permission Errors

| Code                     | HTTP | Developer Message                       | User Meaning                     | Retryable |
| ------------------------ | ---- | --------------------------------------- | -------------------------------- | --------- |
| `FORBIDDEN`              | 403  | Caller lacks permission for this action | Not authorized                   | No        |
| `PLAN_UPGRADE_REQUIRED`  | 403  | Feature requires paid plan              | Upgrade to access this feature   | No        |
| `PLAN_CREDITS_EXHAUSTED` | 402  | No credits remaining                    | Purchase credits or upgrade plan | No        |
| `OWNERSHIP_VIOLATION`    | 404  | Resource not owned by caller            | Resource not found               | No        |

### 5.4 Book Errors

| Code                          | HTTP | Developer Message                           | User Meaning                            | Retryable  |
| ----------------------------- | ---- | ------------------------------------------- | --------------------------------------- | ---------- |
| `BOOK_NOT_FOUND`              | 404  | Book not found or not owned by caller       | Book not found                          | No         |
| `BOOK_GENERATION_IN_PROGRESS` | 409  | Cannot modify book during active generation | Book is still generating                | Yes (wait) |
| `BOOK_NOT_COMPLETE`           | 409  | Operation requires book status = complete   | Book is not finished yet                | Yes (wait) |
| `BOOK_ALREADY_CANCELLED`      | 409  | Book generation already cancelled           | —                                       | No         |
| `BOOK_NOT_IN_PROGRESS`        | 409  | No active run to cancel (Phase G1)          | Nothing is currently generating         | No         |
| `BOOK_REGEN_LIMIT_REACHED`    | 409  | Page regeneration limit exceeded            | Max regenerations reached for this page | No         |
| `BOOK_DRAFT_EXPIRED`          | 410  | Wizard draft has expired                    | Your draft expired, please start over   | No         |
| `BOOK_DELETE_IN_PROGRESS`     | 409  | Book is being deleted                       | —                                       | Yes (wait) |

### 5.5 Generation Errors

| Code                         | HTTP | Developer Message              | User Meaning                         | Retryable |
| ---------------------------- | ---- | ------------------------------ | ------------------------------------ | --------- |
| `GENERATION_FAILED`          | 500  | All pipeline retries exhausted | Generation failed — credits refunded | No        |
| `GENERATION_TIMEOUT`         | 504  | Pipeline exceeded maximum time | Generation timed out — try again     | Yes       |
| `GENERATION_CONTENT_BLOCKED` | 422  | AI provider refused content    | Content policy prevented generation  | No        |
| `GENERATION_JOB_NOT_FOUND`   | 404  | Job ID not found               | Job not found                        | No        |
| `GENERATION_PROVIDER_ERROR`  | 502  | Upstream AI provider error     | AI provider temporarily unavailable  | Yes       |

### 5.6 Upload Errors

| Code                      | HTTP | Developer Message                | User Meaning                                    | Retryable          |
| ------------------------- | ---- | -------------------------------- | ----------------------------------------------- | ------------------ |
| `UPLOAD_FILE_TOO_LARGE`   | 413  | File exceeds 10MB limit          | File must be under 10MB                         | Yes (resize file)  |
| `UPLOAD_INVALID_MIME`     | 422  | MIME type not in allowed list    | Only JPEG, PNG, HEIC are supported              | Yes (convert file) |
| `UPLOAD_NO_FACE_DETECTED` | 422  | Face detection returned no faces | No face detected in photo — try a clearer photo | Yes                |
| `UPLOAD_TOO_SMALL`        | 422  | Image dimensions below 200×200px | Photo is too small                              | Yes                |
| `UPLOAD_ASSET_NOT_FOUND`  | 404  | Asset ID not found               | Asset not found                                 | No                 |
| `UPLOAD_PRESIGN_EXPIRED`  | 410  | Presigned URL has expired        | Upload link expired — request a new one         | Yes                |

### 5.7 Billing Errors

| Code                             | HTTP | Developer Message                    | User Meaning                             | Retryable       |
| -------------------------------- | ---- | ------------------------------------ | ---------------------------------------- | --------------- |
| `BILLING_STRIPE_ERROR`           | 502  | Stripe API returned an error         | Payment service error — try again        | Yes             |
| `BILLING_PAYMENT_FAILED`         | 402  | Payment method declined              | Payment declined — update payment method | Yes (update PM) |
| `BILLING_SUBSCRIPTION_NOT_FOUND` | 404  | No active subscription for user      | No active subscription                   | No              |
| `BILLING_ALREADY_SUBSCRIBED`     | 409  | User already has active subscription | You already have an active plan          | No              |
| `BILLING_CHECKOUT_EXPIRED`       | 410  | Checkout session has expired         | Checkout session expired — start over    | Yes             |

### 5.8 Sharing Errors

| Code                    | HTTP | Developer Message                      | User Meaning                  | Retryable |
| ----------------------- | ---- | -------------------------------------- | ----------------------------- | --------- |
| `SHARE_LINK_NOT_FOUND`  | 404  | Share token not found or revoked       | Link not found or has expired | No        |
| `SHARE_LINK_EXPIRED`    | 410  | Share link past expiry date            | This link has expired         | No        |
| `SHARE_LINK_REVOKED`    | 410  | Share link explicitly revoked          | This link is no longer active | No        |
| `SHARE_BOOK_NOT_PUBLIC` | 403  | Book is private — share not accessible | This book is private          | No        |

### 5.9 Rate Limit Errors

| Code                    | HTTP | Developer Message                   | User Meaning                                  | Retryable             |
| ----------------------- | ---- | ----------------------------------- | --------------------------------------------- | --------------------- |
| `RATE_LIMIT_EXCEEDED`   | 429  | User-level rate limit exceeded      | Too many requests — slow down                 | Yes (see Retry-After) |
| `RATE_LIMIT_GENERATION` | 429  | Book generation rate limit exceeded | Too many books — wait before creating another | Yes                   |
| `RATE_LIMIT_AUTH`       | 429  | Auth endpoint rate limit exceeded   | Too many attempts — try again later           | Yes                   |
| `RATE_LIMIT_UPLOAD`     | 429  | Upload rate limit exceeded          | Too many uploads — try again later            | Yes                   |

### 5.10 Server Errors

| Code                    | HTTP | Developer Message       | User Meaning                     | Retryable |
| ----------------------- | ---- | ----------------------- | -------------------------------- | --------- |
| `INTERNAL_SERVER_ERROR` | 500  | Unexpected server error | Something went wrong — try again | Yes       |
| `SERVICE_UNAVAILABLE`   | 503  | Dependency unavailable  | Service temporarily down         | Yes       |
| `GATEWAY_TIMEOUT`       | 504  | Upstream timeout        | Request timed out — try again    | Yes       |

---

## 6. Authentication API

**Base path:** `/v1/auth` (NestJS) / `/api/auth` (BFF)
**Rate limit:** 10 requests / 15 minutes per IP (applies to all auth endpoints)

---

### POST /v1/auth/signup

**Purpose:** Register a new user with email + password. Returns access token + sets refresh cookie.

**Auth required:** No

**Rate limit:** 5 requests / hour per IP

**Request body:**

```typescript
interface SignupRequestDto {
  email: string; // valid email format
  password: string; // min 8 chars, 1 uppercase, 1 number
  name: string; // 1–100 chars, trimmed
  locale?: string; // BCP-47, default "en"
}
```

**Response `201`:**

```typescript
interface AuthResponseDto {
  accessToken: string;
  user: UserDto; // see §24
}
```

**Cookies set:**

```
Set-Cookie: storyme_refresh=<token>; HttpOnly; Secure; SameSite=Strict; Path=/api/auth; Max-Age=604800; Domain=.storyme.app
```

**Status codes:**

| Status | Condition                                                                      |
| ------ | ------------------------------------------------------------------------------ |
| 201    | User created successfully                                                      |
| 409    | Email already registered (`AUTH_OAUTH_EMAIL_CONFLICT` if OAuth account exists) |
| 422    | Validation failure (`VALIDATION_ERROR`)                                        |
| 429    | Rate limit exceeded                                                            |

**Error codes:** `VALIDATION_ERROR`, `AUTH_OAUTH_EMAIL_CONFLICT`

**Validation rules:**

| Field      | Rule                                                        |
| ---------- | ----------------------------------------------------------- |
| `email`    | Valid RFC 5322 email, max 254 chars, lowercased             |
| `password` | Min 8 chars, at least 1 uppercase letter, at least 1 number |
| `name`     | 1–100 chars, trimmed, no control characters                 |

**Side effects:**

- Creates `users` record with `plan=free`, `credits=3`
- Sends verification email (non-blocking — failure does not block signup response)
- Creates entry in `refresh_tokens` table

---

### POST /v1/auth/login

**Purpose:** Authenticate with email + password.

**Auth required:** No

**Rate limit:** 10 requests / 15 minutes per IP; after 10 failures → 429 with `Retry-After: 900`

**Request body:**

```typescript
interface LoginRequestDto {
  email: string;
  password: string;
  rememberMe?: boolean; // if false, session cookie (no Max-Age)
}
```

**Response `200`:**

```typescript
interface AuthResponseDto {
  accessToken: string;
  user: UserDto;
}
```

**Cookies set:** Same as signup (Max-Age omitted if `rememberMe=false`)

**Status codes:**

| Status | Condition                                                                                             |
| ------ | ----------------------------------------------------------------------------------------------------- |
| 200    | Login successful                                                                                      |
| 401    | Invalid credentials — always generic (`AUTH_INVALID_CREDENTIALS`). Never reveal which field is wrong. |
| 401    | OAuth-only account (`AUTH_PASSWORD_NOT_SET`)                                                          |
| 429    | Rate limit                                                                                            |

---

### POST /v1/auth/logout

**Purpose:** Revoke current refresh token and clear cookie.

**Auth required:** Yes (access token OR refresh cookie)

**Request body:** Empty

**Response `204`:** No content

**Cookies cleared:**

```
Set-Cookie: storyme_refresh=; HttpOnly; Secure; SameSite=Strict; Path=/api/auth; Max-Age=0
```

**Status codes:**

| Status | Condition                                                   |
| ------ | ----------------------------------------------------------- |
| 204    | Logged out (even if token was already invalid — idempotent) |

---

### POST /v1/auth/refresh

**Purpose:** Exchange refresh token for new access token + rotated refresh token.

**Auth required:** Refresh cookie (no Bearer token needed)

**Request body:** Empty — refresh token read from `storyme_refresh` cookie

**Response `200`:**

```typescript
interface AuthResponseDto {
  accessToken: string;
  user: UserDto;
}
```

**Cookies:** New rotated refresh token set; old one invalidated in DB

**Status codes:**

| Status | Condition                                                         |
| ------ | ----------------------------------------------------------------- |
| 200    | New tokens issued                                                 |
| 401    | Cookie missing (`AUTH_REFRESH_MISSING`)                           |
| 401    | Token expired (`AUTH_REFRESH_EXPIRED`)                            |
| 401    | Token reuse detected — full family revoked (`AUTH_REFRESH_REUSE`) |

**BFF behavior:** The BFF calls this endpoint automatically when the access token expires (silent refresh). The browser never calls this endpoint directly — it is proxied through the BFF's token relay logic.

---

### POST /v1/auth/forgot-password

**Purpose:** Initiate password reset flow. Always returns `200` regardless of whether email exists (prevents email enumeration).

**Auth required:** No

**Rate limit:** 3 requests / hour per IP

**Request body:**

```typescript
interface ForgotPasswordRequestDto {
  email: string;
}
```

**Response `200`:**

```json
{ "data": { "message": "If an account exists with that email, a reset link has been sent." }, "meta": { ... } }
```

**Status codes:** Always `200` (intentional)

**Side effects:**

- If user exists: generates reset token → stores in Redis `password_reset:{token}` → `userId`, TTL 1 hour
- Sends reset email with link: `https://storyme.app/reset-password/{token}`

---

### POST /v1/auth/reset-password

**Purpose:** Set new password using reset token.

**Auth required:** No

**Request body:**

```typescript
interface ResetPasswordRequestDto {
  token: string; // from email link
  newPassword: string; // min 8 chars, 1 uppercase, 1 number
}
```

**Response `200`:**

```json
{ "data": { "message": "Password updated successfully." }, "meta": { ... } }
```

**Status codes:**

| Status | Condition                           |
| ------ | ----------------------------------- |
| 200    | Password reset                      |
| 400    | Token not found or expired          |
| 422    | Password does not meet requirements |

**Side effects:**

- Updates `users.password_hash`
- Revokes ALL `refresh_tokens` for the user (forces re-login everywhere)
- Deletes the Redis reset token key

---

### GET /v1/auth/me

**Purpose:** Return the currently authenticated user.

**Auth required:** Yes

**Response `200`:**

```typescript
interface AuthMeResponseDto {
  user: UserDto;
}
```

**Status codes:** `200` / `401`

---

### POST /v1/auth/oauth/google

**Purpose:** Exchange Google OAuth code for StoryMe tokens.

**Auth required:** No

**Request body:**

```typescript
interface OAuthGoogleRequestDto {
  code: string; // authorization code from Google
  redirectUri: string; // must match registered redirect URI
}
```

**Response `200`:**

```typescript
interface AuthResponseDto {
  accessToken: string;
  user: UserDto;
  isNewUser: boolean; // true if account was just created
}
```

**Cookies set:** Refresh token (same as login)

**Status codes:**

| Status | Condition                                                           |
| ------ | ------------------------------------------------------------------- |
| 200    | Auth successful                                                     |
| 409    | Email already registered via password (`AUTH_OAUTH_EMAIL_CONFLICT`) |
| 400    | Invalid or expired OAuth code                                       |

---

### POST /v1/auth/oauth/apple

**Purpose:** Exchange Apple Sign In ID token for StoryMe tokens.

**Auth required:** No

**Request body:**

```typescript
interface OAuthAppleRequestDto {
  idToken: string; // Apple JWT — verified server-side with Apple's public keys
  name?: string; // only sent on first sign-in from Apple
}
```

**Response `200`:** Same as Google OAuth response

---

## 7. User API

**Base path:** `/v1/users`

---

### GET /v1/users/me

**Purpose:** Get full authenticated user profile. (Alias for `GET /v1/auth/me` with more detail.)

**Auth required:** Yes

**Response `200`:**

```typescript
interface UserProfileResponseDto {
  user: UserDto; // see §24
  subscription: SubscriptionDto | null;
  creditBalance: number;
}
```

---

### PATCH /v1/users/me

**Purpose:** Update user profile fields.

**Auth required:** Yes

**Request body (all fields optional):**

```typescript
interface UpdateUserRequestDto {
  name?: string; // 1–100 chars
  locale?: string; // BCP-47 locale code
  timezone?: string; // IANA timezone string
}
```

**Response `200`:**

```typescript
interface UpdateUserResponseDto {
  user: UserDto;
}
```

**Status codes:** `200` / `401` / `422`

**Note:** Email change is not handled here — requires a separate verification flow (not in v1 scope).

---

### DELETE /v1/users/me

**Purpose:** Request account deletion. Initiates GDPR right-to-erasure process.

**Auth required:** Yes

**Request body:**

```typescript
interface DeleteUserRequestDto {
  password?: string; // required if account has password auth
  confirmation: 'DELETE'; // must be literal string "DELETE"
}
```

**Response `204`:** No content

**Status codes:**

| Status | Condition                                  |
| ------ | ------------------------------------------ |
| 204    | Deletion initiated                         |
| 400    | Confirmation string incorrect              |
| 401    | Password incorrect (for password accounts) |

**Side effects (synchronous):**

1. Sets `users.deactivated_at = now()`
2. Nulls PII: `users.email → "REDACTED_{id}"`, `users.name`, `users.password_hash`, `users.oauth_id`
3. Deletes all `child_profiles` (hard delete — PII)
4. Clears child name / appearance fields in `books.request` JSONB
5. Revokes all `refresh_tokens`
6. Cancels active Stripe subscription (`cancel_at_period_end = true`)
7. Clears refresh cookie

**Note:** `books` rows are retained for financial audit. Users cannot re-register with the same email for 30 days.

---

### GET /v1/users/me/export

**Purpose:** GDPR data export. Returns a JSON file of all user data.

**Auth required:** Yes

**Rate limit:** 1 request / 24 hours per user

**Response `200`:**

```
Content-Type: application/json
Content-Disposition: attachment; filename="storyme-export-{userId}.json"
```

```typescript
interface UserDataExportDto {
  user: UserDto;
  childProfiles: ChildProfileDto[];
  books: BookDto[];
  creditTransactions: CreditTransactionDto[];
  notifications: NotificationDto[];
  exportedAt: string; // ISO 8601
}
```

---

## 8. Child Profiles API

**Base path:** `/v1/child-profiles`

**Ownership rule:** All child profiles are owned by the authenticated user. Requests for another user's profiles return `404`.

---

### GET /v1/child-profiles

**Purpose:** List all child profiles for the authenticated user.

**Auth required:** Yes

**Query params:** No pagination (max 20 profiles per user — list is always complete)

**Response `200`:**

```typescript
interface ChildProfileListResponseDto {
  profiles: ChildProfileDto[];
}
```

---

### POST /v1/child-profiles

**Purpose:** Create a new child profile.

**Auth required:** Yes

**Request body:**

```typescript
interface CreateChildProfileRequestDto {
  name: string; // 1–50 chars, trimmed
  nickname?: string; // 1–30 chars
  age: number; // integer 2–12
  pronouns: 'he/him' | 'she/her' | 'they/them';
  birthday?: string; // ISO 8601 date: "2020-03-15"
  avatarConfig?: AvatarConfigDto; // from avatar builder
  photoAssetId?: string; // from upload flow — references uploads table
}
```

**Response `201`:**

```typescript
interface ChildProfileResponseDto {
  profile: ChildProfileDto;
}
```

**Validation rules:**

| Field          | Rule                                                                                   |
| -------------- | -------------------------------------------------------------------------------------- |
| `name`         | 1–50 chars, no control characters                                                      |
| `age`          | Integer between 2 and 12 inclusive                                                     |
| `pronouns`     | Must be one of the enum values                                                         |
| `birthday`     | If provided, must be a valid date; child age derived from birthday must match `age` ±1 |
| `photoAssetId` | If provided, must be owned by the calling user and have `status=complete`              |

**Status codes:** `201` / `401` / `422`

---

### GET /v1/child-profiles/{id}

**Purpose:** Get a single child profile.

**Auth required:** Yes

**Path params:**

- `id` — UUID of the child profile

**Response `200`:**

```typescript
interface ChildProfileResponseDto {
  profile: ChildProfileDto;
}
```

**Status codes:** `200` / `401` / `404` (not found OR not owned — same response)

---

### PATCH /v1/child-profiles/{id}

**Purpose:** Update a child profile. All fields optional.

**Auth required:** Yes

**Request body:**

```typescript
interface UpdateChildProfileRequestDto {
  name?: string;
  nickname?: string;
  age?: number;
  pronouns?: 'he/him' | 'she/her' | 'they/them';
  birthday?: string;
  avatarConfig?: AvatarConfigDto;
  photoAssetId?: string | null; // null to remove photo
}
```

**Response `200`:**

```typescript
interface ChildProfileResponseDto {
  profile: ChildProfileDto;
}
```

**Status codes:** `200` / `401` / `404` / `422`

---

### DELETE /v1/child-profiles/{id}

**Purpose:** Delete a child profile. Soft-deletes; books referencing this profile keep their data but `child_profile_id` is set to null.

**Auth required:** Yes

**Response `204`:** No content

**Status codes:** `204` / `401` / `404`

**Constraint:** Cannot delete a profile while a book using it is actively generating (`status` not in terminal states). Returns `409 BOOK_GENERATION_IN_PROGRESS`.

---

## 9. Wizard Draft API

**Base path:** `/v1/wizard-drafts`

The wizard draft is a server-persisted snapshot of the wizard form state. There is exactly one draft per user (or per guest session). Drafts expire after 30 days of inactivity.

Guest drafts are identified by a session ID stored in a non-HttpOnly cookie (`storyme_guest_session`). On signup/login, the draft is migrated to the user's account.

---

### GET /v1/wizard-drafts/current

**Purpose:** Retrieve the current draft for the authenticated user or guest session.

**Auth required:** No (works for guests via session cookie)

**Query params:** None

**Response `200`:**

```typescript
interface WizardDraftResponseDto {
  draft: WizardDraftDto | null; // null if no draft exists
}
```

**Response `200` (no draft):**

```json
{ "data": { "draft": null }, "meta": { ... } }
```

**Status codes:** `200` (always, even if no draft found)

---

### PUT /v1/wizard-drafts/current

**Purpose:** Create or replace the current draft. Called on each wizard step completion (autosave).

**Auth required:** No (works for guests)

**Request body:**

```typescript
interface UpsertWizardDraftRequestDto {
  step: number; // current wizard step (1–6)
  completedSteps: number[]; // steps that have been completed
  data: Partial<CreateBookRequestDto>; // partial wizard payload
  childProfileId?: string; // if user selected existing profile
}
```

**Response `200`:**

```typescript
interface WizardDraftResponseDto {
  draft: WizardDraftDto;
}
```

**Side effects:**

- Creates or replaces the draft (upsert by userId or guestSessionId)
- Sets `expiresAt = now() + 30 days`
- For guests: sets `storyme_guest_session` cookie if not already present

**Status codes:** `200` / `422`

**Notes:**

- Partial payloads are accepted — the server merges with existing draft data
- The server stores the raw `data` object; no deep validation of the book request fields until `POST /v1/books` is called

---

### DELETE /v1/wizard-drafts/current

**Purpose:** Clear the current draft. Called after generation starts.

**Auth required:** No (works for guests)

**Response `204`:** No content

---

### POST /v1/wizard-drafts/migrate

**Purpose:** Migrate a guest draft to an authenticated user account after signup/login.

**Auth required:** Yes

**Request body:**

```typescript
interface MigrateWizardDraftRequestDto {
  guestSessionId: string; // value from storyme_guest_session cookie
}
```

**Response `200`:**

```typescript
interface WizardDraftResponseDto {
  draft: WizardDraftDto | null; // the migrated draft, or null if guest had no draft
}
```

**Behavior:**

- If guest draft exists: associate it with `userId`, clear guestSessionId
- If user already has a draft: guest draft takes priority (overwrite), unless the user's draft is newer (compare `updatedAt`)
- The BFF calls this endpoint automatically on login/signup completion if `storyme_guest_session` cookie exists

**Status codes:** `200` / `401` / `404` (if guest session has no draft)

---

## 10. Upload API

**Base path:** `/v1/uploads`

Photo uploads use a two-step presigned URL flow to avoid proxying large files through the API server.

**Upload flow:**

1. Client calls `POST /v1/uploads/photo/presign` → receives presigned R2 URL + `assetId`
2. Client uploads file directly to R2 via `PUT <presignedUrl>`
3. Client calls `POST /v1/uploads/photo/complete` → triggers processing pipeline
4. Client polls `GET /v1/uploads/{assetId}` or waits for `status=complete` before using

---

### POST /v1/uploads/photo/presign

**Purpose:** Generate a presigned R2 upload URL for a child photo.

**Auth required:** Yes

**Rate limit:** 10 uploads / hour per user

**Request body:**

```typescript
interface PhotoPresignRequestDto {
  filename: string; // original filename, used for extension detection
  contentType: string; // "image/jpeg" | "image/png" | "image/heic"
  fileSizeBytes: number; // must be declared upfront; validated against limit
  childProfileId?: string; // optional — associates upload with a profile
}
```

**Response `200`:**

```typescript
interface PhotoPresignResponseDto {
  assetId: string; // UUID — reference this in subsequent calls
  uploadUrl: string; // presigned R2 PUT URL, valid for 10 minutes
  uploadHeaders: {
    // headers required on the PUT request
    'Content-Type': string;
  };
  r2Key: string; // e.g. "uploads/{userId}/{assetId}.jpg"
  expiresAt: string; // ISO 8601 — when the presigned URL expires
}
```

**Validation:**

| Field           | Rule                                               |
| --------------- | -------------------------------------------------- |
| `contentType`   | Must be `image/jpeg`, `image/png`, or `image/heic` |
| `fileSizeBytes` | Must be ≤ 10,485,760 bytes (10MB)                  |
| `filename`      | 1–255 chars, extension must match contentType      |

**Status codes:** `200` / `401` / `422` / `429`

---

### POST /v1/uploads/photo/complete

**Purpose:** Signal that the R2 upload is complete. Triggers server-side processing.

**Auth required:** Yes

**Request body:**

```typescript
interface PhotoUploadCompleteRequestDto {
  assetId: string; // from presign response
}
```

**Response `202`:**

```typescript
interface PhotoUploadAcceptedDto {
  assetId: string;
  status: 'processing';
  pollUrl: string; // GET /v1/uploads/{assetId}
}
```

**Server-side processing (async):**

1. Verify the R2 object exists at the expected key
2. Download and validate: MIME type check, dimension check (min 200×200px)
3. Run face detection
4. If face detected: resize to 512×512, save to `characters/{userId}/reference-{assetId}.png`
5. Update upload record: `status=complete`, `processedUrl=signedCdnUrl`
6. If face not detected: `status=failed`, `failureReason=no_face_detected`

**Status codes:** `202` / `401` / `404` (assetId not found) / `409` (already completed)

---

### GET /v1/uploads/{assetId}

**Purpose:** Poll upload processing status.

**Auth required:** Yes

**Path params:** `assetId` — UUID from presign response

**Response `200`:**

```typescript
interface UploadStatusResponseDto {
  asset: AssetDto; // see §24
}
```

**Status codes:** `200` / `401` / `404`

---

### DELETE /v1/uploads/{assetId}

**Purpose:** Delete an uploaded asset.

**Auth required:** Yes

**Response `204`:** No content

**Constraint:** Cannot delete an asset that is referenced by an active child profile. Returns `409` with message indicating which profile to update first.

---

## 11. Books API

**Base path:** `/v1/books`

**Idempotency:** `POST /v1/books` requires an `Idempotency-Key` header.

**Ownership:** All book endpoints enforce that `book.user_id = req.user.id`. Non-owned books return `404`.

---

### GET /v1/books

**Purpose:** List authenticated user's books with filtering and sorting.

**Auth required:** Yes

**Query params:**

| Param            | Type                     | Default      | Description                          |
| ---------------- | ------------------------ | ------------ | ------------------------------------ |
| `cursor`         | string                   | —            | Pagination cursor                    |
| `limit`          | number                   | 20           | Max 100                              |
| `status`         | string                   | —            | Filter by status enum value          |
| `childProfileId` | string                   | —            | Filter by child                      |
| `sort`           | `created_at\|updated_at` | `created_at` | Sort field                           |
| `order`          | `asc\|desc`              | `desc`       | Sort direction                       |
| `q`              | string                   | —            | Search by book title (partial match) |

**Response `200`:** `PaginatedResponse<BookListItemDto>`

**Status codes:** `200` / `401`

---

### POST /v1/books

**Purpose:** Create a book and immediately enqueue generation. Consumes 1 credit.

**Auth required:** Yes

**Idempotency-Key:** Required

**Request body:**

```typescript
interface CreateBookRequestDto {
  childName: string; // 1–50 chars
  age: number; // 2–12
  pronouns: 'he/him' | 'she/her' | 'they/them';
  appearance: {
    hairColor: string; // max 50 chars
    hairStyle: string; // max 50 chars
    eyeColor: string; // max 50 chars
    skinTone: string; // max 50 chars
    height?: 'tall' | 'average' | 'short';
    distinctiveFeatures?: string[]; // max 5 items, each max 100 chars
  };
  personality: string[]; // 1–5 traits, each 1–50 chars
  favoriteAnimals: string[]; // 0–3 items
  favoriteColors: string[]; // 0–3 items
  favoriteToys: string[]; // 0–3 items
  hobbies: string[]; // 0–5 items
  educationalGoal?: string; // max 200 chars
  genre: 'adventure' | 'fantasy' | 'friendship' | 'mystery' | 'nature' | 'space' | 'ocean';
  bookLength: 8 | 16 | 24 | 32;
  illustrationStyle: 'watercolor' | 'comic' | '3d_cartoon' | 'pencil_sketch';
  language: string; // BCP-47 code: 'en', 'es', 'fr', 'de', 'ru', 'pt', 'ar'
  photoAssetId?: string; // optional reference photo for likeness
  childProfileId?: string; // optional — saves to existing profile
  dedicationText?: string; // max 300 chars
}
```

**Response `202`:**

```typescript
interface BookCreatedResponseDto {
  bookId: string;
  jobId: string; // same as bookId for generation tracking
  status: 'queued';
  creditsCharged: number; // always 1
  estimatedMinutes: number;
  sseUrl: string; // "/api/generation/jobs/{bookId}/events"
  pollUrl: string; // "/api/generation/jobs/{bookId}"
}
```

**Plan gates:**

| Plan           | Allowed book lengths      |
| -------------- | ------------------------- |
| `free`         | 8 pages only (first book) |
| `pay_per_book` | 8, 16, 24, 32             |
| `family`       | 8, 16, 24, 32             |
| `annual`       | 8, 16, 24, 32             |
| `educator`     | 8, 16, 24, 32             |

**Status codes:**

| Status | Condition                                                      |
| ------ | -------------------------------------------------------------- |
| 202    | Generation job enqueued                                        |
| 402    | Insufficient credits (`PLAN_CREDITS_EXHAUSTED`)                |
| 403    | Plan does not allow this book length (`PLAN_UPGRADE_REQUIRED`) |
| 409    | Duplicate `Idempotency-Key` — returns original 202 response    |
| 422    | Validation failure                                             |

**Side effects:**

1. Atomically deducts 1 credit from `users.credits`
2. Records `credit_transactions` entry with `reason=book_creation`
3. Creates `books` record with `status=created`
4. Clears wizard draft (`DELETE /v1/wizard-drafts/current`)
5. Enqueues orchestration job in `book:orchestrate` queue
6. Returns immediately (generation happens asynchronously)

---

### GET /v1/books/{bookId}

**Purpose:** Get full book details including generation status, pages, and URLs.

**Auth required:** Yes

**Path params:** `bookId` — UUID

**Response `200`:**

```typescript
interface BookResponseDto {
  book: BookDto; // see §24
}
```

**Status codes:** `200` / `401` / `404`

---

### PATCH /v1/books/{bookId}

**Purpose:** Update editable book metadata. Only allowed when book is in terminal state (`complete` or `failed`).

**Auth required:** Yes

**Request body:**

```typescript
interface UpdateBookRequestDto {
  title?: string; // 1–200 chars
  dedicationText?: string; // max 300 chars
}
```

**Response `200`:**

```typescript
interface BookResponseDto {
  book: BookDto;
}
```

**Status codes:** `200` / `401` / `404` / `409 BOOK_GENERATION_IN_PROGRESS`

---

### DELETE /v1/books/{bookId}

**Purpose:** Delete a book and all its assets from R2.

**Auth required:** Yes

**Response `204`:** No content

**Status codes:** `204` / `401` / `404` / `409 BOOK_GENERATION_IN_PROGRESS`

**Side effects:**

1. Verifies no active generation job for this book
2. Deletes all R2 objects under `books/{bookId}/` prefix (batch delete)
3. Hard-deletes `books` record and cascades to `book_pages`
4. Does NOT refund credits

---

### GET /v1/books/{bookId}/status

**Purpose:** Lightweight status polling endpoint. Returns only the generation status and progress, not full book data. Used as polling fallback when SSE is unavailable.

**Auth required:** Yes

**Response `200`:**

```typescript
interface BookStatusResponseDto {
  bookId: string;
  status: BookStatus;
  progress: {
    step: string; // current agent step name
    percentComplete: number; // 0–100
    completedSteps: string[];
    pagesComplete: number; // pages with images ready
    totalPages: number;
  };
  error?: {
    code: string;
    message: string;
  };
  completedAt?: string; // set when status=complete
}
```

**Status codes:** `200` / `401` / `404`

**Polling guidance:** Poll every 5 seconds maximum. Prefer SSE for real-time updates.

---

### POST /v1/books/{bookId}/cancel

> **Corrected (Phase G1).** The rules below on this endpoint replace this
> section's earlier draft, which predated any real implementation and
> described a refund policy (before `image_gen` only, never during
> `pdf_render`, always exactly one credit) this codebase does not follow.
> Implemented at `POST /api/books/:id/cancel` — backend cancellation only, no
> frontend Cancel button yet (Phase G2). Full mechanism writeup:
> `apps/api/docs/local-generation-pipeline.md`, "Phase G1 — user-initiated
> cancellation"; credit-ledger detail: `apps/api/docs/credits.md`, "Phase
> G1: cancellation refunds."

**Purpose:** Cancel an in-progress (`queued`/`running`) generation run.

**Auth required:** Yes (`AuthModeGuard` + `RequireVerifiedEmailGuard`, same
as `generate`/`retry-generation`/`regenerate`)

**Request body:** Empty

**Response `200`:**

```typescript
interface CancelGenerationResponse {
  book: BookDto;
  creditsRefunded: number;
}
```

**Status codes:**

| Status | Condition                                                                                                                                                 |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 200    | Cancellation accepted                                                                                                                                     |
| 404    | Book not found / not owned by caller / soft-deleted                                                                                                       |
| 409    | Book already cancelled (`BOOK_ALREADY_CANCELLED`)                                                                                                         |
| 409    | Book has no active run to cancel (`BOOK_NOT_IN_PROGRESS`) — covers `created`, `complete`, `failed`, `partial`, or a completion that won a concurrent race |

**Refund policy (Phase G1 — replaces the earlier draft above):**

- Every accepted cancellation of a **billed** run refunds its original
  charge in full, regardless of which pipeline step it was on — there is no
  "too late to refund" step.
- A **legacy/unbilled** run (no matching charge, e.g. created before
  generation credit charging existed) is still cancelled, but
  `creditsRefunded` is `0` — never a fabricated `1`.
- The refunded amount always equals the original charge's own amount, never
  a hardcoded constant (currently always `1` in practice, since every run
  costs `GENERATION_CREDIT_COST`, but the mechanism does not assume that).

**Side effects:**

- Fences out any worker currently executing the run — its next heartbeat (or
  DB write) is rejected, and it can never publish a Book outcome for this
  run once cancelled.
- Suppresses a still-pending dispatch of this run so it can never be newly
  enqueued to BullMQ after cancellation.
- Best-effort removes a not-yet-picked-up BullMQ job; an already-active
  (worker-locked) job is left alone — the committed DB cancellation, not
  queue removal, is the real correctness mechanism. An in-flight external
  provider request already started by the pipeline may still finish, but
  its result can never be published.
- **No SSE event is sent** — there is no `generation.cancelled` (or any
  other) SSE/WebSocket surface implemented anywhere in this codebase yet;
  see §14 for that subsystem's actual (unimplemented) status. The web app
  polls `GET /:id` instead, same as every other status transition.
- A cancelled book may start a fresh full regeneration via
  `POST /:id/regenerate` (independently charged); `POST /:id/retry-generation`
  remains specific to a `failed` book and does **not** accept a cancelled one.

---

### POST /v1/books/{bookId}/regenerate

**Purpose:** Restart the full generation pipeline for a completed or failed book. Creates a new generation job using the same input parameters.

**Auth required:** Yes

**Plan gate:** `family`, `annual`, `educator` plans only

**Idempotency-Key:** Required

**Request body:**

```typescript
interface RegenerateBookRequestDto {
  reason?: string; // optional user-provided reason (for analytics)
}
```

**Response `202`:**

```typescript
interface BookCreatedResponseDto {
  bookId: string;
  jobId: string;
  status: 'queued';
  creditsCharged: number;
  estimatedMinutes: number;
  sseUrl: string;
  pollUrl: string;
}
```

**Status codes:** `202` / `401` / `403 PLAN_UPGRADE_REQUIRED` / `404` / `402 PLAN_CREDITS_EXHAUSTED` / `409 BOOK_GENERATION_IN_PROGRESS`

---

## 12. Book Pages API

**Base path:** `/v1/books/{bookId}/pages`

**Access rules:**

- Pages 1–3 (preview pages) are accessible to any authenticated user who can see the book, plus anonymous viewers with a valid share link
- Pages 4+ require `book.is_paid = true` for download-quality access; reading in-app requires `book.user_id = req.user.id`
- Page images (CDN URLs) are publicly accessible via URL — auth protects the metadata/text only

---

### GET /v1/books/{bookId}/pages

**Purpose:** List all pages with their content, images, and status.

**Auth required:** Yes (book owner only)

**Response `200`:**

```typescript
interface BookPagesResponseDto {
  pages: BookPageDto[]; // see §24
  bookId: string;
  totalPages: number;
}
```

**Status codes:** `200` / `401` / `404`

---

### GET /v1/books/{bookId}/pages/{pageNumber}

**Purpose:** Get a single page.

**Auth required:** Yes (book owner); pages 1–3 accessible to shared-link holders

**Path params:**

- `pageNumber` — 1-indexed integer

**Response `200`:**

```typescript
interface BookPageResponseDto {
  page: BookPageDto;
}
```

**Free preview restriction:** If caller is a share-link viewer and `pageNumber > 3`, returns `403 PLAN_UPGRADE_REQUIRED` with `upgradeUrl` pointing to the book's share page.

**Status codes:** `200` / `401` / `403` / `404`

---

### PATCH /v1/books/{bookId}/pages/{pageNumber}

**Purpose:** Edit page text content (post-generation editing).

**Auth required:** Yes (book owner only)

**Plan gate:** `family`, `annual`, `educator` plans

**Request body:**

```typescript
interface UpdatePageRequestDto {
  textContent: string; // max 500 chars, must be non-empty
}
```

**Response `200`:**

```typescript
interface BookPageResponseDto {
  page: BookPageDto;
}
```

**Status codes:** `200` / `401` / `403 PLAN_UPGRADE_REQUIRED` / `404` / `409 BOOK_GENERATION_IN_PROGRESS`

**Constraint:** Text edits do not trigger image regeneration automatically. The user must separately call `POST /regenerate-image` if they want the image updated. The `qa_passed` field is reset to `null` after text edit.

---

### POST /v1/books/{bookId}/pages/{pageNumber}/regenerate-text

**Purpose:** Regenerate only the text content for a single page.

**Auth required:** Yes (book owner only)

**Plan gate:** `family`, `annual`, `educator` plans

**Idempotency-Key:** Required

**Request body:**

```typescript
interface RegenerateTextRequestDto {
  feedback?: string; // optional hint for the AI (max 200 chars)
}
```

**Response `202`:**

```typescript
interface PageRegenAcceptedDto {
  bookId: string;
  pageNumber: number;
  jobId: string;
  estimatedSeconds: number;
}
```

**Limits:**

- Maximum 3 text regenerations per page per book
- Returns `409 BOOK_REGEN_LIMIT_REACHED` when exceeded

**Status codes:** `202` / `401` / `403` / `404` / `409`

**Side effects:** Does NOT consume credits. Deducts credits only on full book regeneration.

---

### POST /v1/books/{bookId}/pages/{pageNumber}/regenerate-image

**Purpose:** Regenerate only the illustration for a single page.

**Auth required:** Yes (book owner only)

**Plan gate:** `family`, `annual`, `educator` plans

**Idempotency-Key:** Required

**Request body:**

```typescript
interface RegenerateImageRequestDto {
  feedback?: string; // optional art direction hint (max 200 chars)
  useDifferentSeed?: boolean; // default true — generates variation
}
```

**Response `202`:**

```typescript
interface PageRegenAcceptedDto {
  bookId: string;
  pageNumber: number;
  jobId: string;
  estimatedSeconds: number;
}
```

**Limits:** Maximum 3 image regenerations per page per book.

**Status codes:** `202` / `401` / `403` / `404` / `409`

---

## 13. Generation API

**Base path:** `/v1/generation/jobs`

This API provides job-level visibility into the AI generation pipeline. The `jobId` is always equal to the `bookId` for generation jobs. Endpoints in this section are designed for both real-time tracking (SSE) and polling fallback.

---

### POST /v1/generation/jobs

**Purpose:** Start a generation job for an existing book. Used by the orchestrator and for admin-triggered retries. (End users use `POST /v1/books` or `POST /v1/books/{bookId}/regenerate` instead.)

**Auth required:** Yes (admin role OR book owner)

**Idempotency-Key:** Required

**Request body:**

```typescript
interface StartGenerationJobRequestDto {
  bookId: string;
  priority?: 'high' | 'normal' | 'low'; // default 'normal'
  fromStep?: AgentStep; // resume from a specific step (admin only)
}
```

**Response `202`:**

```typescript
interface GenerationJobResponseDto {
  job: GenerationJobDto; // see §24
}
```

**Status codes:** `202` / `401` / `403` / `404` / `409`

---

### GET /v1/generation/jobs/{jobId}

**Purpose:** Get current status of a generation job. Polling fallback for clients that cannot use SSE.

**Auth required:** Yes

**Path params:** `jobId` — equals `bookId`

**Response `200`:**

```typescript
interface GenerationJobResponseDto {
  job: GenerationJobDto;
}
```

**Status codes:** `200` / `401` / `404`

---

### GET /v1/generation/jobs/{jobId}/events

**Purpose:** Server-Sent Events stream for real-time generation progress.

**Auth required:** Yes (access token via query param for SSE — see note)

**Path params:** `jobId` — equals `bookId`

**Query params:**

| Param         | Required | Description                                                                                                                                                       |
| ------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `token`       | Yes      | Short-lived SSE token (obtained from `POST /v1/generation/jobs/{jobId}/sse-token`). Cannot send Authorization header on SSE connections — use this token instead. |
| `lastEventId` | No       | ID of last received event for reconnect                                                                                                                           |

**Response:** `Content-Type: text/event-stream`

```
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no
```

See §14 for the complete SSE event specification.

**Reconnect behavior:**

- Clients should reconnect on disconnect with the `lastEventId` of the last received event
- The BFF buffers the last 100 events in Redis for 10 minutes for reconnect support
- On reconnect with `lastEventId`: server replays missed events since that ID
- After `generation.completed` or `generation.failed`, the SSE stream closes with `event: close`

**Multiple tabs behavior:**

- Multiple SSE connections from the same user for the same `jobId` are allowed
- Each connection receives the same event stream (fan-out via Redis pub/sub)

**SSE token endpoint:**

```
POST /v1/generation/jobs/{jobId}/sse-token
Auth: Yes (Bearer)
Response: { token: string, expiresAt: string }  // token valid 5 minutes
```

**Status codes:** `200` (stream) / `401` / `404`

---

### POST /v1/generation/jobs/{jobId}/retry

**Purpose:** Retry a failed generation job from the last successful step.

**Auth required:** Yes (admin role OR book owner)

**Idempotency-Key:** Required

**Request body:**

```typescript
interface RetryGenerationJobRequestDto {
  fromStep?: AgentStep; // admin only — override which step to restart from
}
```

**Response `202`:**

```typescript
interface GenerationJobResponseDto {
  job: GenerationJobDto;
}
```

**Constraint:** Only jobs with `status=failed` can be retried. Returns `409` if job is active or complete.

**Status codes:** `202` / `401` / `403` / `404` / `409`

---

### POST /v1/generation/jobs/{jobId}/cancel

**Purpose:** Cancel an active generation job.

**Auth required:** Yes (book owner or admin)

**Request body:** Empty

**Response `200`:**

```typescript
interface CancelJobResponseDto {
  jobId: string;
  status: 'cancelled';
}
```

**Status codes:** `200` / `401` / `404` / `409`

---

## 14. SSE Event Specification

All SSE events follow the standard SSE format:

```
id: {eventId}
event: {eventName}
data: {JSON payload}

```

(Two newlines after `data:` to terminate the event block.)

The BFF converts Socket.io events from NestJS into SSE events. The mapping is:

| Socket.io event  | SSE event name           |
| ---------------- | ------------------------ |
| `book:progress`  | `generation.progress`    |
| `page:ready`     | `generation.page_ready`  |
| `cover:ready`    | `generation.cover_ready` |
| `book:complete`  | `generation.completed`   |
| `book:error`     | `generation.failed`      |
| `book:cancelled` | `generation.cancelled`   |

---

### generation.started

Emitted immediately when the orchestrator picks up the job from the queue.

```typescript
interface GenerationStartedEvent {
  eventId: string;
  bookId: string;
  jobId: string;
  totalSteps: number; // 9 pipeline steps
  estimatedMinutes: number;
  startedAt: string; // ISO 8601
}
```

**SSE example:**

```
id: evt_01J8XK001
event: generation.started
data: {"eventId":"evt_01J8XK001","bookId":"bk_abc","jobId":"bk_abc","totalSteps":9,"estimatedMinutes":4,"startedAt":"2026-06-30T12:00:00.000Z"}
```

**Frontend behavior:** Show generation progress UI, start progress bar animation.

---

### generation.progress

Emitted at each pipeline step transition.

```typescript
interface GenerationProgressEvent {
  eventId: string;
  bookId: string;
  step: AgentStep; // current step name
  stepLabel: string; // human-readable label for UI display
  percentComplete: number; // 0–100
  completedSteps: AgentStep[];
}

type AgentStep =
  | 'char_build'
  | 'story_plan'
  | 'chapter_gen'
  | 'illust_plan'
  | 'char_consistency'
  | 'image_gen'
  | 'qa_review'
  | 'layout'
  | 'pdf_render';
```

**Step labels and percentages:**

| `step`             | `stepLabel`                                   | `percentComplete` |
| ------------------ | --------------------------------------------- | ----------------- |
| `char_build`       | "Getting to know {childName}…"                | 5                 |
| `story_plan`       | "Planning the adventure…"                     | 15                |
| `chapter_gen`      | "Writing the story…"                          | 35                |
| `illust_plan`      | "Imagining the illustrations…"                | 45                |
| `char_consistency` | "Making sure the character looks just right…" | 52                |
| `image_gen`        | "Painting the pages…"                         | 70                |
| `qa_review`        | "Checking every detail…"                      | 85                |
| `layout`           | "Laying out the book…"                        | 92                |
| `pdf_render`       | "Almost ready…"                               | 98                |

**SSE example:**

```
id: evt_01J8XK002
event: generation.progress
data: {"eventId":"evt_01J8XK002","bookId":"bk_abc","step":"story_plan","stepLabel":"Planning the adventure…","percentComplete":15,"completedSteps":["char_build"]}
```

**Frontend behavior:** Update progress bar. Replace step label in UI.

---

### generation.page_ready

Emitted for each completed page image during `image_gen`. Pages may arrive out of order.

```typescript
interface GenerationPageReadyEvent {
  eventId: string;
  bookId: string;
  pageNumber: number; // 1-indexed
  imageUrl: string; // CDN WebP URL: cdn.storyme.app/books/{bookId}/images/page-{NN}.webp
  pagesComplete: number; // how many pages have images so far
  totalPages: number;
}
```

**SSE example:**

```
id: evt_01J8XK003
event: generation.page_ready
data: {"eventId":"evt_01J8XK003","bookId":"bk_abc","pageNumber":3,"imageUrl":"https://cdn.storyme.app/books/bk_abc/images/page-03.webp","pagesComplete":3,"totalPages":16}
```

**Frontend behavior:** Show the new page image in the live preview grid. Animate its appearance.

---

### generation.cover_ready

Emitted when the cover image is generated (during `image_gen`, typically early).

```typescript
interface GenerationCoverReadyEvent {
  eventId: string;
  bookId: string;
  coverUrl: string; // cdn.storyme.app/books/{bookId}/cover-thumb.webp
  title: string; // book title from StoryPlan (available after story_plan)
}
```

**Frontend behavior:** Display the cover image and title in the progress screen. This is the "wow moment" — show it prominently.

---

### generation.completed

Emitted when the full pipeline completes and the PDF is ready.

```typescript
interface GenerationCompletedEvent {
  eventId: string;
  bookId: string;
  title: string;
  coverUrl: string;
  pageCount: number;
  pdfReady: boolean; // always true when this event fires
  generationTimeMs: number;
  previewPdfAvailable: boolean; // always true
}
```

**SSE example:**

```
id: evt_01J8XK042
event: generation.completed
data: {"eventId":"evt_01J8XK042","bookId":"bk_abc","title":"Emma and the Magic Forest","coverUrl":"https://cdn.storyme.app/books/bk_abc/cover-thumb.webp","pageCount":16,"pdfReady":true,"generationTimeMs":247000,"previewPdfAvailable":true}
```

**Frontend behavior:**

1. Show confetti / celebration animation
2. Transition to book reveal screen
3. Fetch `GET /v1/books/{bookId}` to get full book data
4. Offer download / share actions

**Note:** After this event, the SSE stream sends `event: close` and the connection closes.

---

### generation.failed

Emitted when the pipeline exhausts all retries.

```typescript
interface GenerationFailedEvent {
  eventId: string;
  bookId: string;
  errorCode: string; // e.g. "GENERATION_FAILED", "GENERATION_CONTENT_BLOCKED"
  errorMessage: string; // developer message
  creditsRefunded: number; // always 1
  retryable: boolean;
  step: AgentStep; // which step failed
}
```

**Frontend behavior:**

1. Show error state with user-friendly message
2. If `retryable=true`: offer retry button → calls `POST /v1/generation/jobs/{jobId}/retry`
3. If `retryable=false` (e.g., content policy): show support link
4. Confirm credits refunded in UI

---

### generation.cancelled

Emitted when cancellation completes.

```typescript
interface GenerationCancelledEvent {
  eventId: string;
  bookId: string;
  creditsRefunded: number;
  cancelledAt: string; // ISO 8601
}
```

**Frontend behavior:** Return to dashboard. Show toast: "Generation cancelled. 1 credit refunded."

---

## 15. Reader API

**Base path:** `/v1/reader`

The Reader API provides optimized access to book content for the in-app reader experience. It is separate from the Books API because it:

1. Serves a different consumer shape (reader needs pages + CDN URLs, not generation metadata)
2. Must support anonymous shared-link access
3. Tracks reading progress

---

### GET /v1/reader/books/{bookId}

**Purpose:** Load complete book data for the reader. Includes all pages, CDN URLs, and reading state.

**Auth required:** Yes (book owner) OR valid `shareToken` query param

**Query params:**

| Param        | Required    | Description                               |
| ------------ | ----------- | ----------------------------------------- |
| `shareToken` | Conditional | Required for anonymous shared-book access |

**Response `200`:**

```typescript
interface ReaderBookResponseDto {
  book: {
    id: string;
    title: string;
    coverUrl: string;
    pageCount: number;
    isOwner: boolean;
    isPaid: boolean;
    previewPageCount: number; // 3 for non-paid, pageCount for paid
  };
  pages: ReaderPageDto[];
  readingState: {
    lastPage: number;
    bookmarks: number[];
  } | null; // null for anonymous viewers
}

interface ReaderPageDto {
  pageNumber: number;
  imageUrl: string; // CDN WebP URL
  textContent: string; // page text
  isLocked: boolean; // true if page > previewPageCount and book not paid
}
```

**Free preview access:** Pages 1–3 always have `isLocked=false`. Pages 4+ have `isLocked=true` if `book.is_paid=false`.

**Status codes:** `200` / `401` (no token, no shareToken) / `403 SHARE_BOOK_NOT_PUBLIC` / `404`

---

### GET /v1/reader/books/{bookId}/preview

**Purpose:** Load only the first 3 pages. Used for public sharing pages and upsell previews.

**Auth required:** No (fully public if book has `is_public=true`)

**Query params:** `shareToken` (optional — unlocks preview for private shared books)

**Response `200`:**

```typescript
interface ReaderPreviewResponseDto {
  book: {
    id: string;
    title: string;
    coverUrl: string;
    pageCount: number;
    isPublic: boolean;
  };
  pages: ReaderPageDto[]; // always exactly pages 1–3
  upgradeUrl: string; // link to purchase/unlock full book
}
```

**Status codes:** `200` / `403` (private book without shareToken) / `404`

---

### PATCH /v1/reader/books/{bookId}/progress

**Purpose:** Save reading progress (current page).

**Auth required:** Yes

**Request body:**

```typescript
interface UpdateReadingProgressRequestDto {
  lastPage: number; // 1-indexed, must be 1–book.pageCount
}
```

**Response `204`:** No content

**Status codes:** `204` / `401` / `404` / `422`

**Implementation note:** Upserts `user_book_states.last_page`. Debounce on the frontend — call at most once per page turn, not on every scroll event.

---

### POST /v1/reader/books/{bookId}/bookmark

**Purpose:** Add a bookmark to a page.

**Auth required:** Yes

**Request body:**

```typescript
interface AddBookmarkRequestDto {
  pageNumber: number;
}
```

**Response `200`:**

```typescript
interface BookmarkResponseDto {
  bookmarks: number[]; // updated full list of bookmarked pages
}
```

**Status codes:** `200` / `401` / `404` / `422`

**Limit:** Maximum 10 bookmarks per book. Returns `422` if limit exceeded.

---

### DELETE /v1/reader/books/{bookId}/bookmark/{pageNumber}

**Purpose:** Remove a bookmark from a page.

**Auth required:** Yes

**Path params:** `pageNumber` — 1-indexed

**Response `200`:**

```typescript
interface BookmarkResponseDto {
  bookmarks: number[];
}
```

**Status codes:** `200` / `401` / `404`

---

## 16. PDF & Download API

**Base path:** `/v1/books/{bookId}`

PDFs are private assets. Every download request goes through the API, which verifies auth, ownership, and plan entitlement before issuing a short-lived signed R2 URL. The client then downloads directly from R2 â€” no byte proxying through the API server.

**PDF types:**

| Type    | Resolution      | Pages     | Watermark          | Plan required       |
| ------- | --------------- | --------- | ------------------ | ------------------- |
| Preview | 72 dpi (screen) | 1â€“3     | "Preview" diagonal | None                |
| Screen  | 72 dpi          | Full book | None               | Paid (is_paid=true) |
| Print   | 300 dpi         | Full book | None               | Paid (is_paid=true) |

---

### POST /v1/books/{bookId}/pdf

**Purpose:** Trigger PDF (re)generation. Used when the PDF needs to be regenerated after a page edit or image regeneration.

**Auth required:** Yes (book owner)

**Plan gate:** `family`, `annual`, `educator`

**Idempotency-Key:** Required

**Request body:**

```typescript
interface TriggerPdfRequestDto {
  quality: 'screen' | 'print'; // default 'print'
}
```

**Response `202`:**

```typescript
interface PdfJobAcceptedDto {
  bookId: string;
  jobId: string;
  quality: 'screen' | 'print';
  estimatedSeconds: number;
  pollUrl: string;
}
```

**Status codes:** `202` / `401` / `403` / `404` / `409 BOOK_NOT_COMPLETE`

**Note:** PDF generation is async. The existing PDF remains available while regeneration is in progress.

---

### GET /v1/books/{bookId}/download/pdf

**Purpose:** Get a signed download URL for the print-quality PDF.

**Auth required:** Yes (book owner)

**Plan gate:** `book.is_paid = true`

**Response `200`:**

```typescript
interface PdfDownloadResponseDto {
  downloadUrl: string; // signed R2 URL, valid 24 hours
  expiresAt: string; // ISO 8601
  fileSizeBytes: number;
  pageCount: number;
  quality: 'print';
}
```

**Status codes:**

| Status | Condition                                   |
| ------ | ------------------------------------------- |
| 200    | Signed URL returned                         |
| 401    | Unauthenticated                             |
| 402    | Book not paid â€” use checkout to unlock    |
| 403    | Not book owner                              |
| 404    | Book not found                              |
| 409    | PDF not yet generated (`BOOK_NOT_COMPLETE`) |

---

### GET /v1/books/{bookId}/download/preview

**Purpose:** Get a signed URL for the 3-page preview PDF (watermarked). No auth or payment required.

**Auth required:** No

**Response `200`:**

```typescript
interface PreviewPdfDownloadResponseDto {
  downloadUrl: string;
  expiresAt: string;
  fileSizeBytes: number;
  pageCount: 3;
  quality: 'preview';
  watermarked: true;
}
```

**Status codes:** `200` / `404` / `409 BOOK_NOT_COMPLETE`

---

### GET /v1/books/{bookId}/download/screen

**Purpose:** Get signed URL for screen-quality (72 dpi) full PDF.

**Auth required:** Yes (book owner)

**Plan gate:** `book.is_paid = true`

**Response `200`:** Same shape as `/download/pdf` with `quality: 'screen'`

---

### GET /v1/books/{bookId}/download/print

**Purpose:** Alias for `/download/pdf`. Explicitly named for frontend clarity.

**Auth required:** Yes (book owner)

**Plan gate:** `book.is_paid = true`

**Response `200`:** Same shape as `/download/pdf` with `quality: 'print'`

**Note on signed URL caching:** Clients may cache the signed URL for its full 24-hour validity. Do not call this endpoint on every download button click â€” cache the URL client-side and only refresh after expiry.

---

## 17. Sharing API

**Base path:** `/v1/books/{bookId}/share-links` and `/v1/share-links`

---

### POST /v1/books/{bookId}/share-links

**Purpose:** Create a share link for a book.

**Auth required:** Yes (book owner)

**Idempotency-Key:** Required

**Request body:**

```typescript
interface CreateShareLinkRequestDto {
  mode: 'preview_only' | 'full_read';
  expiresInDays?: number; // 1â€“365; null for never-expiring (default: 30)
  password?: string; // optional access password (max 100 chars)
}
```

**Response `201`:**

```typescript
interface ShareLinkResponseDto {
  shareLink: ShareLinkDto;
  shareUrl: string; // e.g. "https://storyme.app/shared/bk_abc/s_tok123"
}
```

**Status codes:** `201` / `401` / `404` / `409 BOOK_NOT_COMPLETE`

**Limit:** Maximum 5 active share links per book.

---

### GET /v1/share-links/{token}

**Purpose:** Resolve a share token. Called by the shared viewer page (public, no auth).

**Auth required:** No

**Response `200`:**

```typescript
interface ShareLinkResolveResponseDto {
  token: string;
  bookId: string;
  mode: 'preview_only' | 'full_read';
  expiresAt: string | null;
  passwordRequired: boolean;
  book: {
    id: string;
    title: string;
    coverUrl: string;
    pageCount: number;
    previewPageCount: number;
  };
}
```

**Status codes:**

| Status | Condition                                                              |
| ------ | ---------------------------------------------------------------------- |
| 200    | Token valid                                                            |
| 401    | Password required â€” send `X-Share-Password` header and retry         |
| 404    | Token not found                                                        |
| 410    | Token expired (`SHARE_LINK_EXPIRED`) or revoked (`SHARE_LINK_REVOKED`) |

**Password-protected access:** Send password as `X-Share-Password: <value>` header. Validated server-side; password hash is never returned to clients.

---

### PATCH /v1/share-links/{token}

**Purpose:** Update an existing share link.

**Auth required:** Yes (book owner)

**Request body:**

```typescript
interface UpdateShareLinkRequestDto {
  expiresInDays?: number | null; // null = never-expiring
  mode?: 'preview_only' | 'full_read';
  password?: string | null; // null = remove password
}
```

**Response `200`:**

```typescript
interface ShareLinkResponseDto {
  shareLink: ShareLinkDto;
  shareUrl: string;
}
```

**Status codes:** `200` / `401` / `404`

---

### DELETE /v1/share-links/{token}

**Purpose:** Revoke a share link immediately.

**Auth required:** Yes (book owner)

**Response `204`:** No content

**Status codes:** `204` / `401` / `404`

---

### POST /v1/books/{bookId}/social-card

**Purpose:** Generate a 1200Ã—630 social-sharing card image (OG image) for the book.

**Auth required:** Yes (book owner)

**Idempotency-Key:** Required

**Request body:**

```typescript
interface SocialCardRequestDto {
  layout?: 'cover_only' | 'cover_with_title'; // default 'cover_with_title'
}
```

**Response `200`:**

```typescript
interface SocialCardResponseDto {
  socialCardUrl: string; // cdn.storyme.app/books/{bookId}/social-card.png
  width: 1200;
  height: 630;
  generatedAt: string;
}
```

**Status codes:** `200` / `201` (first generation) / `401` / `404` / `409 BOOK_NOT_COMPLETE`

---

## 18. Billing API

**Base path:** `/v1/billing`

The frontend never calls Stripe directly. All Stripe interactions go through the NestJS `BillingModule`. The Stripe secret key never reaches the browser.

---

### GET /v1/billing/plans

**Purpose:** Return all available plans and pricing. Public â€” no auth required.

**Auth required:** No

**Response `200`:**

```typescript
interface PlansResponseDto {
  plans: PlanDto[];
}
```

**Caching:** Response cached 1 hour at CDN level.

---

### POST /v1/billing/checkout-session

**Purpose:** Create a Stripe checkout session or PaymentIntent.

**Auth required:** Yes

**Idempotency-Key:** Required

**Request body:**

```typescript
interface CreateCheckoutSessionRequestDto {
  priceId: 'price_single' | 'price_monthly' | 'price_annual' | 'price_educator';
  bookId?: string; // required when priceId = 'price_single'
  successUrl?: string;
  cancelUrl?: string;
}
```

**Response `200`:**

```typescript
interface CheckoutSessionResponseDto {
  mode: 'payment' | 'subscription';
  clientSecret?: string; // for Stripe Elements (one-time payment)
  checkoutUrl?: string; // Stripe Checkout hosted URL (subscription)
  sessionId?: string;
  expiresAt: string;
}
```

**Behavior by priceId:**

| `priceId`        | Mode           | Frontend action                         |
| ---------------- | -------------- | --------------------------------------- |
| `price_single`   | `payment`      | Use `clientSecret` with Stripe Elements |
| `price_monthly`  | `subscription` | Redirect to `checkoutUrl`               |
| `price_annual`   | `subscription` | Redirect to `checkoutUrl`               |
| `price_educator` | `subscription` | Redirect to `checkoutUrl`               |

**Status codes:** `200` / `401` / `402` / `409 BILLING_ALREADY_SUBSCRIBED` / `500 BILLING_STRIPE_ERROR`

---

### GET /v1/billing/customer-portal

**Purpose:** Generate a Stripe Customer Portal URL for payment management.

**Auth required:** Yes

**Response `200`:**

```typescript
interface CustomerPortalResponseDto {
  portalUrl: string; // single-use Stripe URL, valid 5 minutes
  expiresAt: string;
}
```

**Status codes:** `200` / `401` / `404 BILLING_SUBSCRIPTION_NOT_FOUND`

---

### GET /v1/billing/invoices

**Purpose:** List past invoices.

**Auth required:** Yes

**Query params:** `cursor`, `limit` (default 10, max 50)

**Response `200`:** `PaginatedResponse<InvoiceDto>`

---

### GET /v1/billing/payment-methods

**Purpose:** List saved payment methods.

**Auth required:** Yes

**Response `200`:**

```typescript
interface PaymentMethodsResponseDto {
  paymentMethods: Array<{
    id: string;
    brand: string;
    last4: string;
    expMonth: number;
    expYear: number;
    isDefault: boolean;
  }>;
}
```

---

### POST /v1/billing/cancel-subscription

**Purpose:** Cancel subscription at period end (user keeps access until end of billing cycle).

**Auth required:** Yes

**Request body:**

```typescript
interface CancelSubscriptionRequestDto {
  reason?: string;
  feedback?: string;
}
```

**Response `200`:**

```typescript
interface SubscriptionCancelResponseDto {
  subscription: SubscriptionDto;
  accessUntil: string; // ISO 8601
  message: string;
}
```

**Status codes:** `200` / `401` / `404 BILLING_SUBSCRIPTION_NOT_FOUND`

**Note:** Calls Stripe `subscriptions.update({ cancel_at_period_end: true })`. Subscription is NOT immediately cancelled.

---

### POST /v1/billing/resume-subscription

**Purpose:** Undo a scheduled cancellation (re-activate before period end).

**Auth required:** Yes

**Request body:** Empty

**Response `200`:**

```typescript
interface SubscriptionResumeResponseDto {
  subscription: SubscriptionDto;
}
```

**Status codes:** `200` / `401` / `404` / `409` (subscription already expired)

---

## 19. Credits API

**Base path:** `/v1/credits`

---

### GET /v1/credits/balance

**Purpose:** Get current credit balance.

**Auth required:** Yes

**Response `200`:**

```typescript
interface CreditBalanceResponseDto {
  balance: number;
  plan: string;
  nextRefillAt: string | null;
  nextRefillAmount: number | null;
}
```

**Caching:** Redis cache, 30-second TTL per user. Invalidated on credit mutation.

---

### GET /v1/credits/transactions

**Purpose:** Get credit transaction history.

**Auth required:** Yes

**Query params:** `cursor`, `limit` (default 20, max 100), `type` (`debit` | `credit`)

**Response `200`:** `PaginatedResponse<CreditTransactionDto>`

---

### POST /v1/credits/redeem

**Purpose:** Redeem a promotional credit code.

**Auth required:** Yes

**Request body:**

```typescript
interface RedeemCreditRequestDto {
  code: string; // 6â€“20 chars, case-insensitive
}
```

**Response `200`:**

```typescript
interface RedeemCreditResponseDto {
  creditsAdded: number;
  newBalance: number;
  message: string;
}
```

**Status codes:** `200` / `401` / `404` (code not found) / `409` (already used) / `410` (expired)

---

## 20. Stripe Webhooks

**Endpoint:** `POST /v1/webhooks/stripe`

**Auth:** No Bearer token. Stripe signature verified via `stripe.webhooks.constructEvent()` using `STRIPE_WEBHOOK_SECRET`.

**Idempotency:** Every event is checked against Redis key `stripe_event:{event.id}` before processing. If found, return `200` immediately.

**Error handling:** Always return `200` to Stripe even on internal errors. Log to Sentry. Never return non-2xx â€” Stripe will retry for 3 days.

> **Correction (Phase E3 — the actual implementation):** this section
> predates any real code. The real endpoint is `POST /api/billing/webhook`
> (not `/v1/webhooks/stripe`), there is no Redis event-id dedupe or Sentry,
> and only `checkout.session.completed` for one-time purchases is handled.
> The "always return 200 even on internal errors" guidance above is
> **deliberately not followed** — a genuine transient Stripe/DB failure
> returns a non-2xx response so Stripe retries; only a successful grant (or
> a business-logic no-op) returns 200. See
> [apps/api/docs/credits.md, "Phase E3"](apps/api/docs/credits.md#phase-e3-stripe-checkout-credit-purchases-and-idempotent-webhooks)
> for what's actually implemented.

---

### checkout.session.completed

**Triggered by:** Stripe Checkout completion (subscription purchases).

**Fields used:**

```typescript
{
  id: string;
  mode: 'subscription';
  customer: string;
  subscription: string;
  metadata: {
    userId: string;
  }
  payment_status: 'paid';
}
```

**Database updates:**

1. Create or update `subscriptions` row
2. Set `users.plan` to the subscribed plan
3. Grant monthly credits via `credit_transactions` (`reason=subscription_grant`)
4. Send welcome email

---

### customer.subscription.created

**Triggered by:** New subscription creation.

**Fields used:**

```typescript
{
  id: string;
  customer: string;
  status: string;
  items: {
    data: [{ price: { id: string } }];
  }
  current_period_start: number;
  current_period_end: number;
  metadata: {
    userId: string;
  }
}
```

**Database updates:** Upsert `subscriptions` row. No-op if `checkout.session.completed` already handled it.

---

### customer.subscription.updated

**Triggered by:** Plan change, status change, or scheduled cancellation.

**Fields used:**

```typescript
{
  id: string;
  customer: string;
  status: 'active' | 'past_due' | 'cancelled' | 'trialing';
  cancel_at_period_end: boolean;
  current_period_start: number;
  current_period_end: number;
  items: {
    data: [{ price: { id: string } }];
  }
}
```

**Database updates:**

- Update `subscriptions.status`, `cancel_at_period_end`, period timestamps
- If `cancel_at_period_end=true`: send cancellation confirmed email
- If plan changed: update `users.plan`

---

### customer.subscription.deleted

**Triggered by:** Subscription fully cancelled.

**Fields used:**

```typescript
{
  id: string;
  customer: string;
  metadata: {
    userId: string;
  }
}
```

**Database updates:**

1. Set `subscriptions.status = 'cancelled'`, `cancelled_at = now()`
2. Set `users.plan = 'free'`
3. Send "subscription ended" email

---

### invoice.payment_succeeded

**Triggered by:** Successful subscription renewal.

**Fields used:**

```typescript
{
  id: string;
  customer: string;
  subscription: string;
  amount_paid: number;
  period_start: number;
  period_end: number;
  lines: {
    data: [{ price: { id: string } }];
  }
}
```

**Database updates:**

1. Update `subscriptions.current_period_start/end`
2. Grant monthly credits (`reason=subscription_grant`)
3. Send receipt email (if preference enabled)

---

### invoice.payment_failed

**Triggered by:** Subscription renewal payment failure.

**Fields used:**

```typescript
{
  id: string;
  customer: string;
  subscription: string;
  attempt_count: number;
  next_payment_attempt: number | null;
}
```

**Database updates:**

1. Set `subscriptions.status = 'past_due'`
2. Send dunning email with Customer Portal link
3. Frontend shows "payment failed" banner (polled via `/v1/users/me`)

---

### payment_intent.succeeded

**Triggered by:** Successful one-time book payment.

**Fields used:**

```typescript
{
  id: string;
  customer: string;
  amount: number;
  metadata: {
    userId: string;
    bookId: string;
    priceId: string;
  }
}
```

**Database updates:**

1. Set `books.is_paid = true`, `books.paid_at = now()`, `books.stripe_payment_intent_id = id`
2. Send "book unlocked" notification

---

### payment_intent.payment_failed

**Triggered by:** One-time payment failure.

**Fields used:** `id`, `metadata.userId`, `metadata.bookId`

**Database updates:** No book status changes. Frontend handles via Stripe Elements error state.

---

### charge.refunded

**Triggered by:** Charge refunded via Stripe Dashboard or admin.

**Fields used:**

```typescript
{
  id: string;
  amount_refunded: number;
  payment_intent: string;
}
```

**Database updates:**

1. Lookup `books` by `stripe_payment_intent_id`
2. Set `books.is_paid = false` if fully refunded
3. Add compensating credit transaction (`reason=admin_adjustment`)

---

## 21. Notifications API

**Base path:** `/v1/notifications`

---

### GET /v1/notifications

**Purpose:** List in-app notifications.

**Auth required:** Yes

**Query params:** `cursor`, `limit` (default 20, max 50), `unreadOnly` (boolean, default false)

**Response `200`:** `PaginatedResponse<NotificationDto>`

---

### PATCH /v1/notifications/{id}/read

**Purpose:** Mark a single notification as read.

**Auth required:** Yes

**Response `204`:** No content

**Status codes:** `204` / `401` / `404`

---

### PATCH /v1/notifications/read-all

**Purpose:** Mark all notifications as read.

**Auth required:** Yes

**Request body:** Empty

**Response `204`:** No content

---

### PATCH /v1/notifications/preferences

**Purpose:** Update notification email preferences.

**Auth required:** Yes

**Request body:**

```typescript
interface UpdateNotificationPreferencesRequestDto {
  emailOnCompletion?: boolean;
  emailOnPayment?: boolean;
  emailMarketing?: boolean;
  emailBirthday?: boolean;
  pushEnabled?: boolean; // reserved for mobile Phase 2
}
```

**Response `200`:**

```typescript
interface NotificationPreferencesResponseDto {
  preferences: {
    emailOnCompletion: boolean;
    emailOnPayment: boolean;
    emailMarketing: boolean;
    emailBirthday: boolean;
    pushEnabled: boolean;
  };
}
```

**Status codes:** `200` / `401` / `422`

**Unsubscribe rule:** Setting `emailMarketing=false` adds the user to the SendGrid suppression list. Legally required under CAN-SPAM / GDPR.

---

## 22. Dashboard API

**Base path:** `/v1/dashboard`

Aggregate/optimized endpoints for the dashboard UI. Avoid N+1 queries on the frontend. All responses are cached in Redis for 60 seconds per user.

---

### GET /v1/dashboard/summary

**Purpose:** Top-level summary: credits, plan, stats.

**Auth required:** Yes

**Response `200`:**

```typescript
interface DashboardSummaryResponseDto {
  user: {
    id: string;
    name: string;
    plan: string;
    creditBalance: number;
    nextRefillAt: string | null;
  };
  stats: {
    totalBooks: number;
    completedBooks: number;
    booksInProgress: number;
    totalChildren: number;
  };
  subscription: SubscriptionDto | null;
  hasPaymentIssue: boolean;
}
```

---

### GET /v1/dashboard/library

**Purpose:** Paginated book library for the dashboard grid.

**Auth required:** Yes

**Query params:**

| Param            | Default      | Description                             |
| ---------------- | ------------ | --------------------------------------- |
| `cursor`         | â€”          | Cursor                                  |
| `limit`          | 12           | Max 48                                  |
| `childProfileId` | â€”          | Filter by child                         |
| `status`         | â€”          | Filter by book status                   |
| `sort`           | `created_at` | `created_at` \| `updated_at` \| `title` |
| `order`          | `desc`       | `asc` \| `desc`                         |

**Response `200`:** `PaginatedResponse<BookListItemDto>`

---

### GET /v1/dashboard/children

**Purpose:** Child profiles with book counts.

**Auth required:** Yes

**Response `200`:**

```typescript
interface DashboardChildrenResponseDto {
  children: Array<
    ChildProfileDto & {
      bookCount: number;
      lastBookAt: string | null;
      latestCoverUrl: string | null;
    }
  >;
}
```

---

### GET /v1/dashboard/recent-activity

**Purpose:** Recent activity feed.

**Auth required:** Yes

**Query params:** `limit` (default 10, max 20)

**Response `200`:**

```typescript
interface RecentActivityResponseDto {
  activities: Array<{
    id: string;
    type: 'book_created' | 'book_completed' | 'book_failed' | 'payment_succeeded' | 'credits_added';
    title: string;
    bookId?: string;
    occurredAt: string;
    metadata: Record<string, unknown>;
  }>;
}
```

---

## 23. Admin API

**Base path:** `/v1/admin`

**Auth required:** Yes + `role=admin`

**Audit logging:** All write operations logged to `agent_logs` with `agent=admin_action`.

---

### GET /v1/admin/books

**Purpose:** List all books across all users.

**Query params:** `cursor`, `limit` (max 200), `status`, `userId`, `dateFrom`, `dateTo`, `generatedDegraded`

**Response `200`:** `PaginatedResponse<BookDto>` (includes `userId`, `totalCostUsd`)

---

### GET /v1/admin/generation-jobs

**Purpose:** View active, queued, and failed generation jobs with queue stats.

**Query params:** `queue`, `state` (`active|waiting|failed|completed`), `limit` (max 200)

**Response `200`:**

```typescript
interface AdminGenerationJobsResponseDto {
  jobs: GenerationJobDto[];
  queueStats: Record<
    string,
    {
      waiting: number;
      active: number;
      completed: number;
      failed: number;
    }
  >;
}
```

---

### POST /v1/admin/generation-jobs/{id}/retry

**Purpose:** Admin retry with optional step override.

**Request body:**

```typescript
interface AdminRetryJobRequestDto {
  fromStep?: AgentStep;
  priority?: 'high' | 'normal' | 'low';
  note?: string; // audit note
}
```

**Response `202`:**

```typescript
interface GenerationJobResponseDto {
  job: GenerationJobDto;
}
```

---

### GET /v1/admin/users/{id}

**Purpose:** Full user details for admin inspection.

**Response `200`:**

```typescript
interface AdminUserResponseDto {
  user: UserDto;
  subscription: SubscriptionDto | null;
  creditBalance: number;
  creditTransactions: CreditTransactionDto[];
  books: BookListItemDto[];
  totalBooksCount: number;
}
```

---

### GET /v1/admin/metrics

**Purpose:** Platform metrics aggregated for the admin dashboard.

**Query params:** `period` (`today` | `7d` | `30d` | `all`, default `today`)

**Response `200`:**

```typescript
interface AdminMetricsResponseDto {
  books: {
    totalCreated: number;
    completed: number;
    failed: number;
    inProgress: number;
    avgGenerationTimeMs: number;
    successRate: number;
  };
  revenue: {
    totalUsd: number;
    periodUsd: number;
    activeSubscriptions: number;
    byPlan: Record<string, number>;
  };
  pipeline: {
    avgCostPerBook: number;
    totalAiCostUsd: number;
    byProvider: Record<string, number>;
  };
  storage: {
    totalObjectCount: number;
    totalSizeGb: number;
    avgBookSizeMb: number;
  };
  users: {
    totalRegistered: number;
    newToday: number;
    activeToday: number;
  };
}
```

**Caching:** 5-minute Redis cache.

---

### GET /v1/admin/agent-runs

**Purpose:** Agent execution logs for a book â€” primary pipeline debugging tool.

**Query params:** `bookId` (required)

**Response `200`:**

```typescript
interface AdminAgentRunsResponseDto {
  bookId: string;
  runs: Array<{
    id: string;
    agent: string;
    step: string;
    provider: string;
    model: string;
    durationMs: number;
    tokensInput: number;
    tokensOutput: number;
    costUsd: number;
    attempt: number;
    status: 'success' | 'error' | 'retry';
    error: string | null;
    traceId: string;
    createdAt: string;
  }>;
  totalCostUsd: number;
  totalDurationMs: number;
}
```

---

## 24. API DTO Catalog

All types use strict TypeScript. No `any`. All optional fields use `?`. All enums use explicit union types.

---

### UserDto

```typescript
interface UserDto {
  id: string;
  email: string;
  name: string;
  locale: string;
  timezone: string;
  plan: UserPlan;
  creditBalance: number;
  role: 'user' | 'admin';
  emailVerified: boolean;
  oauthProvider: 'google' | 'apple' | null;
  notificationPreferences: {
    emailOnCompletion: boolean;
    emailOnPayment: boolean;
    emailMarketing: boolean;
    emailBirthday: boolean;
  };
  createdAt: string;
  updatedAt: string;
}

type UserPlan = 'free' | 'pay_per_book' | 'family' | 'annual' | 'educator';
```

---

### ChildProfileDto

```typescript
interface ChildProfileDto {
  id: string;
  userId: string;
  name: string;
  nickname: string | null;
  age: number;
  pronouns: 'he/him' | 'she/her' | 'they/them';
  birthday: string | null;
  avatarConfig: AvatarConfigDto | null;
  photoUrl: string | null;
  bookCount: number;
  createdAt: string;
  updatedAt: string;
}

interface AvatarConfigDto {
  skinTone: string;
  hairColor: string;
  hairStyle: string;
  eyeColor: string;
  accessories: string[];
}
```

---

### WizardDraftDto

```typescript
interface WizardDraftDto {
  id: string;
  userId: string | null;
  guestSessionId: string | null;
  step: number;
  completedSteps: number[];
  data: Partial<CreateBookRequestDto>;
  childProfileId: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}
```

---

### BookDto

```typescript
interface BookDto {
  id: string;
  userId: string;
  childProfileId: string | null;
  status: BookStatus;
  title: string | null;
  coverUrl: string | null;
  pageCount: number | null;
  request: CreateBookRequestDto;
  isPaid: boolean;
  paidAt: string | null;
  shareToken: string | null;
  isPublic: boolean;
  generatedDegraded: boolean;
  generationTimeMs: number | null;
  errorMessage: string | null;
  retryCount: number;
  createdAt: string;
  updatedAt: string;
}

type BookStatus =
  | 'created'
  | 'queued'
  | 'char_build'
  | 'story_plan'
  | 'chapter_gen'
  | 'illust_plan'
  | 'char_consistency'
  | 'image_gen'
  | 'qa_review'
  | 'layout'
  | 'pdf_render'
  | 'complete'
  | 'failed'
  | 'partial'
  | 'cancelled';
```

---

### BookListItemDto

```typescript
interface BookListItemDto {
  id: string;
  title: string | null;
  status: BookStatus;
  coverUrl: string | null;
  pageCount: number | null;
  childProfileId: string | null;
  childName: string | null;
  isPaid: boolean;
  isPublic: boolean;
  generationTimeMs: number | null;
  createdAt: string;
  updatedAt: string;
}
```

---

### BookPageDto

```typescript
interface BookPageDto {
  id: string;
  bookId: string;
  pageNumber: number;
  textContent: string | null;
  readingLevel: number | null;
  imageUrl: string | null;
  qaPassed: boolean | null;
  qaScores: {
    ageAppropriateness: number;
    characterConsistency: number;
    textImageAlignment: number;
    readingLevel: number;
  } | null;
  regenCount: number;
  status: 'pending' | 'generating' | 'complete' | 'failed';
  createdAt: string;
  updatedAt: string;
}
```

---

### GenerationJobDto

```typescript
interface GenerationJobDto {
  jobId: string;
  bookId: string;
  userId: string;
  status: JobStatus;
  currentStep: AgentStep | null;
  percentComplete: number;
  completedSteps: AgentStep[];
  pagesComplete: number;
  totalPages: number;
  priority: 'high' | 'normal' | 'low';
  attempt: number;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  errorCode: string | null;
  estimatedMinutes: number;
}

type JobStatus = 'queued' | 'active' | 'complete' | 'failed' | 'cancelled' | 'stalled';

type AgentStep =
  | 'char_build'
  | 'story_plan'
  | 'chapter_gen'
  | 'illust_plan'
  | 'char_consistency'
  | 'image_gen'
  | 'qa_review'
  | 'layout'
  | 'pdf_render';
```

---

### GenerationProgressEventDto

```typescript
interface GenerationProgressEventDto {
  eventId: string;
  bookId: string;
  type:
    | 'generation.started'
    | 'generation.progress'
    | 'generation.page_ready'
    | 'generation.cover_ready'
    | 'generation.completed'
    | 'generation.failed'
    | 'generation.cancelled';
  timestamp: string;
  payload: Record<string, unknown>;
}
```

---

### AssetDto

```typescript
interface AssetDto {
  id: string;
  userId: string;
  r2Key: string;
  contentType: string;
  fileSizeBytes: number;
  status: 'pending' | 'processing' | 'complete' | 'failed';
  failureReason: 'no_face_detected' | 'invalid_mime' | 'too_small' | 'processing_error' | null;
  processedUrl: string | null;
  childProfileId: string | null;
  createdAt: string;
  updatedAt: string;
}
```

---

### ShareLinkDto

```typescript
interface ShareLinkDto {
  token: string;
  bookId: string;
  userId: string;
  mode: 'preview_only' | 'full_read';
  passwordProtected: boolean;
  expiresAt: string | null;
  revokedAt: string | null;
  viewCount: number;
  createdAt: string;
}
```

---

### SubscriptionDto

```typescript
interface SubscriptionDto {
  id: string;
  userId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string | null;
  plan: UserPlan;
  status: 'active' | 'past_due' | 'cancelled' | 'trialing' | 'incomplete';
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
}
```

---

### PlanDto

```typescript
interface PlanDto {
  id: UserPlan;
  name: string;
  description: string;
  stripePriceId: string | null;
  pricing: {
    amount: number; // cents
    currency: string;
    interval: 'one_time' | 'month' | 'year' | null;
  };
  features: {
    creditsPerMonth: number;
    maxBookLength: 8 | 32;
    canEditPages: boolean;
    canRegeneratePages: boolean;
    canDownloadPdf: boolean;
    canCreateSeries: boolean;
    bookLengths: number[];
  };
  highlighted: boolean;
}
```

---

### InvoiceDto

```typescript
interface InvoiceDto {
  id: string;
  amount: number;
  currency: string;
  status: 'paid' | 'open' | 'void' | 'uncollectible';
  description: string;
  pdfUrl: string | null;
  periodStart: string;
  periodEnd: string;
  paidAt: string | null;
  createdAt: string;
}
```

---

### CreditTransactionDto

```typescript
interface CreditTransactionDto {
  id: string;
  userId: string;
  bookId: string | null;
  amount: number;
  balanceAfter: number;
  reason: CreditTransactionReason;
  stripePaymentId: string | null;
  createdAt: string;
}

type CreditTransactionReason =
  | 'book_creation'
  | 'regen_page'
  | 'refund_generation_failure'
  | 'purchase'
  | 'subscription_grant'
  | 'promotional_grant'
  | 'admin_adjustment';
```

---

### NotificationDto

```typescript
interface NotificationDto {
  id: string;
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  read: boolean;
  actionUrl: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

type NotificationType =
  | 'book_completed'
  | 'book_failed'
  | 'payment_succeeded'
  | 'payment_failed'
  | 'subscription_renewed'
  | 'subscription_cancelled'
  | 'credits_added'
  | 'birthday_reminder'
  | 'system';
```

---

## 25. Validation Rules

### 25.1 Signup

| Field      | Type   | Required | Constraints                                 | Error Code         |
| ---------- | ------ | -------- | ------------------------------------------- | ------------------ |
| `email`    | string | Yes      | Valid RFC 5322, max 254 chars, unique in DB | `VALIDATION_ERROR` |
| `password` | string | Yes      | Min 8 chars, â‰¥1 uppercase, â‰¥1 number    | `VALIDATION_ERROR` |
| `name`     | string | Yes      | 1â€“100 chars, no control characters        | `VALIDATION_ERROR` |
| `locale`   | string | No       | Valid BCP-47 code from supported list       | `VALIDATION_ERROR` |

### 25.2 Login

| Field      | Type   | Required | Constraints | Error Code         |
| ---------- | ------ | -------- | ----------- | ------------------ |
| `email`    | string | Yes      | Non-empty   | `VALIDATION_ERROR` |
| `password` | string | Yes      | Non-empty   | `VALIDATION_ERROR` |

### 25.3 Child Profile

| Field          | Type    | Required | Constraints                                              | Error Code         |
| -------------- | ------- | -------- | -------------------------------------------------------- | ------------------ |
| `name`         | string  | Yes      | 1â€“50 chars, no control characters                      | `VALIDATION_ERROR` |
| `nickname`     | string  | No       | 1â€“30 chars                                             | `VALIDATION_ERROR` |
| `age`          | integer | Yes      | 2â€“12 inclusive                                         | `VALIDATION_ERROR` |
| `pronouns`     | enum    | Yes      | `he/him` \| `she/her` \| `they/them`                     | `VALIDATION_ERROR` |
| `birthday`     | string  | No       | ISO 8601 date, past dates only, age consistency Â±1 year | `VALIDATION_ERROR` |
| `photoAssetId` | UUID    | No       | Owned by calling user, `status=complete`                 | `VALIDATION_ERROR` |

### 25.4 Book Creation

| Field                            | Type     | Required | Constraints                                                     | Error Code                                   |
| -------------------------------- | -------- | -------- | --------------------------------------------------------------- | -------------------------------------------- |
| `childName`                      | string   | Yes      | 1â€“50 chars, trimmed                                           | `VALIDATION_ERROR`                           |
| `age`                            | integer  | Yes      | 2â€“12 inclusive                                                | `VALIDATION_ERROR`                           |
| `pronouns`                       | enum     | Yes      | `he/him` \| `she/her` \| `they/them`                            | `VALIDATION_ERROR`                           |
| `appearance.hairColor`           | string   | Yes      | 1â€“50 chars                                                    | `VALIDATION_ERROR`                           |
| `appearance.hairStyle`           | string   | Yes      | 1â€“50 chars                                                    | `VALIDATION_ERROR`                           |
| `appearance.eyeColor`            | string   | Yes      | 1â€“50 chars                                                    | `VALIDATION_ERROR`                           |
| `appearance.skinTone`            | string   | Yes      | 1â€“50 chars                                                    | `VALIDATION_ERROR`                           |
| `appearance.distinctiveFeatures` | string[] | No       | Max 5 items, each â‰¤100 chars                                  | `VALIDATION_ERROR`                           |
| `personality`                    | string[] | Yes      | 1â€“5 items, each 1â€“50 chars                                  | `VALIDATION_ERROR`                           |
| `favoriteAnimals`                | string[] | No       | 0â€“3 items, each â‰¤50 chars                                   | `VALIDATION_ERROR`                           |
| `favoriteColors`                 | string[] | No       | 0â€“3 items, each â‰¤30 chars                                   | `VALIDATION_ERROR`                           |
| `favoriteToys`                   | string[] | No       | 0â€“3 items, each â‰¤50 chars                                   | `VALIDATION_ERROR`                           |
| `hobbies`                        | string[] | No       | 0â€“5 items, each â‰¤50 chars                                   | `VALIDATION_ERROR`                           |
| `educationalGoal`                | string   | No       | Max 200 chars                                                   | `VALIDATION_ERROR`                           |
| `genre`                          | enum     | Yes      | `adventure\|fantasy\|friendship\|mystery\|nature\|space\|ocean` | `VALIDATION_ERROR`                           |
| `bookLength`                     | enum     | Yes      | `8\|16\|24\|32` (plan-gated)                                    | `VALIDATION_ERROR` / `PLAN_UPGRADE_REQUIRED` |
| `illustrationStyle`              | enum     | Yes      | `watercolor\|comic\|3d_cartoon\|pencil_sketch`                  | `VALIDATION_ERROR`                           |
| `language`                       | string   | Yes      | Valid BCP-47 from supported list                                | `VALIDATION_ERROR`                           |
| `dedicationText`                 | string   | No       | Max 300 chars                                                   | `VALIDATION_ERROR`                           |
| All string fields                | â€”      | â€”      | Content safety screening                                        | `VALIDATION_CONTENT_POLICY`                  |

### 25.5 Photo Upload

| Field            | Type    | Required            | Constraints                                     | Error Code                |
| ---------------- | ------- | ------------------- | ----------------------------------------------- | ------------------------- |
| `contentType`    | string  | Yes                 | `image/jpeg\|image/png\|image/heic`             | `UPLOAD_INVALID_MIME`     |
| `fileSizeBytes`  | integer | Yes                 | 1â€“10,485,760 bytes (10MB)                     | `UPLOAD_FILE_TOO_LARGE`   |
| `filename`       | string  | Yes                 | 1â€“255 chars, extension must match contentType | `VALIDATION_ERROR`        |
| Image dimensions | â€”     | Checked server-side | Min 200Ã—200px                                  | `UPLOAD_TOO_SMALL`        |
| Face detection   | â€”     | Checked server-side | â‰¥1 face detected                              | `UPLOAD_NO_FACE_DETECTED` |

### 25.6 Share Link

| Field           | Type    | Required | Constraints               | Error Code         |
| --------------- | ------- | -------- | ------------------------- | ------------------ |
| `mode`          | enum    | Yes      | `preview_only\|full_read` | `VALIDATION_ERROR` |
| `expiresInDays` | integer | No       | 1â€“365 or null           | `VALIDATION_ERROR` |
| `password`      | string  | No       | Max 100 chars             | `VALIDATION_ERROR` |

### 25.7 Checkout

| Field     | Type | Required    | Constraints                                                 | Error Code         |
| --------- | ---- | ----------- | ----------------------------------------------------------- | ------------------ |
| `priceId` | enum | Yes         | One of the 4 configured Stripe price IDs                    | `VALIDATION_ERROR` |
| `bookId`  | UUID | Conditional | Required when `priceId=price_single`; must be owned by user | `VALIDATION_ERROR` |

### 25.8 Notification Preferences

All fields boolean, all optional. No error codes â€” invalid types return `422 VALIDATION_ERROR`.

---

## 26. Rate Limits

Rate limits are enforced per user (authenticated) or per IP (unauthenticated) via Redis sliding window.

### 26.1 Rate Limit Table

| Endpoint Group                            | Guest (per IP)  | Free User       | Paid User     | Admin        |
| ----------------------------------------- | --------------- | --------------- | ------------- | ------------ |
| General API                               | 30 req/min      | 100 req/min     | 200 req/min   | 1000 req/min |
| `POST /auth/login`                        | 10 req/15 min   | 10 req/15 min   | 10 req/15 min | Unlimited    |
| `POST /auth/signup`                       | 5 req/hour      | â€”             | â€”           | Unlimited    |
| `POST /auth/forgot-password`              | 3 req/hour      | 3 req/hour      | 3 req/hour    | Unlimited    |
| `POST /books`                             | N/A (auth req.) | 3 books/hour    | 10 books/hour | Unlimited    |
| `POST /books/{id}/regenerate`             | N/A             | 1 req/hour      | 5 req/hour    | Unlimited    |
| `POST /books/{id}/pages/{n}/regenerate-*` | N/A             | N/A (plan gate) | 10 req/hour   | Unlimited    |
| `POST /uploads/photo/presign`             | N/A             | 5 req/hour      | 10 req/hour   | Unlimited    |
| `GET /generation/jobs/{id}/events`        | N/A             | 5 concurrent    | 5 concurrent  | Unlimited    |
| `POST /billing/checkout-session`          | N/A             | 5 req/hour      | 5 req/hour    | Unlimited    |
| `GET /admin/*`                            | N/A             | N/A             | N/A           | 1000 req/min |

### 26.2 Global IP Limits (Cloudflare)

| Condition                | Limit       | Action |
| ------------------------ | ----------- | ------ |
| Any IP                   | 500 req/min | 429    |
| Auth endpoints, per IP   | 50 req/min  | 429    |
| Upload endpoints, per IP | 20 req/min  | 429    |

### 26.3 Generation Concurrency Limit

Maximum 2 books generating simultaneously per user. Third concurrent attempt â†’ `429 RATE_LIMIT_GENERATION`.

### 26.4 Rate Limit Headers

Included on all responses:

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 43
X-RateLimit-Reset: 1751280000
```

On 429:

```
Retry-After: 57
```

---

## 27. Authorization Matrix

| Resource                             | Guest            | Auth Free         | Auth Paid          | Book Owner           | Share-Link Viewer | Admin     |
| ------------------------------------ | ---------------- | ----------------- | ------------------ | -------------------- | ----------------- | --------- |
| **Wizard draft (guest)**             | Read/Write       | â€”               | â€”                | â€”                  | â€”               | â€”       |
| **Wizard draft (user)**              | â€”              | Read/Write        | Read/Write         | â€”                  | No                | Read      |
| **Create book**                      | No               | Yes (8-page)      | Yes (all)          | â€”                  | No                | Yes       |
| **List own books**                   | No               | Yes               | Yes                | â€”                  | No                | Yes (all) |
| **Read book metadata**               | No               | Yes (own)         | Yes (own)          | Yes                  | Preview only      | Yes       |
| **Preview pages 1â€“3**              | No               | Yes (own)         | Yes (own)          | Yes                  | Yes               | Yes       |
| **Full pages 4+**                    | No               | Yes (own, unpaid) | Yes (own, paid)    | Yes (if paid)        | No                | Yes       |
| **Edit page text**                   | No               | No                | No                 | Yes (paid plan only) | No                | Yes       |
| **Regenerate page**                  | No               | No                | No                 | Yes (paid plan only) | No                | Yes       |
| **Delete book**                      | No               | Yes (own)         | Yes (own)          | Yes                  | No                | Yes       |
| **Download PDF**                     | No               | No                | Yes (is_paid=true) | Yes (is_paid=true)   | No                | Yes       |
| **Preview PDF (3-page watermarked)** | Yes              | Yes               | Yes                | Yes                  | Yes               | Yes       |
| **Child profiles**                   | No               | Own only          | Own only           | Own only             | No                | All       |
| **Billing checkout**                 | No               | Yes               | Yes                | â€”                  | No                | Yes       |
| **Billing portal**                   | No               | Subscribers only  | Subscribers only   | â€”                  | No                | Yes       |
| **Share links: create**              | No               | No                | No                 | Yes                  | No                | Yes       |
| **Share links: view**                | Yes (with token) | Yes (with token)  | Yes (with token)   | Yes                  | Yes               | Yes       |
| **Admin endpoints**                  | No               | No                | No                 | No                   | No                | Yes       |

---

## 28. Idempotency Rules

### 28.1 Header

```
Idempotency-Key: <UUID v4>
```

Rules:

- Must be UUID v4 (36-char hyphenated)
- Unique per distinct user action
- Reused on retries of the same operation
- BFF generates this before proxying to NestJS

### 28.2 Idempotent Endpoints

| Endpoint                                         | TTL      | Duplicate Behavior    |
| ------------------------------------------------ | -------- | --------------------- |
| `POST /v1/books`                                 | 24 hours | Return original `202` |
| `POST /v1/generation/jobs`                       | 24 hours | Return original `202` |
| `POST /v1/generation/jobs/{id}/retry`            | 24 hours | Return original `202` |
| `POST /v1/books/{id}/regenerate`                 | 24 hours | Return original `202` |
| `POST /v1/books/{id}/pages/{n}/regenerate-image` | 1 hour   | Return original `202` |
| `POST /v1/books/{id}/pages/{n}/regenerate-text`  | 1 hour   | Return original `202` |
| `POST /v1/billing/checkout-session`              | 1 hour   | Return original `200` |
| `POST /v1/books/{id}/share-links`                | 1 hour   | Return original `201` |

### 28.3 Redis Storage Format

```
Key:   idempotency:{userId}:{idempotencyKey}
Value: { statusCode, body }   (JSON-serialized)
TTL:   Per table above
```

On duplicate: return cached response with `X-Idempotent-Replay: true` header.

### 28.4 In-Flight Race Condition

If the same key is received while the original is still processing:

```json
{ "error": { "code": "IDEMPOTENCY_KEY_IN_FLIGHT", "message": "..." } }
```

HTTP `409`. Client waits 2 seconds and retries.

### 28.5 Stripe Idempotency

All Stripe calls use a compound key:

```typescript
idempotencyKey: `${userId}:${priceId}:${clientIdempotencyKey}`;
```

### 28.6 Webhook Idempotency

```
Key:   stripe_event:{event.id}
Value: "processed"
TTL:   7 days
```

---

## 29. OpenAPI Readiness

### 29.1 Tags

| Tag              | Section |
| ---------------- | ------- |
| `auth`           | Â§6     |
| `users`          | Â§7     |
| `child-profiles` | Â§8     |
| `wizard-drafts`  | Â§9     |
| `uploads`        | Â§10    |
| `books`          | Â§11    |
| `book-pages`     | Â§12    |
| `generation`     | Â§13    |
| `reader`         | Â§15    |
| `downloads`      | Â§16    |
| `sharing`        | Â§17    |
| `billing`        | Â§18    |
| `credits`        | Â§19    |
| `webhooks`       | Â§20    |
| `notifications`  | Â§21    |
| `dashboard`      | Â§22    |
| `admin`          | Â§23    |

### 29.2 Security Schemes

```yaml
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT
    shareToken:
      type: apiKey
      in: query
      name: shareToken
    stripeSignature:
      type: apiKey
      in: header
      name: Stripe-Signature
```

### 29.3 Reusable Parameters

```yaml
components:
  parameters:
    bookId:
      name: bookId
      in: path
      required: true
      schema: { type: string, format: uuid }
    pageNumber:
      name: pageNumber
      in: path
      required: true
      schema: { type: integer, minimum: 1 }
    cursor:
      name: cursor
      in: query
      required: false
      schema: { type: string }
    limit:
      name: limit
      in: query
      schema: { type: integer, default: 20, minimum: 1, maximum: 100 }
    idempotencyKey:
      name: Idempotency-Key
      in: header
      required: false
      schema: { type: string, format: uuid }
```

### 29.4 Reusable Responses

```yaml
components:
  responses:
    Unauthorized:
      description: Authentication required
    Forbidden:
      description: Insufficient permissions or plan
    NotFound:
      description: Resource not found
    ValidationError:
      description: Input validation failed (422)
    RateLimited:
      description: Rate limit exceeded (429)
      headers:
        Retry-After:
          schema: { type: integer }
```

### 29.5 Codegen Strategy

```bash
# Regenerate typed API client from OpenAPI spec
npx @hey-api/openapi-ts \
  --input https://api.storyme.app/v1/openapi.json \
  --output src/shared/api/generated \
  --client fetch
```

The spec is auto-generated at build time from NestJS decorators + Zod schemas via `nestjs-zod`. Exposed at `GET /v1/openapi.json`.

### 29.6 Drift Prevention in CI

```yaml
- name: Check OpenAPI drift
  run: |
    curl -s https://staging-api.storyme.app/v1/openapi.json > /tmp/current.json
    diff packages/types/openapi.json /tmp/current.json || \
      (echo "OpenAPI drifted. Run: pnpm generate:spec" && exit 1)
```

---

## 30. Contract Testing Plan

### 30.1 Consumer-Driven Contracts (Pact)

The frontend is the consumer; the NestJS API is the provider. Pact tests define the expected request/response pairs.

**Location:** `apps/web/src/__tests__/contracts/`

**Example contract:**

```typescript
it('POST /v1/books returns 202 with expected shape', async () => {
  await provider
    .given('user has 3 credits and plan=free')
    .uponReceiving('a request to create an 8-page book')
    .withRequest({
      method: 'POST',
      path: '/v1/books',
      headers: { Authorization: 'Bearer <token>', 'Idempotency-Key': 'test-key' },
      body: validCreateBookRequest,
    })
    .willRespondWith({
      status: 202,
      body: Matchers.like({
        data: {
          bookId: Matchers.uuid(),
          status: 'queued',
          creditsCharged: 1,
        },
      }),
    });
});
```

**Coverage target:** All 201/202/200 success paths for every endpoint in Â§6â€“Â§23.

### 30.2 Backend Integration Tests

**Location:** `apps/api/src/__tests__/integration/`

Each endpoint test:

1. Seeds test data in isolated test Postgres instance
2. Calls endpoint via supertest
3. Asserts response shape matches DTO in Â§24
4. Asserts DB state after mutation

### 30.3 DTO Snapshot Tests

```typescript
it('BookDto matches snapshot', () => {
  const schema = zodToJsonSchema(BookDtoSchema);
  expect(schema).toMatchSnapshot();
});
```

Run with: `pnpm test:snapshots`

### 30.4 SSE Event Tests

```typescript
it('generation.completed event has required fields', () => {
  const event = buildGenerationCompletedEvent({ bookId: 'bk_test' });
  expect(event).toMatchSchema(GenerationCompletedEventSchema);
  expect(event.pdfReady).toBe(true);
});
```

Every event type in Â§14 has a Zod schema and a unit test.

### 30.5 Webhook Fixture Tests

**Location:** `apps/api/src/__tests__/fixtures/stripe/`

Fixtures captured from Stripe test mode:

```
checkout.session.completed.json
customer.subscription.created.json
customer.subscription.updated.json
customer.subscription.deleted.json
invoice.payment_succeeded.json
invoice.payment_failed.json
payment_intent.succeeded.json
payment_intent.payment_failed.json
charge.refunded.json
```

Each fixture test sends the payload to `POST /v1/webhooks/stripe` with a valid test signature, asserts DB state, then sends it again to verify idempotency.

### 30.6 Frontend Mock Generation

MSW handlers auto-generated from Pact contracts:

```typescript
// apps/web/src/__tests__/mocks/handlers.ts (generated)
export const handlers = [
  rest.post('/api/books', (req, res, ctx) =>
    res(ctx.status(202), ctx.json(bookCreatedMockResponse)),
  ),
];
```

Regenerate with: `pnpm generate:mocks`

### 30.7 OpenAPI Drift Prevention

CI fails if checked-in `packages/types/openapi.json` does not match the live staging spec. Engineers run `pnpm generate:spec` to update.

---

## 31. Architecture Alignment Notes

Issues that must be resolved before implementation to prevent conflicting interpretations.

---

### Issue 1: Direct Frontend-to-Backend vs BFF

**Problem:** `ARCHITECTURE.md` implies both a direct connection and a BFF. `BACKEND_DESIGN.md Â§1.4` lists CORS for `storyme.app`, which could mean the browser hits NestJS.

**Decision:** The browser **never** calls `api.storyme.app` directly. All traffic routes through the BFF at `storyme.app/api`. The NestJS CORS allows `storyme.app` so the BFF server process can call NestJS server-to-server. The browser's fetch target is always the BFF.

**Impact:** All `apiClient` calls in the frontend target BFF paths (`/api/...`). No NestJS URL appears in browser code.

**Follow-up:** Confirm in `FRONTEND_DESIGN.md Â§8` that `apiClient` base URL is `storyme.app/api`.

---

### Issue 2: Socket.io vs SSE

**Problem:** `ARCHITECTURE.md` shows a WebSocket server. `BACKEND_DESIGN.md Â§1.7` describes Socket.io events. `FRONTEND_DESIGN.md Â§10` is titled "WebSocket & SSE Strategy."

**Decision:**

- **NestJS â†’ BFF:** Socket.io (server-to-server, internal)
- **BFF â†’ Browser:** SSE via `EventSource` (external, browser-compatible)
- The browser uses `EventSource`. No Socket.io client library in the browser bundle.

**Impact:** BFF needs a Socket.io client. Frontend needs only the native `EventSource` API.

**Follow-up:** Update `FRONTEND_DESIGN.md Â§10` to specify SSE-only browser strategy.

---

### Issue 3: Guest Wizard vs Authenticated Generation

**Problem:** The transition point from guest wizard to authenticated generation was implicit.

**Decision:**

- Wizard steps 1â€“5 are accessible to guests. Draft saved server-side by `storyme_guest_session` cookie.
- Step 6 ("Preview & auth wall") requires authentication before calling `POST /v1/books`.
- On login/signup at step 6, BFF auto-calls `POST /v1/wizard-drafts/migrate`.
- `POST /v1/books` always requires authentication â€” returns `401` for unauthenticated callers.

**Follow-up:** Confirm auth-gate placement in `UX_SPEC.md`.

---

### Issue 4: Free Preview vs Paid PDF

**Problem:** Inconsistency between documents on what "free" users can access.

**Decision:**

- **Always free:** Pages 1â€“3 in reader, 3-page watermarked preview PDF, share-link preview mode
- **Requires `is_paid=true`:** Pages 4+ in reader, full PDF download (screen + print)
- `is_paid=true` is set by: (a) consuming a subscription credit at `POST /v1/books`, OR (b) successful Stripe `payment_intent.succeeded` webhook
- Free plan users' 3 starter credits make their generated books `is_paid=true`

**Follow-up:** Make this explicit in `PRD.md Â§15`.

---

### Issue 5: Credits vs Subscriptions Coexistence

**Problem:** Whether subscription users consume credits or have unlimited generation was unclear.

**Decision:**

- Credits are **always** consumed at `POST /v1/books`, regardless of plan
- Subscriptions grant a monthly credit allowance (family: 10/mo, annual: 10/mo, educator: 30/mo)
- `pay_per_book` users: no credits â€” they pay per book via Stripe checkout (webhook sets `is_paid=true`)
- Subscription user with 0 credits â†’ `402 PLAN_CREDITS_EXHAUSTED` (must wait for refill or buy more)

**Follow-up:** Confirm educator plan credit grant in `BACKEND_DESIGN.md Â§7.5`.

---

### Issue 6: PDF Generation â€” Sync vs Async

**Problem:** Initial pipeline PDF is async (PDFRenderAgent). Post-edit PDF trigger via API endpoint was underdefined.

**Decision:**

- **Initial generation:** `PDFRenderAgent` runs as the final pipeline step. No explicit API call needed.
- **Post-edit regeneration:** `POST /v1/books/{bookId}/pdf` triggers a new `pdf:render` BullMQ job. Plan-gated (family, annual, educator).
- Re-generation does NOT re-run AI agents â€” only the layout and PDF render step.

**Impact:** Frontend must show "Regenerating PDF..." state after page edits. The current `pdf_url` remains valid until regeneration completes.

---

### Issue 7: Public Assets vs Signed URLs

**Decision (authoritative):**

| Asset                     | Served as              | Why                                        |
| ------------------------- | ---------------------- | ------------------------------------------ |
| Cover thumbnail `.webp`   | Public CDN URL         | Fast loading; not the paid deliverable     |
| Page images `.webp`       | Public CDN URL         | Reader performance; acceptable risk        |
| Preview PDF (watermarked) | Public CDN URL         | Shareable by design                        |
| Full PDF (print/screen)   | Signed R2 URL, 24h TTL | Paid deliverable; ownership check required |
| Original PNG images       | Internal only          | Used only by PDF renderer                  |

**Impact:** Frontend constructs page image URLs from CDN pattern (Â§2.3) directly. PDF downloads always need an API call first.

---

### Issue 8: Plan Limits Enforcement Location

**Decision:** NestJS is the authoritative enforcer. The BFF and frontend show UX-only gates (upgrade CTAs) based on cached plan from `/v1/users/me`, but these are never relied upon for security.

---

### Issue 9: `bookId` as `jobId`

**Decision:** `jobId === bookId` always. There is no separate job UUID for generation jobs. The `GenerationJobDto.jobId` field is an alias. Future async operations (PDF regeneration) use separate job IDs returned by their respective endpoints.

---

### Issue 10: Anonymous Reader Access via Share Token

**Decision:**

- `GET /v1/reader/books/{bookId}?shareToken={token}` bypasses `JwtAuthGuard`
- A `ShareTokenGuard` validates the share token against the `share_links` table
- Returns pages up to `previewPageCount` based on share link `mode`
- Anonymous readers cannot bookmark, save progress, or download PDFs

**Impact:** NestJS reader controller needs a custom guard accepting either Bearer token or `shareToken` query param.

**Follow-up:** Add `ShareTokenGuard` to `BACKEND_DESIGN.md`.

---

_Document version 1.0 â€” StoryMe API Specification_
_This document is the authoritative engineering contract._
_Changes require RFC + approval from the Staff API Architect._
_Next step: Generate OpenAPI 3.1 YAML from this document's DTOs and endpoint definitions._
