# UX Specification
## StoryMe — Interaction Design & Engineering Reference
**Version 1.0 | UX Architecture Document**
**Prepared by: Product Design & UX Architecture Team | Date: June 2026**

> This document is the single source of truth for interaction design, component behavior, navigation architecture, and responsive logic. It assumes the PRD exists and does not repeat product decisions. Its audience is senior frontend engineers and UI designers beginning implementation.

---

# Table of Contents

1. UX Principles
2. Information Architecture
3. Navigation System
4. Screen Specifications
5. Component Inventory
6. User Interactions
7. Responsive Behavior
8. Motion Specification
9. Accessibility Specification
10. UX Edge Cases
11. Analytics Events
12. Design Tokens

---

# 1. UX Principles

## 1.1 Core Philosophy

StoryMe occupies an emotional category. The child who sees themselves as a book hero, the parent who made it happen, the grandparent who gave it as a gift — these are peak emotional moments. Every UX decision must protect and amplify these moments, never interrupt or dilute them.

We borrow from three design traditions:

- **Airbnb**: Experience design that uses narrative and emotion to reduce perceived complexity
- **Linear**: Interface that disappears — keyboard-first, fast, opinionated
- **Apple**: Motion and reveal as communication — transitions that *mean* something

---

## 1.2 Principle 1 — Emotion First, Efficiency Second

In a typical SaaS product, we minimize time-to-value. In StoryMe, time-to-emotion is the metric. A user who spends 3 engaged minutes in the wizard is more invested than one who rushes through in 90 seconds. Design each screen to invite presence, not acceleration.

**Implications:**
- Wizard steps use full-screen layouts with illustration, not compact form rows
- Progress animations play fully — they are not skippable
- The reveal screen holds attention before offering any action
- Copy is warm and personal, never transactional

---

## 1.3 Principle 2 — One Primary Action Per Screen

Every screen has a single, unambiguous primary action. Secondary actions are present but visually subordinate. The user should never have to decide what to do next.

**Hierarchy rule:** Primary → Secondary → Tertiary → Destructive
**Visual weight rule:** Filled → Outlined → Text → Ghost

---

## 1.4 Principle 3 — Progressive Disclosure

Show only what is needed at the current moment. Information, options, and controls are revealed as context demands them.

- Wizard collects only what is required at each step; optional fields are collapsed or labeled "optional"
- Dashboard shows actions on hover/focus (not always visible)
- Settings surface options relevant to the user's plan
- Error messages appear inline, only after interaction

---

## 1.5 Principle 4 — Mobile-First, Desktop-Enhanced

The product is built for the parent on the couch with an iPhone. Desktop is an enhancement. Every layout decision starts from 375px and expands.

**Rule:** If a component or flow works perfectly on mobile, it works everywhere. If it only works on desktop, it is a problem.

---

## 1.6 Principle 5 — Accessibility Is a Feature, Not a Checkbox

Keyboard-only users, screen reader users, users with motor difficulties, and users with cognitive load constraints are first-class users. No feature ships without keyboard support and ARIA annotations.

---

## 1.7 Principle 6 — Friendly Microcopy

Every string a user reads is an opportunity to reinforce warmth and trust. Error messages are not error messages — they are reassurances. Empty states are not empty — they are invitations.

**Voice rules:**
- Use the child's name whenever possible: "Lily's book is ready" not "Your book is ready"
- Use "we" sparingly — prefer "your" and "you"
- Never use passive voice in errors
- Never use technical terms in user-facing copy

---

## 1.8 Principle 7 — Trust Through Transparency

Users are uploading photos of their children and paying money. Every moment of uncertainty must be resolved with clear, honest communication.

- Show what the AI will do before it does it (preview card)
- Show generation progress honestly (never fake progress)
- Show pricing without hidden fees
- Show what happens on cancellation before it happens

---

## 1.9 Principle 8 — Zero Dead Ends

Every error, empty state, and failure must offer a path forward. No screen terminates without a next action. No action fails without a recovery option.

---

# 2. Information Architecture

## 2.1 Complete Sitemap

```
storyme.app/
│
├── PUBLIC (unauthenticated)
│   ├── / ............................ Landing Page
│   ├── /how-it-works ............... How It Works
│   ├── /pricing .................... Pricing Page
│   ├── /samples .................... Sample Books Gallery
│   ├── /blog ....................... Blog (marketing)
│   ├── /about ...................... About
│   ├── /faq ........................ FAQ
│   ├── /contact .................... Contact / Support
│   ├── /gift ....................... Gift Landing Page
│   ├── /teachers ................... Educator Pack Landing
│   ├── /privacy .................... Privacy Policy
│   ├── /terms ...................... Terms of Service
│   └── /shared/:bookId ............. Public Book Viewer (no auth required)
│
├── AUTH
│   ├── /login ...................... Login
│   ├── /signup ..................... Sign Up
│   ├── /forgot-password ............ Forgot Password
│   ├── /reset-password/:token ...... Reset Password
│   ├── /verify-email/:token ........ Email Verification
│   └── /oauth/callback ............. OAuth Return Handler (Google, Apple)
│
├── WIZARD (semi-authenticated: starts without auth, wall at step 5)
│   ├── /create ..................... Wizard Entry / Step 1 (Name & Age)
│   ├── /create/world ............... Step 2 (Interests & World)
│   ├── /create/story ............... Step 3 (Theme & Setting)
│   ├── /create/look ................ Step 4 (Appearance)
│   ├── /create/dedication .......... Step 5 (Dedication)
│   ├── /create/preview ............. Preview & Confirm (auth wall)
│   └── /create/generating/:jobId ... Generation Progress
│
├── APP (authenticated)
│   ├── /dashboard .................. Dashboard / Library
│   │   └── [child filter state in URL: /dashboard?child=:profileId]
│   │
│   ├── /book/:bookId ............... Book Reader
│   │   ├── [query: ?page=N] ........ Deep link to page
│   │   └── [MODAL] Paywall Overlay
│   │
│   ├── /book/:bookId/edit .......... Book Edit (post-generation light edit)
│   │
│   ├── /series/:seriesId ........... Series Overview
│   │
│   ├── /gift ....................... Gift Purchase Flow
│   │   ├── /gift/create ............ Gift Wizard (abbreviated)
│   │   ├── /gift/details ........... Recipient Details
│   │   └── /gift/checkout .......... Gift Checkout
│   │
│   ├── /checkout ................... Upgrade / Purchase
│   │   ├── /checkout?plan=single ... Single Book Purchase
│   │   └── /checkout?plan=family ... Subscription Purchase
│   │
│   └── /settings ................... Settings Shell
│       ├── /settings/profile ....... Profile
│       ├── /settings/children ....... Child Profiles
│       │   ├── /settings/children/new     New Child Profile
│       │   └── /settings/children/:id    Edit Child Profile
│       ├── /settings/subscription .. Subscription Management
│       ├── /settings/billing ....... Billing & Invoices
│       ├── /settings/notifications . Notification Preferences
│       ├── /settings/language ...... Language & Locale
│       └── /settings/privacy ....... Privacy & Data
│
├── MODALS (rendered in-context, not full routes)
│   ├── Share Book Modal
│   ├── Download Options Modal
│   ├── Delete Book Confirmation
│   ├── Delete Account Confirmation
│   ├── Cancel Subscription Retention Modal
│   ├── Exit Wizard Confirmation
│   ├── Photo Upload / Crop Modal
│   ├── Bookmark Panel (Drawer)
│   ├── Page Thumbnail Strip (Drawer)
│   ├── Gift Book Modal
│   └── Upgrade Prompt Modal (soft paywall)
│
└── ERROR PAGES
    ├── /404 ........................ Not Found
    ├── /500 ........................ Server Error
    └── /maintenance ............... Maintenance Mode
```

---

## 2.2 Route Access Matrix

| Route Pattern | Guest | Logged-in Free | Logged-in Paid | Admin |
|---|---|---|---|---|
| `/` and public pages | ✓ | ✓ | ✓ | ✓ |
| `/create` (steps 1–4) | ✓ | ✓ | ✓ | ✓ |
| `/create/preview` | Redirect to signup | ✓ | ✓ | ✓ |
| `/create/generating` | Redirect to login | ✓ | ✓ | ✓ |
| `/dashboard` | Redirect to `/` | ✓ | ✓ | ✓ |
| `/book/:id` (preview) | Redirect to login | ✓ (pages 1-7) | ✓ | ✓ |
| `/book/:id/edit` | Redirect to login | ✗ (upgrade) | ✓ | ✓ |
| `/checkout` | Redirect to login | ✓ | ✓ | ✓ |
| `/settings/*` | Redirect to login | ✓ | ✓ | ✓ |
| `/shared/:bookId` | ✓ | ✓ | ✓ | ✓ |

---

## 2.3 URL State Management

The following UI states are persisted in the URL to support deep linking, sharing, and browser history:

| State | URL Pattern | Notes |
|---|---|---|
| Dashboard child filter | `/dashboard?child=profileId` | Persisted on filter change |
| Dashboard sort | `/dashboard?sort=oldest` | Default omitted from URL |
| Book page | `/book/:id?page=12` | Updated on every page turn |
| Settings section | `/settings/billing` | Full route, not query param |
| Wizard step | `/create/world` | Each step is a route |
| Generation job | `/create/generating/jobId` | Shareable for "email when ready" |

---

# 3. Navigation System

## 3.1 Navigation Zones

The application has three distinct navigation contexts:

1. **Public zone** — landing page, marketing pages, shared book viewer
2. **Auth zone** — login/signup/reset flows
3. **App zone** — authenticated product experience

Each zone has its own navigation shell. They never share a shell component.

---

## 3.2 App Zone — Desktop Navigation (≥1024px)

```
┌─────────────────────────────────────────────────────────────────────┐
│  [StoryMe Logo]     [Library]  [Children ▾]        [+ Create Book]  │
│                                              [?] [🔔] [Avatar ▾]    │
└─────────────────────────────────────────────────────────────────────┘
```

**Header components (left to right):**
- Logo: links to `/dashboard` when authenticated, `/` when guest
- Nav link: Library → `/dashboard`
- Nav dropdown: Children → lists child profiles + "Add Child"
- Spacer (flex-grow)
- Help icon: opens intercom / help center
- Notification bell: opens notification drawer
- Account avatar: opens account dropdown menu

**Account dropdown menu items:**
1. Profile (→ `/settings/profile`)
2. Subscription (→ `/settings/subscription`)
3. Divider
4. Sign Out

**Active state:** Nav links use an underline indicator (2px, brand color), not background highlight.

**Sticky behavior:** Header sticks to top on scroll. On reader screen, header is replaced by reader toolbar.

---

## 3.3 App Zone — Mobile Navigation (< 768px)

Mobile uses a **bottom tab bar** instead of a top header nav.

```
┌────────────────────────────────────────┐
│  [StoryMe Logo]              [Avatar]  │  ← Minimal top bar
├────────────────────────────────────────┤
│                                        │
│              [Content]                 │
│                                        │
├────────────────────────────────────────┤
│  [🏠 Library]  [✨ Create]  [⚙ Account] │  ← Bottom tab bar
└────────────────────────────────────────┘
```

