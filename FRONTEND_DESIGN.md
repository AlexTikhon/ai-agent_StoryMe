# Frontend Technical Design

## StoryMe — Implementation Reference for Senior Frontend Engineers

**Version 1.0 | Frontend Architecture Document**
**Prepared by: Principal Frontend Architect | Date: June 2026**

> This document is the authoritative implementation guide for the StoryMe web frontend. It assumes familiarity with the companion documents: `PRD.md`, `UX_SPEC.md`, `DESIGN_SYSTEM.md`, and `ARCHITECTURE.md`. It does not repeat product or design decisions — it translates them into engineering decisions.
>
> **Audience:** Senior Frontend Engineers beginning implementation.
>
> **Goal:** Eliminate every significant architectural decision before the first line of feature code is written.

---

# Table of Contents

1. [Frontend Architecture](#1-frontend-architecture)
2. [Project Folder Structure](#2-project-folder-structure)
3. [App Router Structure](#3-app-router-structure)
4. [Layout Architecture](#4-layout-architecture)
5. [Component Architecture](#5-component-architecture)
6. [State Management](#6-state-management)
7. [Forms Architecture](#7-forms-architecture)
8. [API Layer](#8-api-layer)
9. [Authentication Flow](#9-authentication-flow)
10. [WebSocket & SSE Strategy](#10-websocket--sse-strategy)
11. [Performance Strategy](#11-performance-strategy)
12. [Accessibility](#12-accessibility)
13. [Error Boundaries](#13-error-boundaries)
14. [Testing Strategy](#14-testing-strategy)
15. [Internationalization](#15-internationalization)
16. [Environment Configuration](#16-environment-configuration)
17. [Frontend Security](#17-frontend-security)
18. [Analytics](#18-analytics)
19. [Coding Standards](#19-coding-standards)
20. [Future Scalability](#20-future-scalability)

---

# 1. Frontend Architecture

## 1.1 Architectural Principles

Five principles govern every frontend decision:

**1. Zone Isolation**
The application has four distinct navigation zones: Public (marketing), Auth (login/signup), Wizard (semi-public creation flow), and App (authenticated product). Each zone has its own layout shell, navigation component, data-fetching strategy, and auth requirements. No zone borrows infrastructure from another.

**2. Server-First, Hydrate Selectively**
Next.js 15 App Router is used throughout. Every route begins as a React Server Component (RSC). A component opts into client-side rendering only when it needs interactivity, browser APIs, or state. The decision is: _can this component be a Server Component?_ If yes, it must be.

**3. Feature Ownership**
Each product feature (wizard, reader, dashboard, checkout) owns its own folder. A feature exports only what other features need. Nothing from inside a feature folder is imported across feature boundaries — shared code lives in `src/shared`. This makes features independently deployable and testable.

**4. State by Layer**
State is allocated to the lowest layer that owns it:

- Server state → React Query (TanStack Query)
- URL state → `useSearchParams` / `useRouter`
- Global client state → Zustand
- Form state → React Hook Form
- Ephemeral UI state → `useState`

Violating this — for example, putting server state in Zustand — is an architecture error.

**5. Type Safety End-to-End**
The monorepo's `packages/types` package is the single source of truth for all shared types. The frontend consumes `@storyme/types` and never re-declares types that already exist on the API contract. An OpenAPI-generated client provides typed API calls. TypeScript strict mode is on everywhere with zero `any` budget in production code.

---

## 1.2 Technology Stack

| Layer         | Technology               | Version         | Purpose                                                 |
| ------------- | ------------------------ | --------------- | ------------------------------------------------------- |
| Framework     | Next.js                  | 15 (App Router) | SSR for marketing, RSC for fast initial load, BFF layer |
| UI            | React                    | 19              | Concurrent rendering, Suspense, Server Components       |
| Language      | TypeScript               | 5.x             | Full strict mode; zero `any`                            |
| Styling       | TailwindCSS              | 4.x             | Utility-first, purges to minimal bundle                 |
| Animation     | Framer Motion            | 11.x            | Book reveal, page flip, wizard transitions              |
| Server State  | TanStack Query           | 5.x             | Server state, polling, background refetch               |
| Client State  | Zustand                  | 5.x             | Wizard draft, auth token, reader position               |
| Forms         | React Hook Form          | 7.x             | Uncontrolled, performant form handling                  |
| Validation    | Zod                      | 3.x             | Schema validation; shared with API via `@storyme/types` |
| PDF Preview   | @react-pdf/renderer      | 3.x             | In-browser PDF preview (client-side only)               |
| Real-time     | Socket.io client         | 4.x             | Generation progress events                              |
| Icons         | Lucide React             | Latest          | Tree-shakable icon set                                  |
| Date handling | date-fns                 | 3.x             | Locale-aware date formatting                            |
| Testing       | Vitest + Testing Library | Latest          | Unit and integration tests                              |
| E2E           | Playwright               | Latest          | End-to-end and visual regression                        |

---

## 1.3 What We Do Not Use

These explicit exclusions prevent common mistakes:

- **No Redux or Redux Toolkit.** Zustand + React Query covers all state needs with less boilerplate.
- **No next-auth.** Authentication is handled via the NestJS backend; the BFF manages token relay.
- **No CSS Modules or styled-components.** TailwindCSS 4 is the sole styling system.
- **No moment.js.** date-fns only.
- **No Axios.** The native `fetch` API wrapped in our typed API client.
- **No class components.** Function components only.

---

## 1.4 Rendering Strategy by Zone

| Zone                | Rendering Model                 | Rationale                                                 |
| ------------------- | ------------------------------- | --------------------------------------------------------- |
| Marketing pages     | SSR (RSC)                       | SEO-critical; content is static or near-static            |
| Auth pages          | SSR shell + Client form         | Form interactivity needed; shell can be server-rendered   |
| Wizard              | Client Component (CSR)          | Multi-step form with complex local state; no SEO value    |
| Dashboard           | SSR shell + Client library grid | Auth check server-side; book grid rehydrated client-side  |
| Book Reader         | Client Component (CSR)          | Highly interactive; page flip, gestures, realtime updates |
| Generation progress | Client Component (CSR)          | Real-time WebSocket/SSE updates                           |
| Shared book viewer  | SSR                             | Public, shareable, SEO-friendly                           |
| Settings            | SSR shell + Client forms        | Auth server-side; form interactivity client-side          |
| Checkout            | Client Component (CSR)          | Stripe Elements requires client-side; no SSR              |

---

## 1.5 Module Boundaries

```
External consumers (pages, routes)
         │
         ▼
  Feature modules (wizard, reader, dashboard, ...)
         │ export only public API
         ▼
  Shared modules (components, hooks, services, ...)
         │ no feature imports
         ▼
  packages/types (shared types, Zod schemas)
```

**Rules:**

- Features may import from `shared`, never from other features directly.
- `shared` may not import from features.
- A feature's internal files are not public API. Only what is re-exported from the feature's `index.ts` barrel file is part of the public API.
- `packages/types` has no dependencies on any application code.

---

## 1.6 Scalability Strategy

The architecture scales across three dimensions:

**Team scale:** Feature isolation means multiple engineers can work on wizard, reader, and dashboard simultaneously without conflicts. Feature ownership maps naturally to squad ownership.

**Bundle scale:** Each feature is a natural code-split boundary. The reader's PDF renderer (~600 KB) never loads unless the user visits the reader. The avatar builder's assets never load on the checkout page.

**Traffic scale:** SSR for public pages means CDN edge caching handles marketing traffic without hitting the application server. The App Router's streaming support means time-to-first-byte for authenticated pages is fast even for slow data fetches.

---

# 2. Project Folder Structure

The frontend application lives at `apps/web` within the monorepo.

```
apps/web/
│
├── src/
│   │
│   ├── app/                          # Next.js App Router — routing only
│   │   │
│   │   ├── (marketing)/              # Route group: public marketing pages
│   │   │   ├── layout.tsx            # PublicLayout (top nav, footer)
│   │   │   ├── page.tsx              # / — Landing page
│   │   │   ├── how-it-works/
│   │   │   │   └── page.tsx
│   │   │   ├── pricing/
│   │   │   │   └── page.tsx
│   │   │   ├── samples/
│   │   │   │   └── page.tsx
│   │   │   ├── blog/
│   │   │   │   ├── page.tsx
│   │   │   │   └── [slug]/
│   │   │   │       └── page.tsx
│   │   │   ├── about/
│   │   │   ├── faq/
│   │   │   ├── contact/
│   │   │   ├── gift/
│   │   │   ├── teachers/
│   │   │   ├── privacy/
│   │   │   └── terms/
│   │   │
│   │   ├── (auth)/                   # Route group: auth pages
│   │   │   ├── layout.tsx            # AuthLayout (minimal, centered card)
│   │   │   ├── login/
│   │   │   │   └── page.tsx
│   │   │   ├── signup/
│   │   │   │   └── page.tsx
│   │   │   ├── forgot-password/
│   │   │   │   └── page.tsx
│   │   │   ├── reset-password/
│   │   │   │   └── [token]/
│   │   │   │       └── page.tsx
│   │   │   ├── verify-email/
│   │   │   │   └── [token]/
│   │   │   │       └── page.tsx
│   │   │   └── oauth/
│   │   │       └── callback/
│   │   │           └── page.tsx
│   │   │
│   │   ├── (wizard)/                 # Route group: book creation wizard
│   │   │   ├── layout.tsx            # WizardLayout (progress bar, exit button)
│   │   │   └── create/
│   │   │       ├── page.tsx          # Step 1 — Child's name & age
│   │   │       ├── world/
│   │   │       │   └── page.tsx      # Step 2 — Interests & world
│   │   │       ├── story/
│   │   │       │   └── page.tsx      # Step 3 — Theme & setting
│   │   │       ├── look/
│   │   │       │   └── page.tsx      # Step 4 — Appearance
│   │   │       ├── dedication/
│   │   │       │   └── page.tsx      # Step 5 — Dedication
│   │   │       ├── preview/
│   │   │       │   └── page.tsx      # Preview & auth wall
│   │   │       └── generating/
│   │   │           └── [jobId]/
│   │   │               └── page.tsx  # Generation progress
│   │   │
│   │   ├── (app)/                    # Route group: authenticated app
│   │   │   ├── layout.tsx            # AppLayout (header, nav, auth guard)
│   │   │   ├── dashboard/
│   │   │   │   └── page.tsx
│   │   │   ├── book/
│   │   │   │   └── [bookId]/
│   │   │   │       ├── page.tsx      # Book reader
│   │   │   │       └── edit/
│   │   │   │           └── page.tsx  # Post-generation edit
│   │   │   ├── series/
│   │   │   │   └── [seriesId]/
│   │   │   │       └── page.tsx
│   │   │   ├── checkout/
│   │   │   │   └── page.tsx
│   │   │   ├── gift/
│   │   │   │   ├── create/
│   │   │   │   │   └── page.tsx
│   │   │   │   ├── details/
│   │   │   │   │   └── page.tsx
│   │   │   │   └── checkout/
│   │   │   │       └── page.tsx
│   │   │   └── settings/
│   │   │       ├── layout.tsx        # SettingsLayout (sidebar nav on desktop)
│   │   │       ├── profile/
│   │   │       │   └── page.tsx
│   │   │       ├── children/
│   │   │       │   ├── page.tsx
│   │   │       │   ├── new/
│   │   │       │   │   └── page.tsx
│   │   │       │   └── [childId]/
│   │   │       │       └── page.tsx
│   │   │       ├── subscription/
│   │   │       │   └── page.tsx
│   │   │       ├── billing/
│   │   │       │   └── page.tsx
│   │   │       ├── notifications/
│   │   │       │   └── page.tsx
│   │   │       ├── language/
│   │   │       │   └── page.tsx
│   │   │       └── privacy/
│   │   │           └── page.tsx
│   │   │
│   │   ├── shared/                   # Public shared book viewer (no auth)
│   │   │   └── [bookId]/
│   │   │       └── page.tsx
│   │   │
│   │   ├── api/                      # Next.js Route Handlers (BFF)
│   │   │   ├── auth/
│   │   │   │   ├── login/route.ts
│   │   │   │   ├── logout/route.ts
│   │   │   │   ├── refresh/route.ts
│   │   │   │   ├── google/route.ts
│   │   │   │   └── apple/route.ts
│   │   │   ├── books/
│   │   │   │   ├── route.ts          # GET (list), POST (create)
│   │   │   │   └── [bookId]/
│   │   │   │       ├── route.ts
│   │   │   │       ├── download/route.ts
│   │   │   │       └── pages/
│   │   │   │           └── [pageN]/
│   │   │   │               ├── regen-image/route.ts
│   │   │   │               └── regen-text/route.ts
│   │   │   ├── billing/
│   │   │   │   ├── checkout/route.ts
│   │   │   │   └── webhook/route.ts  # Stripe webhook
│   │   │   └── upload/
│   │   │       └── photo/route.ts    # Photo upload proxy
│   │   │
│   │   ├── not-found.tsx             # 404 page
│   │   ├── error.tsx                 # Unhandled error boundary
│   │   ├── global-error.tsx          # Root-level error (layout crash)
│   │   ├── loading.tsx               # Root loading fallback
│   │   ├── layout.tsx                # Root layout (html, body, providers)
│   │   └── robots.ts / sitemap.ts    # SEO
│   │
│   ├── features/                     # Feature modules (encapsulated)
│   │   │
│   │   ├── wizard/
│   │   │   ├── components/           # Wizard-specific components
│   │   │   │   ├── WizardShell.tsx
│   │   │   │   ├── WizardStep.tsx
│   │   │   │   ├── StepChildInfo.tsx
│   │   │   │   ├── StepWorld.tsx
│   │   │   │   ├── StepStory.tsx
│   │   │   │   ├── StepAppearance.tsx
│   │   │   │   ├── StepDedication.tsx
│   │   │   │   ├── WizardPreview.tsx
│   │   │   │   └── AvatarBuilder/
│   │   │   │       ├── AvatarBuilder.tsx
│   │   │   │       ├── SkinTonePicker.tsx
│   │   │   │       ├── HairStyleGrid.tsx
│   │   │   │       └── AvatarPreview.tsx
│   │   │   ├── hooks/
│   │   │   │   ├── useWizardForm.ts
│   │   │   │   ├── useWizardNavigation.ts
│   │   │   │   ├── usePhotoUpload.ts
│   │   │   │   └── useStorySummary.ts
│   │   │   ├── stores/
│   │   │   │   └── wizardStore.ts    # Zustand slice
│   │   │   ├── schemas/
│   │   │   │   └── wizard.schema.ts  # Zod schemas per step
│   │   │   ├── utils/
│   │   │   │   └── wizardDraft.ts    # localStorage draft persistence
│   │   │   └── index.ts              # Public API barrel
│   │   │
│   │   ├── reader/
│   │   │   ├── components/
│   │   │   │   ├── BookReader.tsx
│   │   │   │   ├── ReaderToolbar.tsx
│   │   │   │   ├── BookSpread.tsx
│   │   │   │   ├── BookPage.tsx
│   │   │   │   ├── PageTurnButton.tsx
│   │   │   │   ├── ProgressScrubber.tsx
│   │   │   │   ├── ThumbnailStrip.tsx
│   │   │   │   ├── BookmarkPanel.tsx
│   │   │   │   ├── PaywallOverlay.tsx
│   │   │   │   └── BookReveal.tsx
│   │   │   ├── hooks/
│   │   │   │   ├── useReaderKeyboard.ts
│   │   │   │   ├── usePageSwipe.ts
│   │   │   │   ├── useReaderFullscreen.ts
│   │   │   │   └── useReadingProgress.ts
│   │   │   ├── stores/
│   │   │   │   └── readerStore.ts
│   │   │   └── index.ts
│   │   │
│   │   ├── dashboard/
│   │   │   ├── components/
│   │   │   │   ├── BookCardGrid.tsx
│   │   │   │   ├── BookCard.tsx
│   │   │   │   ├── ChildProfileStrip.tsx
│   │   │   │   ├── LibraryToolbar.tsx
│   │   │   │   ├── BookCardSkeleton.tsx
│   │   │   │   └── CreateBookCard.tsx
│   │   │   ├── hooks/
│   │   │   │   ├── useLibraryFilters.ts
│   │   │   │   └── useBookActions.ts
│   │   │   └── index.ts
│   │   │
│   │   ├── generation/
│   │   │   ├── components/
│   │   │   │   ├── GenerationProgress.tsx
│   │   │   │   ├── GenerationStageTimeline.tsx
│   │   │   │   ├── ThemedProgressBar.tsx
│   │   │   │   ├── PartialPreview.tsx
│   │   │   │   └── FactCarousel.tsx
│   │   │   ├── hooks/
│   │   │   │   ├── useGenerationStatus.ts  # SSE + polling
│   │   │   │   └── useEstimatedTime.ts
│   │   │   └── index.ts
│   │   │
│   │   ├── auth/
│   │   │   ├── components/
│   │   │   │   ├── LoginForm.tsx
│   │   │   │   ├── SignupForm.tsx
│   │   │   │   ├── OAuthButtons.tsx
│   │   │   │   └── AuthModal.tsx         # Auth wall in wizard
│   │   │   ├── hooks/
│   │   │   │   ├── useLogin.ts
│   │   │   │   ├── useSignup.ts
│   │   │   │   └── useOAuth.ts
│   │   │   ├── stores/
│   │   │   │   └── authStore.ts
│   │   │   └── index.ts
│   │   │
│   │   ├── checkout/
│   │   │   ├── components/
│   │   │   │   ├── CheckoutForm.tsx
│   │   │   │   ├── OrderSummary.tsx
│   │   │   │   ├── StripeCardForm.tsx
│   │   │   │   └── PromoCodeField.tsx
│   │   │   ├── hooks/
│   │   │   │   └── useStripePayment.ts
│   │   │   └── index.ts
│   │   │
│   │   └── settings/
│   │       ├── components/
│   │       │   ├── ProfileForm.tsx
│   │       │   ├── ChildProfileCard.tsx
│   │       │   ├── SubscriptionPanel.tsx
│   │       │   ├── BillingHistory.tsx
│   │       │   ├── NotificationToggles.tsx
│   │       │   └── DeleteAccountFlow.tsx
│   │       ├── hooks/
│   │       │   └── useSettingsMutations.ts
│   │       └── index.ts
│   │
│   ├── shared/                       # Cross-feature shared code
│   │   │
│   │   ├── components/               # Design system components
│   │   │   ├── ui/                   # Primitive UI components
│   │   │   │   ├── Button.tsx
│   │   │   │   ├── Input.tsx
│   │   │   │   ├── Textarea.tsx
│   │   │   │   ├── Checkbox.tsx
│   │   │   │   ├── RadioGroup.tsx
│   │   │   │   ├── Switch.tsx
│   │   │   │   ├── Select.tsx
│   │   │   │   ├── NumberStepper.tsx
│   │   │   │   ├── TagPicker.tsx
│   │   │   │   ├── ColorPicker.tsx
│   │   │   │   ├── Badge.tsx
│   │   │   │   ├── Chip.tsx
│   │   │   │   ├── Avatar.tsx
│   │   │   │   ├── Card.tsx
│   │   │   │   ├── Modal.tsx
│   │   │   │   ├── Drawer.tsx
│   │   │   │   ├── Toast.tsx
│   │   │   │   ├── Tooltip.tsx
│   │   │   │   ├── SkeletonLoader.tsx
│   │   │   │   └── EmptyState.tsx
│   │   │   ├── layout/               # Layout primitives
│   │   │   │   ├── Container.tsx
│   │   │   │   ├── Section.tsx
│   │   │   │   └── Divider.tsx
│   │   │   └── feedback/             # Feedback components
│   │   │       ├── ToastProvider.tsx
│   │   │       ├── ErrorMessage.tsx
│   │   │       └── ProgressBar.tsx
│   │   │
│   │   ├── hooks/                    # Shared custom hooks
│   │   │   ├── useToast.ts
│   │   │   ├── useMediaQuery.ts
│   │   │   ├── useDebounce.ts
│   │   │   ├── useLocalStorage.ts
│   │   │   ├── useReducedMotion.ts
│   │   │   ├── useIntersectionObserver.ts
│   │   │   ├── useCopyToClipboard.ts
│   │   │   ├── usePrevious.ts
│   │   │   └── useOnClickOutside.ts
│   │   │
│   │   ├── services/                 # API service functions
│   │   │   ├── api.client.ts         # Base fetch client
│   │   │   ├── books.service.ts
│   │   │   ├── auth.service.ts
│   │   │   ├── children.service.ts
│   │   │   ├── billing.service.ts
│   │   │   ├── upload.service.ts
│   │   │   └── sharing.service.ts
│   │   │
│   │   ├── providers/                # React context providers
│   │   │   ├── QueryProvider.tsx     # TanStack Query client
│   │   │   ├── AuthProvider.tsx      # Auth state + token refresh
│   │   │   ├── ToastProvider.tsx     # Global toast queue
│   │   │   ├── ThemeProvider.tsx     # Design token CSS vars
│   │   │   └── AnalyticsProvider.tsx
│   │   │
│   │   ├── stores/                   # Zustand stores (shared slices)
│   │   │   └── uiStore.ts            # Global UI state (modals, theme)
│   │   │
│   │   ├── lib/                      # Third-party integrations
│   │   │   ├── queryClient.ts        # TanStack Query client config
│   │   │   ├── stripe.ts             # Stripe.js loader
│   │   │   ├── analytics.ts          # Analytics abstraction
│   │   │   └── i18n.ts               # next-intl configuration
│   │   │
│   │   ├── types/                    # Frontend-only types
│   │   │   ├── ui.types.ts           # Component props, UI state types
│   │   │   └── navigation.types.ts   # Route params, search params
│   │   │
│   │   ├── utils/                    # Pure utility functions
│   │   │   ├── format.ts             # Date, number, currency formatters
│   │   │   ├── cn.ts                 # Tailwind class merging (clsx + twMerge)
│   │   │   ├── errors.ts             # Error parsing helpers
│   │   │   ├── image.ts              # Image URL helpers (CDN, signed URLs)
│   │   │   └── validation.ts         # Shared validation helpers
│   │   │
│   │   └── constants/
│   │       ├── routes.ts             # Typed route constants
│   │       ├── queryKeys.ts          # React Query key factories
│   │       └── config.ts             # Feature flags, limits
│   │
│   ├── styles/
│   │   ├── globals.css               # Tailwind directives + CSS custom properties
│   │   ├── tokens.css                # Design token CSS variables (from DESIGN_SYSTEM.md)
│   │   └── fonts.css                 # Font declarations (Fraunces, Plus Jakarta Sans, Lora)
│   │
│   └── assets/
│       ├── images/                   # Static images (logos, og-images)
│       ├── illustrations/            # UI illustrations (SVG, optimized)
│       │   ├── wizard/               # Per-step wizard background illustrations
│       │   ├── empty-states/         # Empty state illustrations
│       │   └── error/                # Error state illustrations
│       └── fonts/                    # Self-hosted font files (OpenDyslexic)
│
├── public/
│   ├── favicon.ico
│   ├── og-image.png
│   └── manifest.json                 # PWA manifest
│
├── next.config.ts
├── tailwind.config.ts
├── tsconfig.json
├── vitest.config.ts
└── playwright.config.ts
```

---

## 2.1 Folder Purpose Summary

| Folder                  | Purpose                                                                     |
| ----------------------- | --------------------------------------------------------------------------- |
| `app/`                  | Routing only. Pages and layouts. No business logic.                         |
| `app/(marketing)/`      | SSR marketing pages, public routes.                                         |
| `app/(auth)/`           | Auth flow pages with minimal auth layout.                                   |
| `app/(wizard)/`         | Wizard steps with dedicated wizard shell layout.                            |
| `app/(app)/`            | All authenticated pages under the app shell.                                |
| `app/api/`              | BFF Route Handlers. Proxies to NestJS API, handles cookie auth.             |
| `features/`             | Encapsulated product features. Each owns its own components, hooks, stores. |
| `shared/components/ui/` | Design system primitives. No domain knowledge.                              |
| `shared/hooks/`         | Reusable, stateless, domain-agnostic hooks.                                 |
| `shared/services/`      | Typed functions that call the BFF API layer.                                |
| `shared/providers/`     | React context providers that wrap the app tree.                             |
| `shared/stores/`        | Zustand stores not owned by a single feature.                               |
| `shared/lib/`           | Third-party SDK configuration and wrappers.                                 |
| `shared/constants/`     | Typed constants: routes, query keys, feature config.                        |
| `styles/`               | Global CSS: Tailwind, design tokens, font loading.                          |
| `assets/`               | Static assets bundled by Next.js.                                           |

---

# 3. App Router Structure

## 3.1 Route Groups and Their Logic

Next.js route groups (`(name)`) are used to apply different layouts to different zones without affecting the URL structure. This is the primary mechanism for zone isolation.

```
Route Group     URL Prefix      Layout Applied     Auth Required
(marketing)     /               PublicLayout        No
(auth)          /login, etc.    AuthLayout          No (redirect if authed)
(wizard)        /create/*       WizardLayout        Partial (wall at /preview)
(app)           /dashboard, etc AppLayout           Yes (redirect to /login)
(none)          /shared/:id     MinimalLayout       No
```

## 3.2 Complete Route Table

| URL Pattern                  | Component             | Auth                 | Layout       | Render    |
| ---------------------------- | --------------------- | -------------------- | ------------ | --------- |
| `/`                          | LandingPage           | No                   | Public       | SSR       |
| `/how-it-works`              | HowItWorksPage        | No                   | Public       | SSR       |
| `/pricing`                   | PricingPage           | No                   | Public       | SSR       |
| `/samples`                   | SamplesPage           | No                   | Public       | SSR       |
| `/blog`                      | BlogIndexPage         | No                   | Public       | SSR       |
| `/blog/[slug]`               | BlogPostPage          | No                   | Public       | SSR       |
| `/about`                     | AboutPage             | No                   | Public       | SSR       |
| `/faq`                       | FAQPage               | No                   | Public       | SSR       |
| `/contact`                   | ContactPage           | No                   | Public       | SSR       |
| `/gift`                      | GiftLandingPage       | No                   | Public       | SSR       |
| `/teachers`                  | TeachersPage          | No                   | Public       | SSR       |
| `/privacy`                   | PrivacyPage           | No                   | Public       | SSR       |
| `/terms`                     | TermsPage             | No                   | Public       | SSR       |
| `/login`                     | LoginPage             | Redirect if authed   | Auth         | SSR shell |
| `/signup`                    | SignupPage            | Redirect if authed   | Auth         | SSR shell |
| `/forgot-password`           | ForgotPasswordPage    | No                   | Auth         | SSR       |
| `/reset-password/[token]`    | ResetPasswordPage     | No                   | Auth         | CSR       |
| `/verify-email/[token]`      | VerifyEmailPage       | No                   | Auth         | CSR       |
| `/oauth/callback`            | OAuthCallbackPage     | No                   | Auth         | CSR       |
| `/create`                    | WizardStep1           | No                   | Wizard       | CSR       |
| `/create/world`              | WizardStep2           | No                   | Wizard       | CSR       |
| `/create/story`              | WizardStep3           | No                   | Wizard       | CSR       |
| `/create/look`               | WizardStep4           | No                   | Wizard       | CSR       |
| `/create/dedication`         | WizardStep5           | No                   | Wizard       | CSR       |
| `/create/preview`            | WizardPreview         | Wall (auth modal)    | Wizard       | CSR       |
| `/create/generating/[jobId]` | GenerationProgress    | Yes → /login         | Wizard       | CSR       |
| `/dashboard`                 | DashboardPage         | Yes → /login         | App          | SSR shell |
| `/book/[bookId]`             | BookReaderPage        | Yes → /login         | App          | CSR       |
| `/book/[bookId]/edit`        | BookEditPage          | Yes + paid → upgrade | App          | CSR       |
| `/series/[seriesId]`         | SeriesPage            | Yes → /login         | App          | SSR       |
| `/checkout`                  | CheckoutPage          | Yes → /login         | App          | CSR       |
| `/gift/create`               | GiftCreatePage        | Yes → /login         | App          | CSR       |
| `/gift/details`              | GiftDetailsPage       | Yes → /login         | App          | CSR       |
| `/gift/checkout`             | GiftCheckoutPage      | Yes → /login         | App          | CSR       |
| `/settings/profile`          | ProfileSettings       | Yes → /login         | App+Settings | SSR shell |
| `/settings/children`         | ChildrenSettings      | Yes → /login         | App+Settings | SSR shell |
| `/settings/children/new`     | NewChildPage          | Yes → /login         | App+Settings | CSR       |
| `/settings/children/[id]`    | EditChildPage         | Yes → /login         | App+Settings | CSR       |
| `/settings/subscription`     | SubscriptionSettings  | Yes → /login         | App+Settings | SSR shell |
| `/settings/billing`          | BillingSettings       | Yes → /login         | App+Settings | SSR shell |
| `/settings/notifications`    | NotificationsSettings | Yes → /login         | App+Settings | CSR       |
| `/settings/language`         | LanguageSettings      | Yes → /login         | App+Settings | CSR       |
| `/settings/privacy`          | PrivacySettings       | Yes → /login         | App+Settings | CSR       |
| `/shared/[bookId]`           | SharedBookViewer      | No                   | Minimal      | SSR       |
| `/not-found`                 | NotFoundPage          | No                   | Minimal      | SSR       |
| `/500` (error.tsx)           | ServerErrorPage       | No                   | Minimal      | CSR       |

## 3.3 Auth Guard Pattern

Auth protection is implemented at the Server Component layer in the App layout, not in individual pages:

```
app/(app)/layout.tsx:
  1. Read session from HttpOnly cookie on the server
  2. If no valid session → redirect to /login?redirect=<current-url>
  3. If valid session → render children with user context in props
  4. Child pages never check auth themselves
```

The `/create/*` wizard routes are different — they use a hybrid approach:

- Steps 1–5: Always accessible (no auth guard)
- `/create/preview`: Renders a client-side auth modal over the preview when no session is present. The wizard data is preserved. After auth, generation begins immediately.
- `/create/generating/:jobId`: Has a full server-side auth guard (redirect to login if no session).

## 3.4 Route Parameters and Search Params Types

All route params and search params are typed:

```typescript
// shared/types/navigation.types.ts

type BookPageParams = { bookId: string };
type BookPageSearchParams = { page?: string; reveal?: string };

type DashboardSearchParams = {
  child?: string;
  sort?: 'newest' | 'oldest' | 'az' | 'az-child';
  q?: string;
  theme?: string;
};

type WizardGeneratingParams = { jobId: string };
type CheckoutSearchParams = { plan?: 'single' | 'family' };
```

---

# 4. Layout Architecture

## 4.1 Layout Tree

```
RootLayout (app/layout.tsx)
│  html, body, CSS variables, font links
│  Providers: QueryProvider, AuthProvider, ToastProvider, ThemeProvider, AnalyticsProvider
│
├── PublicLayout (app/(marketing)/layout.tsx)
│   │  PublicHeader (logo, pricing link, login/CTA)
│   │  <main>{children}</main>
│   └── PublicFooter (links, social, legal)
│
├── AuthLayout (app/(auth)/layout.tsx)
│   │  Minimal: logo centered top
│   └── Centered card container, no nav, no footer
│
├── WizardLayout (app/(wizard)/layout.tsx)
│   │  WizardShell (progress bar, exit button)
│   │  No nav, no footer — full focus on wizard
│   └── <main>{children}</main>
│
├── AppLayout (app/(app)/layout.tsx)
│   │  Server-side auth check → redirect if no session
│   │  AppHeader (desktop) / MobileTopBar + BottomTabBar (mobile)
│   │  <main>{children}</main>
│   │
│   └── SettingsLayout (app/(app)/settings/layout.tsx)
│       │  2-column: SettingsSidebar (desktop) + <section>{children}</section>
│       └── Mobile: list-first navigation (no sidebar)
│
└── MinimalLayout (shared/[bookId], error pages)
    │  SharedBookHeader (logo + "Create your own" CTA)
    └── <main>{children}</main>
```

## 4.2 PublicLayout

- **Header:** Sticky, 64px height. Logo (left) → Pricing, How It Works, Samples links → "Log in" (ghost) + "Get Started" (primary button). On mobile: logo + hamburger → slide-down mobile menu.
- **Footer:** Full-width. 4-column grid (desktop), stacked (mobile). Columns: Product, Company, Legal, Social. Copyright at bottom.
- **Behavior:** Header background transitions from transparent to `bg-surface` with `shadow-xs` after 8px scroll (landing page only). All other pages: always `bg-surface`.

## 4.3 AppLayout

- **Desktop (≥1024px):** Top header. Logo → Library link → Children dropdown → spacer → Help icon + Notification bell + Account avatar dropdown.
- **Tablet (768px–1023px):** Minimal top bar with hamburger → left drawer with full nav tree.
- **Mobile (<768px):** Minimal top bar (logo + avatar). Bottom tab bar: Library | Create (emphasized) | Account.
- **Auth behavior:** Layout receives user session from server. Passes user object down via React context (not prop drilling). Pages read from context.
- **Notification badge:** Reads from a lightweight polling query (60s interval, background-only) for unread notification count.

## 4.4 WizardLayout

- No standard navigation. Wizard is a dedicated focus experience.
- Top bar contains only: Exit button (×, top-left) + WizardProgressBar (5 nodes).
- No footer. No links. No distractions.
- On mobile: progress bar node labels are hidden (icons or numbers only, max 5 nodes in ~250px).
- The wizard layout must be a Client Component because the progress bar reflects wizard state from Zustand.

## 4.5 ReaderLayout

The reader is not a layout in the routing sense — it is a full-viewport Client Component that renders within the AppLayout. When the reader mounts, it uses `position: fixed; inset: 0; z-index: 50` to take over the full viewport. The AppLayout header is hidden via a layout effect when the reader is active.

## 4.6 Responsive Behavior Summary

| Layout         | Mobile (<768px)                   | Tablet (768–1023px)            | Desktop (≥1024px)                |
| -------------- | --------------------------------- | ------------------------------ | -------------------------------- |
| PublicLayout   | Hamburger menu, stacked sections  | Hamburger, 2-col grid sections | Full top nav, multi-col sections |
| AppLayout      | Bottom tabs, minimal top bar      | Hamburger + left drawer        | Full top header                  |
| WizardLayout   | Full-screen step, no illustration | Illustration shown in column   | 50/50 split (form/illustration)  |
| SettingsLayout | Mobile: list → push sub-pages     | Same                           | 240px sidebar + content area     |
| ReaderLayout   | Single page, swipe nav            | Single page, arrows            | 2-page spread, arrows            |

---

# 5. Component Architecture

## 5.1 Component Hierarchy

```
Design System Primitives (shared/components/ui/)
         ↑ consumed by
Shared Composite Components (shared/components/)
         ↑ consumed by
Feature Components (features/*/components/)
         ↑ composed into
Page Components (app/**/page.tsx)
```

Each layer depends only on layers below it. Pages compose feature components. Feature components use shared components and primitives.

## 5.2 Design System Primitives

All components in `shared/components/ui/` are:

- **Uncontrolled by default** — they accept value and onChange via props, they do not manage their own state.
- **Design-token aware** — they consume CSS custom property tokens from `styles/tokens.css`, never raw hex values or pixel values.
- **Accessible by default** — ARIA attributes, keyboard handling, and focus management are built in, not left to callers.
- **Variant-based** — variants drive visual behavior via the `cn()` utility (clsx + twMerge), never conditional inline styles.
- **Typed** — all props are TypeScript interfaces extending the appropriate HTML element's attributes.

## 5.3 Component Composition Patterns

**Pattern 1 — Compound Components** (for complex interactive widgets)

Used for: `Modal`, `Drawer`, `TagPicker`, `NumberStepper`

A parent component manages shared state. Sub-components read from a React context provided by the parent. Consumers assemble sub-components freely without prop drilling.

```
<Modal>
  <Modal.Header title="Share your book" />
  <Modal.Body>...</Modal.Body>
  <Modal.Footer>
    <Button variant="ghost">Cancel</Button>
    <Button variant="primary">Copy link</Button>
  </Modal.Footer>
</Modal>
```

**Pattern 2 — Render Props / Slot Pattern** (for layout components)

Used for: `EmptyState`, `Card`, `WizardStep`

Components accept `children` or explicit slot props for sections they do not control.

**Pattern 3 — Headless Hooks** (for behavior without rendering)

Used for: `useToast`, `useReaderKeyboard`, `usePageSwipe`, `useCopyToClipboard`

The hook returns state and event handlers. The component renders the UI. This makes components easy to test (mock the hook) and easy to restyle.

**Pattern 4 — Controlled Wrappers** (for form integration)

Used for: `TagPicker`, `ColorPicker`, `SkinTonePicker`, `HairStyleGrid`

These widgets are always fully controlled — they receive `value` and `onChange`. They never hold their own state. React Hook Form's `Controller` wraps them in wizard forms.

## 5.4 Feature Component Rules

Feature components may:

- Import from `shared/components`, `shared/hooks`, `shared/services`, `shared/stores`
- Import from the feature's own sub-directories
- Import from `@storyme/types`

Feature components must not:

- Import from other feature folders
- Contain raw API calls (`fetch(...)`) — all API calls go through `shared/services`
- Contain design token values in component code — use Tailwind classes from the token mapping

## 5.5 Server vs. Client Component Decision Matrix

| Component            | Server or Client                        | Reason                                                                             |
| -------------------- | --------------------------------------- | ---------------------------------------------------------------------------------- |
| `LandingPage`        | Server                                  | No interactivity; SEO-critical                                                     |
| `BookCard`           | Server (shell) + Client (hover actions) | Cover image and metadata can be server-rendered; hover actions need event handlers |
| `BookCardGrid`       | Client                                  | Depends on filter/sort state from Zustand/URL                                      |
| `WizardStep*`        | Client                                  | All wizard components need form state and animations                               |
| `BookReader`         | Client                                  | Page gestures, keyboard, WebSocket                                                 |
| `ReaderToolbar`      | Client                                  | Auto-hide on inactivity, keyboard shortcuts                                        |
| `Modal`              | Client                                  | Needs browser APIs (focus management, scroll lock)                                 |
| `Toast`              | Client                                  | Animated, needs event handlers                                                     |
| `SettingsProfile`    | Server (shell)                          | Can pre-render the form shell; hydrate for interactivity                           |
| `CheckoutForm`       | Client                                  | Stripe Elements requires client-side                                               |
| `GenerationProgress` | Client                                  | WebSocket/SSE updates                                                              |
| `DashboardLayout`    | Server                                  | Auth check, initial book list fetch                                                |
| `ChildProfileStrip`  | Client                                  | Click handlers for filtering                                                       |
| `AuthModal`          | Client                                  | In-wizard auth modal; needs state                                                  |

---

# 6. State Management

## 6.1 State Allocation Table

| State Type                           | Tool                    | Location                          | Persisted                             |
| ------------------------------------ | ----------------------- | --------------------------------- | ------------------------------------- |
| Server data (books, user, credits)   | TanStack Query          | Query cache                       | In-memory; TTL-based                  |
| Authentication (token, user session) | Zustand (`authStore`)   | Memory (token) + Cookie (refresh) | Cookie persists across tabs           |
| Wizard draft (all step data)         | Zustand (`wizardStore`) | Memory + localStorage backup      | localStorage (guest), server (authed) |
| Reader position, bookmarks           | Zustand (`readerStore`) | Memory + server sync              | Server (via mutation on change)       |
| Global UI (toasts, active modals)    | Zustand (`uiStore`)     | Memory only                       | No                                    |
| Dashboard filters + sort             | URL (`useSearchParams`) | URL                               | Browser history                       |
| Search query                         | URL (`useSearchParams`) | URL                               | Browser history                       |
| Book page position (deep link)       | URL (`useSearchParams`) | URL                               | Browser history                       |
| Form state (all forms)               | React Hook Form         | Memory (per form)                 | No                                    |
| Ephemeral UI (dropdown open, hover)  | `useState`              | Component                         | No                                    |

## 6.2 TanStack Query Configuration

**Query Client setup (`shared/lib/queryClient.ts`):**

The query client is configured with these defaults:

- `staleTime`: 30 seconds for most queries. The user's book list does not need sub-second freshness.
- `gcTime`: 5 minutes. Keeps dehydrated pages fast on navigation.
- `retry`: 1 for server errors; 0 for 4xx client errors (retry on auth failure handled by the `AuthProvider` interceptor, not per-query retry).
- `refetchOnWindowFocus`: `true` for book status queries (catches completion when user returns from another tab); `false` for everything else.

**Query Key Factory (`shared/constants/queryKeys.ts`):**

All query keys are produced by a factory function, never constructed inline:

```
queryKeys.books.all()                     → ['books']
queryKeys.books.list(filters)             → ['books', 'list', filters]
queryKeys.books.detail(bookId)            → ['books', 'detail', bookId]
queryKeys.books.status(bookId)            → ['books', 'status', bookId]
queryKeys.children.all()                  → ['children']
queryKeys.user.profile()                  → ['user', 'profile']
queryKeys.user.credits()                  → ['user', 'credits']
```

**Polling strategy for book generation:**

When a book is in a generating state, the status query switches to active polling:

- Poll interval: 5 seconds while generation is active
- Polling stops when status changes to `complete`, `failed`, or `partial`
- The WebSocket/SSE is the primary update mechanism; polling is the fallback (see Section 10)

**Optimistic updates:**

Applied to these mutations:

- Bookmark a page → immediately reflects in the reader
- Delete a book → immediately removes from grid
- Add/remove child profile filter → immediately updates URL and triggers re-render
- Toggle notification preference → immediately reflects toggle state

All optimistic updates roll back to the server state on mutation failure.

**Prefetching strategy:**

- On dashboard render: prefetch the first 4 book details for visible cards (cover URL, page count)
- On wizard Step 5 completion: prefetch the `/create/preview` story summary API call
- On book card hover (desktop): prefetch the book reader data for that book after 400ms hover delay

## 6.3 Zustand Stores

**`authStore.ts`**

```
State:
  accessToken: string | null        // JWT; stored in memory only
  user: UserProfile | null
  isLoading: boolean

Actions:
  setTokenAndUser(token, user)
  clearAuth()
  refreshToken() → async, calls BFF /api/auth/refresh
```

The `AuthProvider` calls `refreshToken()` on mount (to restore session from the HttpOnly refresh cookie) and sets up an interval to refresh the access token before it expires (every 14 minutes, since tokens expire at 15 minutes).

**`wizardStore.ts`**

```
State:
  step: 1 | 2 | 3 | 4 | 5 | 'preview' | 'generating'
  draft: WizardDraft (all step data combined)
    step1: { childName, nickname, age, pronouns }
    step2: { interests, favoriteColor, bestFriendName, petName, ... }
    step3: { theme, setting, mood, lesson, bookLength }
    step4: { mode: 'photo' | 'avatar'; photoUrl?; avatarConfig? }
    step5: { dedication, fromName, includeDedication, language }
  isDirty: boolean                  // has any data been entered
  jobId: string | null              // set after book creation

Actions:
  updateDraft(stepData)             // merges partial update
  setStep(step)
  setJobId(id)
  resetWizard()
  restoreFromLocalStorage()
  persistToLocalStorage()
```

**`readerStore.ts`**

```
State:
  bookId: string | null
  currentPage: number
  totalPages: number
  bookmarks: Set<number>
  isFullscreen: boolean
  showThumbnailStrip: boolean
  toolbarVisible: boolean

Actions:
  openBook(bookId, savedPage)
  goToPage(page)
  nextPage()
  prevPage()
  toggleBookmark()
  setFullscreen(bool)
  toggleThumbnailStrip()
  setToolbarVisible(bool)
```

**`uiStore.ts`**

```
State:
  toastQueue: Toast[]
  activeModal: string | null

Actions:
  addToast(toast)
  removeToast(id)
  openModal(id)
  closeModal()
```

## 6.4 Context API Usage

React Context is used sparingly — only for values that many deeply nested components need and that change rarely:

| Context      | Provider      | Consumers                              | Value                                  |
| ------------ | ------------- | -------------------------------------- | -------------------------------------- |
| AuthContext  | AuthProvider  | Any component needing user             | `{ user, isLoading, isAuthenticated }` |
| ToastContext | ToastProvider | `useToast` hook                        | `{ addToast }`                         |
| ThemeContext | ThemeProvider | No component (CSS vars handle theming) | Dark/light mode toggle                 |
| QueryContext | QueryProvider | React Query hooks automatically        | QueryClient instance                   |

Context is **not** used for wizard state, reader state, or dashboard filters — those use Zustand or URL state.

---

# 7. Forms Architecture

## 7.1 Core Approach

All forms use **React Hook Form (RHF)** with **Zod** validation. The Zod schema is the single source of truth for both type inference and runtime validation. Form state is never in Zustand or React Query — only in RHF's internal state.

## 7.2 Zod Schema Strategy

Schemas live close to their feature:

- Wizard step schemas: `features/wizard/schemas/wizard.schema.ts`
- Auth form schemas: `features/auth/schemas/auth.schema.ts`
- Settings schemas: `features/settings/schemas/settings.schema.ts`

Schemas that mirror API contracts import base schemas from `@storyme/types` and extend them for frontend needs (e.g., adding confirm-password field, extending optional fields with UI-specific defaults).

**Wizard schemas are split per step** to enable incremental validation:

```
WizardStep1Schema: z.object({ childName, nickname?, age, pronouns })
WizardStep2Schema: z.object({ interests (min 1), favoriteColor?, ... })
WizardStep3Schema: z.object({ theme, setting, mood?, lesson?, bookLength })
WizardStep4Schema: z.discriminatedUnion('mode', [PhotoSchema, AvatarSchema])
WizardStep5Schema: z.object({ dedication?, fromName?, ... })
WizardDraftSchema: WizardStep1Schema.merge(WizardStep2Schema).merge(...)  // full merged
```

## 7.3 Wizard State and Form Integration

The wizard has a subtle state duality:

- **RHF** owns the in-step form state (what's currently on screen, input errors)
- **Zustand** (`wizardStore.draft`) owns the persisted draft (what the user has completed across all steps)

The flow for each step:

1. Step mounts → RHF is initialized with `defaultValues` from `wizardStore.draft` (restores on back-navigation)
2. User fills in step → RHF manages field state internally
3. User clicks "Continue" → RHF validates → on success, `wizardStore.updateDraft(stepData)` is called, then navigate to next step
4. `wizardStore.persistToLocalStorage()` is called after every successful step completion (debounced 500ms)

This pattern means:

- Navigating back always shows the previously entered data (from Zustand)
- Data is never lost on refresh (from localStorage)
- Validation is local to each step; only that step's schema is evaluated on Continue

## 7.4 Non-Wizard Forms

All settings forms, auth forms, and checkout forms use RHF with `zodResolver`. They follow this pattern:

- `useForm` with Zod schema and `defaultValues` from server data (loaded via React Query)
- When server data loads, `form.reset(serverData)` is called to populate form
- `onSubmit` calls the relevant mutation (React Query mutation or direct service call)
- Mutation errors from the API are set on specific form fields via `form.setError(fieldName, ...)`

## 7.5 Autosave (Dashboard Settings)

Settings forms autosave after a 1-second debounce following any field change. The flow:

1. User changes any field
2. `useWatch` detects the change
3. 1-second debounce fires → mutation is called
4. On success: toast "Saved" (2 seconds, bottom-right)
5. On error: toast error + form reverts to last saved value

Autosave is disabled during initial loading and when the form has validation errors.

## 7.6 Wizard Draft Recovery

When a user returns to `/create` (after closing browser, leaving, or session expiry):

**If the user is authenticated:** On wizard load, call `/api/books/draft` to retrieve the server-stored draft. If found, pre-populate the wizard and navigate to the last completed step.

**If the user is a guest:** On wizard load, call `wizardStore.restoreFromLocalStorage()`. If a draft is found, show a banner: "Welcome back! We saved your progress." with options "Continue" and "Start Over."

Draft data is always cleared from localStorage after a successful book generation. It is also cleared on explicit "Start Over" action.

---

# 8. API Layer

## 8.1 Architecture

The frontend never calls the NestJS backend directly. All API calls go through the **Next.js BFF (Backend for Frontend)** layer at `app/api/*`. This allows the BFF to:

- Relay the access token as a server-to-server call (token not exposed to browser JS)
- Set and read the HttpOnly refresh token cookie
- Transform responses for the frontend without leaking backend internals
- Proxy photo uploads without CORS issues

```
Browser → BFF (Next.js API Route) → NestJS API → Database / AI
                         ↑
               Sets/reads HttpOnly cookie
               Adds Authorization header
               Handles token refresh
```

## 8.2 API Client (`shared/services/api.client.ts`)

A typed base fetch wrapper with the following behaviors:

- **Base URL:** Read from environment variable `NEXT_PUBLIC_API_BASE_URL` (points to `/api` for same-origin BFF calls)
- **Default headers:** `Content-Type: application/json`, `Accept: application/json`
- **Auth:** Reads access token from `authStore.accessToken` and adds `Authorization: Bearer <token>`
- **Request cancellation:** All requests accept an `AbortSignal` from `AbortController`
- **Error normalization:** Network errors, 4xx, and 5xx are all normalized to a `ApiError` type with `status`, `message`, and `code` fields
- **Response typing:** The client is generic — `apiClient.get<BookStatusResponse>('/books/123')` returns `Promise<BookStatusResponse>`

## 8.3 Service Functions (`shared/services/*.service.ts`)

Service functions are thin wrappers around the API client that:

- Define the request shape (typed request body)
- Define the response shape (typed return value)
- Handle any request-specific transformation

Service functions are called from React Query hooks or mutations. They are never called directly from components.

Example structure:

```
books.service.ts
  createBook(request: CreateBookRequest) → Promise<CreateBookResponse>
  getBook(bookId: string) → Promise<BookStatusResponse>
  listBooks(filters: BookFilters) → Promise<PaginatedBooks>
  downloadBook(bookId: string) → Promise<{ downloadUrl: string }>
  regenPage(bookId: string, pageN: number, type: 'image' | 'text') → Promise<void>
  deleteBook(bookId: string) → Promise<void>
```

## 8.4 Error Handling

**API errors are caught at three levels:**

1. **Network errors** (fetch throws): Caught by the API client, normalized to `ApiError { status: 0, message: 'Network error' }`. The UI shows a generic offline message.

2. **HTTP errors (4xx/5xx)**: The API client reads the error body and constructs a typed `ApiError`. React Query's `onError` callbacks receive this typed error.

3. **Mutation errors**: Surface as inline form errors (via `form.setError()`) or as toast notifications, depending on context. Never surfaced as full-page errors.

**React Query error handling:**

- Query errors: set error state on the component using `useQuery`'s `error` return value
- Mutation errors: handled in the mutation's `onError` callback
- No global `onError` handler that silently swallows errors

**HTTP 401 Unauthorized handling:**
When the BFF returns 401, the API client:

1. Calls `authStore.refreshToken()` to attempt token refresh
2. If refresh succeeds: retries the original request with the new token
3. If refresh fails: calls `authStore.clearAuth()` and redirects to `/login?redirect=<current-url>`

This retry happens at the API client layer, transparently to components.

## 8.5 Pagination

Book list queries use **cursor-based pagination** (not offset). The API returns a `nextCursor` string with each response. TanStack Query's `useInfiniteQuery` manages the cursor chain:

```
useInfiniteQuery({
  queryKey: queryKeys.books.list(filters),
  queryFn: ({ pageParam }) => booksService.listBooks({ ...filters, cursor: pageParam }),
  getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
})
```

The dashboard uses infinite scroll (intersection observer triggers `fetchNextPage()`) rather than paginated page numbers.

## 8.6 Request Cancellation

All data-fetching queries pass an `AbortSignal` from React Query's `meta.signal`:

```typescript
queryFn: ({ signal }) => booksService.listBooks(filters, { signal });
```

Service functions pass the signal to the underlying `fetch()` call. When the user navigates away mid-fetch, the request is cancelled immediately.

---

# 9. Authentication Flow

## 9.1 Token Architecture

| Token         | Storage                         | Lifetime   | Purpose                                      |
| ------------- | ------------------------------- | ---------- | -------------------------------------------- |
| Access Token  | JavaScript memory (`authStore`) | 15 minutes | Sent in `Authorization` header for API calls |
| Refresh Token | HttpOnly Secure cookie          | 7 days     | Used by BFF to issue new access tokens       |

The access token is **never** written to localStorage or sessionStorage. It lives exclusively in the Zustand `authStore`. This means the token is lost on full page refresh — which is correct behavior, triggering a silent token refresh via the HttpOnly cookie on mount.

## 9.2 Session Restore on App Mount

The `AuthProvider` runs this flow on mount (before any page renders):

```
1. Call BFF /api/auth/refresh (cookie is sent automatically by browser)
2. If 200: store new accessToken + user profile in authStore → user is authenticated
3. If 401: authStore remains empty → user is unauthenticated
4. Set authStore.isLoading = false
```

Child components render only after `isLoading = false`. The app root shows a full-page loading screen (brand-colored, spinner) for the brief refresh window (~200ms typical).

## 9.3 Login Flow

**Email/Password:**

1. User submits `LoginForm`
2. Call BFF `/api/auth/login` with `{ email, password }`
3. BFF calls NestJS → NestJS returns `{ accessToken }` and sets the `refreshToken` cookie on the BFF response
4. BFF forwards `{ accessToken, user }` to the browser
5. `authStore.setTokenAndUser(token, user)` is called
6. Navigate to `redirect` param URL or `/dashboard`

**Google OAuth:**

1. User clicks "Continue with Google" → redirect to BFF `/api/auth/google` → Google OAuth
2. Google redirects to BFF callback → BFF exchanges code → NestJS issues tokens → BFF sets cookie
3. BFF redirects to `/oauth/callback?accessToken=...&user=...` (short-lived GET param, not stored)
4. `/oauth/callback` page reads params, stores in `authStore`, clears URL params, navigates to destination

**Apple Sign-In:** Same as Google, with Apple's OAuth provider.

## 9.4 Logout Flow

1. Call BFF `/api/auth/logout` (BFF clears the HttpOnly cookie)
2. Call `authStore.clearAuth()` (clears memory token)
3. Call `queryClient.clear()` (clears all cached server data — prevents data leakage)
4. Navigate to `/`

## 9.5 Protected Route Enforcement

**Server-side (AppLayout RSC):**

- Reads session from cookie using `cookies()` from `next/headers`
- If no valid session: `redirect('/login?redirect=' + pathname)`
- If valid: renders children with user passed as prop

**Client-side (secondary guard):**

- `AuthProvider` checks `authStore.isAuthenticated` after `isLoading = false`
- If unauthenticated on a page that should be protected: navigate to `/login`
- This is a secondary guard only — the server-side check is primary

## 9.6 Permissions / Plan-Gating

Plan-based feature access is checked using a `usePlanGate` hook:

```
usePlanGate('download-pdf') → { allowed: boolean, requiredPlan: 'paid' | 'subscription' }
```

The hook reads from `authStore.user.plan`. When `allowed = false`:

- Render the feature with a lock overlay
- Clicking the locked feature opens the upgrade modal

The feature is **visible but locked**, not hidden. This is intentional — users see what they can get by upgrading.

---

# 10. WebSocket & SSE Strategy

## 10.1 Architecture

The generation progress screen uses a hybrid real-time strategy: **Server-Sent Events (SSE) as primary**, with **polling fallback** when SSE is unavailable or disconnected.

```
Browser
  │
  ├─── SSE: GET /api/books/{bookId}/events (EventSource)
  │         ↓
  │    BFF proxies to NestJS WebSocket gateway → Redis pub/sub
  │
  └─── Polling fallback: GET /api/books/{bookId}/status every 5s
                         (activated when SSE disconnects or is unavailable)
```

The NestJS backend uses Socket.io for server-to-server real-time. The BFF converts Socket.io events into SSE for the browser, avoiding the complexity of Socket.io client in the frontend bundle.

## 10.2 useGenerationStatus Hook

This hook is the single interface for generation progress in the frontend:

```
useGenerationStatus(jobId: string) → {
  status: BookStatus
  progress: number           // 0–100
  currentStep: string
  completedSteps: string[]
  partialCoverUrl?: string   // set at 40% progress
  error?: string
}
```

**Internally:**

1. Opens an `EventSource` to `/api/books/${jobId}/events`
2. On each message: updates local state
3. On SSE error/close: starts polling at 5-second intervals via React Query
4. On polling response showing final state: stops polling, switches back to SSE attempt
5. On generation complete: calls `queryClient.invalidateQueries(queryKeys.books.detail(bookId))` to hydrate the final book data

## 10.3 SSE Reconnect Strategy

- On connection error: wait 3 seconds, reconnect (browser `EventSource` auto-reconnects with exponential backoff after 3 retries)
- After 3 failed reconnect attempts: fall back to polling permanently for that session
- Show user feedback after 30 seconds of no updates: "Still working on it..."
- Max generation timeout: 10 minutes, as defined in backend architecture

## 10.4 Multiple Tab Behavior

If the user has the generation screen open in two tabs:

- Both tabs independently connect to SSE
- Both receive the same events (SSE is broadcast from the backend)
- On completion, both tabs navigate to the reveal screen

If the user has the dashboard open in one tab and the generation screen in another:

- Dashboard shows the book in "generating" state (pulsing card)
- When generation completes, the generation tab auto-navigates to the reveal
- The dashboard tab re-fetches the book list when it regains focus (`refetchOnWindowFocus: true` on the books list query)

---

# 11. Performance Strategy

## 11.1 Code Splitting

Next.js App Router provides automatic code splitting by route. No manual `React.lazy()` is needed for page-level code.

**Manual lazy loading** applies to these specific heavy components:

| Component                    | Reason                       | Bundle size approx. |
| ---------------------------- | ---------------------------- | ------------------- |
| `@react-pdf/renderer`        | PDF preview in browser       | ~600 KB             |
| `AvatarBuilder`              | Hair style grid with images  | ~200 KB assets      |
| `BookReveal` + Framer Motion | Animation-heavy; reveal-only | ~80 KB              |
| `StripeCardForm`             | Stripe Elements              | ~300 KB             |
| `OpenDyslexic` font          | Reader only, opt-in          | ~120 KB             |

All of the above are wrapped in `React.lazy()` + `Suspense`. The Suspense boundary nearest to the component shows a skeleton or spinner while loading.

## 11.2 Dynamic Imports

```
// PDF renderer — only loaded inside the reader when user clicks "Preview PDF"
const PDFPreview = dynamic(() => import('@/features/reader/components/PDFPreview'), {
  loading: () => <PDFPreviewSkeleton />,
  ssr: false,
})

// Avatar builder — only loaded on wizard Step 4
const AvatarBuilder = dynamic(() => import('@/features/wizard/components/AvatarBuilder'), {
  loading: () => <AvatarBuilderSkeleton />,
  ssr: false,
})

// Stripe — loaded only on checkout page
const CheckoutForm = dynamic(() => import('@/features/checkout/components/CheckoutForm'), {
  ssr: false,
})
```

## 11.3 Image Optimization

All images use Next.js `<Image>` component except where images are loaded dynamically from the CDN (book pages in reader):

**Static UI images** (illustrations, avatars): `<Image>` with `sizes` prop for responsive images.

**Book cover thumbnails** (dashboard): `<Image>` with `loading="lazy"` for off-screen cards. First 4 visible cards use `loading="eager"` (LCP optimization).

**Book page images** (reader): Direct `<img>` tags with `loading="lazy"`. Pages preload 2 pages ahead using `<link rel="prefetch">` injected into `<head>` when the user is on page N.

**CDN image URLs:** Book images are served from Cloudflare CDN. The CDN URL is constructed by `shared/utils/image.ts` helper functions. Image sizing query parameters (width, quality) are appended for appropriate sizes:

- Dashboard thumbnail: `?w=400&q=80`
- Reader full page: `?w=1200&q=90`
- Cover reveal: `?w=800&q=95`

**Low-Quality Image Placeholder (LQIP):** Book cover thumbnails display a blurred, 10px wide placeholder while the full image loads. The LQIP is a base64-encoded tiny image stored alongside the cover URL in the API response.

## 11.4 Prefetching

**Route prefetching:**

- All `<Link>` components in the app shell prefetch their routes on hover/focus (Next.js default)
- The `/create` route is prefetched on landing page hero CTA render (100% of users will click it)

**Data prefetching:**

- On dashboard mount: prefetch book detail queries for the first 4 visible book cards
- On wizard Step 5 (Dedication): prefetch the story summary to avoid wait on Preview screen
- On book card hover (400ms): prefetch the full book data for the reader

**Font prefetching:**

- Fraunces and Plus Jakarta Sans are preconnected and prefetched in `<head>`
- Lora (book font) is lazy-loaded; it is only fetched when the reader mounts

## 11.5 Caching Headers

Next.js serves pages with these cache policies:

| Content                   | Cache-Control                                 |
| ------------------------- | --------------------------------------------- |
| Static marketing pages    | `s-maxage=3600, stale-while-revalidate=86400` |
| API route responses (BFF) | `no-store` (contains auth-gated data)         |
| Static assets (JS, CSS)   | `max-age=31536000, immutable`                 |
| Next.js page RSC payloads | `no-store` for authed routes                  |

CDN (Cloudflare) caches:

- Book PDFs: `max-age=31536000, immutable` (content-addressed by bookId)
- Book page images: `max-age=2592000` (30 days)
- Cover thumbnails: `max-age=2592000`

## 11.6 Virtualization

The dashboard book grid is **not** virtualized at launch. A typical user has fewer than 50 books; DOM overhead is negligible at that scale.

**When to add virtualization:** If analytics shows any user reaching 200+ books and experiencing scroll jank. At that point, add `@tanstack/react-virtual` to the book grid. The grid uses CSS Grid, which maps cleanly to react-virtual's grid virtualization.

## 11.7 Bundle Optimization

**Critical rules:**

- No lodash (use native methods)
- No moment.js (date-fns with tree-shaking)
- Lucide icons imported individually: `import { BookOpen } from 'lucide-react'` — never `import * from 'lucide-react'`
- Framer Motion: use `m` from `framer-motion/m` (lazy motion) for animation-heavy pages to defer loading the full Framer Motion bundle
- Analyze bundle weekly during development with `next build && npx @next/bundle-analyzer`

**Target bundle sizes (gzipped):**

- First load JS (landing page): < 120 KB
- First load JS (app shell): < 200 KB
- Reader chunk (lazy): < 150 KB
- PDF renderer chunk (lazy): < 250 KB

## 11.8 React Suspense Strategy

Suspense boundaries are placed at the feature level, not the component level. Each major feature has one Suspense wrapper that shows a skeleton matching the feature's layout while data loads:

```
<Suspense fallback={<DashboardSkeleton />}>
  <DashboardPage />          // SSR with streaming
</Suspense>

<Suspense fallback={<ReaderSkeleton />}>
  <BookReader />             // Lazy; shows skeleton while bundle loads
</Suspense>
```

Avoid nested Suspense boundaries that cause waterfall loading. Data fetching is kicked off at the highest possible level (parent page RSC) and streamed down to child components.

---

# 12. Accessibility

## 12.1 Implementation Contract

WCAG 2.1 AA is the minimum. Every component ships accessible or it does not ship. Accessibility is validated at three levels: automated (CI), manual (keyboard + screen reader testing), and visual (color contrast checks).

## 12.2 Keyboard Navigation

**Global keyboard conventions:**

- `Tab` / `Shift+Tab`: focus forward/backward through interactive elements
- `Enter`: activate focused button or link; submit form
- `Space`: toggle focused checkbox, switch, or button
- `Escape`: close active modal, drawer, dropdown, or fullscreen mode
- Arrow keys: navigate within composite widgets (TagPicker, ThemeCardGrid, NumberStepper)

**Focus trap implementation:**
All modals, drawers, and bottom sheets implement focus trapping. When a modal opens:

1. Focus moves to the first focusable element inside the modal
2. `Tab`/`Shift+Tab` cycle within the modal only
3. When modal closes, focus returns to the element that triggered it

Use a shared `useFocusTrap` hook that handles this with `focusTrap.js` under the hood, wrapping it in an abstraction to avoid library lock-in.

**Reader keyboard map:**

| Key    | Action                         |
| ------ | ------------------------------ |
| `← →`  | Previous / Next page           |
| `Home` | First page                     |
| `End`  | Last page                      |
| `F`    | Toggle fullscreen              |
| `B`    | Bookmark current page          |
| `D`    | Open download modal            |
| `S`    | Open share modal               |
| `Esc`  | Exit fullscreen / close reader |

**TagPicker keyboard:**

- Tags are rendered as `role="checkbox"` in a `role="group"` `<fieldset>`
- `Tab` moves between tags
- `Space` toggles selection
- Arrow keys navigate between tags (grid navigation)

## 12.3 ARIA Requirements

**Landmarks on every page:**

```html
<header role="banner"></header>
<nav role="navigation" aria-label="Main navigation"></nav>
<main role="main"></main>
<footer role="contentinfo"></footer>
```

**Wizard step ARIA:**

```html
<form role="form" aria-label="Book creation wizard, step {n} of 5">
  <h2 id="step-title">Tell us about {childName}</h2>
  <fieldset aria-labelledby="step-title">
    <!-- step fields -->
  </fieldset>
</form>
```

**Generation progress:**

```html
<div role="progressbar"
     aria-valuenow={progress}
     aria-valuemin="0"
     aria-valuemax="100"
     aria-label={`Creating ${childName}'s book, ${progress}% complete`}>
```

**Live regions:**

```html
<!-- Stage label updates — polite (doesn't interrupt) -->
<div aria-live="polite" aria-atomic="true">{stageLabelText}</div>

<!-- Error messages — assertive (interrupts immediately) -->
<div role="alert" aria-live="assertive">{errorMessage}</div>

<!-- Toast notifications — status -->
<div role="status" aria-live="polite">{toastMessage}</div>
```

## 12.4 Focus Management Rules

| Trigger                 | Focus moves to                                         |
| ----------------------- | ------------------------------------------------------ |
| Modal opens             | First focusable element in modal, or modal heading     |
| Modal closes            | Element that triggered the modal                       |
| Wizard step transition  | H2 heading of the new step                             |
| Form submit with errors | First input with an error                              |
| Toast appears           | Toast does NOT receive focus (announced via aria-live) |
| Book page turns         | Hidden `aria-live` region announcing page text         |
| Dropdown opens          | First option in dropdown                               |
| Dropdown closes         | Trigger button                                         |

## 12.5 Color and Visual

**All color usage follows the Design System's verified contrast ratios.** No exceptions for "design reasons."

Focus rings:

```css
/* Applied globally in globals.css */
:focus-visible {
  outline: none;
  box-shadow:
    0 0 0 2px var(--color-bg-base),
    0 0 0 5px rgba(101, 53, 224, 0.35);
}
```

Note `:focus-visible` not `:focus` — prevents focus ring on mouse click.

**Reduced motion:**

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

For JavaScript-driven animations (Framer Motion, book reveal), check at component level:

```typescript
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
```

Framer Motion's `useReducedMotion()` hook is used within animated components.

## 12.6 Screen Reader Support for the Book Reader

The book reader presents text alongside illustrations. Screen reader users need both:

1. **Page text:** Each page has its full text content in a visually-hidden `<div>` that screen readers can access: `<div className="sr-only" aria-label="Page {n} text">{pageText}</div>`
2. **Illustration descriptions:** Each illustration is wrapped in `<figure>` with `<figcaption>` containing the AI-generated alt text
3. **Page turn announcements:** An `aria-live="polite"` region announces the new page text when the page turns
4. **Text reader mode:** A toggle in the reader toolbar switches to a plain-text view (no illustrations, large font, high contrast) for users who prefer it

---

# 13. Error Boundaries

## 13.1 Error Boundary Architecture

Error boundaries are placed at **zone boundaries and feature boundaries**, not around individual components.

```
Root (global-error.tsx)          ← Catches layout crashes; minimal recovery UI
│
├── PublicLayout ErrorBoundary   ← Marketing page errors; friendly page with retry
├── AppLayout ErrorBoundary      ← App shell errors; preserves nav, shows error in content area
├── WizardLayout ErrorBoundary   ← Wizard errors; shows error + option to save progress and exit
│
└── Feature-level Boundaries:
    ├── BookReader ErrorBoundary ← Reader crashes show friendly message, preserve library access
    ├── Dashboard ErrorBoundary  ← Library load failure; shows empty state with retry
    └── Generation ErrorBoundary ← Generation failure with "Try Again" (preserves wizard inputs)
```

## 13.2 Next.js Error Files

| File                     | Scope                        | Behavior                                                     |
| ------------------------ | ---------------------------- | ------------------------------------------------------------ |
| `app/global-error.tsx`   | Root layout crash            | Renders minimal HTML (no layout); "Reload page" button only  |
| `app/error.tsx`          | All unhandled errors in app  | Renders within the active layout; shows error UI with retry  |
| `app/(app)/error.tsx`    | Errors in authenticated zone | Shows app header + error content + "Go to Dashboard" button  |
| `app/(wizard)/error.tsx` | Wizard zone errors           | Shows "Your progress is saved. Go back to Dashboard?" option |
| `app/not-found.tsx`      | 404 (not-found() called)     | Friendly 404 illustration + search + popular links           |

## 13.3 Error Classification and User Messaging

| Error Class               | User Message Strategy                                       | Recovery Action                          |
| ------------------------- | ----------------------------------------------------------- | ---------------------------------------- |
| Network error (offline)   | "You're offline. Check your connection."                    | Auto-retry on reconnect                  |
| 401 Unauthorized          | "Please sign in to continue." (handled by auth interceptor) | Redirect to login                        |
| 403 Forbidden (plan gate) | "This feature requires [plan name]."                        | Upgrade CTA                              |
| 404 Not Found             | "This page doesn't seem to exist."                          | Go to Dashboard / Go Home                |
| 422 Validation Error      | Inline field error messages                                 | Fix the field                            |
| 429 Rate Limited          | "You're doing that too fast. Please wait a moment."         | Retry after delay                        |
| 500 Server Error          | "Something went wrong on our end. We've been notified."     | Try again + status page link             |
| Generation failure        | E02 from PRD error catalog                                  | "Try Again" button with preserved inputs |
| Payment declined          | E07 from PRD                                                | Re-enter card / try another              |

Error messages are **never** raw API error strings. Every error code maps to a localized, human-readable message string in `shared/constants/errorMessages.ts`.

## 13.4 Toast vs. Modal vs. Inline vs. Page Error Rules

| Severity | Error Type                                | UI Treatment                               |
| -------- | ----------------------------------------- | ------------------------------------------ |
| Low      | Transient (copy failed, image load)       | Toast (auto-dismiss, 4s)                   |
| Low      | Form field validation                     | Inline below field                         |
| Medium   | Action failed (share failed, save failed) | Toast (with retry action)                  |
| Medium   | Persistent warning (plan limit near)      | Banner below header                        |
| High     | Payment failure                           | Modal (blocks action, requires resolution) |
| High     | Feature access denied                     | Upgrade modal                              |
| Critical | Generation failed                         | Full-screen error state                    |
| Critical | Page crash (ErrorBoundary)                | Full-page error within layout              |

---

# 14. Testing Strategy

## 14.1 Testing Pyramid

```
         ▲  E2E (Playwright)
        ▲▲▲  Visual Regression (Playwright)
      ▲▲▲▲▲  Integration (Testing Library)
    ▲▲▲▲▲▲▲  Component (Testing Library)
  ▲▲▲▲▲▲▲▲▲  Unit (Vitest)
```

## 14.2 Unit Tests (Vitest)

**What to test:**

- Utility functions (`shared/utils/*`)
- Zod schema validation (all wizard step schemas)
- Store reducers (Zustand store action functions)
- Service function input/output transformation (using MSW for mocked API)
- `useReducedMotion`, `useDebounce`, and other pure hooks

**Tools:** Vitest, `@testing-library/react-hooks`, MSW (Mock Service Worker)

**Coverage target:** 90% on `shared/utils`, 80% on store logic, 70% on service functions.

**Run command:** `pnpm test:unit`

## 14.3 Component Tests (Vitest + Testing Library)

**What to test:**

- All design system primitives in `shared/components/ui/`
- Complex feature components: `WizardProgressBar`, `TagPicker`, `BookCard`, `NumberStepper`
- Modal and focus trap behavior
- Toast queue behavior
- Form validation display (not submission)
- Keyboard interaction for custom widgets

**Approach:** Render the component in isolation. Use Testing Library's accessibility-first queries (`getByRole`, `getByLabelText`). Assert on visible text, ARIA states, and DOM structure — not implementation details.

**Do not test:**

- CSS classes (fragile, tests design not behavior)
- Internal state of components
- Whether `useState` was called

**Run command:** `pnpm test:components`

## 14.4 Integration Tests (Vitest + Testing Library + MSW)

**What to test:**

- Wizard flow: completing steps 1–5, draft persistence, back navigation
- Authentication flow: login, logout, session restore
- Dashboard library: filtering, sorting, search
- Reader: page navigation, keyboard shortcuts, paywall behavior
- Checkout: form submission, error handling

**Approach:** Render feature components with real stores (not mocked). Mock only the API layer via MSW. Assert on user-visible outcomes.

**MSW setup:** `src/__mocks__/msw/handlers.ts` defines all API mock handlers. Tests can override specific handlers for error scenarios.

**Run command:** `pnpm test:integration`

## 14.5 E2E Tests (Playwright)

**Golden paths to test:**

| Test                           | Description                                                     |
| ------------------------------ | --------------------------------------------------------------- |
| `wizard-happy-path.spec.ts`    | Guest → wizard steps 1–5 → auth modal → redirect to /generating |
| `generation-to-reveal.spec.ts` | Monitor generation screen → auto-navigate to reveal             |
| `reader-navigation.spec.ts`    | Open book → page navigation → keyboard → paywall                |
| `dashboard-library.spec.ts`    | Books grid → search → filter → sort                             |
| `auth-flow.spec.ts`            | Signup → email verify → login → logout                          |
| `checkout-flow.spec.ts`        | Upgrade prompt → checkout → success                             |
| `settings-profile.spec.ts`     | Edit profile → autosave                                         |

**Environment:** Tests run against a staging environment with seeded test data. Never against production.

**Run command:** `pnpm test:e2e`

## 14.6 Visual Regression (Playwright)

Playwright screenshots are taken for:

- All design system components in all variants and states
- All responsive breakpoints for key pages (landing, dashboard, reader, wizard)
- Dark mode vs. light mode (when dark mode ships)

Screenshots are compared to a baseline using Playwright's `expect(page).toHaveScreenshot()`. Diffs larger than 0.5% fail the CI check.

**Run command:** `pnpm test:visual`

**Baseline update workflow:** When a visual change is intentional, run `pnpm test:visual --update-snapshots` and commit the new baseline screenshots alongside the code change.

## 14.7 CI Gate

All PRs must pass:

1. TypeScript type check (`pnpm typecheck`)
2. ESLint (`pnpm lint`)
3. Unit tests (`pnpm test:unit`)
4. Component tests (`pnpm test:components`)
5. Integration tests (`pnpm test:integration`)
6. Build (`pnpm build`)
7. Accessibility check with axe-core on critical flows

E2E and visual regression run on merge to main (not on every PR, to keep CI fast).

---

# 15. Internationalization

## 15.1 i18n Library

**`next-intl`** is the i18n library. It integrates natively with Next.js App Router, supports RSC, and has a clean API for message formatting.

## 15.2 Architecture

**URL structure:** Locale prefix is optional for English (default), required for others:

- `/` — English (default, no prefix)
- `/es/` — Spanish
- `/fr/` — French
- `/de/` — German
- `/pt-br/` — Portuguese (Brazil)

This is implemented via Next.js middleware (`middleware.ts`) that reads the user's preferred locale from:

1. URL prefix (if present)
2. Accept-Language header (for first-time visitors)
3. Saved locale preference in `authStore.user.locale` (for authenticated users)

## 15.3 Message Files

```
src/
  messages/
    en.json
    es.json
    fr.json
    de.json
    pt-br.json
```

Messages are namespaced by feature:

```json
{
  "wizard": {
    "step1": {
      "title": "Tell us about {childName}",
      "namePlaceholder": "First name"
    }
  },
  "reader": {
    "paywall": {
      "headline": "The adventure continues here!",
      "cta": "Get the full book ({price})"
    }
  },
  "errors": {
    "E02": "Something went wrong while creating {childName}'s book."
  }
}
```

**Rules:**

- No hardcoded English strings anywhere in component code
- Always use the child's name via interpolation: `t('wizard.step1.title', { childName })` not `"Tell us about " + childName`
- Currency and date formatting always use `Intl.NumberFormat` and `Intl.DateTimeFormat` with the active locale

## 15.4 RTL Support

RTL (for future Arabic/Hebrew support) is handled via Tailwind's RTL plugin and CSS logical properties:

- `ml-4` (margin-left) is replaced by `ms-4` (margin-start) in all components
- `text-left` is replaced by `text-start`
- The `dir` attribute on `<html>` is set by next-intl based on locale
- Framer Motion animations that use `x` transforms use a `rtlMultiplier` helper to reverse direction in RTL

## 15.5 Book Content vs. UI Language

The book's story language (selected in wizard Step 5) is independent from the app UI language. A user in a German UI can create a book in English. These are separate settings:

- UI language: stored in `authStore.user.locale`, applied to next-intl
- Book language: stored in wizard draft `step5.language`, sent to the API as `language` field in the `CreateBookRequest`

---

# 16. Environment Configuration

## 16.1 Environment Variables

All environment variables are typed via `src/env.ts` using Zod validation. The app will fail to start if required variables are missing or malformed.

```
# Public (exposed to browser via NEXT_PUBLIC_ prefix)
NEXT_PUBLIC_API_BASE_URL        BFF base URL
NEXT_PUBLIC_STRIPE_PUBLIC_KEY   Stripe publishable key
NEXT_PUBLIC_ANALYTICS_KEY       Analytics write key
NEXT_PUBLIC_APP_URL             Canonical app URL (for OG tags, sharing)
NEXT_PUBLIC_CDN_URL             Cloudflare CDN base URL for assets

# Private (server-side only)
NESTJS_API_URL                  NestJS backend URL (BFF→NestJS calls)
NEXTAUTH_SECRET                 Secret for session cookie signing
STRIPE_SECRET_KEY               Stripe secret (webhook processing)
STRIPE_WEBHOOK_SECRET           Stripe webhook signature verification
```

## 16.2 Environments

| Environment   | Purpose                     | API Target              | Features                                               |
| ------------- | --------------------------- | ----------------------- | ------------------------------------------------------ |
| `development` | Local development           | localhost:3001 (NestJS) | All features enabled; detailed error logging           |
| `preview`     | PR preview deploys (Vercel) | Staging API             | All features; test Stripe keys                         |
| `staging`     | Pre-production testing      | Staging API             | Production-like; test AI keys; performance monitoring  |
| `production`  | Live product                | Production API          | All features; real Stripe; real AI keys; no debug info |

## 16.3 Feature Flags

Feature flags are implemented as simple environment-variable-driven constants, not a full feature flag SDK at launch:

```typescript
// shared/constants/config.ts
export const FEATURES = {
  DARK_MODE: process.env.NEXT_PUBLIC_ENABLE_DARK_MODE === 'true',
  SERIES_FEATURE: process.env.NEXT_PUBLIC_ENABLE_SERIES === 'true',
  PRINT_ON_DEMAND: process.env.NEXT_PUBLIC_ENABLE_POD === 'true',
  CLASSROOM_PACK: process.env.NEXT_PUBLIC_ENABLE_CLASSROOM === 'true',
} as const;
```

Feature flags are evaluated at build time. They cannot be toggled without a redeploy. This is acceptable for v1. When runtime feature flags are needed (A/B testing, gradual rollout), integrate with a proper feature flag service (LaunchDarkly or similar).

**Using a flag in a component:**

```tsx
{
  FEATURES.DARK_MODE && <DarkModeToggle />;
}
```

---

# 17. Frontend Security

## 17.1 XSS Prevention

**Primary defense:** React's default behavior is HTML escaping all values in JSX. As long as no `dangerouslySetInnerHTML` is used, React prevents XSS.

**`dangerouslySetInnerHTML` policy:** Forbidden unless the content is:

1. Sanitized by DOMPurify before rendering
2. Generated entirely from trusted server-side sources (e.g., pre-rendered markdown from blog)

User-provided content (child names, dedication text, book titles) **never** flows into `dangerouslySetInnerHTML`. These are always rendered as React children (`{value}`) or text content.

**URL parameters:** Any URL-derived string that is rendered into the DOM (search queries, redirect URLs) is validated with Zod before use.

## 17.2 CSRF Prevention

The BFF's state-mutating endpoints (POST, PATCH, DELETE) use double-submit cookie validation:

- On page load, the BFF sets a `csrf-token` cookie (not HttpOnly)
- Client reads this cookie via JavaScript and includes it in request headers as `X-CSRF-Token`
- BFF validates that the header matches the cookie
- The refresh token endpoint is protected by the `SameSite=Strict` cookie attribute

## 17.3 Content Security Policy (CSP)

CSP headers are set in `next.config.ts`:

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'nonce-{SERVER_NONCE}' https://js.stripe.com;
  style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
  font-src 'self' https://fonts.gstatic.com;
  img-src 'self' data: blob: https://cdn.storyme.app;
  connect-src 'self' https://api.stripe.com wss://realtime.storyme.app;
  frame-src https://js.stripe.com;
  object-src 'none';
  base-uri 'self';
  form-action 'self';
```

Stripe Elements requires `script-src 'unsafe-eval'` as a known limitation of Stripe's SDK. This is an accepted exception.

Nonces are generated per-request in `middleware.ts` and injected into the `_document` for inline scripts.

## 17.4 Secure Storage

**What is stored where:**

| Data                             | Storage                | Reason                                     |
| -------------------------------- | ---------------------- | ------------------------------------------ |
| Access JWT                       | Zustand (memory only)  | Never persisted; cleared on tab close      |
| Refresh token                    | HttpOnly Secure cookie | Inaccessible to JavaScript                 |
| Wizard draft                     | localStorage           | Non-sensitive; cleared after book creation |
| User preferences (locale, theme) | localStorage           | Non-sensitive                              |
| Reading position                 | API (server)           | Synced across devices; cleared on delete   |

**Never stored:**

- Passwords (never handled client-side at all — auth is OAuth + email link)
- Credit card details (handled by Stripe Elements, never touch our code)
- Access tokens in localStorage or sessionStorage
- Full user profile in localStorage

## 17.5 Input Sanitization

User inputs collected in wizard forms are:

1. Validated at the client by Zod schemas before submission
2. Re-validated at the BFF layer before forwarding to NestJS
3. Re-validated at the NestJS layer with its own Zod/class-validator schemas

Client-side validation is for UX (instant feedback), not for security. Server-side validation is the security boundary.

**Prompt injection defense:** User inputs that flow into AI prompts (child's name, interests, dedication) are sanitized at the NestJS layer before insertion into LLM prompts. The frontend sends raw user input — it does not attempt to sanitize for LLM injection (that is the backend's concern).

## 17.6 Dependency Security

- `pnpm audit` runs in CI; any high-severity vulnerability blocks the build
- Dependabot is enabled for automated security patch PRs
- Production bundle is analyzed for suspicious package inclusion

---

# 18. Analytics

## 18.1 Analytics Architecture

Analytics are abstracted behind a single interface in `shared/lib/analytics.ts`. This prevents vendor lock-in and makes analytics calls testable.

```typescript
// shared/lib/analytics.ts
interface AnalyticsEvent {
  name: string;
  properties?: Record<string, string | number | boolean>;
}

export function track(event: AnalyticsEvent): void;
export function identify(userId: string, traits: Record<string, unknown>): void;
export function page(name: string, properties?: Record<string, unknown>): void;
```

The implementation behind this abstraction is Segment (Phase 1). Segment routes events to Mixpanel (product analytics) and GA4 (marketing analytics). Swapping the analytics provider requires changing only `analytics.ts`.

## 18.2 Event Taxonomy

All events follow this naming convention: `{noun}_{verb}` (e.g., `book_created`, `page_viewed`, `paywall_shown`).

**Critical funnel events (must fire with 100% reliability):**

| Event                       | Properties                                                      | Trigger                          |
| --------------------------- | --------------------------------------------------------------- | -------------------------------- |
| `page_viewed`               | `{ pageName, locale }`                                          | Every route change               |
| `wizard_started`            | `{ source: 'landing' \| 'dashboard' }`                          | Wizard step 1 mount              |
| `wizard_step_completed`     | `{ step: 1-5, timeOnStep }`                                     | Each step Continue click         |
| `wizard_abandoned`          | `{ step, dataEntered }`                                         | Exit wizard confirmation         |
| `auth_modal_opened`         | `{ source: 'wizard_preview' }`                                  | Auth wall shown                  |
| `auth_completed`            | `{ method: 'google' \| 'apple' \| 'email', isNewUser }`         | Successful auth                  |
| `book_generation_started`   | `{ bookLength, theme, language }`                               | Job ID received from API         |
| `book_generation_completed` | `{ durationMs, pageCount }`                                     | Status → complete                |
| `book_generation_failed`    | `{ step, errorCode }`                                           | Status → failed                  |
| `book_reveal_viewed`        | `{ timeToReveal }`                                              | Reveal animation starts          |
| `book_opened`               | `{ source: 'reveal' \| 'dashboard' \| 'share_link' }`           | Reader mounts                    |
| `paywall_shown`             | `{ bookId, page }`                                              | Paywall overlay renders          |
| `paywall_cta_clicked`       | `{ plan: 'single' \| 'subscription' }`                          | Paywall button clicked           |
| `checkout_started`          | `{ plan, source }`                                              | Checkout page mounts with intent |
| `payment_submitted`         | `{ plan, method }`                                              | Submit clicked                   |
| `payment_succeeded`         | `{ plan, revenue }`                                             | Stripe webhook confirms          |
| `payment_failed`            | `{ errorCode }`                                                 | Stripe decline                   |
| `pdf_download_initiated`    | `{ resolution: 'screen' \| 'print' }`                           | Download button clicked          |
| `book_shared`               | `{ method: 'link' \| 'instagram' \| 'whatsapp' \| 'facebook' }` | Share action completed           |

## 18.3 Analytics Provider

The `AnalyticsProvider` component (`shared/providers/AnalyticsProvider.tsx`):

- Initializes the analytics SDK once on app mount
- Calls `page()` on every route change via `usePathname()` effect
- Calls `identify(userId, traits)` when `authStore.user` changes (login/signup/logout)
- On logout: calls `analytics.reset()` to clear the identity

## 18.4 Performance Monitoring

**Core Web Vitals** are tracked via Next.js's built-in `reportWebVitals()` function, forwarded to the analytics abstraction as custom events.

**Custom performance events:**

- `time_to_first_book_visible`: time from dashboard mount to first book card render
- `time_to_wizard_interactive`: time from clicking "Create Your Book" to Step 1 being interactive
- `reader_page_load_time`: time for each book page image to load in the reader
- `generation_completion_time`: total seconds from job creation to completion

---

# 19. Coding Standards

## 19.1 TypeScript Rules

- `strict: true` in `tsconfig.json` — non-negotiable
- Zero `any` in production code. Use `unknown` and narrow it. If a library forces `any`, create a typed wrapper
- Type inference is preferred over explicit annotation when the type is obvious from context (function return types are the exception — always annotate)
- Enums are forbidden. Use `const` objects with `as const` or union types instead
- Optional chaining (`?.`) is required; nullish coalescing (`??`) is required. No `x && x.y` patterns
- `unknown` over `any` for external data at boundaries. Narrow with Zod before use.

## 19.2 File Naming

| What              | Convention                     | Example                     |
| ----------------- | ------------------------------ | --------------------------- |
| React components  | PascalCase                     | `BookCard.tsx`              |
| Custom hooks      | camelCase, `use` prefix        | `useReaderKeyboard.ts`      |
| Utility functions | camelCase                      | `formatDate.ts`             |
| Zustand stores    | camelCase, `Store` suffix      | `wizardStore.ts`            |
| Service files     | camelCase, `service` suffix    | `books.service.ts`          |
| Test files        | Same name + `.test` or `.spec` | `BookCard.test.tsx`         |
| Schema files      | camelCase, `schema` suffix     | `wizard.schema.ts`          |
| Type files        | camelCase, `types` suffix      | `ui.types.ts`               |
| Constants         | camelCase                      | `queryKeys.ts`, `routes.ts` |
| Index barrels     | `index.ts` always              | `index.ts`                  |

## 19.3 Component Conventions

**File structure within a component file:**

1. Imports (external → internal → types)
2. Types and interfaces for this component only
3. Constants local to the component
4. The component function (exported)
5. Sub-components used only by this component (not exported)
6. `export default ComponentName` at the bottom (or named export, consistently)

**Props interfaces:**

- Named `ComponentNameProps`, not `Props`
- Extended from appropriate HTML element when wrapping HTML: `interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>`
- Optional props get `?`, never `| undefined` explicitly

**Component size rule:** If a component exceeds 200 lines, split it. The split should follow logic boundaries, not arbitrary line counts. A 250-line component with a clear internal structure is better than two 120-line components with tight coupling.

**No anonymous default exports.** Always name your component:

- ✓ `export default function BookCard() {}`
- ✗ `export default () => {}`

## 19.4 Hook Conventions

- All hooks start with `use`
- Hooks that wrap a single `useState` pair are not worth extracting (avoid over-abstraction)
- Hooks that combine multiple pieces of state + effects + callbacks are good extraction candidates
- A hook always returns an object (not a tuple) unless it is a direct analog of a primitive React hook

## 19.5 Import Conventions

Import order is enforced by ESLint (eslint-plugin-import + prettier-plugin-sort-imports):

1. React and React-related (`react`, `react-dom`, `next/*`)
2. External packages (alphabetical)
3. Monorepo packages (`@storyme/*`)
4. Internal absolute imports (`@/shared/*`, `@/features/*`)
5. Relative imports (`./`, `../`)
6. Type-only imports (`import type ...`)

**Absolute import paths** use `@/` alias configured in `tsconfig.json`:

- `@/features/wizard/components/WizardStep`
- `@/shared/components/ui/Button`
- `@/shared/utils/cn`

No relative paths that traverse more than one directory up: `../../..` is a sign that the module should be moved or the import path restructured.

## 19.6 Tailwind CSS Conventions

- Classes are applied directly in JSX via the `cn()` helper (clsx + tailwind-merge)
- Variant logic lives in a `cva()` call (class-variance-authority), not in inline ternaries
- Design tokens are mapped to Tailwind custom properties in `tailwind.config.ts` (colors, spacing, shadows, fonts)
- Never use raw pixel values in Tailwind (`text-[17px]`) when a scale value exists — use the scale
- Responsive classes always use mobile-first: `text-base md:text-lg lg:text-xl` not the reverse

## 19.7 Architecture Rules (ESLint + linting)

These rules are enforced by ESLint with `eslint-plugin-boundaries`:

1. **No cross-feature imports:** `features/reader/**` cannot import from `features/wizard/**`
2. **No upward imports:** `shared/**` cannot import from `features/**` or `app/**`
3. **No direct API calls in components:** Components may not call `fetch()` directly. Only hooks and service functions make API calls.
4. **No business logic in pages:** Page files (`app/**/page.tsx`) contain only layout composition and data fetching initiation. Business logic lives in feature components and hooks.
5. **No `any` in production code:** `@typescript-eslint/no-explicit-any` is set to `error`.
6. **No console.log in production:** All logging uses a `logger` utility that is no-op in production.

---

# 20. Future Scalability

## 20.1 Feature Flag Graduation

When the current environment-variable feature flags need runtime control (A/B testing, gradual rollout, per-user overrides), the `shared/lib/analytics.ts` abstraction pattern is duplicated for feature flags:

```typescript
// shared/lib/featureFlags.ts
export function isEnabled(flag: string): boolean;
```

The implementation migrates to LaunchDarkly, Statsig, or similar. No component code changes because they import from this abstraction, not from the SDK directly.

## 20.2 Dark Mode

The token system is already built for dark mode (see `DESIGN_SYSTEM.md §3.12`). All color values in components use CSS custom property tokens (`var(--color-text-primary)`), not raw hex values. Enabling dark mode requires:

1. Adding a `ThemeProvider` that writes `data-theme="dark"` to `<html>`
2. Adding the dark mode token overrides to `styles/tokens.css` (already designed, not yet written)
3. Adding a theme toggle to the Settings language screen

**No component changes** are required because all components already use the token layer.

## 20.3 Mobile App (React Native)

The monorepo structure prepares for a React Native app:

- `packages/types` already exports all shared types (consumed by web today, React Native tomorrow)
- `features/**/hooks/` are written with zero DOM dependencies (no `document`, `window`) where possible. Hooks with DOM dependencies are cleanly separated from hooks with pure logic.
- Zustand stores have no DOM dependencies and can be reused in React Native
- Service functions are `fetch`-based (works in React Native) with no browser-specific APIs

When the mobile app is built, it will live at `apps/mobile` in the monorepo and share `packages/types`, service function contracts, and validation schemas.

## 20.4 Micro-Frontend Readiness

The feature-based architecture maps naturally to micro-frontends if team or product scale demands it:

- Each feature in `features/` is already a candidate for extraction into its own deployable unit
- Module Federation (Webpack 5) can be configured to serve `features/reader` or `features/checkout` from separate deployments
- Shared components would need to move to a separate package (`packages/ui`) rather than `apps/web/src/shared`

This migration path is documented here as a future option, not a current goal.

## 20.5 Performance at Scale

**When the book library exceeds 200 books:** Add `@tanstack/react-virtual` to the book grid. The CSS Grid layout already supports the row/column measurements virtual scrolling needs.

**When SSE connection limits are hit:** The SSE → Redis pub/sub architecture scales horizontally. The BFF layer is stateless (it proxies to Redis). Adding BFF instances requires no frontend changes.

**When bundles grow:** The Webpack bundle analyzer runs in CI. Any chunk exceeding the established size budget fails the build, forcing intentional review before accepting the growth.

## 20.6 Analytics Scale

When events volume outgrows Segment's free tier:

- The `analytics.ts` abstraction makes provider migration painless
- All event calls in components remain unchanged
- Only the implementation inside `analytics.ts` changes

When A/B testing is needed:

- The feature flag abstraction (`featureFlags.ts`) already provides the hook for experiment assignment
- Adding experiment metadata to events is a single change in the `AnalyticsProvider`

## 20.7 Internationalization at Scale

The current `next-intl` setup with JSON message files scales to:

- Any number of locales (add a new JSON file + update middleware)
- RTL languages (Tailwind RTL + CSS logical properties already in place)
- Machine-assisted translation workflows (JSON format is compatible with all major TMS tools like Lokalise or Phrase)

When over-the-air translation updates are needed (changing copy without redeploy), message files can be fetched from a CDN at runtime rather than bundled at build time — a configuration change in `next-intl`, not a structural change.

---

## Appendix A — Component Checklist for PR Review

Before any new component is merged, the reviewer confirms:

- [ ] Component is in the correct layer (primitive / shared composite / feature)
- [ ] All color values use design token CSS variables, not raw hex
- [ ] All spacing uses Tailwind scale values, not arbitrary pixel values
- [ ] Keyboard interaction is functional and tested
- [ ] ARIA attributes are correct (role, aria-label, aria-describedby where needed)
- [ ] Focus management is correct (focus trap in modals, focus restoration on close)
- [ ] `prefers-reduced-motion` is respected for any animation
- [ ] Component has a test file covering its primary behavior
- [ ] Component is responsive (tested at 375px, 768px, and 1280px minimum)
- [ ] No cross-feature or upward imports
- [ ] No `any` type
- [ ] Loading state is handled (skeleton or spinner)
- [ ] Error state is handled (inline error or Error Boundary)
- [ ] Empty state is handled where applicable

---

## Appendix B — Environment Setup for New Engineers

```bash
# 1. Clone the monorepo
git clone git@github.com:storyme/app.git
cd app

# 2. Install dependencies
pnpm install

# 3. Copy environment file
cp apps/web/.env.example apps/web/.env.local
# Fill in the required values from the team's secret manager

# 4. Start local infrastructure (Docker)
docker compose up -d  # starts Postgres, Redis, NestJS API

# 5. Start the frontend
cd apps/web
pnpm dev

# 6. Run tests
pnpm test:unit
pnpm test:components
```

---

_Document version 1.0 — StoryMe Frontend Technical Design_
_This document is the engineering contract. Changes require RFC + approval from the Principal Frontend Architect._
