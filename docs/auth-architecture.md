# StoryMe Auth Architecture — Phase 6A Plan

Status: **planning only — nothing in this document has been implemented.**
No auth libraries, guards, controllers, routes, or schema changes were made
while writing it. See [Quality gates](#quality-gates) at the bottom.

This phase produces the plan. Implementation is a future phase (proposed
name: Phase 6B).

---

## 1. Current state — how auth works today

StoryMe has no real authentication. Every request is attributed to a caller
identity taken **on faith** from a request header.

### 1.1 `DevAuthGuard` (`apps/api/src/auth/dev-auth.guard.ts`)

- Reads `x-user-email` (required) and `x-user-name` (optional) headers.
- Validates only that `x-user-email` looks like an email address
  (`class-validator`'s `isEmail`) — no password, token, or session check.
- Calls `UsersService.findOrCreateByEmail()`, which **auto-provisions** a
  `User` row on first sight of a new email and returns the existing row
  otherwise.
- Attaches the resulting `User` to `request.user` and returns `true`
  (`CanActivate`), i.e. it never actually denies a syntactically valid
  request.

### 1.2 `AuthModule` (`apps/api/src/auth/auth.module.ts`)

- Imports `UsersModule`, declares `AuthController`, provides `DevAuthGuard`.
- Exports **both** `DevAuthGuard` and `UsersModule` — the latter only
  because Nest resolves a cross-module guard's constructor deps relative to
  the *consuming* module's visible providers, not the guard's own declaring
  module. `BooksModule` imports `AuthModule` (not `UsersModule` directly)
  and applies `@UseGuards(DevAuthGuard)`, so `UsersModule` must be
  re-exported or the app fails to boot. (This was a real boot-blocking bug
  found and fixed in Phase 5C — see `docs/deployment-readiness.md`.) Any
  real-auth replacement module needs the same re-export if it keeps a
  similar guard/service split.

### 1.3 `AuthController` (`apps/api/src/auth/auth.controller.ts`)

- One route: `GET /api/me`, guarded by `DevAuthGuard`, returns
  `toUserDto(user)`. No register/login/logout/refresh endpoints exist.

### 1.4 `UsersService` / `UsersModule` (`apps/api/src/users/`)

- `findOrCreateByEmail(email, name?)` is the only method. No password
  handling, no credential verification, no lookup-without-create path.

### 1.5 `User` Prisma model (`apps/api/prisma/schema.prisma:160-203`)

Already contains fields a real auth system needs, unused today:
- `passwordHash String?` — nullable, ready for email/password users.
- `oauthProvider String?` / `oauthId String?` with a composite index —
  ready for OAuth users.
- `emailVerified Boolean @default(false)`.
- `role UserRole @default(user)` (`user | admin`).
- `deactivatedAt DateTime?`.

A `RefreshToken` model already exists (`schema.prisma:205-221`): `userId`,
`tokenHash` (unique), `family` (UUID, for rotation/reuse-detection), 
`expiresAt`, `revokedAt`, `ipAddress`, `userAgent`. This is the exact shape
`BACKEND_DESIGN.md` §6.1/§6.4 describes for refresh-token-family rotation.

**Conclusion: no schema migration is needed to start implementing real
auth.** The columns and the `RefreshToken` table are already migrated in
(`prisma/migrations/20260630000000_init`). This phase proposes zero schema
changes.

### 1.6 Request user typing (`apps/api/src/auth/request-with-user.ts`)

`RequestWithUser extends Request { user?: User }` — generic enough that a
real guard can populate the same field; `@CurrentUser()`
(`current-user.decorator.ts`) and every consuming controller only depend on
`request.user` being populated, not on how.

### 1.7 Protected controllers

Only two controllers use `@UseGuards(DevAuthGuard)`:
- `AuthController` (`GET /api/me`)
- `BooksController` (`apps/api/src/books/books.controller.ts`) — all of
  `GET/POST /books`, `GET/PATCH/DELETE /books/:id`, `GET
  /books/:id/pdf/preview`, `POST /books/:id/generate`, `POST
  /books/:id/retry-generation`, `GET /books/:id/generation-diagnostics`.

`HealthController` is the only other controller and is intentionally
unguarded (health checks).

All `BooksService` methods take `userId` as a parameter and scope Prisma
queries to it (e.g. `findAllForUser`, `findOneForUser`) — ownership
filtering already happens at the service layer, keyed off whatever
`user.id` the guard attaches. This means a real auth guard is a drop-in
replacement as long as it populates `request.user.id` correctly; no service
or controller logic needs to change.

### 1.8 Frontend assumptions

- `apps/web/src/lib/api/client.ts` hardcodes `DEV_EMAIL =
  'dev@storyme.local'` and `DEV_NAME = 'Dev User'`, sent as
  `x-user-email`/`x-user-name` on **every** `apiFetch`/`apiFetchBlob` call.
  There is no login flow, no token storage, no auth state.
- `apps/web/src/app/dashboard/page.tsx` hardcodes the display text `Signed
  in as dev@storyme.local` — it does not read this from an API response.
- No login/register page exists (`apps/web/src/app/` has only `page.tsx`
  (landing), `dashboard/page.tsx`, `dashboard/books/new/page.tsx`,
  `dashboard/books/[id]/page.tsx`).
- No route protection: `/dashboard/*` renders unconditionally; there is no
  redirect-to-login for an unauthenticated visitor because "unauthenticated"
  isn't a state the frontend can currently represent.
- No BFF layer: `apps/web` has no `app/api/*` route handlers. The browser
  calls the NestJS API directly via `NEXT_PUBLIC_API_URL`, cross-origin.

### 1.9 CORS (`apps/api/src/main.ts:22-39`)

`allowedHeaders` explicitly allow-lists `x-user-email` and `x-user-name`
next to `Content-Type`/`Authorization`/`X-Request-ID`, with a comment
marking them dev-only. `credentials: true` is already set (needed for any
future cookie-based refresh token), and `origin` is env-driven via
`ALLOWED_ORIGINS`, not hardcoded — so no CORS *infrastructure* change is
needed, only removing the two dev headers once `DevAuthGuard` is retired.

### 1.10 Docs already describing this

- `docs/deployment-readiness.md` (§"Auth limitation", lines ~341-363)
  already documents the `x-user-email` trust model, names the exact schema
  fields reserved for real auth, and lists it as a public-production
  blocker. This phase's findings agree with and extend that section.
- `docs/local-demo.md` mentions the `x-user-email` header sent automatically
  by the web app.
- `docs/private-demo-deploy.md` repeats the same warning for the private
  demo runbook.
- `apps/api/docs/local-generation-pipeline.md` references `x-user-email` in
  passing (pipeline walkthrough uses it to identify the caller).
- **Pre-existing target design already exists** in `BACKEND_DESIGN.md` §6
  ("Auth") and `API_SPEC.md` (`/v1/auth/*` / `/api/auth/*` contracts) and
  `ROADMAP.md` Phase 1 (TASK-027 through TASK-036) — written before any auth
  code existed. It specifies JWT access tokens + rotating refresh-token
  cookies with token-family reuse detection, plus optional Google/Apple
  OAuth, behind a BFF token-relay layer. `JWT_SECRET`/`JWT_REFRESH_SECRET`
  are already in `.env.example` and already validated at API startup
  (`apps/api/src/config/env.schema.ts:20-21`, min 32 chars) — reserved for
  this but currently unused by any code. **This phase's recommendation
  builds on that existing design rather than inventing a new one**, scoped
  down for a first implementation pass (see §3).

---

## 2. Security risks in `DevAuthGuard`

1. **Full identity impersonation.** Any caller can act as any user —
   existing or not-yet-existing — simply by setting `x-user-email`. There is
   no secret, token, or proof of control over that email address. Combined
   with CORS `origin` being the only cross-origin restriction (and origin is
   spoofable outside a browser, e.g. via `curl`), anyone who can reach the
   API can read/write/delete **any** user's books.
2. **No credential verification of any kind.** No password, no signed
   token, no session cookie. `passwordHash` exists on the model but nothing
   ever checks it.
3. **Silent auto-provisioning.** `findOrCreateByEmail` creates a `User` row
   for any syntactically valid email on first use — an attacker can mint
   arbitrary accounts with no rate limit, no email ownership proof, no
   CAPTCHA.
4. **No expiry, no revocation, no logout.** There's no token to expire or
   revoke, so there's no way to end a "session" — the concept doesn't exist.
5. **Header trust extends to the frontend by construction.** The web client
   hardcodes a single identity (`dev@storyme.local`); this is fine only
   because it's the *only* identity anyone is meant to use in this
   deployment.
6. **Why this is acceptable today:** the current deployment target (per
   `docs/private-demo-deploy.md`, Phase 5E) is a private/internal demo
   shared only with trusted reviewers via an unlisted URL, single shared
   dev identity, no billing, no real user data beyond the operator's own
   test books. The blast radius of impersonation is "someone I gave the URL
   to could see/edit demo books," not "an attacker takes over paying
   users' accounts."
7. **What must change before any public exposure:**
   - Replace header-based identity with cryptographically verified identity
     (signed JWT and/or verified password).
   - Remove auto-provisioning-on-any-request; require an explicit
     register/OAuth step.
   - Remove `x-user-email`/`x-user-name` from `allowedHeaders` in CORS.
   - Add rate limiting on auth endpoints specifically (brute force,
     credential stuffing, account enumeration via registration).
   - Add session/token revocation (logout, and ideally reuse detection on
     refresh tokens).

---

## 3. Recommended auth strategy

| | A. Email/password + JWT + refresh cookie | B. Magic link / OTP | C. OAuth (Google/GitHub) | D. External provider (Clerk/Auth0/Supabase) |
|---|---|---|---|---|
| Fastest safe path | Moderate — need password hashing, token issuance/verification, rotation | Needs transactional email sending (not built yet) | Fast per-provider, but needs OAuth app registration + callback plumbing | Fastest to wire, but adds an external service dependency and account |
| Complexity | Medium, fully in our control | Medium (email deliverability is the hard part) | Low-medium per provider, multiplies with each provider added | Low code, but a new vendor integration + billing surface |
| Frontend integration | Standard login/register forms | Simple form, but async "check your email" step breaks the immediate-use flow | Redirect-based, slightly awkward for a modal-driven UX | SDK-driven, less control over UI |
| Backend control | Full — auth data lives in our DB, matches existing schema exactly | Full | Partial — identity delegated to provider, but our DB still owns the account | Minimal — provider owns credentials/sessions |
| User ownership | Full ownership of `User`/`RefreshToken` rows already in schema | Same schema, just no `passwordHash` usage | Schema already has `oauthProvider`/`oauthId` for this | Would require syncing an external user ID into our schema |
| Deployment simplicity | No new external services; needs `JWT_SECRET`/`JWT_REFRESH_SECRET` (already reserved) | Needs an email provider (SMTP/Resend/etc.) not yet integrated | Needs OAuth app credentials per provider, and a public callback URL (harder before this ships) | Needs a Clerk/Auth0/Supabase account, its own env vars, and its own uptime dependency |
| Portfolio/demo value | High — demonstrates hashing, JWT, refresh rotation, guard design end-to-end | Lower — mostly showcases email plumbing | Medium — shows OAuth integration but less "roll your own auth" depth | Lowest — the interesting work is delegated to the vendor |

**Recommendation: Option A — email/password with a short-lived JWT access
token plus a rotating refresh token in an `HttpOnly` cookie**, matching the
design already specified in `BACKEND_DESIGN.md` §6 and scaffolded in the
Prisma schema (`passwordHash`, `RefreshToken.family`) and env schema
(`JWT_SECRET`, `JWT_REFRESH_SECRET`).

Reasoning:
- It's the only option requiring **zero new external services** — no email
  provider, no OAuth app registration, no third-party account — which keeps
  this deployable on the same private-demo infra documented in Phase 5E.
- The schema and env vars were already designed for exactly this; picking
  anything else means those fields sit unused and the `passwordHash`/
  `RefreshToken` design goes to waste.
- It gives the most implementation depth for a portfolio project (password
  hashing, JWT signing/verification, refresh rotation with reuse detection,
  guard replacement) versus a fast-but-shallow vendor integration.
- OAuth (C) is a natural **follow-up**, not a replacement — the schema
  already reserves `oauthProvider`/`oauthId` on the same `User` row, so it
  can be added later as a second login method without a schema change,
  exactly as `BACKEND_DESIGN.md` §6.5 lays out.

**Scoping note — one deviation from `BACKEND_DESIGN.md`:** that document
specifies a Next.js BFF that proxies auth and holds the token relay
(`ARCHITECTURE.md`/`API_SPEC.md` diagrams a "Next.js BFF ... protects
tokens" layer). No such BFF exists in `apps/web` today — the browser calls
the NestJS API directly cross-origin (confirmed in §1.8/§1.9). Building a
full BFF token-relay layer is a significant, separable addition. **This
plan proposes the API set the refresh cookie directly** (cross-origin,
`SameSite=None; Secure`, scoped to `/api/auth`) and the browser hold the
access token in memory, calling the API directly — matching the current
architecture instead of introducing a BFF as a Phase 6 prerequisite. A BFF
can be layered in later without changing the `User`/`RefreshToken` schema
or the token semantics; it only changes *where* the refresh cookie is set
and *who* calls `/auth/refresh`. This is the one place this plan's backend
design differs from `BACKEND_DESIGN.md`, and it should be called out
explicitly if that document is ever treated as binding rather than
directional.

---

## 4. Proposed backend architecture

### 4.1 `AuthModule` responsibilities

- Owns `AuthController`, `AuthService`, `TokenService`, `PasswordService`
  (or fold hashing into `AuthService` — small enough either way), and the
  new `JwtAuthGuard`.
- Continues to import/export `UsersModule` (same re-export pattern as
  today, for the same cross-module DI reason documented in §1.2).
- `DevAuthGuard` stays in the module, gated to non-production use only
  (see §4.6).

### 4.2 `AuthController` endpoints

See full contracts in §6. Routes: `POST /api/auth/register`, `POST
/api/auth/login`, `POST /api/auth/logout`, `POST /api/auth/refresh`, `GET
/api/auth/me` (replaces today's `GET /api/me`).

### 4.3 `AuthService` responsibilities

- `register(email, password, name?)`: uniqueness check → hash password →
  create `User` (`plan: free`, `credits: 3`, matching current defaults) →
  issue token pair.
- `login(email, password)`: look up by email → reject generically on
  not-found *or* wrong password (no user-enumeration signal) → reject with
  a distinct message if `passwordHash` is null (OAuth-only account, once
  OAuth exists) → issue token pair.
- `refresh(rawRefreshToken)`: hash → look up in `RefreshToken` by hash →
  reuse-detected handling (see §4.5) → rotate → issue new pair.
- `logout(rawRefreshToken)`: revoke the matching `RefreshToken` row.
- `getMe(user)`: thin passthrough to `toUserDto` (already exists).

### 4.4 Password hashing

- `bcrypt`, cost factor 12 (matches `BACKEND_DESIGN.md` §6.2). New
  dependency (`bcrypt` or `@node-rs/bcrypt`) — **not installed in this
  phase**.
- Minimum policy: 8+ chars, at least one uppercase, at least one number
  (matches `BACKEND_DESIGN.md` §6.2). Enforced via `class-validator` on the
  register DTO, consistent with the existing `ValidationPipe`
  (`whitelist`/`forbidNonWhitelisted`, already global in `main.ts`).

### 4.5 Token / session strategy

- Access token: JWT, HS256, signed with `JWT_SECRET`, 15 min expiry,
  payload `{ sub: userId, email, role, iat, exp }`. Held in memory on the
  frontend (never `localStorage`), sent as `Authorization: Bearer <token>`.
- Refresh token: opaque random value (not a JWT — matches
  `BACKEND_DESIGN.md` §6.1), 7 day expiry, transmitted only via `HttpOnly;
  Secure; SameSite=None; Path=/api/auth` cookie (`SameSite=None` because web
  and API are on different origins per the current deployment architecture
  in `docs/private-demo-deploy.md`; `Strict` only becomes viable if a same-
  origin BFF is added later). The *hash* of the token (bcrypt or SHA-256 —
  SHA-256 is sufficient here since it's a high-entropy random value, not a
  human password; cheaper than bcrypt for this) is stored in
  `RefreshToken.tokenHash`.
- **Rotation + reuse detection**, using the existing `RefreshToken.family`
  column: each login generates a new `family` UUID; each refresh revokes
  the presented token and issues a new one in the same family. If a
  *revoked* token is presented again, treat it as theft — revoke every
  token in that family, forcing re-login. This is a direct implementation
  of `BACKEND_DESIGN.md` §6.4 against the schema that's already migrated
  in.
- No schema changes required (§1.5).

### 4.6 Guards

- `JwtAuthGuard` (new, `apps/api/src/auth/jwt-auth.guard.ts`): extracts
  `Authorization: Bearer`, verifies signature + expiry, loads the `User` row
  by `sub` (fresh from DB, not just trusting the payload — matches
  `BACKEND_DESIGN.md` §6.6 reasoning: plan/role changes take effect without
  re-login), attaches to `request.user`. Same `RequestWithUser` shape as
  today — no controller changes needed.
- `DevAuthGuard`: kept, but restricted to non-production. Concretely: throw
  from its constructor (or from `canActivate`) if
  `process.env.NODE_ENV === 'production'`, so it fails loudly if
  accidentally left wired into a controller in prod rather than silently
  granting access. It remains available for fast local iteration without
  needing to register/log in every time `pnpm --filter @book/api dev`
  restarts.
- `BooksController` and `AuthController`'s `/me` route swap
  `@UseGuards(DevAuthGuard)` → `@UseGuards(JwtAuthGuard)`. No other change,
  because ownership filtering already happens in `BooksService` off
  `user.id` (§1.7).

### 4.7 Current-user decorator / request typing

- `RequestWithUser` and `@CurrentUser()` are already generic over "however
  `request.user` got populated" — no changes needed (§1.6).

### 4.8 `UsersService` changes

- Split `findOrCreateByEmail` (dev-only convenience) from two new,
  explicit methods `AuthService` needs: `findByEmail(email)` (returns
  `null`, doesn't create) and `create(data: { email, passwordHash, name?
  })`. Keep `findOrCreateByEmail` only for `DevAuthGuard`'s continued
  non-prod use.

### 4.9 Prisma schema changes

**None required for the core flow** — see §1.5. If OAuth (follow-up phase)
is added later, still no migration needed; `oauthProvider`/`oauthId`
already exist.

### 4.10 Migration plan

No `prisma migrate` needed for this phase. See §7 for the code migration
sequence (distinct from a DB migration).

---

## 5. Proposed frontend architecture

- **Login/register**: two routes, `apps/web/src/app/login/page.tsx` and
  `apps/web/src/app/register/page.tsx` (plain pages, not a modal — simpler
  to link to from a 401 redirect, and avoids needing global modal state).
- **Logout**: a button (e.g. in a header/nav, which doesn't exist yet
  either — dashboard currently has no chrome beyond its own header) that
  calls `POST /api/auth/logout`, clears the in-memory access token, and
  redirects to `/login`.
- **Protected routing**: `apps/web/src/app/dashboard/layout.tsx` (new) reads
  auth state; if unauthenticated after the initial load resolves, redirect
  to `/login?next=<path>`. Client-side check is acceptable here (no SSR
  auth today — matches the existing all-client-rendered dashboard).
- **Auth state**: a small React context (`AuthProvider`) wrapping
  `RootLayout`, holding `{ user, accessToken, status: 'loading' | 'authed'
  | 'anon' }`. On mount, if a refresh cookie might exist, silently call
  `POST /api/auth/refresh` to try to obtain an access token before deciding
  `anon` vs `authed` — this is what makes "stay logged in across a page
  reload" work without `localStorage`.
- **Token storage**: access token in the `AuthProvider`'s React state only
  (memory) — never `localStorage`/`sessionStorage`, per
  `BACKEND_DESIGN.md` §6.1's rationale (XSS exfiltration risk). Refresh
  token never touches JS at all (`HttpOnly` cookie, §4.5).
- **API client changes** (`apps/web/src/lib/api/client.ts`):
  - Remove the hardcoded `DEV_EMAIL`/`x-user-email`/`x-user-name` headers.
  - Add `Authorization: Bearer <accessToken>`, sourced from the
    `AuthProvider` (module can't import a hook directly — proposal:
    `apiFetch` accepts an optional token, or a tiny non-React token holder
    module that `AuthProvider` updates and `apiFetch` reads synchronously).
  - Add `credentials: 'include'` to both `apiFetch` and `apiFetchBlob` so
    the refresh cookie round-trips (CORS already has `credentials: true`
    server-side per §1.9).
  - On a `401`, attempt one `POST /api/auth/refresh`, then retry the
    original request once with the new token; on a second 401, clear auth
    state and surface the error (caller navigates to `/login`).
- **Redirect after login**: honor `?next=` if present, else `/dashboard`.
- **Error states**: inline form error for invalid credentials (login),
  inline field error for duplicate email / weak password (register), and a
  full-page "session expired" state if refresh fails while already on a
  protected route.

---

## 6. API contract proposal

All routes under the existing `/api` global prefix (`main.ts:42`).

### `POST /api/auth/register`
- Body: `{ email: string, password: string, name?: string }`
- Validation: `email` valid format; `password` ≥ 8 chars, 1 uppercase, 1
  number; `name` optional, trimmed, max length matching existing user name
  constraints.
- 201: `{ accessToken: string, user: UserDto }` + `Set-Cookie:
  storyme_refresh=...; HttpOnly; Secure; SameSite=None; Path=/api/auth;
  Max-Age=604800`
- 409: email already registered
- 400: validation failure (shape matches existing global `ValidationPipe`
  error format)

### `POST /api/auth/login`
- Body: `{ email: string, password: string }`
- 200: `{ accessToken: string, user: UserDto }` + refresh cookie (same as
  register)
- 401: invalid credentials (generic message — do not distinguish
  "no such user" from "wrong password"); also 401 with a distinct message
  if the account has no `passwordHash` (OAuth-only, future)
- 429: rate-limited (see §8, §2 risk 3)

### `POST /api/auth/logout`
- No body. Reads `storyme_refresh` cookie.
- Auth required: refresh cookie (not access token — must work even if the
  access token already expired).
- 204, clears cookie (`Max-Age=0`)

### `POST /api/auth/refresh`
- No body. Reads `storyme_refresh` cookie.
- 200: `{ accessToken: string, user: UserDto }` + rotated refresh cookie
- 401: missing/invalid/expired/reused token (reuse ⇒ family revoked, per
  §4.5)

### `GET /api/auth/me`
- Auth required: `Authorization: Bearer <accessToken>` via `JwtAuthGuard`
- 200: `UserDto` (same shape as today's `GET /api/me`)
- 401: missing/invalid/expired access token
- Replaces `GET /api/me`; keep `/api/me` as a deprecated alias returning the
  same payload for one release if any external caller depends on it (none
  currently do — internal only).

---

## 7. Migration from `DevAuthGuard` — implementation sequence

1. **Backend: token plumbing.** Add `bcrypt` + a JWT lib (`@nestjs/jwt` or
   raw `jsonwebtoken`, matching `TokenService` as sketched in
   `ROADMAP.md` TASK-029). Implement `TokenService`
   (sign/verify access + refresh), unit tested in isolation.
2. **Backend: `AuthService`.** `register`/`login`/`refresh`/`logout` per
   §4.3, against real `UsersService` methods added in §4.8.
3. **Backend: `JwtAuthGuard`.** Implement, unit test against
   valid/expired/malformed/missing tokens.
4. **Backend: `AuthController`.** Wire the five endpoints (§6), with
   `ValidationPipe`-backed DTOs for register/login bodies.
5. **Backend: swap guards.** `BooksController` and the `/me` route move to
   `JwtAuthGuard`. `DevAuthGuard` gains the prod-disable check (§4.6) and
   stays wired for local-only convenience — or is dropped entirely from
   `BooksController` at this step if the team decides local dev should also
   use real login (open decision, not blocking).
6. **Frontend: `AuthProvider` + token holder module.**
7. **Frontend: login/register pages**, wired to the new endpoints.
8. **Frontend: `api/client.ts` changes** (§5) — remove dev headers, add
   bearer token + credentials + 401-retry-once logic.
9. **Frontend: protected dashboard layout** + redirect-to-login.
10. **Frontend: logout affordance.**
11. **Tests** (§8) added alongside each backend/frontend step above, not
    batched at the end.
12. **Docs** updated (§9).
13. **CORS cleanup**: remove `x-user-email`/`x-user-name` from
    `allowedHeaders` in `main.ts` once nothing sends them.
14. **Dev-auth fallback decision**: either keep `DevAuthGuard` permanently
    behind the `NODE_ENV !== 'production'` check for fast local iteration,
    or remove it once the team is comfortable logging in locally too. Given
    this project's small size, keeping it as a documented, guarded local
    convenience is reasonable — the risk it guards against (accidental prod
    use) is fully mitigated by the constructor check in §4.6.

---

## 8. Testing plan

- **Register**: success creates user with hashed password (never plaintext
  in DB) and default `plan`/`credits`; duplicate email → 409; weak password
  → 400 for each violated rule (length, uppercase, number).
- **Login**: success issues both tokens and sets cookie; wrong password →
  401 generic message; unknown email → same 401 generic message (verify the
  messages are *identical*, guarding against enumeration regressions);
  OAuth-only account (`passwordHash: null`) → distinct 401 message.
- **Logout**: revokes the specific `RefreshToken` row (`revokedAt` set);
  subsequent refresh with that token → 401.
- **Refresh rotation**: valid refresh → new pair, old token marked revoked;
  reusing the now-revoked token → 401 **and** every other token in that
  `family` is also revoked (reuse-detection test, directly exercises the
  scenario `BACKEND_DESIGN.md` §6.4 exists to prevent).
- **Protected route access**: `JwtAuthGuard` rejects missing/malformed/
  expired/wrong-signature tokens with 401; accepts a valid token and
  populates `request.user`.
- **User isolation for books**: user A cannot `GET/PATCH/DELETE` user B's
  book (this already has coverage via `findOneForUser`-style scoping per
  §1.7 — add a test using two real JWT-authenticated users instead of two
  dev-header identities, since that's a meaningfully different code path
  now).
- **Frontend auth redirects**: unauthenticated visit to `/dashboard` →
  redirect to `/login?next=/dashboard`; post-login redirect honors `next`.
- **Frontend API client**: attaches bearer token; on 401 attempts exactly
  one refresh-and-retry; on repeated 401 clears auth state instead of
  looping.
- All new backend tests run under the existing quality gate:
  `pnpm --filter @book/api test` / `pnpm --filter @book/api typecheck`.
  Frontend: `pnpm --filter @book/web test` / `typecheck` / `build`. (Not run
  in this phase — see §11.)

---

## 9. Documentation plan

Docs to update when Phase 6B (implementation) lands:
- `README.md` — replace any dev-auth mention with the real login flow.
- `docs/local-demo.md` — remove the `x-user-email` explanation; document
  local register/login instead.
- `docs/deployment-readiness.md` — update the "Auth limitation" section
  (currently lines ~341-363) to reflect real auth is live; move it from
  "Known blockers" to "resolved," and update the "Recommended deployment
  architecture" section's cookie/CORS notes (`SameSite=None` cross-origin
  refresh cookie needs `ALLOWED_ORIGINS` to be exact-origin, already true
  today).
- `docs/private-demo-deploy.md` — same DevAuthGuard warning removal/update.
- `.env.example` — `JWT_SECRET`/`JWT_REFRESH_SECRET` already documented;
  add a comment that they're now live (currently unused).
- `apps/web/.env.example` — no new vars anticipated (no BFF, no OAuth
  client IDs in this phase).
- This document (`docs/auth-architecture.md`) — mark implemented sections
  as done as Phase 6B progresses, or supersede with a "Phase 6B: Auth
  Implementation" write-up once built, linking back here for rationale.

---

## 10. Rollout / deployment notes

- Cross-origin refresh cookie requires `SameSite=None; Secure` — `Secure`
  means it will not work over plain HTTP, so local dev either needs HTTPS
  or a `SameSite=Lax`/no-`Secure` dev-only cookie config (mirroring the
  existing pattern of `DevAuthGuard`-only-in-non-prod). Flag this as a
  concrete decision needed in Phase 6B, not resolved here.
- `ALLOWED_ORIGINS` (already env-driven, §1.9) must list the exact web
  origin(s) for the refresh cookie's `SameSite=None` to be meaningful —
  wildcard origins are incompatible with `credentials: true` per the Fetch
  spec, and the current config doesn't use a wildcard, so no change needed
  there.
- No infrastructure changes needed beyond what Phase 5E already
  provisioned — no new external service, no new managed dependency, no
  schema migration.
- Rollout can be incremental: ship backend endpoints + guard first (behind
  the fact that nothing calls them yet), then cut over the frontend in a
  follow-up commit/PR, keeping `DevAuthGuard` as a rollback path until the
  frontend cutover is verified working end-to-end.

---

## 11. Quality gates

This phase changed only documentation (`docs/auth-architecture.md`, this
file). No source, config, or schema files were modified, and no auth
libraries were installed. Per `CLAUDE.md`, docs-only phases require no test
run; none were run.