**Bottom tab items:**
1. Library (house icon) → `/dashboard`
2. Create (sparkle/plus icon) → `/create` — **emphasized tab** (slightly larger icon, brand color)
3. Account (person icon) → `/settings/profile`

**Tab indicator:** Active tab uses filled icon + label below. Inactive: outlined icon, no label on smallest screens.

**Notification badge:** Shown as a red dot on the Account tab when there are unread notifications.

---

## 3.4 App Zone — Tablet Navigation (768px – 1023px)

Tablet uses the **top header** layout but with a condensed navigation:

- Logo (left)
- Hamburger menu that opens a **left drawer** with full navigation tree
- "+ Create Book" button always visible (right side)

The drawer contains:
- Child profile avatars (row)
- Library link
- Settings link
- Sign Out

---

## 3.5 Wizard Navigation

The wizard uses its own shell — no top nav, no bottom tabs.

```
┌─────────────────────────────────────────────────────┐
│  [✕ Exit]     ●──────●──────○──────○──────○         │
│              Step 1   2      3      4      5         │
└─────────────────────────────────────────────────────┘
```

**Components:**
- Exit button (top-left X): triggers exit confirmation modal
- Progress bar (top-center): shows 5 nodes, filled = completed, active = current, empty = upcoming
- Node labels: visible on desktop (Name · World · Story · Look · Dedication), icon-only on mobile
- No back button in header — Back is handled by a text link within the step content area

**Navigation rules:**
- Forward: only when current step validation passes
- Back: always allowed, no validation required
- Exit: triggers confirmation modal if any data has been entered
- Browser back button: same behavior as Back link (no browser back on step 1 — offers exit confirmation)
- Keyboard: Enter = Continue, Escape = open exit confirmation

---

## 3.6 Reader Navigation

The reader replaces the app shell entirely (full viewport).

```
┌───────────────────────────────────────────────────────────────────┐
│  [← Back]  Lily's Space Adventure  [🔖][⛶][↓][↗]  Page 4 of 24  │
└───────────────────────────────────────────────────────────────────┘
│                                                                   │
│                      [Book spread content]                        │
│                                                                   │
├───────────────────────────────────────────────────────────────────┤
│  [◀ Prev]    ████████████████░░░░░░░░░░░░░░   [Next ▶]           │
└───────────────────────────────────────────────────────────────────┘
```

**Top bar auto-hide:** Hides after 4 seconds of inactivity. Reappears on mouse move, key press, or tap.

**Back button behavior:** Returns to the previous route in history. If no history (direct link), goes to `/dashboard`.

---

## 3.7 Back Button Behavior

| Context | Back button action |
|---|---|
| Dashboard → Book Reader | Reader closes → Dashboard |
| Dashboard → Wizard | Wizard opens (not dashboard "back") |
| Wizard Step 2 → Step 1 | Step 1, data preserved |
| Wizard Step 1, back pressed | Exit confirmation modal |
| Settings sub-page | Goes to parent settings page |
| Settings → Dashboard | Back to dashboard |
| Checkout → Book | Returns to book reader |
| Generation screen | Cannot go back (shows modal: "Your book is being created — going back won't stop it") |
| Book Reader (browser back) | Goes to dashboard or previous page in history |

---

## 3.8 Deep Linking

All routes are deep-linkable. When a user follows a deep link while unauthenticated:

1. Redirect to `/login?redirect=<original-url>`
2. After login/signup: redirect to the original URL
3. Exception: `/shared/:bookId` — no auth required, always accessible

---

## 3.9 Browser Refresh Behavior

| Page | Refresh behavior |
|---|---|
| Dashboard | Reloads data from API, maintains filter state from URL |
| Wizard (any step) | Data restored from localStorage (guest) or server (logged-in) |
| Generation screen | Re-polls job status API; shows current progress |
| Book Reader | Restores to last saved page position |
| Settings | Reloads, preserves URL sub-section |
| Checkout | Reloads fresh (no payment state preserved in URL) |

---

## 3.10 Multiple Tab Behavior

- If user opens wizard in two tabs simultaneously: server-side session lock on wizard draft; second tab shows: "You have a wizard open in another tab — continue there?"
- Generation polling uses SSE (Server-Sent Events) — all open tabs receive updates
- If user completes payment in one tab while another tab shows the paywall: paywall tab detects payment via polling and auto-updates (removes paywall)

---

# 4. Screen Specifications

## Screen 01 — Landing Page (`/`)

**Purpose:** Convert visitors to wizard starters. Demonstrate emotional value in under 5 seconds.

**Entry points:** All external traffic (ads, SEO, direct, referral)

**Exit points:** CTA → `/create`, nav → `/pricing`, `/how-it-works`, `/samples`

**Components:**
- `HeroSection`: headline, subheadline, CTA button, hero media (video/gif)
- `BookCarousel`: swipeable sample books (3–5 books, auto-advance paused on hover)
- `HowItWorksSection`: 3-step visual explanation
- `TestimonialsSection`: quote cards with parent photo and name
- `PricingTeaser`: simplified plan overview with CTA
- `FAQAccordion`: 6–8 most common questions
- `Footer`: links, social, legal

**Primary action:** "Create Your Book" CTA → `/create`

**Loading state:** Page loads progressively — text renders first, then images. BookCarousel has skeleton loader.

**Responsive behavior:**
- Desktop: hero has side-by-side text + media
- Tablet: stacked, media below text
- Mobile: hero is text + CTA only (media loads lazily below fold)

**Analytics events:** `page_viewed`, `cta_clicked`, `sample_book_viewed`, `testimonial_scrolled`

---

## Screen 02 — Wizard Step 1 — Child's Name (`/create`)

**Purpose:** Begin personalization. Capture name, age, pronouns.

**Entry points:** CTA from landing, "Create New Book" from dashboard

**Exit points:** Continue → `/create/world`, Exit → confirmation modal → `/dashboard` or `/`

**Components:**
- `WizardShell` (progress bar, exit button)
- `WizardStep` wrapper (title, subtitle, illustration)
- `TextInput` (name)
- `TextInput` (nickname, optional)
- `NumberStepper` (age, range 1–12)
- `PronounSelector` (dropdown/radio)
- `ContinueButton` (primary)
- `BackLink` (disabled on step 1 — shows exit confirmation instead)

**Primary action:** Continue → validates name, proceeds to step 2

