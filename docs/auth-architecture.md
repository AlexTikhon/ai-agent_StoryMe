# StoryMe Auth Architecture — Phase 6A Plan

Status: **Phase 6B (backend), Phase 6C (frontend), Phase 6D (JWT-mode
end-to-end verification), Phase 6E (auth rate limiting), and Phase 6F
(email verification) are all done.**
See [§12 Phase 6D — JWT mode verification](#12-phase-6d--jwt-mode-verification),
[§13 Phase 6E — auth rate limiting](#13-phase-6e--auth-rate-limiting), and
[§14 Phase 6F — email verification](#14-phase-6f--email-verification) at
the bottom of this document for what changed in each pass.
Everything under §4–§8 below describing the backend (`AuthService`,
`TokenService`, `JwtAuthGuard`, `AuthModeGuard`, the five `/api/auth/*`
endpoints, cookie handling) exists in code exactly as planned, with one
addition not foreseen here: `AuthModeGuard`, a small composite guard that
picks `DevAuthGuard` vs. `JwtAuthGuard` per request based on the new
`AUTH_MODE` env var, so controllers need no code change to switch modes.
See `apps/api/src/auth/` for the implementation and its `*.spec.ts` files
for test coverage.

Phase 6C implemented §5 as planned: `apps/web/src/lib/auth/auth-context.tsx`
(`AuthProvider`/`useAuth`), `apps/web/src/lib/auth/token-store.ts`
(in-memory access token), `apps/web/src/lib/api/auth.ts` (`authApi`, raw
`fetch` against `/api/auth/*` with `credentials: 'include'`),
`apps/web/src/app/login/page.tsx` and `.../register/page.tsx`, and
`apps/web/src/app/dashboard/layout.tsx` (route protection + logout). One
deviation from §5's original sketch: instead of an explicit upfront
`POST /api/auth/refresh` call on mount, `AuthProvider` calls
`GET /api/auth/me` directly and lets `apiFetch`'s built-in
refresh-once-on-401 logic (`apps/web/src/lib/api/client.ts`) restore the
session from the cookie — same effect, one fewer code path. `apps/web`'s
dev-header behavior (`x-user-email`/`x-user-name`) is now gated behind
`NEXT_PUBLIC_AUTH_MODE=dev` (default `jwt`) rather than being unconditional.
OAuth (§3 option C) remains out of scope.

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

---

## 12. Phase 6D — JWT mode verification

Goal: verify the Phase 6B/6C implementation actually works end-to-end in real
`AUTH_MODE=jwt` (not just unit-tested in isolation), fix anything broken, and
make `jwt` unambiguously the recommended local/private-demo mode. No new
product features, no OAuth, no payments, no queue infra, no email
verification/password reset — those remain listed as open blockers below.

### 12.1 Bugs found and fixed

1. **`.env.example` (repo root) set `AUTH_MODE="dev"` while
   `apps/web/.env.example` already defaulted to `NEXT_PUBLIC_AUTH_MODE="jwt"`.**
   Anyone who copied both example files verbatim — the exact instruction in
   `docs/local-demo.md` step 3 — landed in a **mismatched** state: API
   expects `x-user-email`, web sends a bearer token, every request 401s. Both
   files' own comments already warned "a mismatch means every request 401s,"
   but the shipped default value violated that. Fixed by changing the root
   `.env.example` default to `AUTH_MODE="jwt"`, matching the web default and
   the schema default (`env.schema.ts`'s `.default('jwt')`).
2. **A silent-refresh failure mid-session never signaled the rest of the
   app.** `apiFetch`/`apiFetchBlob` (`apps/web/src/lib/api/client.ts`) already
   attempted exactly one refresh-and-retry on a `401`, and cleared the
   in-memory access token if that refresh failed — but nothing told
   `AuthProvider` the session had ended. In practice: a user active past
   their 7-day refresh-cookie expiry (or one whose refresh token was revoked,
   e.g. reuse-detection kicking in) kept seeing generic "Failed to load
   books" / "Failed to update book" error banners indefinitely instead of
   being bounced to `/login`. Fixed by adding a `storyme:auth-expired` window
   event, dispatched exactly where the refresh attempt's `.catch` already
   ran, and a listener in `AuthProvider` that flips `status` to `'anon'` —
   which `DashboardLayout`'s existing redirect effect turns into a
   `/login?next=...` bounce with no new redirect logic needed. Covered by
   new tests in `client.test.ts` and `auth-context.test.tsx`.

### 12.2 What was already correct (verified, not changed)

Phase 6C's implementation and test coverage were more complete than a fresh
audit expected — most of the risk areas this phase set out to check already
had passing tests:

- **`x-user-email` is ignored in `jwt` mode.** `JwtAuthGuard` only ever reads
  the `Authorization` header; `AuthModeGuard` never invokes `DevAuthGuard`
  when `AUTH_MODE=jwt`, so a spoofed `x-user-email` header has zero effect —
  verified by an existing `jwt-auth.guard.spec.ts` test and unchanged.
- **Cross-user book isolation.** Every `BooksService` method that takes a
  book id also takes the caller's `userId` and routes through
  `findOwnedOrThrow`, which scopes the Prisma lookup to `{ id, userId,
  deletedAt: null }` — a book that exists but belongs to someone else 404s
  exactly like a book that doesn't exist (no existence leak). This was
  already tested for `findOneForUser`, `startGeneration`, `retryGeneration`,
  and `getGenerationDiagnostics`; this phase added the missing equivalent
  test for `getPreviewPdfBuffer` (the PDF download path) in
  `books.service.spec.ts`.
- **401-retry-once semantics.** `apiFetch`/`apiFetchBlob` retry exactly once
  after a successful silent refresh, and do not loop or retry again on a
  second `401` — already tested in `client.test.ts`.
- **Session restore.** `AuthProvider` calls `GET /api/auth/me` on mount; a
  `401` triggers the same refresh-once flow via the refresh cookie, landing
  on `authed` (cookie valid) or `anon` (no valid cookie) — already tested.
- **Dashboard route protection.** `/dashboard/*` redirects an anonymous
  visitor to `/login?next=<path>` only in `jwt` mode; `dev` mode never gates
  — already tested in `dashboard/layout.test.tsx`.
- **Open-redirect guard on `?next=`.** `apps/web/src/app/login/page.tsx`'s
  `safeNextPath` only honors a same-origin path (`startsWith('/')`, rejects
  `//`), falling back to `/dashboard` otherwise.

### 12.3 Cookie / CORS verification (local dev, cross-origin http)

`apps/web` (`localhost:3000`) and `apps/api` (`localhost:4000`) are different
origins (different ports) but the **same site** — `localhost` has no public
suffix, so browsers treat it as one registrable domain regardless of port.
This matters because `buildRefreshCookieOptions` (`refresh-cookie.ts`) sets
`SameSite=Lax` (not `None`) outside production, and `SameSite=Lax` cookies
are normally withheld from cross-site `fetch`/XHR — but same-site
cross-origin requests are unaffected by that restriction, so the
`storyme_refresh` cookie round-trips correctly on `POST /api/auth/refresh`
called via `fetch(..., { credentials: 'include' })` from `localhost:3000` to
`localhost:4000` with no HTTPS needed locally. This was confirmed by reading
the cookie/CORS code paths together (`refresh-cookie.ts`, `main.ts`'s
`app.enableCors({ credentials: true, origin: allowedOrigins })`) rather than
by a live capture; if a future environment renames the local hostname away
from `localhost` (e.g. a custom `*.test` domain), re-verify this assumption.
In production (`NODE_ENV=production`), the cookie switches to
`Secure; SameSite=None`, which requires HTTPS on both origins and an exact
(non-wildcard) `ALLOWED_ORIGINS` entry for the deployed web origin — already
documented in `docs/private-demo-deploy.md`.

### 12.4 Manual verification checklist

No browser-based E2E framework (Playwright or otherwise) exists in this repo
yet, and adding one was explicitly out of scope for this phase. Ownership
isolation, the 401-refresh-retry contract, session restore, and route
protection are covered by the automated tests referenced in §12.2 instead.
The remaining steps below only exercise real browser/cookie behavior and
should be run manually against a local `AUTH_MODE=jwt` /
`NEXT_PUBLIC_AUTH_MODE=jwt` stack (`docs/local-demo.md`) before a private
demo deploy:

- [ ] Register a new user at `/register`; confirm immediate redirect into
      `/dashboard` already signed in (no separate login step required).
- [ ] Create a book, generate it (mock provider), confirm the preview
      renders and **Open PDF**/**Download PDF** both work.
- [ ] Log out; confirm `/dashboard` immediately redirects to `/login`.
- [ ] Log back in; confirm the same book is visible.
- [ ] Reload the page (full browser refresh) while signed in; confirm the
      session restores silently with no visible login flash beyond the
      brief `status: 'loading'` state.
- [ ] Register a **second** user in a different browser profile/incognito
      window; confirm their dashboard is empty and navigating directly to
      the first user's book detail URL renders "Book not found" (404), not
      the first user's data.
- [ ] In devtools, delete the `storyme_refresh` cookie while signed in, then
      trigger any API call (e.g. click "Refresh status"); confirm the app
      lands back on `/login` instead of showing a stuck error banner (this
      exercises the `storyme:auth-expired` fix in §12.1).

### 12.5 Remaining blockers before public (non-private-demo) production

Unchanged from `docs/deployment-readiness.md`'s existing "What's left" list
— this phase did not attempt any of these, per its explicit scope:

- ~~No rate limiting on `/api/auth/*`.~~ **Resolved in Phase 6E** — see
  [§13](#13-phase-6e--auth-rate-limiting) below.
- No email verification.
- No password-reset flow.
- No OAuth (still a documented future follow-up, not required for `jwt`
  mode to be the recommended private-demo default).

### 12.6 Quality gates

`pnpm --filter @book/api test`, `pnpm --filter @book/api typecheck`,
`pnpm --filter @book/web test`, `pnpm --filter @book/web typecheck`,
`pnpm --filter @book/web build` — all run for this phase; see the commit/PR
description for exact pass counts.

## 13. Phase 6E — auth rate limiting

Goal: cap brute-force/credential-stuffing/registration-abuse volume against
`/api/auth/*` without adding external infrastructure or touching the JWT/
refresh-cookie logic itself. No email verification, no password reset — those
remain open (see §12.5).

> **Note:** §13.1 describes this phase's original in-memory design, later
> replaced by a Redis-backed limiter without changing the guard's public
> behavior — see the superseded note in [§13.2](#132-why-in-memory-not-redis)
> before relying on "in-memory" as the current state.

### 13.1 Design

- **`RateLimiterService`** (`apps/api/src/rate-limit/rate-limiter.service.ts`)
  — a small, dependency-free, in-memory fixed-window counter:
  `consume(key, windowMs, maxAttempts)` returns `{ allowed, remaining,
  retryAfterMs }`, plus a `reset()` for test isolation. It knows nothing
  about HTTP or auth — any future endpoint can reuse it directly. Registered
  as a `@Global()` provider (`rate-limit.module.ts`, imported once in
  `AppModule`, mirroring `CacheModule`'s pattern) so it doesn't need
  re-importing per consumer.
- **`AuthRateLimitGuard`** (`apps/api/src/auth/auth-rate-limit.guard.ts`) —
  the auth-specific wiring: reads `AUTH_RATE_LIMIT_WINDOW_MS` /
  `AUTH_RATE_LIMIT_MAX_ATTEMPTS` from `ConfigService`, builds a key from the
  decorated handler's class+method name (so register/login/refresh/logout
  each get an independent budget), the caller's IP, and — when the request
  body has an `email` field — that email too. Keying on email when present
  means a credential-stuffing run targeted at one victim email can't burn
  through the shared-IP budget for every other legitimate user behind the
  same NAT/proxy; keying on IP alone (no email, e.g. `refresh`/`logout`)
  still caps a single attacker rotating identities from one address.
  On exceeding the limit it sets a `Retry-After` header and throws
  `HttpException({ error: 'Too many requests', code: 'RATE_LIMITED' }, 429)`.
- **`HttpExceptionFilter`** (`apps/api/src/common/filters/http-exception.filter.ts`)
  gained an optional `code` pass-through field on its JSON error shape (only
  present when the thrown `HttpException`'s response object has one) so
  `RATE_LIMITED` survives the global filter unchanged. Every other exception
  path is unaffected since `code` is omitted entirely when absent.
- **Applied via `@UseGuards(AuthRateLimitGuard)`** on `AuthController`'s
  `register`, `login`, `refresh`, and `logout` — **not** `getMe`, which
  already requires a valid bearer token and isn't a credential-guessing
  target.

### 13.2 Why in-memory, not Redis

> **Superseded (Phase F1 audit).** A later hardening pass
> (`apps/api/src/rate-limit/redis-rate-limiter.service.ts`) replaced the
> in-memory limiter on the auth path with a Redis-backed one:
> `RATE_LIMITER_TOKEN` now resolves to `RedisRateLimiter` unconditionally
> (`apps/api/src/rate-limit/rate-limit.module.ts`), and `AuthRateLimitGuard`
> injects that token, not `RateLimiterService` directly. The commit that made
> this change explicitly deferred updating this doc section ("deployment/doc
> reconciliation" left as follow-up), so the reasoning below is historical —
> it explains why in-memory was the *original* choice, not the current
> behavior. `RateLimiterService` (in-memory) still exists and is exported for
> direct injection in unit tests that construct a guard without a Redis
> connection, but no production request path uses it anymore. The auth path
> is correct across multiple API instances today without further work — see
> [deployment-readiness.md Production readiness summary](deployment-readiness.md#production-readiness-summary).

The app already provisions Redis (`REDIS_URL`, `CacheModule`) and, since
Phase 3K, depends on it for the generation pipeline (BullMQ — see
`apps/api/docs/local-generation-pipeline.md`'s "Durable generation queue
(Phase 3K)" section) — but the *auth/rate-limiting* path is a separate
concern and still doesn't need Redis for correctness. Adding a Redis-backed
limiter now would mean the auth path's availability starts depending on
Redis too, for a feature whose current single-instance deploy target doesn't
need it — a different tradeoff than generation's, which already justifies
the Redis dependency. `RateLimiterService`'s
`consume()`/`reset()` shape is intentionally the entire surface a caller
depends on, so a future `RedisRateLimiterService` implementing the same
two methods is a drop-in swap when multi-instance deployment actually
happens — no call-site changes needed, matching how `PdfStorage`/
`ImageAssetStorage` already abstract local-vs-cloud storage in this codebase.

**Known limitation**: state is per-process and unbounded-but-self-pruning —
each key's entry is only overwritten (not proactively evicted) once its
window elapses on the next `consume()` call for that same key, so a flood of
distinct one-off keys (e.g. many distinct emails from many distinct IPs)
grows the map until those keys are hit again or the process restarts. Not a
concern at current traffic levels; would need an eviction sweep or a
size-bounded store (e.g. LRU) before this became a real memory-growth risk.

### 13.3 Configuration

`AUTH_RATE_LIMIT_WINDOW_MS` (default `900000`, 15 minutes) and
`AUTH_RATE_LIMIT_MAX_ATTEMPTS` (default `10`) — both optional with sane
defaults in `env.schema.ts`, documented in `.env.example`. Defaults are
deliberately generous enough not to interfere with normal local dev/demo
usage (registering/logging in repeatedly while testing) while still bounding
brute-force volume.

### 13.4 Tests

- `apps/api/src/rate-limit/rate-limiter.service.spec.ts` — window
  allow/block behavior, window expiry reset, independent keys, `reset()`.
- `apps/api/src/auth/auth-rate-limit.guard.spec.ts` — allows under the
  threshold, throws 429 with the `RATE_LIMITED` code + `Retry-After` header
  once exceeded, scopes independently per handler/email/IP.
- `apps/api/src/auth/auth.controller.spec.ts` — asserts (via Nest's
  `GUARDS_METADATA` reflection) that `AuthRateLimitGuard` is wired to
  register/login/refresh/logout and deliberately not to `getMe`.

No existing test changed behavior; the guard only takes effect through
Nest's real request pipeline (no e2e/supertest harness exists in this repo —
see §12.4), so the existing controller-level unit tests, which instantiate
`AuthController` directly and call its methods, don't exercise guards at all
and remain unaffected.

### 13.5 Quality gates

`pnpm --filter @book/api test`, `pnpm --filter @book/api typecheck`,
`pnpm --filter @book/api lint` — all run for this phase. No web changes were
needed (rate limiting is backend-only and the frontend doesn't special-case
error codes today), so web gates were not re-run.

## 14. Phase 6F — email verification

Goal: require new users to prove ownership of their registered email address
before they can log back in, without adding a real third-party email
provider or implementing password reset (both explicitly out of scope for
this pass — password reset remains the one open account-recovery gap, see
§12.5/§13 and `docs/deployment-readiness.md`).

### 14.1 Schema

Three new nullable columns on `User` (migration
`20260703000000_phase6f_email_verification`), alongside the existing
`emailVerified Boolean @default(false)`:

- `emailVerifiedAt DateTime?` — set once, on successful verification.
- `emailVerificationTokenHash String? @unique` — SHA-256 hash of the current
  pending verification token; `null` when there is no pending token (never
  issued, or already consumed). **Only the hash is ever persisted** — the
  raw token exists only in memory for the duration of the request that
  generates it, and in the outbound email/log line.
- `emailVerificationExpiresAt DateTime?` — 24 hours from issuance
  (`EMAIL_VERIFICATION_TOKEN_TTL_MS` in `token.service.ts`, not
  env-configurable — same pattern as the existing 15-minute access-token and
  7-day refresh-token TTL constants).

### 14.2 Token generation and hashing (`TokenService`)

`generateEmailVerificationToken()` returns `{ raw, hash, expiresAt }`: `raw`
is 32 random bytes (hex), `hash` is **plain SHA-256** of `raw` — no HMAC
secret, unlike `hashRefreshToken`. This is deliberate and matches the
existing reasoning for refresh-token hashing (`token.service.ts`'s own
comment): the input being hashed is already a high-entropy random value, not
a human password or anything guessable, so a secret-keyed HMAC adds no
resistance to reversal that the token's own entropy doesn't already provide.
Using a distinct hash function (SHA-256 vs. HMAC-SHA256) rather than reusing
`hashRefreshToken` also means an email-verification token hash and a
refresh-token hash are never comparable to each other, keeping the two
token spaces cryptographically separate even though both currently happen to
use SHA-256 as the underlying primitive.

### 14.3 `EmailService` abstraction (`apps/api/src/email/`)

A storage-boundary-style interface, deliberately mirroring `PdfStorage`/
`ImageAssetStorage`: `AuthService` depends only on `EmailService`
(`sendVerificationEmail(payload)`), injected via `EMAIL_SERVICE_TOKEN`, so a
real provider (Resend, SES, Postmark, etc.) is a drop-in swap later with no
`AuthService` changes. The only implementation today, `ConsoleEmailService`
(`console-email.service.ts`), logs the verification link via `Logger`
instead of calling any real transport, and keeps the most recently "sent"
payload per recipient in an in-memory `Map` — a `getLastVerificationEmail(to)`
inspection hook that exists purely for tests/local dev, not part of the
`EmailService` contract itself. **No real email is sent anywhere in this
codebase yet** — this is the explicit scope boundary called out in the
phase's own requirements (no third-party provider unless one already
existed; none did).

### 14.4 Registration (`AuthService.register`)

Unchanged in shape, extended in content: still creates the `User` row and
still auto-signs the caller in immediately (issues the same access
token + refresh cookie as before) — this preserves the existing "register →
land straight in `/dashboard`, no separate login step" UX
(`docs/auth-architecture.md` §12.4's manual checklist, and the existing
`register.test.tsx`/`RegisterPage` behavior) rather than introducing a new
blocking step at signup. What's new: the created user starts
`emailVerified: false`, `UsersService.create` is called with a freshly
generated token hash + expiry, and `EmailService.sendVerificationEmail` is
called with the raw token and a `${WEB_APP_URL}/verify-email?token=...`
link before the token pair is issued.

### 14.5 Login policy (`AuthService.login`)

**Blocks login until verified** — the option this phase's own requirements
called out as preferred, and the one that doesn't conflict with the existing
auto-login-on-register UX (registration bypasses `login()` entirely, so it's
unaffected by this gate). The check runs *after* the existing
credential/deactivation check, in the same generic-message style: wrong
password and unknown email both still throw the identical "Invalid email or
password" message (no enumeration signal), and only once credentials are
confirmed valid does an unverified account get a *distinct* rejection:

```json
{ "error": "Email is not verified", "code": "EMAIL_NOT_VERIFIED" }
```

`refresh()`/`logout()`/`JwtAuthGuard` are untouched — a session already
established via register (or a prior verified login) keeps working normally
even if the account is later found unverified again (which can't currently
happen — there's no code path that un-verifies an account). The gate only
ever fires on a fresh `POST /api/auth/login` call.

### 14.6 Verification endpoint — `POST /api/auth/verify-email`

Body `{ token: string }`. Hashes the submitted raw token and looks it up by
`emailVerificationTokenHash` (the column is `@unique`, so at most one user
can ever match a given hash). On a match with a non-expired
`emailVerificationExpiresAt`: sets `emailVerified: true`,
`emailVerifiedAt: now()`, and **clears both `emailVerificationTokenHash` and
`emailVerificationExpiresAt`** in the same update — this is what makes the
token single-use: a replay of the same raw token afterward hashes to a value
no row matches anymore, so it 400s exactly like a token that was never
valid. Unknown/expired tokens get the same generic `400 Bad Request`
("Invalid or expired verification token") — no signal distinguishing
"doesn't exist" from "expired" from "already used." Guarded by the existing
`AuthRateLimitGuard`.

### 14.7 Resend endpoint — `POST /api/auth/resend-verification`

Body `{ email: string }`. Always resolves the same way (`204`, no body)
regardless of whether the email exists, belongs to an already-verified
account, or belongs to a deactivated account — `AuthService.resendVerificationEmail`
returns early (no-op) in all three of those cases, with **no way for a
caller to distinguish them from the success path**, matching this codebase's
existing no-enumeration policy for `login`/register-duplicate-email
handling. For a genuine unverified account, it generates a *new* token via
`TokenService.generateEmailVerificationToken()` and overwrites the stored
hash/expiry — the old raw token (if the user still has the original email)
stops working immediately, since its hash no longer matches any stored row.
Also guarded by `AuthRateLimitGuard`.

### 14.8 Frontend changes (minimal, per phase scope)

- `apps/web/src/lib/api/api-error.ts`: `ApiError` gained an optional `code`
  field, and a new `parseApiError()` (returning `{ message, code? }`)
  sits behind the existing `parseErrorMessage()` so every existing call site
  keeps working unchanged while `client.ts`/`auth.ts` now thread `code`
  through to the thrown `ApiError`.
- `apps/web/src/lib/api/auth.ts`: two new methods, `verifyEmail(token)` and
  `resendVerification(email)`, calling the two new endpoints.
- `apps/web/src/app/verify-email/page.tsx` (new): reads `?token=` from the
  URL, calls `verifyEmail`, and renders one of three states — verifying /
  verified (link to `/login`) / failed (generic error + link back to
  `/login`). No new routing logic beyond this single page.
- `apps/web/src/app/login/page.tsx`: catches `ApiError` with
  `code === 'EMAIL_NOT_VERIFIED'` specifically, shows "Please verify your
  email before signing in," and offers a **Resend verification email**
  button wired to `resendVerification`. Any other error keeps the previous
  generic-message behavior unchanged.
- `apps/web/src/app/dashboard/layout.tsx`: a small dismissless banner
  (`role="status"`), shown only when `authMode === 'jwt'` and the signed-in
  user's `emailVerified` is `false`, with the same resend action. This is
  the "check your email" state for users who are already past registration
  (register itself still lands them in the dashboard immediately, verified
  or not) — deliberately not a full email-management UI.
- `packages/types/src/user.types.ts` / `apps/api/src/users/users.mapper.ts`:
  `UserDto` gained `emailVerified: boolean` so the frontend can read it —
  the only reason the login/register pages and dashboard banner can react to
  verification state at all.

### 14.9 Configuration

`WEB_APP_URL` (new, optional, defaults to `http://localhost:3000`) —
the only new env var this phase adds. Used solely to build the
`${WEB_APP_URL}/verify-email?token=...` link sent to `EmailService`; nothing
else reads it. No new secret is needed (the token is hashed with plain
SHA-256, not an HMAC secret — see §14.2), so `JWT_REFRESH_SECRET` gains no
new responsibility from this phase.

### 14.10 Tests

- `apps/api/src/auth/token.service.spec.ts` — new token/hash determinism,
  24-hour expiry, and confirms the hash does **not** depend on
  `JWT_REFRESH_SECRET` (plain SHA-256, not HMAC — distinguishing it from
  `hashRefreshToken`'s tests in the same file).
- `apps/api/src/email/console-email.service.spec.ts` — records instead of
  sending, per-recipient inspection hook, keeps only the most recent send.
- `apps/api/src/auth/auth.service.spec.ts` — registered users start
  unverified with only the hash persisted (asserts the raw token string
  never appears anywhere in the `usersService.create` call argument);
  verification email sent with the raw token; registration still auto-signs
  in even though unverified; login rejects an unverified account with the
  `EMAIL_NOT_VERIFIED` code (and confirms no refresh token row is created);
  `verifyEmail` accepts a valid token, rejects unknown/expired tokens, and
  rejects replay of an already-consumed token; `resendVerificationEmail`
  issues a fresh token for a genuine unverified account and is a silent
  no-op for an unknown/verified/deactivated email (three separate tests, one
  per leak vector).
- `apps/api/src/auth/auth.controller.spec.ts` — `verifyEmail`/
  `resendVerification` delegate to `AuthService` with the right arguments,
  and `AuthRateLimitGuard` wiring now covers both new routes (the existing
  `it.each` guard-wiring test was extended, not duplicated).
- `apps/api/src/users/users.service.spec.ts` — `create()` passes the
  optional verification hash/expiry straight through when present.
- Web: `apps/web/src/lib/api/auth.test.ts` (`verifyEmail`/
  `resendVerification` request shape, `EMAIL_NOT_VERIFIED` code surfaced as
  `ApiError.code`), `apps/web/src/app/verify-email/page.test.tsx` (all three
  render states), `apps/web/src/app/login/page.test.tsx` (unverified-login
  message + resend flow), `apps/web/src/app/dashboard/layout.test.tsx`
  (banner shown for an unverified user, absent for a verified one).
- All pre-existing auth tests remain green; the only fixture change needed
  was bumping the shared `makeUser()`/`MOCK_USER` test helpers' default
  `emailVerified` to `true` (so tests asserting "valid credentials succeed"
  keep testing that, rather than incidentally tripping the new gate) and
  adding the three new nullable Prisma-generated fields to those same
  object literals so `tsc` still accepts them as a full `User` shape.

### 14.11 Quality gates

`pnpm --filter @book/types build` (regenerates the compiled `UserDto` type
new the `emailVerified` field depends on), `pnpm --filter @book/api
prisma:generate`, `pnpm --filter @book/api test`, `pnpm --filter @book/api
typecheck`, `pnpm --filter @book/api lint`, `pnpm --filter @book/web test`,
`pnpm --filter @book/web typecheck`, `pnpm --filter @book/web build`,
`pnpm --filter @book/web lint` — all run and green for this phase (524 API
tests, 197 web tests).

### 14.12 Remaining blockers before public production

- ~~Password-reset flow~~ **Resolved in Phase 6G** — see
  [§15](#15-phase-6g--password-reset) below.
- ~~No real transactional email provider~~ **Resolved in Phase 6H** — see
  [§16](#16-phase-6h--real-transactional-email-provider) below.
- **No OAuth** — unchanged from earlier phases, still a documented future
  follow-up.

## 15. Phase 6G — password reset

Goal: let a user with a forgotten password regain access without a real
transactional email provider, mirroring Phase 6F's email-verification design
(same token-hashing strategy, same `EmailService` boundary, same
no-account-enumeration policy) rather than inventing a second pattern.

### 15.1 Schema

Three new nullable columns on `User` (migration
`20260703010000_phase6g_password_reset`):

- `passwordResetTokenHash String? @unique` — SHA-256 hash of the current
  pending reset token; `null` when there is no pending token. **Only the
  hash is ever persisted**, same as `emailVerificationTokenHash`.
- `passwordResetExpiresAt DateTime?` — 30 minutes from issuance
  (`PASSWORD_RESET_TOKEN_TTL_MS` in `token.service.ts`), deliberately shorter
  than the 24-hour email verification window since a reset link grants
  immediate account takeover if intercepted.
- `passwordResetRequestedAt DateTime?` — timestamp of the most recent reset
  request, kept for support/audit visibility; not read by any code path
  today (rate limiting is handled entirely by `AuthRateLimitGuard`, not by
  this column).

### 15.2 Token generation and hashing (`TokenService`)

`generatePasswordResetToken()` returns `{ raw, hash, expiresAt }` using the
exact same primitive as `generateEmailVerificationToken()` — 32 random bytes
(hex) hashed with plain SHA-256, no HMAC secret — for the same reason: the
input is already high-entropy and random, not a guessable human password, so
a secret-keyed hash adds no resistance to reversal. `hashPasswordResetToken`
is a separate named method (not a reuse of `hashEmailVerificationToken`)
purely for call-site clarity; the underlying hash function is identical.

### 15.3 `EmailService` extension

`sendPasswordResetEmail(payload)` added to the `EmailService` interface
alongside the existing `sendVerificationEmail`. `ConsoleEmailService` logs
the reset link instead of sending it and keeps the most recently "sent"
password-reset payload per recipient in a separate in-memory map
(`getLastPasswordResetEmail(to)`), independent of the verification-email map
so the two inspection hooks never collide for a recipient who triggers both
flows. **No real email is sent anywhere in this codebase** — same explicit
scope boundary as Phase 6F.

### 15.4 Request endpoint — `POST /api/auth/request-password-reset`

Body `{ email: string }`. `AuthService.requestPasswordReset` always resolves
the same way — the controller always returns `200 { ok: true }` — regardless
of whether the email exists or belongs to a deactivated account, matching
this codebase's existing no-enumeration policy (`resendVerificationEmail`,
`login`). For a genuine account: generates a fresh token via
`TokenService.generatePasswordResetToken()`, overwrites
`passwordResetTokenHash`/`passwordResetExpiresAt` (which is what
invalidates any previously issued, still-unused reset token — its hash no
longer matches any stored row), stamps `passwordResetRequestedAt`, and calls
`EmailService.sendPasswordResetEmail` with the raw token and a
`${WEB_APP_URL}/reset-password?token=...` link. Guarded by the existing
`AuthRateLimitGuard`.

### 15.5 Reset endpoint — `POST /api/auth/reset-password`

Body `{ token: string, password: string }`, `password` validated against the
identical policy as registration (`class-validator`: 8–72 chars, 1
uppercase, 1 number — `ResetPasswordDto` mirrors `RegisterDto`). Hashes the
submitted raw token and looks it up by `passwordResetTokenHash` (`@unique`,
so at most one user can match). Unknown or expired tokens both reject with
the identical body:

```json
{ "error": "Invalid or expired reset token", "code": "INVALID_RESET_TOKEN" }
```

— no signal distinguishing "doesn't exist" from "expired" from "already
used," same reasoning as `verifyEmail`'s generic rejection. On success:
bcrypt-hashes the new password (same `BCRYPT_COST` as registration/login),
clears both `passwordResetTokenHash` and `passwordResetExpiresAt` in the same
update (making the token single-use — a replay hashes to a value no row
matches anymore), and **revokes every non-revoked `RefreshToken` row for that
user** so a session already established before the reset (e.g. by whoever
had originally compromised the account) doesn't outlive the password change.
`login`/`register`/`refresh`/`verify-email` are otherwise untouched. Guarded
by `AuthRateLimitGuard`.

### 15.6 Frontend changes

- `apps/web/src/lib/api/auth.ts`: `requestPasswordReset(email)` and
  `resetPassword(token, password)`, calling the two new endpoints.
- `apps/web/src/app/forgot-password/page.tsx` (new): email form; always
  renders the same generic success message
  ("If an account exists for this email, a reset link has been sent.")
  regardless of whether the request actually found an account — only a
  request-level failure (e.g. rate limited) surfaces a distinct error.
- `apps/web/src/app/reset-password/page.tsx` (new): reads `?token=` from the
  URL; new-password + confirm-password form with client-side
  mismatch checking; success state links to `/login`; a missing token in the
  URL renders a dedicated "reset link invalid" state with a link back to
  `/forgot-password`, while a token rejected by the API (invalid/expired)
  surfaces inline on the form, mirroring the login page's existing
  inline-error convention.
- `apps/web/src/app/login/page.tsx`: a **Forgot password?** link next to the
  password field, pointing at `/forgot-password`.

### 15.7 Configuration

No new env vars — reuses `WEB_APP_URL` (already added in Phase 6F) to build
the reset link, same as the verification link.

### 15.8 Tests

- `apps/api/src/auth/token.service.spec.ts` — password-reset token/hash
  determinism, 30-minute expiry, hash independence from
  `JWT_REFRESH_SECRET`.
- `apps/api/src/email/console-email.service.spec.ts` — records password
  reset payloads separately from verification payloads, per-recipient
  inspection hook, keeps only the most recent send.
- `apps/api/src/auth/dto/reset-password.dto.spec.ts` (new) — exercises the
  password policy directly via `class-validator`'s `validate()` (mirrors
  `create-book.dto.spec.ts`'s pattern), since the DTO's `ValidationPipe`
  enforcement isn't exercised by the controller-level unit tests here (no
  e2e/supertest harness exists in this repo — see §12.4).
- `apps/api/src/auth/auth.service.spec.ts` — reset request issues a token
  with only the hash persisted (raw token never appears in the
  `prisma.user.update` call argument) and emails the raw token; a second
  request overwrites (invalidates) the first token's hash; unknown-email and
  deactivated-account requests are silent no-ops; `resetPassword` accepts a
  valid token (hashes the new password, clears the token, revokes all
  refresh tokens for the user), rejects unknown/expired tokens with
  `INVALID_RESET_TOKEN`, and rejects replay of an already-consumed token.
- `apps/api/src/auth/auth.controller.spec.ts` — `requestPasswordReset`/
  `resetPassword` delegate to `AuthService` with the right arguments and
  always return `{ ok: true }`; `AuthRateLimitGuard` wiring extended to cover
  both new routes.
- Web: `apps/web/src/lib/api/auth.test.ts` (request/reset request shapes,
  `INVALID_RESET_TOKEN` code surfaced as `ApiError.code`),
  `apps/web/src/app/forgot-password/page.test.tsx` (identical generic
  success for known/unknown email, request-failure error state, login link),
  `apps/web/src/app/reset-password/page.test.tsx` (success state, mismatched
  confirmation caught client-side without calling the API, invalid/expired
  token error, missing-token state), `apps/web/src/app/login/page.test.tsx`
  (forgot-password link present).
- All pre-existing auth/email-verification tests remain green — no shared
  fixture changes were needed beyond `tsc` accepting the three new nullable
  `User` fields (spec files are excluded from `apps/api`'s typecheck
  `include`, so existing `makeUser()` helpers didn't need updating).

### 15.9 Quality gates

`pnpm --filter @book/types build`, `pnpm --filter @book/api prisma:generate`,
`pnpm --filter @book/api test`, `pnpm --filter @book/api typecheck`,
`pnpm --filter @book/api lint`, `pnpm --filter @book/web test`,
`pnpm --filter @book/web typecheck`, `pnpm --filter @book/web build`,
`pnpm --filter @book/web lint` — all run and green for this phase (550 API
tests, 210 web tests).

### 15.10 Remaining blockers before public production

- ~~No real transactional email provider~~ **Resolved in Phase 6H** — see
  [§16](#16-phase-6h--real-transactional-email-provider) below.
- **No OAuth** — unchanged from earlier phases, still a documented future
  follow-up.

## 16. Phase 6H — real transactional email provider

Goal: close the last auth production blocker from Phase 6F/6G — swap in a
real transport behind the existing `EmailService` boundary (§14.3) without
touching `AuthService`, token semantics, or any existing test.
`ConsoleEmailService` remains the default everywhere; nothing sends real
email unless `EMAIL_PROVIDER=resend` is explicitly set.

### 16.1 Provider selection (`apps/api/src/email/email-provider.factory.ts`)

`createEmailService(env)` mirrors `createStoryGenerationProvider`
(§3B/`story-generation-provider.factory.ts`) exactly: reads `EMAIL_PROVIDER`
case-insensitively, defaults to `console` on missing/empty, throws a clear
`Error` for anything other than `console`/`resend`, and — when `resend` is
selected — throws a clear `Error` naming every missing required var
(`RESEND_API_KEY`, `EMAIL_FROM`) rather than constructing a half-configured
client. Takes an explicit env map (default `process.env`) so selection is
unit-testable without mutating global state. `EmailModule` wires this as a
single `useFactory` provider for `EMAIL_SERVICE_TOKEN` — `AuthService` still
depends only on the `EmailService` interface and never learns which
implementation is active.

The same fail-fast check is duplicated one layer up in `env.schema.ts`'s
`superRefine` (same pattern as the existing `OPENAI_API_KEY` conditional
requirement): if `EMAIL_PROVIDER=resend` but `RESEND_API_KEY` or `EMAIL_FROM`
is missing, the app refuses to boot at `EnvModule` validation time with a
named-field error, before Nest even constructs `EmailModule`. The factory's
own check is what actually protects any call site that constructs
`createEmailService` outside of Nest's DI (e.g. a script), so both checks are
intentionally kept in sync rather than relying on just one.

### 16.2 `ResendEmailService` (`apps/api/src/email/resend-email.service.ts`)

Calls the Resend HTTP API (`POST https://api.resend.com/emails`) directly via
native `fetch` — no new dependency, mirroring
`OpenAIStoryGenerationProvider`'s existing fetch-based approach rather than
adding an SDK for two call sites. Per-request `AbortController` timeout
(`timeoutMs`, default 10s) guards against a hung request blocking
registration/reset indefinitely. Constructor validates `apiKey`/`from` are
non-empty and throws `EmailProviderError` immediately if not — the same
class also wraps every failure mode from `send()` (network error, timeout,
non-2xx response) so `AuthService`'s `await this.emailService.send...()`
calls see one consistent error type regardless of provider, without
`AuthService` importing anything provider-specific.

Both emails are sent with **HTML and plain-text bodies** built from the same
payload the existing `EmailService` interface already defines (`to`, `name`,
`token` — used only to build the URL upstream, never referenced directly
here — and `verificationUrl`/`resetUrl`). Content requirements from this
phase's own scope:

- Verification email: app name (`StoryMe`), the verification link, and "this
  link expires in 24 hours."
- Password reset email: app name, the reset link, "this link expires in 30
  minutes," and an explicit "if you didn't request this, you can safely
  ignore this email — your password will not be changed" warning.

User-supplied `name` is HTML-escaped before interpolation into the HTML body
(`escapeHtml`) — the only untrusted string embedded in markup; the
verification/reset URLs are server-constructed
(`${WEB_APP_URL}/verify-email?token=...`) and not user input.

**Never logs the verification/reset URL or token** — unlike
`ConsoleEmailService`, which intentionally logs the link for local/dev
inspection, `ResendEmailService.send()` only logs the recipient address and
email kind (`"Sent verification email to=..."`) on success, and status
code/reason (never the response body, which could echo request content back)
on failure. The Resend API key is never included in any log line or thrown
error message — errors surface the HTTP status and a truncated response body
only.

### 16.3 Configuration

New env vars, all optional (only `RESEND_API_KEY`/`EMAIL_FROM` become
required, enforced at boot, once `EMAIL_PROVIDER=resend` is set):

- `EMAIL_PROVIDER` — `console` (default) | `resend`.
- `RESEND_API_KEY` — Resend API key; required when `EMAIL_PROVIDER=resend`.
- `EMAIL_FROM` — `from` address, e.g. `"StoryMe <noreply@storyme.app>"`; must
  be a verified sender/domain in Resend; required when
  `EMAIL_PROVIDER=resend`.
- `EMAIL_REPLY_TO` — optional `reply-to` address, included in the Resend
  payload only when set.

`WEB_APP_URL` (added in Phase 6F) is unchanged and still the only source of
the verification/reset link host.

### 16.4 Tests

- `apps/api/src/email/email-provider.factory.spec.ts` (new) — defaults to
  `ConsoleEmailService` when unset/empty/`"console"` (case-insensitive);
  returns `ResendEmailService` when `resend` is selected with both required
  vars set; throws naming the missing var(s) when `resend` is selected
  without `RESEND_API_KEY` and/or `EMAIL_FROM`; throws for an unknown
  provider name.
- `apps/api/src/email/resend-email.service.spec.ts` (new) — constructor
  rejects an empty `apiKey`/`from`; verification and password-reset emails
  each assert on the exact request sent to the mocked `fetchImpl` (`from`,
  `to`, `subject`, `html`, `text` all contain the app name, link, and the
  right expiration/warning copy); `reply_to` included only when configured;
  a non-2xx response and a network/timeout error both reject with
  `EmailProviderError`, and the timeout/network-error case is asserted not
  to leak the configured API key into the thrown error's message. No test in
  this file makes a real network call — `fetchImpl` is always a `vi.fn()`
  mock.
- `apps/api/src/config/env.schema.spec.ts` — extended with the
  `EMAIL_PROVIDER=resend` conditional-requirement cases, mirroring the
  existing `OPENAI_API_KEY` conditional-requirement `describe` block.
- All pre-existing email/auth tests (`console-email.service.spec.ts`,
  `auth.service.spec.ts`, `auth.controller.spec.ts`, `token.service.spec.ts`)
  remain green unchanged — `AuthService` still only ever sees the
  `EmailService` interface via a mock in its own spec, so it has no idea
  `ResendEmailService` exists.

### 16.5 Quality gates

`pnpm --filter @book/types build`, `pnpm --filter @book/api test`,
`pnpm --filter @book/api typecheck`, `pnpm --filter @book/api lint`,
`pnpm --filter @book/web test`, `pnpm --filter @book/web typecheck`,
`pnpm --filter @book/web build`, `pnpm --filter @book/web lint`.

### 16.6 Remaining blockers before public production

- **No OAuth** — unchanged from earlier phases, still a documented future
  follow-up. This was the last auth-specific blocker called out in §14.12/
  §15.10 — real auth, rate limiting, email verification, password reset, and
  now real transactional email are all done end-to-end.