**Validation:**
- Name: required, 1–30 chars, letters + hyphens + apostrophes (supports names like O'Brien, Mary-Jane)
- Name: trim whitespace before validation
- Age: required, 1–12, integer only (stepper prevents invalid input)
- Pronouns: required (no default pre-selected — user must make an explicit choice)
- Nickname: optional, 0–20 chars

**Loading state:** None. Instant.

**Empty state:** Form starts blank except age stepper (defaults to 5 but not locked)

**Error state:**
- Name empty: inline error below field: "What's this adventurer's name?"
- Name invalid chars: "Please use letters, hyphens, and apostrophes only"
- Pronouns not selected: highlight selector with outline, show: "Please select pronouns to continue"

**Keyboard interactions:**
- Tab: Name → Nickname → Age (up/down arrows) → Pronouns → Continue
- Enter: submits if valid
- Escape: triggers exit confirmation modal

**Analytics events:** `wizard_started`, `wizard_step_1_completed`, `wizard_abandoned` (on exit)

---

## Screen 03 — Wizard Step 2 — Their World (`/create/world`)

**Purpose:** Capture interests, relationships, and personal details that will be woven into the story.

**Entry points:** Step 1 Continue

**Exit points:** Continue → `/create/story`, Back → `/create`

**Components:**
- `WizardShell`
- `TagPicker` (interests, multi-select, min 1, max 5)
- `ColorPicker` (favorite color, optional, 16-color grid)
- `TextInput` ×3 (best friend's name, pet name, favorite food — all optional)
- `TextInput` (something they're proud of — optional, 100 chars max)
- `CharacterCount` (on the "proud of" field)
- `ContinueButton`
- `BackLink` → Step 1

**TagPicker behavior:**
- 16 tags shown initially (2 rows of 8 on desktop, scrollable on mobile)
- "Show more" reveals remaining tags
- Selected tags have filled background + checkmark
- Deselect by clicking again
- When 5 selected: remaining tags dim with tooltip "You've selected the maximum (5)"

**Loading state:** None.

**Keyboard interactions:**
- Tags are keyboard navigable: Tab focuses, Space/Enter toggles selection
- Continue button at bottom, focusable via Tab

**Analytics events:** `wizard_step_2_completed`, `tags_selected` (count), `optional_fields_filled` (count)

---

## Screen 04 — Wizard Step 3 — Their Story (`/create/story`)

**Purpose:** Select narrative theme, setting, mood, and lesson.

**Entry points:** Step 2 Continue

**Exit points:** Continue → `/create/look`, Back → `/create/world`

**Components:**
- `WizardShell`
- `ThemeCardGrid` (story themes, single select, 2×4 grid on desktop, 1×N on mobile)
- `SettingCardGrid` (settings, single select, same layout)
- `MoodSelector` (3-option button group: "Exciting & Fun" / "Cozy & Warm" / "Mysterious & Magical")
- `LessonDropdown` (optional, collapsed by default with "Add a lesson (optional)" label)
- `BookLengthToggle` (Standard 24 pages / Extended 32 pages — Extended requires paid plan, shows lock icon for free users)
- `ContinueButton`
- `BackLink`

**ThemeCard anatomy:**
```
┌────────────────┐
│   [Illustration│
│    thumbnail]  │
│                │
│  Theme Title   │
│  Short desc    │
└────────────────┘
```
Selected state: border color = brand primary (3px), background tint

**LessonDropdown behavior:** Collapsed by default. Clicking "Add a lesson" expands a dropdown. Selecting a lesson shows the value and a "Remove" ×. The field label changes to "Story lesson: [selected]".

**BookLengthToggle (free user):** Extended option is visible but has a lock icon. Clicking it opens the upgrade modal.

**Validation:**
- Theme: required
- Setting: required
- Mood: optional (default = "Exciting & Fun" if not selected by the time Continue is clicked)
- Lesson: optional

**Analytics events:** `wizard_step_3_completed`, `theme_selected` (value), `setting_selected` (value)

---

## Screen 05 — Wizard Step 4 — Their Look (`/create/look`)

**Purpose:** Define the child's visual appearance for AI illustration.

**Entry points:** Step 3 Continue

**Exit points:** Continue → `/create/dedication`, Back → `/create/story`

**Components:**
- `WizardShell`
- `AppearanceModePicker`: two-tab switcher ("Upload Photo" / "Build Their Look")
- **Photo mode:** `PhotoUploadZone`, `PhotoPreview`, `RetryPhotoButton`, `AvatarAdjustmentPanel`
- **Avatar mode:** `SkinTonePicker`, `HairStyleGrid`, `HairColorPicker`, `EyeColorPicker`, `AccessoriesPicker`, `AvatarPreview`

**Photo upload flow:**
1. User drags/drops or clicks to open file picker
2. File validation (type, size) — inline error if fails
3. Upload begins → spinner on drop zone with percentage
4. Server processes → "Analyzing [Name]'s look..." (animated)
5. Success → show extracted avatar preview in `AvatarPreview`
6. User can adjust individual features in `AvatarAdjustmentPanel`
7. Failure → fallback message, switch to avatar mode

**AvatarPreview:** Live-updating illustrated character preview. Updates in real time as user adjusts features. Updates are debounced 300ms (no preview update mid-drag on color picker).

**SkinTonePicker:** 12 circular swatches arranged in 2 rows. No labels (accessible via aria-label: "Skin tone: [Fitzpatrick description]"). Selected = ring outline around swatch.

**HairStyleGrid:** 20 illustrated hair style thumbnails, 5×4 on desktop, 4×5 on mobile. Selected = border + checkmark overlay.

**Validation:**
- Photo mode: photo must be uploaded AND processed successfully
- Avatar mode: skin tone is the only required field (others have reasonable defaults)
- Continue disabled until at least skin tone selected in avatar mode

**Edge cases:**
- Photo with multiple faces: "We found more than one face — tap the one that's [Name]"
- Photo processing timeout (>15s): show "This is taking a moment..." with option to switch to avatar mode
- Very dark/very light photo: "The photo is a bit hard to see — try one with better lighting"

**Analytics events:** `wizard_step_4_completed`, `photo_uploaded`, `avatar_built`, `photo_processing_failed`

---

## Screen 06 — Wizard Step 5 — Dedication (`/create/dedication`)

**Purpose:** Add emotional final layer — from whom the book comes.

**Entry points:** Step 4 Continue

**Exit points:** Continue → `/create/preview`, Back → `/create/look`

**Components:**
- `WizardShell`
- `DedicationToggle` ("Include a dedication page" on/off — on by default)
- `DedicationTextarea` (200 char max, character count shown)
- `DedicationSuggestions` (3 template suggestions shown as clickable chips below textarea)
- `FromNameInput` (text, 50 chars, optional)
- `DedicationPreview` (live styled preview of how it appears in the book — updates on type, debounced 500ms)
- `LanguageSelector` (dropdown — book language)
- `ContinueButton`
- `BackLink`

**DedicationPreview layout:**
```
┌──────────────────────────────────┐
│                                  │
│   ❦  For my brave explorer...    │
│                                  │
│          — With love, Grandma    │
│                                  │
└──────────────────────────────────┘
```
Styled with serif font, warm background, decorative border.

**DedicationToggle = Off:** Textarea, FromName, and Preview collapse with animation (height → 0, 200ms ease-out). Suggestions also collapse.

**Suggestion chips:** Clicking replaces textarea content (with undo: "Undo" toast appears for 4 seconds).

**Validation:** All fields optional. If toggle is on, no content is required — empty dedication is valid (book just has blank dedication page).

**Analytics events:** `wizard_step_5_completed`, `dedication_written`, `book_language_selected`

---

## Screen 07 — Preview & Confirm (`/create/preview`)

**Purpose:** Create peak desire just before auth wall. Show the user what they're about to create.

**Entry points:** Wizard Step 5 Continue

**Exit points:** "Create My Book" → auth modal (if guest) or generation → `/create/generating/:jobId`; "Edit My Answers" → returns to relevant wizard step

**Components:**
- `BookCoverPreview` (animated mockup, title + child's name, style preview)
- `StorySummaryCard` (AI-generated title + 2-sentence story summary — loaded via streaming API)
- `FeatureList` ("24 illustrated pages · Print-quality PDF · Yours forever")
- `CreateButton` (primary, large: "Create [Name]'s Book")
- `EditLink` (secondary: "Change my answers")
- `AuthModal` (mounted but hidden, shown on Create click if guest)

**StorySummaryCard loading:** Streams the summary text word-by-word as the API responds. Shows a pulsing cursor while streaming. This creates a "writing in real time" effect that builds excitement.

**BookCoverPreview:** Shows a 3D-tilted book mockup. The child's name appears on the cover in the story title. Background/color matches the selected theme. NOT the final cover — this is a styled placeholder.

**Auth modal behavior:**
- Slides up from bottom on mobile (bottom sheet)
- Centered dialog on desktop
- Options: Continue with Google, Continue with Apple, Use Email
- Closing the modal returns to the preview screen (user's wizard data is preserved)
- After auth: generation begins immediately, user redirected to `/create/generating/:jobId`

**Analytics events:** `preview_viewed`, `auth_modal_opened`, `auth_completed`, `wizard_completed`

---

## Screen 08 — Generation Progress (`/create/generating/:jobId`)

**Purpose:** Make waiting feel magical and informative.

**Entry points:** Wizard completion + auth

**Exit points:** Generation complete → auto-redirect to `/book/:bookId?reveal=true`

**Components:**
- `GenerationHero` (full-screen themed illustration — based on selected setting)
- `GenerationStageLabel` (animated cycling headline)
- `GenerationProgressBar` (determinate, themed)
- `StageTimeline` (vertical step list: Writing / Designing / Illustrating / Finishing)
- `EstimatedTimeLabel` ("Ready in about 2 minutes")
- `EmailToggle` ("Email me when it's ready")
- `PartialPreview` (book cover preview, unlocked at 40% — slides up from bottom)
- `FactCarousel` (tips/fun facts at bottom, auto-advances every 6 seconds)

**Stage timeline states:**
- Upcoming: gray circle, gray label
- Active: spinning indicator + brand color circle + bold label
- Complete: checkmark circle + muted label

**Progress bar:** Determinate percentage. Never goes backwards. If backend reports slower progress, the bar pauses (doesn't regress). Cap visible progress at 95% until generation is confirmed complete.

**Estimated time:** Calculated from backend estimate. Updates every 30 seconds. Text: "About 3 minutes" → "About 2 minutes" → "About 1 minute" → "Almost ready!" → (complete → redirect).

**PartialPreview:** At 40% progress, a panel slides up from the bottom (mobile) or appears as a side card (desktop) showing the draft cover image. Copy: "Here's a first look at [Name]'s cover — the full book is almost ready..." Tapping/clicking expands the cover full-screen.

**Cannot-go-back behavior:** Browser back button shows a non-blocking toast: "Your book is still being created — you'll find it in your library." Does NOT stop generation. User is redirected to dashboard.

**SSE polling strategy:** Primary = SSE stream. Fallback = polling every 5 seconds if SSE drops. Reconnect SSE after 3 seconds if disconnected.

**Analytics events:** `generation_started`, `generation_progress` (at 25%, 50%, 75%), `generation_completed`, `email_notification_toggled`

---

## Screen 09 — Book Reveal (`/book/:bookId?reveal=true`)

**Purpose:** Maximum emotional impact. The book exists. Show it magnificently.

**Entry points:** Auto-redirect from generation completion

**Exit points:** "Open My Book" → clears `?reveal=true` param, enters reader. "Share" → share modal.

**Components:**
- `RevealOverlay` (full-viewport, themed background with particle animation)
- `RevealBookCover` (book cover flies in from center with scale + opacity animation)
- `RevealHeadline` ("[Name]'s [Title] is ready!")
- `RevealSubtext` ("You just created something no bookstore can sell.")
- `OpenBookButton` (primary, large)
- `ShareQuickButton` (secondary: "Share the magic")

**Animation sequence (total: ~2.5 seconds):**
1. 0ms: Background fades in (200ms, opacity 0→1)
2. 200ms: Particles/sparkles begin (themed: stars, bubbles, leaves, etc.)
3. 400ms: Book cover scales up from 60%→100% + fades in (600ms, ease-out-back)
4. 1000ms: Headline text appears (300ms, slide up + fade)
5. 1300ms: Subtext appears (300ms, slide up + fade)
6. 1800ms: Buttons appear (300ms, fade in)

**Sound:** Optional chime sound. Respects device silent mode. Never plays on page load — only on explicit reveal trigger.

**`prefers-reduced-motion`:** Animation sequence skipped entirely. Book cover and text appear immediately at full opacity.

**Analytics events:** `book_reveal_viewed`, `book_opened_from_reveal`, `share_clicked_from_reveal`

---

## Screen 10 — Book Reader (`/book/:bookId`)

**Purpose:** Immersive, distraction-free reading experience.

**Entry points:** Reveal, dashboard book card, share link, email link

**Exit points:** Back button → `/dashboard` (or history); close button → same as back

**Components:**
- `ReaderToolbar` (top, auto-hiding)
- `BookSpread` (desktop: 2-page spread; mobile: single page)
- `PageTurnButton` (left/right, large hit areas, visible on hover/focus)
- `ProgressBar` (bottom, scrubable)
- `PageCounter` ("Page 4 of 24")
- `ThumbnailStrip` (bottom drawer, toggle in toolbar)
- `PaywallOverlay` (appears over page 8 for free users)
- `BookmarkPanel` (right drawer on desktop, bottom sheet on mobile)

**Toolbar items (left to right):**
`[← Back] [Book Title] [🔖 Bookmark] [⛶ Fullscreen] [↓ Download] [↗ Share] [✕ Close]`

**Page turn interaction:**
- Click/tap left third of screen → previous page
- Click/tap right third of screen → next page
- Click/tap center → toggle toolbar visibility
- Swipe left → next page (mobile)
- Swipe right → previous page (mobile)
- Keyboard ← → arrows → previous/next page
- Keyboard Home → first page
- Keyboard End → last page

**Page transition animation:**
- Desktop: subtle slide (20px, 150ms ease-in-out) — pages slide in from right/left
- Mobile: swipe follows finger with rubber-band at ends

**ProgressBar scrub behavior:**
- Hover shows page number tooltip above cursor
- Click/tap jumps to that page
- Touch: drag to scrub through pages

**PaywallOverlay:**
- Appears on top of page 8 (blurs the page image beneath it)
- NOT a modal — it's an in-place overlay within the reader
- Blurred background: 8px blur, 0.6 opacity overlay
- Copy: "The adventure continues here! Get the full book to keep reading."
- Two buttons: "Get This Book ($12.99)" and "Subscribe ($9.99/mo)"
- X button in corner: closes overlay, returns to page 7 (does not grant access)

**Fullscreen mode:**
- `document.fullscreenAPI` on desktop browsers
- On mobile: hides browser chrome by scrolling to max position, sticky positioning
- Toolbar always accessible in fullscreen (auto-hide + tap to show)

**Keyboard map:**
| Key | Action |
|---|---|
| `←` / `→` | Previous / Next page |
| `Home` | First page |
| `End` | Last page |
| `F` | Toggle fullscreen |
| `Esc` | Exit fullscreen / close reader |
| `B` | Bookmark current page |
| `D` | Open download modal |
| `S` | Open share modal |

**Analytics events:** `book_opened`, `book_page_viewed` (each page), `book_completed` (last page reached), `reader_exited`, `paywall_shown`, `paywall_dismissed`

---

## Screen 11 — Dashboard (`/dashboard`)

**Purpose:** Library and control center for all books and child profiles.

**Entry points:** Top nav, bottom nav (mobile), post-purchase redirect, email links

**Exit points:** Book card → `/book/:id`, Create button → `/create`, Settings → `/settings/*`

**Components:**
- `AppHeader` (full nav header)
- `ChildProfileStrip` (horizontal scrollable row of avatar circles)
- `LibraryToolbar` (`SearchInput`, `FilterDropdown`, `SortDropdown`, view toggle grid/list)
- `BookCardGrid` / `BookCardList`
- `BookCard` (see component spec in Section 5)
- `CreateBookCard` (last item in grid, always visible)
- `EmptyState` (when no books)
- `LibrarySkeletonGrid` (loading state)

**ChildProfileStrip behavior:**
- Horizontally scrollable on overflow (no visible scrollbar; swipe on mobile)
- "All" chip at left (always visible, default selected)
- Each child shows: avatar circle (40px) + name label below
- Selected child: ring outline around avatar, name bold
- Overflow: show fade gradient at right edge when more avatars exist beyond viewport
- "+ Add Child" item at end: navigates to `/settings/children/new`

**Search behavior:**
- Debounced 300ms
- Searches: book title, child name
- URL updates: `/dashboard?q=lily` (supports direct link to search results)
- "Clear" × button appears when input is non-empty

**Filter dropdown:**
- Opens as dropdown on desktop, bottom sheet on mobile
- Sections: By Child (checkboxes), By Theme (checkboxes), By Date (date range picker), By Status (checkboxes)
- Applied filters show as chips in the toolbar (each chip has × to remove)
- "Clear all" link when any filter is active

**Sort dropdown:**
- Options: Newest (default), Oldest, A–Z by title, A–Z by child name
- Selected option shown in button label

**Grid view (default):** 4 columns desktop, 2 columns tablet, 2 columns mobile
**List view:** Single column, horizontal card layout with thumbnail left

**BookCard hover states (desktop):** Quick action buttons fade in on hover (Read, Download, Share). `...` menu always visible on mobile (no hover).

**Analytics events:** `dashboard_viewed`, `search_performed`, `filter_applied`, `book_card_clicked`

---

## Screen 12 — Settings Screens (`/settings/*`)

**Purpose:** Account management, subscription, preferences.

**Layout:**
- Desktop: 2-column layout (left: nav sidebar 240px, right: content)
- Mobile: Settings home page is a list of nav items (no sidebar); each item pushes to its sub-page

**Settings nav items:**
1. Profile
2. Children
3. Subscription
4. Billing
5. Notifications
6. Language
7. Privacy

**Sub-screen: Profile**
- `AvatarUpload` (circle upload zone, 80px)
- `TextInput` (display name)
- `TextInput` (email — disabled, with "Change email" link that sends verification)
- `PasswordChangeForm` (collapsed behind "Change password" link)
- `ConnectedAccountsList` (Google / Apple — connect/disconnect)
- `SaveButton`
- `DangerZone` section (at bottom, separated by divider): "Delete My Account"

**Sub-screen: Children**
- `ChildProfileList` (cards with avatar, name, age, book count, edit/delete actions)
- `AddChildButton` → `/settings/children/new`
- Delete: confirmation modal before delete

**Sub-screen: Subscription**
- `PlanBadge` (current plan name + status)
- `NextBillingInfo` (date + amount)
- `FeatureList` (what's included in current plan)
- `UpgradeCTA` (if on free/single-book plan)
- `CancelLink` (if subscribed) → triggers retention modal

**Sub-screen: Billing**
- `PaymentMethodCard` (masked number, expiry, edit link)
- `BillingAddressForm`
- `InvoiceList` (table: date, amount, status, download)

**Sub-screen: Notifications**
- `ToggleRow` for each notification type
- `BirthdayReminderConfig` per child (dropdown: "N days before")

**Sub-screen: Language**
- `LanguageSelector` (UI language)
- `BookLanguageSelector` (default book language, separate from UI)

**Sub-screen: Privacy**
- `DataDownloadButton` (triggers async export, email when ready)
- `DeleteAccountButton` → multi-step confirmation (see edge cases)
- `CookiePreferencesLink`

---

## Screen 13 — Checkout (`/checkout`)

**Purpose:** Complete purchase with maximum trust and minimum friction.

**Entry points:** Paywall in reader, dashboard upgrade prompt, plan selection

**Components:**
- `OrderSummaryCard` (what they're buying, features list, price)
- `PaymentMethodTabs`: Express (Apple Pay / Google Pay) | Card
- `CardForm` (Stripe Elements — number, expiry, CVC, postal code)
- `PromoCodeField` (collapsed, "Have a promo code?" link expands it)
- `LegalText` ("You'll be charged $X, cancel anytime. 30-day money-back guarantee.")
- `SubmitButton` ("Get My Book" / "Start My Subscription")
- `TrustBadges` (SSL, Stripe, money-back guarantee icons)

**Payment flow:**
1. User sees order summary
2. Apple Pay / Google Pay shown if browser supports it (above the fold)
3. Card form is below, collapsible on mobile
4. Submit → loading spinner on button, button disabled (prevents double-click)
5. Stripe confirms → success state
6. Success state: redirect to book or dashboard (depending on context)

**Loading state on submit:** Button text changes to "Processing..." with spinner. Button remains full-width, same visual weight.

**Error state:** Inline below the card form, not in a modal. Red text: "Your card was declined — please check the details or use a different card."

**Double-payment prevention:** Button disabled after first click until response received. Idempotency key sent with payment request.

**Analytics events:** `checkout_started`, `payment_method_selected`, `payment_submitted`, `payment_succeeded`, `payment_failed`

---

## Screen 14 — Shared Book Viewer (`/shared/:bookId`)

**Purpose:** Allow recipients to read a shared book without an account.

**Entry points:** Shared link (email, social, WhatsApp)

**Components:**
- `MinimalHeader` (StoryMe logo + "Create your own book" CTA link)
- `BookReader` (same as authenticated reader, but without toolbar download/bookmark)
- `ConversionBanner` (bottom of page after reading 3+ pages): "Create a personalized book for your child — free to start"
- `PrivacyNote` (if book is set to private by owner): "This book is private — request access from the owner"

**Read limit:** Shared books are fully readable (no paywall for the recipient). The paywall only applies in the authenticated app for the creator.

**Analytics events:** `shared_book_viewed`, `shared_book_completed`, `conversion_banner_clicked`

---

# 5. Component Inventory

## 5.1 Button

**Purpose:** Trigger actions.

**Variants:**

| Variant | Use | Visual |
|---|---|---|
| `primary` | Main action per screen | Filled, brand color, white label |
| `secondary` | Supporting action | Outlined, brand color |
| `ghost` | Tertiary / low-emphasis | Text only, brand color |
| `danger` | Destructive actions | Filled, error red |
| `loading` | In-progress state | Filled + spinner, disabled |

**Sizes:** `sm` (32px height) · `md` (40px, default) · `lg` (48px) · `xl` (56px, wizard CTAs)

**States:** Default · Hover · Pressed · Focused · Disabled · Loading

**Properties:**
```
Button {
  variant: 'primary' | 'secondary' | 'ghost' | 'danger'
  size: 'sm' | 'md' | 'lg' | 'xl'
  label: string
  icon?: IconName (left or right)
  iconOnly?: boolean
  loading?: boolean
  disabled?: boolean
  fullWidth?: boolean
  onClick: () => void
}
```

**Accessibility:**
- `role="button"` (if not `<button>` element — always prefer `<button>`)
- `aria-disabled="true"` when disabled (not `disabled` attribute — maintains focusability for screen reader users)
- `aria-busy="true"` when loading
- Minimum touch target: 44×44px (padding compensates for smaller visual size)

---

## 5.2 TextInput

**Purpose:** Single-line text entry.

**Variants:** Default · With label · With helper text · With character count · With icon (left/right) · Search

**States:** Empty · Filled · Focused · Error · Disabled · Read-only

**Properties:**
```
TextInput {
  label: string
  placeholder?: string
  value: string
  onChange: (value: string) => void
  error?: string
  helper?: string
  maxLength?: number
  showCount?: boolean
  disabled?: boolean
  readOnly?: boolean
  type: 'text' | 'email' | 'password' | 'number'
  icon?: IconName
  iconPosition?: 'left' | 'right'
  autoComplete?: string
  autoFocus?: boolean
}
```

**Error display:** Inline below input, red text, error icon. Input border turns error-red. Label turns error-red.

**Character count:** Right-aligned below input. Turns red when within 20 chars of limit.

---

## 5.3 Textarea

**Purpose:** Multi-line text entry (dedication, descriptions).

**States:** Same as TextInput + resizable handle (vertical only, or fixed height)

**Auto-grow:** Height expands as user types (up to a max height, then scrolls internally).

---

## 5.4 NumberStepper

**Purpose:** Increment/decrement a bounded integer value (age picker).

**Visual:**
```
[ − ]  [  7  ]  [ + ]
```

**Properties:**
```
NumberStepper {
  value: number
  min: number
  max: number
  onChange: (value: number) => void
  disabled?: boolean
  label?: string
}
```

**Accessibility:**
- `role="spinbutton"`
- `aria-valuenow`, `aria-valuemin`, `aria-valuemax`
- Arrow up/down keys work when focused on the value display

---

## 5.5 TagPicker

**Purpose:** Multi-select from a predefined list (interests).

**Anatomy:** Grid of `Tag` chips. Selected = filled background. Deselected = outlined.

**States:** Unselected · Selected · Disabled (at max selection) · Hovered

**Properties:**
```
TagPicker {
  options: Array<{ id: string, label: string, icon?: string }>
  selected: string[]
  onChange: (selected: string[]) => void
  min?: number
  max?: number
  showMoreThreshold?: number  // tags shown before "Show more"
}
```

**Keyboard:** Tags are in a `role="group"` with `role="checkbox"` on each tag. Space/Enter toggles.

---

## 5.6 ColorPicker

**Purpose:** Select a color from a predefined palette.

**Visual:** Grid of 16 circular swatches. Selected = ring outline.

**Accessibility:** Each swatch has `aria-label="[color name]"`. Selected state communicated via `aria-checked="true"`.

---

## 5.7 BookCard

**Purpose:** Display a single book in the library grid or list.

**Grid card anatomy:**
```
┌──────────────────┐
│                  │
│  [Cover image]   │  ← 3:4 aspect ratio
│                  │
│                  │
├──────────────────┤
│  Book Title      │  ← 14px, semibold, 2 lines max (truncate)
│  Lily · 24 pages │  ← 12px, muted
│  June 2026       │  ← 12px, muted
├──────────────────┤
│ [Read] [↓] [···] │  ← Action bar (hover/focus reveals)
└──────────────────┘
```

**States:** Default · Hover (action bar visible) · Loading (skeleton) · Generating (pulse animation on cover) · Error (failed state with retry icon)

**"In progress" state:** Cover shows a spinner overlay + "Creating..." label. Card is not clickable until complete.

**Properties:**
```
BookCard {
  bookId: string
  title: string
  coverUrl?: string
  childName: string
  pageCount: number
  createdAt: Date
  status: 'complete' | 'generating' | 'failed'
  isDownloaded?: boolean
  onRead: () => void
  onDownload: () => void
  onShare: () => void
  onMore: () => void
}
```

**Accessibility:**
- Card is focusable via keyboard
- Enter on card → opens reader (same as "Read" click)
- Action buttons are keyboard accessible when card is focused (Tab reveals action bar)

---

## 5.8 ThemeCard

**Purpose:** Select a story theme or setting in the wizard.

**Anatomy:**
```
┌──────────────────┐
│  [Theme image    │
│   illustration]  │
│                  │
│  Theme Name      │
│  Short desc      │
└──────────────────┘
```

**States:** Default · Hover (scale 1.02, shadow increase) · Selected (3px primary border, checkmark badge top-right) · Disabled

**Transition:** `transform 150ms ease, box-shadow 150ms ease`

---

## 5.9 WizardProgressBar

**Purpose:** Communicate position in the wizard flow.

**Visual:**
```
●────●────○────○────○
 1    2    3    4    5
Name World Story Look Dedic.
```

**States per node:** Completed (filled circle + checkmark) · Active (filled circle, pulsing ring) · Upcoming (outlined circle)

**Connector lines:** Filled (gradient, brand color) between completed nodes; gray between upcoming nodes.

**Mobile:** Labels hidden (icon or number only). Nodes slightly smaller (24px vs 32px desktop).

---

## 5.10 Modal

**Purpose:** Overlay dialog for focused interactions.

**Variants:** `sm` (400px wide) · `md` (560px) · `lg` (720px) · `fullscreen`

**Behavior:**
- Opens with fade-in + scale (0.95 → 1.0, 200ms)
- Backdrop: semi-transparent overlay, click closes modal (unless `disableBackdropClose` set)
- Escape key closes modal
- Focus trap: Tab cycles within modal only
- Scroll lock on body when open

**Anatomy:**
```
┌───────────────────────────────┐
│  Modal Title             [×]  │
├───────────────────────────────┤
│                               │
│  Modal content area           │
│                               │
├───────────────────────────────┤
│  [Secondary Action] [Primary] │
└───────────────────────────────┘
```

**Mobile:** Always full-width, bottom-aligned (bottom sheet behavior). Slides up from bottom.

**Accessibility:**
- `role="dialog"`, `aria-modal="true"`, `aria-labelledby=[title-id]`
- Focus moved to modal on open (to first interactive element or modal title)
- Focus returned to trigger element on close

---

## 5.11 Drawer (Side / Bottom)

**Purpose:** Supplementary panel for bookmarks, thumbnails, filters.

**Desktop:** Slides in from right (side drawer, 320px wide)
**Mobile:** Slides up from bottom (bottom sheet, max 80vh)

**Behavior:** Backdrop closes drawer. Escape closes drawer. Drag handle on bottom sheet (mobile).

---

## 5.12 Toast

**Purpose:** Transient non-blocking feedback.

**Position:** Bottom-center (mobile) · Bottom-right (desktop)

**Variants:** `success` · `error` · `info` · `warning`

**Duration:** 3 seconds auto-dismiss. Error toasts persist until dismissed (or max 8 seconds). Hover pauses auto-dismiss.

**Anatomy:**
```
[ Icon | Message text                        [×] ]
```

**Queue behavior:** Multiple toasts stack vertically (max 3 visible). Oldest at bottom, newest at top.

**Accessibility:** `role="status"` for success/info. `role="alert"` for errors (immediately read by screen readers).

---

## 5.13 Avatar Picker

**Purpose:** Build the child's character appearance.

**Sub-components:** `SkinTonePicker` · `HairStyleGrid` · `HairColorPicker` · `EyeColorPicker` · `AccessoryPicker`

**AvatarPreview:** 200×200px illustrated character preview. Updates live as features are selected.

**Tabs on mobile:** Because avatar picker has many sub-sections, mobile uses horizontal tabs: Skin · Hair · Eyes · Extras

---

## 5.14 GenerationProgressBar

**Purpose:** Communicate AI generation progress.

**Variants:** `linear` (default) · `themed` (animated character moving along path)

**Properties:**
```
GenerationProgressBar {
  progress: number  // 0–100
  variant: 'linear' | 'themed'
  theme: StoryTheme  // affects animation character
  estimatedSecondsRemaining?: number
}
```

**Themed variant:** For space books: rocket moves along star path. For ocean: submarine. These are SVG animations, not video.

**Regression protection:** Progress can only increase. If backend sends lower progress value, display value is not updated.

---

## 5.15 SkeletonLoader

**Purpose:** Communicate loading state for content that is loading.

**Variants:** `text` · `image` · `card` · `avatar` · `toolbar`

**Behavior:** Animated shimmer (left to right gradient sweep, 1.5s loop).

**Usage rules:**
- Use skeletons for content that takes >300ms to load
- Match skeleton dimensions to actual content dimensions
- Do not use spinners for large content areas — use skeletons

---

## 5.16 EmptyState

**Purpose:** Communicate absence of content with a clear action.

**Anatomy:**
```
        [Illustration]

    "Your library is empty"
  "Create your first book to
    start your collection."

    [ Create Your First Book ]
```

**Properties:**
```
EmptyState {
  illustration: IllustrationName
  headline: string
  subtext: string
  action?: {
    label: string
    onClick: () => void
  }
  secondaryAction?: {
    label: string
    onClick: () => void
  }
}
```

---

## 5.17 SearchInput

**Purpose:** Filter content in library.

**Behavior:**
- Expands on focus (mobile: pushes other toolbar items off-screen)
- Clear button (×) appears when value is non-empty
- Results count shown below: "Showing 3 results for 'lily'"
- Loading indicator while debounce is pending

---

## 5.18 Tooltip

**Purpose:** Contextual label for icon buttons and truncated text.

**Behavior:** Appears on hover (desktop) and long-press (mobile). Disappears after 2 seconds on touch.

**Position:** Auto-positions away from viewport edges. Preference: top → bottom → right → left.

**Accessibility:** `role="tooltip"`, referenced by `aria-describedby` on trigger.

---

## 5.19 ReaderToolbar

**Purpose:** Control bar for the book reader.

**Items:**
```
[← Back]  [Title truncated]  [🔖][⛶][↓][↗]  [Page N of M]
```

**Auto-hide:** Hides 4 seconds after last interaction. Reappears on any interaction.

**Mobile:** Title hidden (too narrow). Page counter moves to bottom progress bar.

**Download button behavior:** Opens `DownloadOptionsModal` (not inline dropdown — modal prevents accidental trigger while reading).

---

## 5.20 PaywallOverlay

**Purpose:** Gate content for free users while preserving the reading context.

**Visual:** Blurred page beneath + centered card with CTAs. NOT a full modal — rendered inside the reader viewport.

**Dismiss behavior:** × button → closes overlay → page counter rewinds to last free page (7). The page is not scrolled away — it animates back.

---

# 6. User Interactions

## 6.1 Hover States

| Element | Hover behavior | Transition |
|---|---|---|
| Button (primary) | 8% darker background | 100ms ease |
| Button (secondary) | Light background tint | 100ms ease |
| BookCard | Reveal action bar, subtle shadow increase | 150ms ease |
| ThemeCard | Scale 1.02, shadow increase | 150ms ease |
| Tag (unselected) | Border color shift, background tint | 100ms ease |
| NavLink | Underline slides in from left | 150ms ease |
| Tooltip trigger | Tooltip appears after 300ms delay | — |
| PageTurnButton | Opacity 0.5 → 1.0 | 150ms ease |

---

## 6.2 Focus States

All interactive elements have a visible focus ring when focused via keyboard:
- **Ring:** 2px solid, brand primary color, 2px offset
- **Background:** Never changes on focus alone (contrast against existing background)
- Focus ring is **never** suppressed via `outline: none` without a visible alternative
- Components use `:focus-visible` (not `:focus`) so mouse clicks don't show the ring

---

## 6.3 Pressed States

| Element | Press behavior |
|---|---|
| Button | Scale 0.97 + slightly darker, 80ms ease |
| ThemeCard | Scale 0.98, 80ms ease |
| Tag | Immediate visual toggle (no delay) |
| PageTurnButton | Scale 0.95, 80ms ease |

---

## 6.4 Loading States

**Button loading:** Text replaced with spinner + "Processing..." text. Button remains full-width, disabled. No layout shift.

**Page content loading:** Skeleton loaders match content layout exactly.

**Async actions (share link copy):** Button shows loading spinner for 300ms (even if instant) — prevents "nothing happened" perception.

---

## 6.5 Confirmation Dialogs

Used for destructive or irreversible actions. Not used for safe actions.

**Actions requiring confirmation:**
- Delete a book
- Delete a child profile
- Delete account
- Cancel subscription
- Exit wizard mid-progress

**Confirmation dialog pattern:**
- Modal, `sm` size
- Headline: plain description of what will happen ("Delete this book?")
- Body: consequences ("This cannot be undone. Your book will be removed from your library.")
- Actions: [Cancel] [Delete] — destructive action on right, styled with `danger` variant
- Keyboard: Escape = Cancel, Enter = focused action

**Subscription cancellation uses a retention modal** (not a simple confirmation — see PRD Section 10.3).

---

## 6.6 Undo Patterns

Used for:
- Replacing dedication text with a suggestion template
- Deleting a tag selection (before confirming)
- Clearing search input

**Undo toast:** Appears for 4 seconds. "Undo" link in toast re-applies previous state. After 4 seconds, action is permanent.

---

## 6.7 Retry Patterns

**Single-action retry (e.g., failed share link copy):**
- Error toast: "Couldn't copy link — try again" with "Retry" button in toast

**Generation retry:**
- Full error screen
- "Try Again" button: resubmits with same inputs (no data re-entry)
- Input data preserved in session and server draft

**Automatic retry (silent):**
- Photo upload: retry once automatically on network error
- Single page illustration failure: retry 3× silently before flagging

---

## 6.8 Animation Inventory

See Section 8 for full motion specification.

**Key interaction animations:**
| Interaction | Animation |
|---|---|
| Modal open | Scale 0.95→1.0, opacity 0→1, 200ms ease-out |
| Modal close | Scale 1.0→0.95, opacity 1→0, 150ms ease-in |
| Bottom sheet open | TranslateY 100%→0%, 250ms cubic-bezier(0.32, 0.72, 0, 1) |
| Page turn (reader) | SlideX ±20px, opacity, 150ms ease-in-out |
| Tag selection | Background fills, scale 0.97→1.0, 100ms ease-out |
| Toast appear | SlideY +8px → 0px, opacity 0→1, 200ms ease-out |
| Toast dismiss | SlideY 0 → +8px, opacity 1→0, 150ms ease-in |
| Wizard step transition | Slide left/right, 250ms ease-in-out |
| Dropdown open | Max-height 0→auto, opacity 0→1, 200ms ease-out |

---

# 7. Responsive Behavior

## 7.1 Breakpoints

| Name | Range | Target |
|---|---|---|
| `xs` | 0–374px | Small phones (SE, older Android) |
| `sm` | 375–767px | Standard phones |
| `md` | 768–1023px | Tablets (portrait & landscape) |
| `lg` | 1024–1279px | Small laptops |
| `xl` | 1280–1535px | Desktop |
| `2xl` | 1536px+ | Large/wide monitors |

**Design baseline:** `sm` (375px) is the design starting point. Components are designed at 375px and enhanced upward.

---

## 7.2 Layout Changes by Breakpoint

### Navigation

| Breakpoint | Navigation |
|---|---|
| `xs`/`sm` | Bottom tab bar (3 tabs) + minimal top bar (logo + avatar) |
| `md` | Top header + hamburger → left drawer |
| `lg`+ | Full top header with all nav items visible |

### Dashboard Grid

| Breakpoint | Columns |
|---|---|
| `xs`/`sm` | 2 columns |
| `md` | 3 columns |
| `lg` | 4 columns |
| `xl`+ | 5 columns |

### Book Reader

| Breakpoint | Layout |
|---|---|
| `xs`/`sm` | Single page, fullscreen, swipe navigation |
| `md` | Single page with visible arrows |
| `lg`+ | Two-page spread |

### Wizard

| Breakpoint | Layout |
|---|---|
| `xs`/`sm` | Full-screen step, stacked layout, no decorative illustration |
| `md` | Full-screen step, illustration visible in column |
| `lg`+ | Split: form left (50%), illustration right (50%) |

### Settings

| Breakpoint | Layout |
|---|---|
| `xs`/`sm` | Single column; settings home is a list; each section pushes new screen |
| `md`+ | Two-column: sidebar (240px fixed) + content |

### Modals

| Breakpoint | Behavior |
|---|---|
| `xs`/`sm` | Full-width bottom sheet (slides up) |
| `md`+ | Centered dialog (fixed max-width) |

---

## 7.3 Components That Collapse/Adapt

| Component | Desktop | Mobile |
|---|---|---|
| `LibraryToolbar` | All controls visible in one row | Search bar takes full width; filter/sort in overflow dropdown |
| `ReaderToolbar` | All icons visible | Title hidden; actions in `...` overflow menu |
| `ChildProfileStrip` | Horizontal scroll visible | Same, but with swipe affordance |
| `AvatarPicker` | All sections visible in tabs | Accordion-style sections |
| `DedicationPreview` | Always visible next to form | Appears in modal on "Preview" tap |
| `ThemeCardGrid` | 4 columns | 2 columns |
| `HairStyleGrid` | 5 columns | 4 columns |
| `GenerationStageTimeline` | Vertical list on right side | Hidden; stage label only |
| `FactCarousel` | Visible | Collapsed (save vertical space) |

---

## 7.4 Touch-Specific Behaviors

**Active on `sm`/`xs` only:**

| Behavior | Implementation |
|---|---|
| Bottom sheet modals | Transform instead of centered dialog |
| Swipe to turn pages | Touch event handling with velocity detection |
| Pull-to-refresh on dashboard | Native gesture → reload library |
| Long-press on BookCard | Opens action sheet (equivalent of hover action bar) |
| Swipe-to-delete on BookCard (list view) | Swipe left reveals delete button |
| Drag handle on bottom sheets | Visual affordance + touch interaction |

---

# 8. Motion Specification

## 8.1 Motion Principles

1. **Motion communicates state** — every animation tells the user something
2. **Motion respects hierarchy** — larger/more important transitions are slower
3. **Motion is restrained** — never animate for pure decoration
4. **Motion respects preferences** — all animations wrap `prefers-reduced-motion` checks

---

## 8.2 Duration Scale

| Token | Duration | Use |
|---|---|---|
| `duration-instant` | 80ms | Pressed states, immediate feedback |
| `duration-fast` | 150ms | State changes, color transitions |
| `duration-medium` | 250ms | Component enter/exit, page transitions |
| `duration-slow` | 400ms | Modal open, drawer open |
| `duration-deliberate` | 600ms | Reveal animations, book open |
| `duration-story` | 1000ms+ | Narrative animations (book reveal sequence) |

---

## 8.3 Easing Scale

| Token | Curve | Use |
|---|---|---|
| `ease-default` | `cubic-bezier(0.4, 0, 0.2, 1)` | General purpose |
| `ease-in` | `cubic-bezier(0.4, 0, 1, 1)` | Elements exiting |
| `ease-out` | `cubic-bezier(0, 0, 0.2, 1)` | Elements entering |
| `ease-spring` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | Playful bouncy arrivals |
| `ease-decelerate` | `cubic-bezier(0, 0, 0, 1)` | Bottom sheets, drawers |

---

## 8.4 Book Reveal Animation

**Total duration: ~2500ms**

```
Timeline:
 0ms   ──→  200ms  : Background overlay fades in (opacity 0→1, ease-out)
 200ms ──→  400ms  : Particle system begins (themed sparkles, CSS animation)
 400ms ──→ 1000ms  : Book cover enters
                     - scale: 0.6 → 1.0
                     - opacity: 0 → 1
                     - timing: ease-spring (600ms)
1000ms ──→ 1300ms  : Headline text appears (translateY 8px → 0, opacity 0→1, ease-out, 300ms)
1300ms ──→ 1600ms  : Subtext appears (same, 300ms)
1800ms ──→ 2100ms  : Buttons appear (opacity 0→1, ease-out, 300ms)
```

**Reduced motion alternative:**
- All elements appear at `t=0` at full opacity, no transforms, no particles
- Only fade transitions (opacity changes) permitted

---

## 8.5 Page Turn Animation (Reader)

**Standard (no reduced motion):**
- Direction: Next = slides in from right. Previous = slides in from left.
- Outgoing page: `translateX(0) → translateX(-20px)` + `opacity 1 → 0` (150ms ease-in)
- Incoming page: `translateX(20px) → translateX(0)` + `opacity 0 → 1` (150ms ease-out)
- Both animate simultaneously (crossfade-slide hybrid)

**Swipe (mobile):** Page follows finger. Release with velocity > 300px/s completes turn. Below velocity: spring back.

**Reduced motion:** Instant page swap (no animation).

---

## 8.6 Wizard Step Transitions

**Between steps:**
- Outgoing: `translateX(0) → translateX(-40px)` + fade out, 200ms ease-in
- Incoming: `translateX(40px) → translateX(0)` + fade in, 250ms ease-out
- Back navigation: reverse direction (incoming from left, outgoing to right)

**Progress bar node:** Fills from left when a step is completed (width animation, 300ms ease).

**Reduced motion:** Fade only (no translateX).

---

## 8.7 Generation Progress Animations

**Stage label change:**
- Old label: fade out (150ms)
- New label: fade in (150ms)
- Slight slide up (8px) on new label entry

**Progress bar fill:**
- Smooth continuous fill, not jumpy
- Never animates backwards

**Stage node transition to "complete":**
- Circle fills with brand color (200ms)
- Checkmark draws in (SVG stroke-dashoffset animation, 300ms)

**Partial preview reveal:**
- Panel slides up from bottom (mobile): 300ms ease-decelerate
- Card appears from right (desktop): 400ms ease-spring

---

## 8.8 Loading Animations

**Skeleton shimmer:** Left-to-right gradient sweep. `background-position: -200% → 200%`, linear, 1.5s, infinite.

**Spinner:** SVG stroke-dasharray circular animation, 600ms linear infinite.

**Pulse (in-progress book card):** `opacity 0.6 → 1.0 → 0.6`, 1.5s ease-in-out, infinite.

---

## 8.9 Success Animations

**Small success (save profile, copy link):**
- Button/field briefly highlights green (100ms flash)
- Toast slides in from bottom

**Large success (purchase complete):**
- Checkmark draws in (SVG, 400ms ease-out)
- Circle fills behind checkmark (400ms, delayed 100ms)
- Subtle background color pulse (1 cycle only)

**Generation complete (book reveal):**
- See 8.4 above

---

## 8.10 prefers-reduced-motion Implementation

**Global wrapper:**
```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

**Exceptions:** Components that use JS-based animation (book reveal, generation progress) check `window.matchMedia('(prefers-reduced-motion: reduce)')` and conditionally skip their animation sequences.

**Particle systems:** Fully disabled when reduced motion is preferred.

---

# 9. Accessibility Specification

## 9.1 WCAG 2.1 AA Compliance

The following success criteria are explicitly targeted:

| Criterion | Level | Implementation |
|---|---|---|
| 1.1.1 Non-text Content | A | Alt text on all images and illustrations |
| 1.3.1 Info and Relationships | A | Semantic HTML, ARIA roles |
| 1.3.2 Meaningful Sequence | A | DOM order matches visual order |
| 1.3.3 Sensory Characteristics | A | No instruction relies on shape/color alone |
| 1.4.1 Use of Color | A | Color never sole conveyor of info |
| 1.4.3 Contrast (Minimum) | AA | 4.5:1 for text, 3:1 for large text |
| 1.4.4 Resize Text | AA | Works at 200% zoom without horizontal scroll |
| 1.4.10 Reflow | AA | Single column at 320px width |
| 1.4.11 Non-text Contrast | AA | 3:1 for UI components |
| 2.1.1 Keyboard | A | All functionality keyboard accessible |
| 2.1.2 No Keyboard Trap | A | Modals have escape route |
| 2.4.3 Focus Order | A | Logical tab order |
| 2.4.4 Link Purpose | A | All links have descriptive text |
| 2.4.7 Focus Visible | AA | All focused elements show visible ring |
| 3.1.1 Language of Page | A | `lang` attribute on `<html>` |
| 3.2.1 On Focus | A | No context change on focus |
| 3.3.1 Error Identification | A | Errors identified and described in text |
| 3.3.2 Labels or Instructions | A | All form fields have labels |
| 4.1.2 Name, Role, Value | A | All components have ARIA names and roles |
| 4.1.3 Status Messages | AA | Status messages via `aria-live` |

---

## 9.2 Keyboard Navigation Map

**Global:**
- `Tab`: Move forward through interactive elements
- `Shift+Tab`: Move backward
- `Enter`: Activate button/link; submit form
- `Space`: Toggle checkbox, radio, toggle; activate button
- `Escape`: Close modal, drawer, dropdown, exit fullscreen

**Wizard:**
- `Enter`: Proceed to next step (if valid)
- `Escape`: Open exit confirmation

**Book Reader:**
- `← →`: Previous/next page
- `Home` / `End`: First/last page
- `F`: Toggle fullscreen
- `B`: Bookmark
- `D`: Download modal
- `S`: Share modal
- `Escape`: Exit fullscreen or close reader

**TagPicker:**
- `Tab`: Move between tags
- `Space`: Toggle tag selection

**ThemeCardGrid:**
- Arrow keys: Navigate between cards
- `Space`/`Enter`: Select card

**Modal:**
- `Escape`: Close
- `Tab`: Cycle within modal only (focus trap)

---

## 9.3 Screen Reader Requirements

**ARIA Landmarks on every page:**
```html
<header role="banner">
<nav role="navigation" aria-label="Main navigation">
<main role="main">
<aside role="complementary">  <!-- sidebars, etc. -->
<footer role="contentinfo">
```

**Wizard ARIA:**
```html
<div role="form" aria-label="Book creation wizard">
  <div role="group" aria-labelledby="step-1-title">
    ...
  </div>
</div>
```

**Generation progress:**
```html
<div role="progressbar"
     aria-valuenow="45"
     aria-valuemin="0"
     aria-valuemax="100"
     aria-label="Generating Lily's book, 45% complete">
```

**Live regions:**
```html
<!-- Status updates (polite) -->
<div aria-live="polite" aria-atomic="true">
  [Stage label updates here]
</div>

<!-- Error messages (assertive) -->
<div role="alert" aria-live="assertive">
  [Error messages here]
</div>
```

**Book Reader:** The book's text content is available to screen readers via an `aria-label` on each page element. Illustration descriptions are provided via `<figure>` + `<figcaption>` structure.

---

## 9.4 Focus Management

**When modal opens:** Move focus to first interactive element inside modal (or modal heading if no interactive element precedes content).

**When modal closes:** Return focus to the element that triggered the modal.

**When wizard step changes:** Move focus to the step's heading (`h2`).

**When error occurs:** Move focus to the error message (or first field with error).

**When toast appears:** Toast is announced by `aria-live` region but does NOT receive focus (it would interrupt user workflow).

**When book page turns:** Announce new page to screen reader: "Page 5: [page text content]" via `aria-live="polite"`.

---

## 9.5 Color Contrast Requirements

**Text on backgrounds:**
- Body text on white: minimum ratio 7:1 (AAA target where feasible)
- Body text on color backgrounds: minimum 4.5:1
- Large text (≥18px bold, ≥24px regular): minimum 3:1

**UI Components:**
- Input borders: 3:1 against background
- Focus rings: 3:1 against adjacent colors
- Icons: 3:1 against background

**Brand palette accessibility check required** before finalizing design tokens. Document the accessible pairings explicitly.

---

## 9.6 Touch Target Requirements

Minimum touch target: **44×44px** for all interactive elements.

For elements smaller visually (e.g., 24px icons), padding is used to extend the interactive area to 44×44px without visual change.

**Spacing between touch targets:** Minimum 8px gap to prevent accidental activation of adjacent targets.

---

## 9.7 Form Accessibility

- Every input has an explicit `<label>` element (not placeholder as label)
- Error messages are associated via `aria-describedby`
- Required fields indicated via `aria-required="true"` AND visible asterisk with explanation ("* Required")
- Form groups use `<fieldset>` + `<legend>` (e.g., pronoun selection, interest tag group)
- Autocomplete attributes set where applicable: `given-name`, `email`, `cc-number`, etc.

---

## 9.8 Reader Accessibility

The book reader presents content that is fundamentally visual. Accessibility considerations:

1. **Full text extraction:** Every page's text content is available in a hidden (screen-reader-visible) `<div>` alongside the illustration
2. **Page announcement:** Each page turn announces the page number and reads the text content
3. **Illustration descriptions:** Each illustration has an AI-generated alt text in the format: "Illustration: [description of scene]"
4. **Reader mode:** Toggle in toolbar switches to a "text reader mode" — plain text layout, no illustrations, larger font, high contrast option

---

# 10. UX Edge Cases

## 10.1 Network & Connectivity

**Slow network (>3s per page load):**
- Skeleton loaders appear immediately (not spinners)
- Images use low-quality placeholders (LQIP) while loading
- Cover image in reader preloads 2 pages ahead; on slow connection reduces to 1 ahead
- Wizard step transition is blocked if server save has not confirmed (with a "Saving..." indicator)

**Offline (service worker):**
- Dashboard: shows cached books, banner: "You're offline — some features may be limited"
- Library books can be read offline if they were previously loaded (cached via service worker)
- Wizard: local draft preserved in localStorage. Save to server retried when connection returns.
- Generation screen: SSE disconnects → polling fallback. After 30s with no response: "You appear to be offline. Your book is still being created — we'll notify you when it's ready."
- Attempting to pay while offline: payment blocked, clear error message shown

**Connection restored:**
- Pending sync items are silently synced
- Toast: "You're back online" (only if the user saw an offline message)
- Generation status polled immediately upon reconnect

---

## 10.2 Generation Edge Cases

**Generation takes >5 minutes:**
- Estimated time label: "This is taking a little longer than usual — we're putting extra care into [Name]'s book."
- No error yet; user remains on progress screen
- At 8 minutes: "Your book is taking longer than expected. We've sent you an email so you don't have to keep waiting." (email sent automatically, user can safely close tab)

**Generation takes >10 minutes:**
- Job timeout on server side
- User sees error screen if they are still on the page
- Email sent regardless: "Your book took longer than expected. We're working on it — we'll email you when it's done."
- Automatic server-side retry (1 attempt)

**Generation fails (all retries exhausted):**
- Error screen with: headline ("Something went wrong"), explanation (no technical detail), "Try Again" button (restores all inputs), "Contact Support" link
- No charge made — payment gate only opens after successful generation
- Input data preserved in draft for 30 days

**User closes tab during generation:**
- Generation continues on server
- On return (any tab): dashboard shows "In progress" book card with spinner
- Email notification sent on completion (if email notification was toggled on — if not, user must check dashboard)

**User starts a second book while first is generating:**
- Allowed on paid plans
- Dashboard shows both as "In progress"
- Generation queue: second job starts immediately on paid plans; queued on free plans

---

## 10.3 Wizard Edge Cases

**User refreshes mid-wizard:**
- Guest: restored from localStorage (step, all field values)
- Logged-in: restored from server draft
- On restore, user sees a banner: "We restored your progress — continue where you left off"

**User opens wizard in two browser tabs:**
- Same draft is loaded in both
- Last write wins (no conflict UI — simply take latest data)
- Show toast on second tab: "You have this wizard open in another tab"

**User presses browser back from wizard step 1:**
- Instead of navigating away: exit confirmation modal appears
- Modal: "Are you sure you want to leave? Your progress will be saved." [Keep Going] [Exit]
- If guest: "Your progress will be lost." [Keep Going] [Exit]

**Wizard takes >30 minutes (session timeout):**
- On wizard step Continue: server responds with 401
- Redirect to login with return URL to preview page
- After login: draft restored, generation begins

**Photo upload during poor connectivity:**
- Progress bar shows upload progress (xhr/fetch with progress events)
- If upload stalls: "Upload is slow — check your connection" after 15 seconds
- Auto-retry on network error (1 retry automatically)

---

## 10.4 Payment Edge Cases

**Payment interrupted (browser closed during checkout):**
- Stripe payment intent is idempotent — if user returns with same session, same intent is reused
- No double-charge possible
- On return: checkout screen shows in same state as when they left

**Payment succeeds but redirect fails (network drops after charge):**
- Stripe webhook → server marks book as paid
- User returns to app → dashboard shows book as "paid" / available to download
- Recovery email sent: "Your payment went through! Your book is ready in your library."

**Double-click on submit button:**
- Button disabled on first click
- Idempotency key prevents double-charge on server

**Card declined:**
- Inline error below card form (not modal, not redirect)
- Specific decline reason from Stripe displayed where available: "Insufficient funds" / "Card expired" / "Do not honor" (generic)
- User can edit card details and retry without re-entering everything

**3D Secure challenge:**
- Stripe.js handles the 3DS modal natively
- Our UI shows a loading overlay while 3DS challenge is in progress
- On 3DS success: normal success flow
- On 3DS failure: clear inline error

**Subscription payment fails (recurring):**
- Handled by Stripe's Smart Retries
- After all retries fail: email to user + in-app banner: "Your subscription payment failed — update your payment method to continue."

---

## 10.5 Session Edge Cases

**Session expires while user is in the app:**
- API returns 401
- Toast: "Your session has expired — please sign in again"
- After sign-in: return to the page they were on (saved in `redirect` query param)
- Form data preserved (no loss of unsaved draft)

**User signs in on another device:**
- Sessions are not invalidated across devices
- Multiple simultaneous sessions supported

**User signs out on one device:**
- Does not affect other devices
- If user had a pending generation: it completes; email sent when ready

---

## 10.6 Account Deletion

**Multi-step confirmation for account deletion:**

Step 1 — Intent:
- "Delete my account" link in settings → full-page confirmation (not modal)
- Explains: "All your books, child profiles, and settings will be permanently deleted. This cannot be undone."
- Lists: books that will be deleted (count + thumbnails)
- Options: [Download All Books] [Cancel] [Continue to Delete]

Step 2 — Verification:
- "Type DELETE to confirm" (text input)
- [Cancel] [Permanently Delete My Account] (danger button, disabled until "DELETE" is typed)

Step 3 — Completion:
- Account deleted → logged out → landing page
- Toast: "Your account has been deleted. We're sorry to see you go."
- Confirmation email sent

**Subscription cancellation before account deletion:**
- If active subscription: system cancels it immediately on account deletion (pro-rated refund per billing policy)

---

## 10.7 Shared Book Edge Cases

**Book deleted by owner after share link sent:**
- Share link returns 404 error page: "This book is no longer available."

**Owner sets book to private after sharing:**
- Share link returns: "This book is private. Request access from the owner."

**Shared link bookmarked and opened years later:**
- If book still exists: works normally
- Link does not expire

---

## 10.8 Miscellaneous Edge Cases

**Very long child name (30 chars):**
- All components that display the name must truncate with ellipsis at their container width
- Tooltip shows full name on truncated text

**Special characters in name (e.g., Ó, ñ, 张):**
- Accepted in all name fields (Unicode support)
- AI generation uses name as-entered (not transliterated)

**Child age changes between book creations:**
- Age is stored per-book (snapshot at creation time), not derived from birthdate
- Prompt shown when creating new book: "Is [Name] still 5 years old, or have they had a birthday?" [Update Age] [Keep as 5]

**Duplicate book creation (user clicks "Create" twice fast):**
- Wizard submit is idempotent — second click is ignored (button disabled after first click)
- Draft is identified by a client-generated UUID, preventing duplicate job creation

**Reader opened on unsupported browser:**
- Feature detection for required APIs (IntersectionObserver, CSS custom properties)
- Fallback: static paginated view (no animations, basic prev/next)
- Banner: "For the best reading experience, use a modern browser like Chrome or Safari."

---

# 11. Analytics Events

## 11.1 Event Taxonomy

Events follow the naming convention: `noun_verb` (lowercase, snake_case).

All events carry these base properties:
```json
{
  "user_id": "usr_xxx",           // null for guests
  "session_id": "ses_xxx",
  "device_type": "mobile|tablet|desktop",
  "platform": "web|ios|android",
  "locale": "en-US",
  "timestamp": "ISO8601",
  "app_version": "1.0.0"
}
```

---

## 11.2 Acquisition Events

| Event | Trigger | Properties |
|---|---|---|
| `page_viewed` | Any page load | `page_name`, `referrer`, `utm_*` |
| `landing_cta_clicked` | Hero CTA clicked | `cta_position` (hero/pricing/footer) |
| `sample_book_viewed` | Sample book opened | `book_theme` |
| `pricing_page_viewed` | Pricing page loaded | `referrer` |

---

## 11.3 Wizard Events

| Event | Trigger | Properties |
|---|---|---|
| `wizard_started` | Step 1 loaded | `entry_point` (landing/dashboard/email) |
| `wizard_step_completed` | Any step continued | `step_number`, `step_name`, `time_on_step_ms` |
| `wizard_step_back` | Back button clicked | `from_step`, `to_step` |
| `wizard_abandoned` | Exit confirmed | `step_abandoned`, `time_in_wizard_ms`, `reason` (exit_button/browser_back/session_timeout) |
| `wizard_photo_uploaded` | Photo upload completes | `success: boolean`, `failure_reason?` |
| `wizard_photo_failed` | Photo processing fails | `failure_reason` (no_face/too_small/unsupported) |
| `wizard_avatar_built` | Avatar builder used | `features_customized: string[]` |
| `wizard_tags_selected` | Interests confirmed | `tags: string[]`, `tag_count: number` |
| `wizard_theme_selected` | Theme chosen | `theme_id`, `theme_name` |
| `wizard_setting_selected` | Setting chosen | `setting_id`, `setting_name` |
| `wizard_dedication_written` | Dedication field filled | `has_from_name: boolean`, `char_count: number` |
| `wizard_completed` | Step 5 confirmed, auth completed | `total_time_ms`, `optional_fields_filled: number` |

---

## 11.4 Generation Events

| Event | Trigger | Properties |
|---|---|---|
| `generation_started` | Job created on server | `job_id`, `theme`, `setting`, `book_language` |
| `generation_progress_milestone` | At 25%, 50%, 75% | `job_id`, `progress_percent` |
| `generation_completed` | Book created successfully | `job_id`, `duration_ms`, `page_count` |
| `generation_failed` | Job fails after retries | `job_id`, `failure_reason`, `attempt_count` |
| `generation_email_toggled` | Email notification toggled | `enabled: boolean` |
| `generation_tab_closed` | User closes tab during generation | `progress_at_close_percent` |
| `partial_preview_viewed` | Cover preview shown at 40% | `job_id` |

---

## 11.5 Reader Events

| Event | Trigger | Properties |
|---|---|---|
| `book_opened` | Reader screen loaded | `book_id`, `entry_point` (reveal/library/share_link/email) |
| `book_page_viewed` | Page displayed | `book_id`, `page_number`, `time_on_page_ms` |
| `book_completed` | Last page reached | `book_id`, `total_read_time_ms` |
| `reader_exited` | Reader closed | `book_id`, `last_page_viewed`, `read_percent` |
| `paywall_shown` | Paywall overlay appears | `book_id`, `user_plan` |
| `paywall_cta_clicked` | Upgrade clicked in paywall | `book_id`, `plan_selected` (single/family) |
| `paywall_dismissed` | Paywall × clicked | `book_id` |
| `reader_fullscreen_entered` | Fullscreen toggled on | `book_id` |
| `reader_bookmark_added` | Bookmark set | `book_id`, `page_number` |
| `reader_download_clicked` | Download button clicked | `book_id`, `resolution` (screen/print) |
| `reader_shared` | Share action completed | `book_id`, `share_method` (link/instagram/facebook/whatsapp) |

---

## 11.6 Conversion Events

| Event | Trigger | Properties |
|---|---|---|
| `signup_started` | Auth modal opened or signup page loaded | `entry_point`, `auth_method` |
| `signup_completed` | Account created | `auth_method` (google/apple/email), `entry_context` (wizard/paywall/landing) |
| `login_completed` | Existing user signs in | `auth_method` |
| `checkout_started` | Checkout page loaded | `plan` (single/monthly/annual), `entry_point` |
| `payment_method_selected` | User selects payment type | `method` (apple_pay/google_pay/card) |
| `payment_submitted` | Submit button clicked | `plan`, `amount`, `currency` |
| `payment_succeeded` | Payment confirmed | `plan`, `amount`, `book_id?` |
| `payment_failed` | Payment error | `failure_reason`, `plan`, `attempt_number` |
| `subscription_created` | First subscription payment succeeds | `plan`, `billing_period` (monthly/annual) |
| `subscription_cancelled` | Cancellation confirmed | `plan`, `days_active`, `reason?` (from exit survey) |
| `subscription_reactivated` | Resubscribed after cancellation | `plan` |

---

## 11.7 Social & Retention Events

| Event | Trigger | Properties |
|---|---|---|
| `share_link_copied` | Share link copied | `book_id`, `context` (reader/library/dashboard) |
| `share_social_clicked` | Social share button clicked | `book_id`, `platform` |
| `gift_flow_started` | Gift purchase flow entered | — |
| `gift_sent` | Gift delivery confirmed | `book_id`, `delivery_method` (now/scheduled) |
| `referral_link_shared` | Referral link copied | `referring_user_id` |
| `referral_converted` | Referred user signs up | `referral_source_user_id` |
| `series_continued` | Second book in series created | `series_id`, `book_number` |
| `birthday_reminder_set` | Birthday saved for a child | `days_until_birthday` |
| `child_profile_created` | New child profile saved | `child_number` (1st, 2nd, etc.) |

---

# 12. Design Tokens (UX Level)

## 12.1 Spacing Scale

Base unit: 4px

| Token | Value | Common use |
|---|---|---|
| `space-0` | 0px | — |
| `space-1` | 4px | Micro gaps, icon padding |
| `space-2` | 8px | Inline element gaps |
| `space-3` | 12px | Input internal padding (vertical) |
| `space-4` | 16px | Default component padding, list item gaps |
| `space-5` | 20px | Card padding (mobile) |
| `space-6` | 24px | Card padding (desktop), section gaps |
| `space-8` | 32px | Component-to-component gaps |
| `space-10` | 40px | Section padding |
| `space-12` | 48px | Large section gaps |
| `space-16` | 64px | Page section padding |
| `space-20` | 80px | Hero/landing section padding |
| `space-24` | 96px | — |

---

## 12.2 Border Radius Scale

| Token | Value | Use |
|---|---|---|
| `radius-sm` | 4px | Input fields, tags (small variant) |
| `radius-md` | 8px | Buttons, dropdown menus |
| `radius-lg` | 12px | Cards, modals |
| `radius-xl` | 16px | Drawers, book card images |
| `radius-2xl` | 24px | Large feature cards |
| `radius-full` | 9999px | Pills, avatars, toggle buttons |

---

## 12.3 Elevation (Shadow Scale)

| Token | Value | Use |
|---|---|---|
| `shadow-none` | none | Flat elements |
| `shadow-xs` | `0 1px 2px rgba(0,0,0,0.08)` | Subtle card lift |
| `shadow-sm` | `0 2px 8px rgba(0,0,0,0.10)` | Default card |
| `shadow-md` | `0 4px 16px rgba(0,0,0,0.12)` | Hover state, dropdowns |
| `shadow-lg` | `0 8px 32px rgba(0,0,0,0.14)` | Modals, pickers |
| `shadow-xl` | `0 16px 48px rgba(0,0,0,0.18)` | Bottom sheets, overlays |
| `shadow-focus` | `0 0 0 3px {brand-primary-40}` | Focus ring |

---

## 12.4 Typography Scale

| Token | Size | Weight | Line height | Use |
|---|---|---|---|---|
| `text-xs` | 12px | 400 | 1.5 | Caption, metadata, legal text |
| `text-sm` | 14px | 400 | 1.5 | Secondary body, labels |
| `text-base` | 16px | 400 | 1.6 | Body text |
| `text-md` | 18px | 400 | 1.5 | Large body |
| `text-lg` | 20px | 600 | 1.4 | Card titles, section labels |
| `text-xl` | 24px | 600 | 1.3 | Sub-headings |
| `text-2xl` | 30px | 700 | 1.2 | Page headings |
| `text-3xl` | 36px | 700 | 1.15 | Section headlines |
| `text-4xl` | 48px | 800 | 1.1 | Hero headline |
| `text-5xl` | 60px | 800 | 1.0 | Landing hero (desktop) |

**Font families:**
- `font-sans`: Primary UI font (system-ui fallback: Inter, -apple-system, Helvetica)
- `font-serif`: Dedication page, book interior text (Georgia, "Times New Roman")
- `font-display`: Marketing headlines (custom variable font — TBD in visual design)
- `font-dyslexic`: Accessibility option in reader (OpenDyslexic)

---

## 12.5 Breakpoints

```
xs:  375px   (min-width)
sm:  640px
md:  768px
lg:  1024px
xl:  1280px
2xl: 1536px
```

**Container max widths:**
```
prose content:  720px
standard layout: 1200px
wide layout:    1440px
```

---

## 12.6 Grid System

**Desktop (lg+):** 12-column grid, 24px gutter, 48px page margin
**Tablet (md):** 8-column grid, 20px gutter, 32px page margin
**Mobile (sm):** 4-column grid, 16px gutter, 16px page margin

**Wizard:** 1-column centered, max-width 560px, 24px padding
**Dashboard grid:** CSS Grid, auto-fill columns (see Section 7.2 for column counts)
**Reader:** Viewport-filling (no grid)

---

## 12.7 Icon Sizes

| Token | Size | Use |
|---|---|---|
| `icon-xs` | 12px | Badge indicators |
| `icon-sm` | 16px | Inline icons in text |
| `icon-md` | 20px | Button icons (default) |
| `icon-lg` | 24px | Toolbar icons, nav icons |
| `icon-xl` | 32px | Empty state icons |
| `icon-2xl` | 48px | Feature section icons |

All icons use an SVG icon system (not icon fonts). Icons are 24px artboard with variable interior sizing.

---

## 12.8 Motion Scale

| Token | Value | Use |
|---|---|---|
| `motion-instant` | 80ms | Pressed states |
| `motion-fast` | 150ms | Color/border transitions |
| `motion-medium` | 250ms | Component enter/exit |
| `motion-slow` | 400ms | Modal, drawer open |
| `motion-deliberate` | 600ms | Reveal elements |
| `motion-story` | 1000ms+ | Narrative sequences |

**Easing tokens:**
```
ease-default:     cubic-bezier(0.4, 0, 0.2, 1)
ease-in:          cubic-bezier(0.4, 0, 1, 1)
ease-out:         cubic-bezier(0, 0, 0.2, 1)
ease-spring:      cubic-bezier(0.34, 1.56, 0.64, 1)
ease-decelerate:  cubic-bezier(0, 0, 0, 1)
```

---

## 12.9 Z-Index Scale

| Token | Value | Layer |
|---|---|---|
| `z-base` | 0 | Normal content |
| `z-raised` | 10 | Cards on hover |
| `z-dropdown` | 100 | Dropdowns, floating menus |
| `z-sticky` | 200 | Sticky headers |
| `z-overlay` | 300 | Backdrop overlays |
| `z-modal` | 400 | Modals, dialogs |
| `z-drawer` | 450 | Drawers |
| `z-toast` | 500 | Toast notifications |
| `z-tooltip` | 600 | Tooltips |

---

## 12.10 Interaction Timing Reference

| Interaction | Duration | Easing |
|---|---|---|
| Button press | 80ms | ease-in-out |
| Button hover | 100ms | ease-out |
| Color transition | 150ms | ease-default |
| Page turn (reader) | 150ms | ease-in-out |
| Tag selection | 100ms | ease-out |
| Dropdown open | 200ms | ease-out |
| Modal open | 200ms | ease-out |
| Modal close | 150ms | ease-in |
| Drawer open | 300ms | ease-decelerate |
| Wizard step transition | 250ms | ease-in-out |
| Toast appear | 200ms | ease-out |
| Toast dismiss | 150ms | ease-in |
| Skeleton shimmer | 1500ms | linear (loop) |
| Book reveal sequence | 2500ms | (staged — see §8.4) |

---

*End of UX Specification*

---

**Document Version:** 1.0
**Status:** Ready for Design & Engineering Review

**Companion documents:**
- `PRD.md` — Product Requirements (what the product does)
- `ARCHITECTURE.md` — Technical Architecture (how it's built)
- `ROADMAP.md` — Implementation Roadmap (when it's built)

**Next steps:**
- Design team: produce Figma wireframes for all screens in Section 4, using tokens in Section 12
- Frontend team: review Section 5 (Component Inventory) and establish the component library scaffold
- QA team: use Section 10 (Edge Cases) to build the test plan
- Analytics team: implement events in Section 11 against the agreed analytics platform
