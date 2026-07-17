# Product Requirements Document

## StoryMe — Personalized AI Children's Books Platform

**Version 1.0 | Product Design Document**
**Prepared by: Product & UX Team | Date: June 2026**

---

# Table of Contents

1. Executive Summary
2. Target Audience & Personas
3. User Journey
4. User Flows
5. Features
6. Screens
7. Book Creation Wizard
8. Dashboard
9. Book Reader
10. Settings
11. AI Generation Experience
12. Errors
13. Empty States
14. Success States
15. Subscription Model
16. Viral Features
17. Retention Features
18. Accessibility
19. Internationalization
20. Future Features

---

# 1. Executive Summary

## Vision

**StoryMe** is the world's most magical way to give a child a book — one where they are the hero.

We live in a world where children are surrounded by generic entertainment. Mass-produced stories feature characters that look nothing like them, live in worlds that don't reflect their life, and solve problems that feel distant. StoryMe flips this entirely. Every book begins with a single premise: _your child is the main character._

Using advanced AI, StoryMe generates a complete, illustrated, print-quality children's book personalized around a specific child — their name, their face, their interests, their values, and the people they love. In under five minutes, a parent, grandparent, or gift-giver creates something no bookstore can sell: a one-of-a-kind story that will be read and re-read for years.

## Who It's For

StoryMe is for anyone who wants to give a child an experience that feels genuinely magical:

- **Parents** who want to foster a love of reading in their child
- **Grandparents** who want to give a meaningful, lasting gift
- **Gift-givers** who are done with generic presents
- **Teachers** who want to celebrate individual students
- **Parents of children with special needs** who want stories that reflect their child's world

## Why Parents Use It

Parents already spend significant money on children's books. But no book at Barnes & Noble features _their_ child. StoryMe offers something categorically different from what exists: not just a personalized name-drop, but a story genuinely _built around_ that specific child — their personality, their fears, their dreams, the dog they have, the grandma they love.

The emotional trigger is powerful. Parents see their child's face light up when they realize they are the hero. They share it. They come back for birthdays, holidays, new siblings. Teachers order for their class. Grandparents order for every grandchild.

## Why It's Different

| Feature                           | Generic AI Story Tools | StoryMe                                                             |
| --------------------------------- | ---------------------- | ------------------------------------------------------------------- |
| Child's likeness in illustrations | No                     | Yes — AI-generated child avatar                                     |
| Story depth                       | 1-2 pages, templated   | 20–32 pages, full narrative arc                                     |
| Illustration quality              | Clip art level         | Premium illustrated book quality                                    |
| Print-ready PDF                   | Rare                   | Core product                                                        |
| Personalization depth             | Name only              | Name, appearance, personality, relationships, values, fears, dreams |
| Emotional arc                     | None                   | Age-appropriate moral and emotional journey                         |
| Series feature                    | No                     | Yes — same character across multiple books                          |
| Family members in story           | No                     | Yes                                                                 |

## Emotional Value

StoryMe doesn't sell books. It sells the memory of a child's face the first time they see themselves as the hero of a story. It sells the feeling a grandparent gets when they see their grandchild read a book _they_ made. It sells the magic of childhood, extended.

This is a **gift product** at its core. Even when parents buy for themselves, they are giving a gift — to their child, to their family's memory, to the future.

---

# 2. Target Audience & Personas

## Persona 1 — Emily, the Engaged Mom (Primary)

**Demographics:** 31 years old, mother of a 4-year-old daughter (Lily), lives in suburban Texas, household income $90k, works part-time as a graphic designer, active on Instagram and Pinterest.

**Goals:**

- Raise a daughter who loves books and reading
- Find birthday gifts for Lily that feel special and personal
- Create memories that will last beyond a toy or subscription box
- Spend quality time with her daughter around books

**Pain Points:**

- Most children's books feel generic — the same princess archetypes, the same color palettes
- Her daughter is biracial and rarely sees characters that look like her
- She wants to give gifts that feel thoughtful, not just purchased
- She's overwhelmed by the number of content subscriptions and wants something with tangible output

**Needs:**

- A simple, beautiful creation process that doesn't require design skills
- A product she can hold or show — not just digital content
- Representation — her daughter should look like herself in the book
- Fast results — she doesn't have hours to wait

**Buying Motivation:**

- The first time she sees a preview of a book with Lily's face on the cover, she is an instant convert
- Will likely gift to other moms in her network
- Will buy 3–5 books per year: birthday, Christmas, sibling announcement, back to school, "just because"

---

## Persona 2 — Michael, the Gift-Giver Dad (High Value)

**Demographics:** 38 years old, father of a 7-year-old son (Noah), lives in Chicago, earns $130k as a marketing manager. Divorced, shares custody. Wants to make his weekends with Noah feel special.

**Goals:**

- Give Noah an experience, not just a toy
- Create something that signals effort and thought
- Strengthen his bond with his son through shared activities

**Pain Points:**

- Standard gifts feel lazy — he's tired of Amazon gift cards
- He doesn't have a lot of creative skill and doesn't know where to start
- He worries the book will feel cheesy or low quality

**Needs:**

- Confidence that the output will be genuinely impressive
- A quick process — 10–15 minutes maximum
- The ability to see before he commits (preview before purchase)

**Buying Motivation:**

- Noah's reaction. Once the boy sees himself flying through space with a lightsaber, Michael is loyal for life.
- Will buy for birthdays, holidays, and special occasions
- Likely to buy premium tier for quality PDF and unlimited books

---

## Persona 3 — Margaret, the Grandmother (Gift Occasion)

**Demographics:** 67 years old, grandmother of three (ages 3, 5, and 9), retired schoolteacher, lives in Florida. Has a tablet, comfortable with apps but not technical.

**Goals:**

- Give each grandchild a meaningful, personalized gift
- Feel connected to grandchildren who live far away
- Give something she made with love, not just ordered off Amazon

**Pain Points:**

- Doesn't know how to use complex tools — interfaces must be simple
- Fears the result will look cheap or amateurish
- Worries she'll get stuck and not know what to do

**Needs:**

- An extremely guided, simple wizard — no blank fields, no jargon
- Large text, clear buttons, obvious progress indicators
- Phone/tablet support with a mobile-first design
- Customer support that's responsive and human-feeling

**Buying Motivation:**

- The idea of giving her grandchild a book with their face on the cover is immediately compelling
- Will likely call her daughter to say "I made Emma a book, come look"
- Will buy once per grandchild per year at minimum — high lifetime value

---

## Persona 4 — Sarah, the Teacher (B2B Adjacent)

**Demographics:** 42 years old, 2nd grade teacher at a public school, uses technology in her classroom, moderate income. Purchases classroom supplies herself.

**Goals:**

- Celebrate each student individually at end of year
- Motivate reluctant readers by making reading feel personal
- Create a memorable classroom experience

**Pain Points:**

- Can't afford individual gifts for 22 students
- School budgets don't cover this
- Needs bulk creation without repetitive manual work

**Needs:**

- Ability to create multiple books efficiently (classroom pack feature)
- Consistent quality across all books
- Simple, age-appropriate story themes aligned to literacy goals

**Buying Motivation:**

- End-of-year celebration, reading month, or student of the week program
- Would pay out of pocket for a classroom pack if the price is right
- Potential to advocate for school-wide adoption

---

## Persona 5 — Jordan, the Millennial Gift Buyer (Occasion-Driven)

**Demographics:** 28 years old, no children of their own, buys gifts for nieces, nephews, and friends' kids. Lives in a city, disposable income, values originality and aesthetics.

**Goals:**

- Be the "cool" aunt/uncle who gives the best gifts
- Give something the child will actually remember
- Skip the toy aisle entirely

**Pain Points:**

- Doesn't know the child's interests well — needs guidance
- Doesn't want to get it wrong (wrong age range, wrong theme)
- Wants the unboxing moment to be impressive

**Needs:**

- Guided prompts that help them make good choices without knowing the child deeply
- A premium physical option (print-on-demand partnership)
- Gift-ready presentation — digital delivery card, gift wrapping option

**Buying Motivation:**

- The novelty and "wow factor" of the product concept alone
- Social proof (reviews, social media)
- Will likely buy once per year per child in their network

---

# 3. User Journey

## Phase 1 — Discovery

**Channel:** Instagram/TikTok ad showing a child's reaction when seeing their face in a book. The ad ends with: _"See your child as the hero. Create their book in 5 minutes."_

**Landing Page Experience:**

- Visitor arrives at a visually rich, emotion-first landing page
- Headline: _"The book they've been waiting for — starring them."_
- Hero: looping video of a child opening a book and gasping with delight
- Below: a live demo showing real book pages (swipeable)
- Social proof: "Over 250,000 books created" / star reviews
- CTA: _"Create Your Book — It's Free to Start"_

**No signup required to begin.** The user goes directly into the wizard. Signup happens at the preview step, just before generation — this lowers friction dramatically and means the user is already invested.

---

## Phase 2 — First Impression (Wizard Entry)

**Moment:** User clicks "Create Your Book" and the wizard opens immediately.

- Warm, friendly welcome message: _"Let's make something magical. Tell us about your child."_
- Step 1 begins: child's name
- Visual progress bar at top — 5 steps, simple icons
- Each step has a warm illustration (not a form)
- The entire wizard feels like a game, not a form

---

## Phase 3 — Personalization (Wizard Steps 1–5)

**Step 1 — The Child:** Name, age, gender (optional/inclusive options), nickname
**Step 2 — Their World:** Interests, favorite things, pet names, best friend name
**Step 3 — Their Story:** Choose theme (adventure, kindness, bravery, creativity...), setting (space, ocean, forest, city...), and lesson/moral
**Step 4 — Their Look:** Upload a photo OR choose from illustrated avatar builder (skin tone, hair style, eye color)
**Step 5 — Dedication:** Optional dedication message ("From Grandma, with all my love")

Each step takes 30–60 seconds. Total wizard time: 3–5 minutes.

---

## Phase 4 — Preview & Commitment

**Moment of peak desire.** Before generation, show the user:

- The book's title (AI-generated based on their inputs)
- A preview of what the cover might look like (a static template with their child's name and rough visual style)
- A summary card: _"Here's the story we'll create for [Name]..."_
- **This is where signup/login is requested.** The user has already made 5 steps of investment.

Signup options: Google, Apple, Email. After account creation, generation begins.

---

## Phase 5 — AI Generation

**Waiting experience is a product feature, not dead time.**

- Full-screen progress experience with delightful animations
- Shows "chapters" of the generation: _"Writing the story... Creating your cover... Illustrating chapter 1..."_
- Estimated time displayed: _"Your book will be ready in about 3 minutes"_
- While waiting: show a preview of generic spread samples to build anticipation
- A progress counter: "Page 4 of 24 illustrated..."
- Option: _"Email me when it's ready"_ — great for mobile users

---

## Phase 6 — The Reveal

**The most emotional moment in the entire product.**

- Generation complete → triumphant, joyful animation
- Sound (optional, respects device setting): a soft magical chime
- Copy: _"[Child's name]'s book is ready!"_
- Immediately open the reader in fullscreen — the cover appears first
- Auto-advance to page 2 slowly, like a real book opening
- No paywall yet — let them read the first 5–8 pages for free

---

## Phase 7 — Decision Point (Upgrade)

After free preview pages:

- A soft paywall appears: _"Download the full book in beautiful PDF quality"_
- Show what they get: full 24-page book, print-ready PDF, no watermark
- Clear pricing: _"$12.99 for this book, or $9.99/month for unlimited books"_
- One-click checkout with Apple Pay / Google Pay
- After payment: immediately download, no waiting

---

## Phase 8 — Post-Purchase

- Confirmation page with celebratory animation
- Prompt to share: _"Share the magic — show the world your little hero"_
- Pre-written social copy and shareable link
- Prompt to create a second book ("Create a series" / "Gift to a sibling")
- Email confirmation with download link and receipt
- Onboarding to their personal library/dashboard

---

## Phase 9 — Ongoing Engagement

- Dashboard shows their library of created books
- Monthly email: _"A new adventure is waiting for [Name]"_ — with seasonal book suggestions
- Birthday reminder: _"[Name]'s birthday is in 2 weeks — create their special book"_
- Series prompts: _"Continue [Name]'s adventure — Book 2 available now"_

---

# 4. User Flows

## Flow 1 — First-Time User (No Account)

```
Landing Page
  → Click "Create Your Book"
  → Wizard Step 1: Child's Name
  → Wizard Step 2: Interests & World
  → Wizard Step 3: Story Theme & Setting
  → Wizard Step 4: Child's Appearance
  → Wizard Step 5: Dedication
  → Preview Screen (book title + summary card)
  → Sign Up (Google / Apple / Email) ← signup wall here
  → Generation begins
  → Progress Screen (animated, ~3 min)
  → Reveal Screen (full-screen book reveal)
  → Free Preview (pages 1–7)
  → Paywall (soft, after page 7)
  → Select Plan / Purchase
  → Checkout
  → Success Screen
  → Download PDF
  → Share Prompt
  → Dashboard (first book visible)
```

---

## Flow 2 — Returning User

```
Home / Dashboard (signed in)
  → "Create New Book" button
  → Wizard (pre-filled with saved child profiles)
  → Select existing child OR create new
  → Abbreviated wizard (confirm/update details)
  → Theme & Story selection
  → Review
  → Generation
  → Reveal
  → Download (no paywall if subscribed)
```

---

## Flow 3 — Generating First Book (Detailed)

```
Wizard Entry
  → Step 1: Child's name (text), age (stepper), pronouns (dropdown: he/him, she/her, they/them, custom)
  → Step 2: Interests (tag selector: dinosaurs, space, princesses, animals, sports, etc.)
           + free text: "What's their favorite thing right now?"
           + pet name (optional text field)
  → Step 3: Story theme (tile selector: Adventure, Kindness, Bravery, Creativity, Family, Friendship)
           + Setting (tile selector: Space, Ocean, Jungle, City, Magical Forest, Under the Sea)
           + Lesson (optional dropdown: Believe in yourself, Be kind, Never give up, etc.)
  → Step 4: Appearance
           Option A: Upload photo (AI extracts features for illustration style)
           Option B: Avatar builder (skin tone selector, hair style grid, hair color, eye color, accessories)
  → Step 5: Dedication (optional rich text, max 200 chars, character count shown)
  → Preview Card (title, theme, character name, 2-sentence story summary)
  → Confirm & Generate
```

---

## Flow 4 — Creating a Series

```
Dashboard → Select existing book → "Continue the Adventure" CTA
  → Series prompt: "Book 2 in [Name]'s adventure"
  → Mini-wizard: Theme + Setting (character and appearance pre-filled)
  → Option to "bring a friend" from book 1 into book 2
  → Review
  → Generate
  → Reveal
  → Series shelf view in library (Book 1 and 2 shown together)
```

---

## Flow 5 — Downloading PDF

```
From Reader or Library:
  → Click "Download" icon
  → Modal: "Download [Book Title]"
  → Options: Screen resolution (for digital sharing), Print resolution (300 DPI, for home/pro printing)
  → If free tier: "Upgrade to download"
  → If paid: Download begins immediately
  → Success toast: "Your PDF is ready — check your downloads"
```

---

## Flow 6 — Sharing a Book

```
From Reader or Library:
  → Click "Share" icon
  → Share Options Modal:
      - Copy shareable link (private link, not public by default)
      - Share to Instagram Stories (pre-sized image with book cover)
      - Share to Facebook
      - WhatsApp / iMessage (mobile only)
      - Download shareable image (cover art + "Made with StoryMe")
  → Privacy toggle: "Anyone with the link can view" / "Only I can view"
  → Optional: Add a personal note before sharing
```

---

## Flow 7 — Viewing Previously Generated Books

```
Dashboard → Library tab
  → Grid or list view of all books
  → Each card: cover thumbnail, book title, child's name, creation date, "Read / Download / Share / Delete" actions
  → Click on book → opens in reader
  → Search bar at top: search by name, theme, or date
  → Filters: by child, by theme, by date range
  → Sort: newest first, oldest first, most viewed
```

---

# 5. Features

## Must Have (v1.0 — Launch)

| #   | Feature                    | Description                                                                  |
| --- | -------------------------- | ---------------------------------------------------------------------------- |
| M1  | Book Creation Wizard       | 5-step wizard to capture all personalization inputs                          |
| M2  | AI Story Generation        | Full narrative, age-appropriate, personalized story (20–28 pages)            |
| M3  | AI Illustration Generation | Consistent, high-quality illustrations matching child's appearance and story |
| M4  | Cover Generation           | Custom cover with child's name as title subject                              |
| M5  | In-App Reader              | Smooth page-turning reader for previewing book                               |
| M6  | Free Preview               | First 5–8 pages free, with clear upgrade prompt                              |
| M7  | PDF Download               | Print-quality PDF export (screen + print resolution)                         |
| M8  | Child Avatar Builder       | Skin tone, hair, eyes, accessories selector                                  |
| M9  | Photo Upload               | Upload photo to influence AI character style                                 |
| M10 | Child Profiles             | Save child's details for future books                                        |
| M11 | User Authentication        | Email, Google, Apple sign-in                                                 |
| M12 | Library / Dashboard        | View and manage all created books                                            |
| M13 | Subscription Billing       | Monthly/annual plans via Stripe                                              |
| M14 | Dedication Page            | Custom dedication text in book                                               |
| M15 | Generation Progress Screen | Animated, informative waiting experience                                     |
| M16 | Mobile-Responsive Design   | Full functionality on phone and tablet                                       |
| M17 | Email Notifications        | Generation complete, receipts, marketing                                     |

---

## Should Have (v1.1 — Post-Launch)

| #   | Feature                   | Description                                             |
| --- | ------------------------- | ------------------------------------------------------- |
| S1  | Series Feature            | Link multiple books with same character                 |
| S2  | Social Sharing            | Shareable links and social card exports                 |
| S3  | Age-Adaptive Content      | Story complexity adjusts to child's age                 |
| S4  | Theme Library Expansion   | 20+ themes across genres                                |
| S5  | Multiple Language Support | English, Spanish, French, German, Portuguese at launch  |
| S6  | Sibling Feature           | Two children as co-main characters                      |
| S7  | Book Regeneration         | Regenerate specific pages or full book                  |
| S8  | Page Editing              | Light text editing for individual pages post-generation |
| S9  | Gift Purchase Flow        | Buy for someone else, email delivery                    |
| S10 | Classroom Pack            | Create up to 30 books in batch mode                     |
| S11 | Print-on-Demand           | Physical book delivered via partner printer             |
| S12 | Retention Emails          | Personalized re-engagement sequences                    |
| S13 | Birthday Reminders        | Prompt before child's birthday                          |

---

## Nice to Have (v1.2 — Growth Phase)

| #   | Feature                      | Description                                                  |
| --- | ---------------------------- | ------------------------------------------------------------ |
| N1  | Watermarked Social Preview   | Share page-by-page with watermark for organic virality       |
| N2  | Book Templates               | Start from a seasonal template (Christmas, Halloween...)     |
| N3  | Parent Notes                 | Hidden parent annotations on each page                       |
| N4  | Reading Mode                 | Simplified large-text reader for children reading themselves |
| N5  | Book Collections             | Group books into "Lily's Library" curated shelf              |
| N6  | Classroom Integration        | Roster import for teachers                                   |
| N7  | Affiliate / Referral Program | Earn credits for referring friends                           |
| N8  | API for B2B                  | White-label or embedded solution for partner brands          |

---

## Future (Roadmap — see Section 20)

- Audiobook generation
- EPUB export
- AR page experiences
- Physical book printing with premium binding
- Video story with voice narration
- Interactive stories with branching paths

---

# 6. Screens

## Screen 1 — Landing Page

**Purpose:** Convert visitors into users by demonstrating emotional value instantly.

**Main Components:**

- Hero section: headline, subheadline, CTA button, looping video/gif of child's reaction
- How It Works section: 3-step visual (Tell us about them → We create their book → Download & share)
- Sample book carousel: swipeable preview of 4–5 real generated books (anonymized)
- Testimonials: parent quotes + star ratings (5 reviews shown, expandable)
- Pricing teaser: "Books from $12.99 or $9.99/month"
- Footer: FAQ, About, Privacy, Terms, Contact

**User Actions:** Click CTA, browse sample books, scroll reviews, click pricing

**States:**

- Default: full landing page
- Mobile: stacked layout, CTA above fold

**Errors:** None (static page)

**Loading:** Full page loads with skeleton for sample book carousel

---

## Screen 2 — Wizard (5 sub-screens)

**Purpose:** Capture personalization data in the most delightful, low-friction way possible.

**Main Components:**

- Progress bar (top, 5 nodes labeled with icons)
- Step title + warm subtitle
- Input fields (designed as cards/tiles, not form fields where possible)
- "Continue" button (primary, bottom)
- "Back" button (secondary, left)
- Estimated completion time ("3 minutes total, you're on step 2 of 5")

**User Actions:** Enter data, select tiles, upload photo, go back/forward

**States:**

- Default (empty fields)
- Partial (some fields complete)
- Complete (all required fields done, Continue enabled)
- Error (missing required field)
- Photo upload pending

**Errors:**

- Required field empty: inline validation message below field ("Please enter a name")
- Photo too small: "This photo is too small — try one over 300px wide"
- Photo face not detected: "We couldn't find a face in this photo — try another one"

**Loading:** Photo upload shows upload progress bar

---

## Screen 3 — Preview / Confirmation Screen

**Purpose:** Create desire and commitment just before signup, by showing what the book will be.

**Main Components:**

- Animated book cover mockup (generic style, personalized name visible)
- Book title (AI-generated)
- 2-sentence story summary
- List of features ("24 illustrated pages, print-quality PDF, yours forever")
- "Create My Book" CTA (primary)
- "Edit My Answers" link (secondary)

**User Actions:** Proceed to sign up, edit inputs

**States:**

- Default: summary shown
- Logged-in user: proceeds directly to generation (no sign-up)

**Errors:** None (display-only screen)

**Loading:** Minimal — title and summary may generate in ~2 seconds (streaming text)

---

## Screen 4 — Sign Up / Login

**Purpose:** Create account with minimum friction. User is motivated at this point.

**Main Components:**

- "Almost there — create your free account" headline
- Google Sign-In button (primary)
- Apple Sign-In button
- Divider: "or"
- Email field + Continue button
- "By continuing, you agree to our Terms and Privacy Policy" footnote

**User Actions:** Sign in with Google/Apple, enter email

**States:**

- Default
- Email entered (Continue enabled)
- Error (invalid email, existing account)
- Loading (sign-in in progress)

**Errors:**

- Invalid email: "Please enter a valid email address"
- Already registered: "You already have an account — sign in instead" (with sign-in link)
- Google auth failure: "Something went wrong with Google — try another method"

---

## Screen 5 — Generation Progress

**Purpose:** Transform the waiting period into a magical, anticipated experience.

**Main Components:**

- Full-screen, branded illustration (child in the story world — abstract, not their character yet)
- Animated headline that cycles through generation stages: "Writing [Name]'s story..." / "Designing the cover..." / "Illustrating the adventure..."
- Progress bar with percentage
- Current stage indicator (4–6 stages shown as steps)
- Estimated time remaining: "Ready in about 2 minutes"
- Option: "Email me when it's ready" toggle
- Fun fact / tip carousel at bottom: "Did you know? All our stories are 100% original — never the same twice."

**User Actions:** Toggle email notification, wait passively

**States:**

- Active generation (default)
- Email notification toggled on
- Nearing completion (progress bar fills, animation shifts to "almost ready!")
- Complete → auto-transition to Reveal

**Errors:**

- Generation failure: See Error section (Section 12)

**Loading:** This IS the loading screen

---

## Screen 6 — Book Reveal

**Purpose:** Deliver the emotional peak of the entire product. Maximum delight.

**Main Components:**

- Full-screen book cover animation (flies in, opens)
- Child's name displayed prominently: "Lily's Cosmic Adventure is ready!"
- Triumphant, warm animation (stars, sparkles — matching the book's theme)
- "Open My Book" button (primary, large)
- Subtle background music / chime (respects device silent mode)

**User Actions:** Open book, share immediately (secondary option)

**States:**

- Reveal animation playing
- Static (after animation completes)

---

## Screen 7 — In-App Book Reader

**Purpose:** Let the user experience the full book in a beautiful, immersive reading environment.

**Main Components:**

- Page spread (two-page layout on desktop, single page on mobile)
- Navigation: left/right arrows, swipe on mobile
- Page counter: "Page 4 of 24"
- Top toolbar: Share, Download, Bookmark, Fullscreen, Close
- Thumbnail strip at bottom (optional, toggleable)
- Paywall overlay after page 7 (free tier)

**User Actions:** Turn pages, swipe, zoom, fullscreen, download, share, bookmark

**States:**

- Reading (default)
- Fullscreen
- Paywall overlay (free tier users)
- Zoomed in
- Last page (shows completion CTA: "Create another book" / "Download your book")

**Errors:**

- Page failed to load: shows placeholder with refresh icon

**Loading:** Pages preload 2 ahead; loading skeleton on slow connections

---

## Screen 8 — Dashboard / Library

**Purpose:** Central hub for managing all books and child profiles.

**Main Components:**

- Header: Logo, Account menu, "Create New Book" button (persistent CTA)
- Child profile selector (avatar row at top for families with multiple children)
- Book grid: cards showing cover, title, child name, date created
- Search bar
- Filter tabs: All / By Child / By Theme / Shared With Me
- Sort control: Newest / Oldest / A–Z
- Empty state (first visit)

**User Actions:** Create new book, click book to open, search, filter, sort, manage profiles

**States:**

- Populated (has books)
- Empty (no books yet)
- Loading (skeleton cards)
- Filtered view
- Search results

**Errors:**

- Failed to load library: "Having trouble loading your library — refresh to try again"

---

## Screen 9 — Account Settings

**Purpose:** Manage account, subscription, and preferences.

**Sub-screens:** Profile, Subscription, Billing, Notifications, Language, Privacy

**Main Components:** Left nav (desktop) / tab bar (mobile), form fields, save button

---

## Screen 10 — Checkout / Upgrade

**Purpose:** Convert free users or complete book purchase cleanly and with trust.

**Main Components:**

- Plan summary card (what they're buying, what they get)
- Price displayed clearly (no hidden fees)
- Payment: Apple Pay / Google Pay (above the fold) + credit card form
- Trust signals: "Secure checkout", SSL badge, money-back guarantee
- Subscription terms in plain English: "You'll be charged $9.99/month, cancel anytime"
- Submit CTA: "Get My Book"

**User Actions:** Choose payment method, enter card, complete purchase

**States:**

- Default
- Processing payment
- Success → redirect to download/reader
- Error (card declined, etc.)

---

## Screen 11 — Gift Purchase Flow

**Purpose:** Allow someone to buy a book as a gift without the recipient having an account.

**Main Components:**

- Gift recipient name field
- Gift message (optional, shown in email delivery)
- Delivery option: Send now / Schedule for a date
- Recipient email
- From name
- Payment

**User Actions:** Fill gift details, choose delivery, pay, confirm

---

## Screen 12 — Onboarding (First-Time, Post-Purchase)

**Purpose:** Orient new users to the dashboard and surface the next logical action.

**Main Components:**

- Welcome banner: "Welcome to StoryMe, [Name]! Your library is ready."
- Book card for the first created book (prominent)
- 3 quick-action cards: "Download PDF", "Share with Family", "Create Another Book"
- Tooltip overlays on first visit to dashboard

---

# 7. Book Creation Wizard

## Overview

The wizard is the product's most critical UX surface. It must feel like a creative experience — not a form. Every field should feel like a gift being built, not a survey being filled in.

**Design Principles for the Wizard:**

- Inputs are tiles, image pickers, sliders, and tag selectors — not text fields wherever possible
- Every screen has one primary action
- Progress is always visible
- Typing is kept to a minimum
- Defaults are always provided so the user can proceed without making every decision

---

## Step 1 — About the Child

**Purpose:** Establish the main character.

**Fields:**

| Field      | Type           | Required | Default   | Validation                         |
| ---------- | -------------- | -------- | --------- | ---------------------------------- |
| First Name | Text input     | Yes      | None      | 1–30 chars, letters only           |
| Nickname   | Text input     | No       | None      | 0–20 chars                         |
| Age        | Stepper (1–12) | Yes      | 5         | Min 1, Max 12                      |
| Pronouns   | Dropdown       | Yes      | "she/her" | She/her, He/him, They/them, Custom |

**Helper text beneath Age:** _"Age helps us match the reading level and story themes to [Name]'s world."_

**Validation:** Name is required to proceed. Age and pronouns have defaults — user can always proceed.

**Default values:** Age = 5, Pronouns = not pre-selected (explicit choice respects privacy).

**Progress:** Step 1 of 5. "4 more steps to [Name]'s book."

---

## Step 2 — Their World

**Purpose:** Add depth and personalization to the story through specific details.

**Fields:**

| Field                      | Type                      | Required    | Default | Validation      |
| -------------------------- | ------------------------- | ----------- | ------- | --------------- |
| Interests                  | Tag picker (multi-select) | Yes (min 1) | None    | Select 1–5 tags |
| Favorite color             | Color picker              | No          | None    | Optional        |
| Best friend's name         | Text input                | No          | None    | 0–30 chars      |
| Pet name                   | Text input                | No          | None    | 0–30 chars      |
| Favorite food              | Text input                | No          | None    | 0–30 chars      |
| Something they're proud of | Text input                | No          | None    | 0–100 chars     |

**Interest Tags Available (phase 1):**
Dinosaurs, Space & Rockets, Animals, Princesses & Castles, Superheroes, Under the Sea, Robots & Tech, Sports, Music, Art & Drawing, Cooking, Nature & Gardening, Magic & Wizards, Cars & Trucks, Ballet & Dance, Science Experiments

**Helper text:** _"The more you tell us, the more personal the story will feel."_

**Validation:** Minimum one interest selected to proceed.

---

## Step 3 — Their Story

**Purpose:** Choose the narrative frame — theme, setting, and the lesson the book will teach.

**Fields:**

| Field        | Type                      | Required | Default               | Validation                              |
| ------------ | ------------------------- | -------- | --------------------- | --------------------------------------- |
| Story Theme  | Tile grid (single select) | Yes      | None                  | Must select one                         |
| Setting      | Tile grid (single select) | Yes      | None                  | Must select one                         |
| Story Mood   | Tile grid (single select) | No       | "Exciting & Fun"      | Optional                                |
| Story Lesson | Dropdown                  | No       | "Believe in yourself" | Optional                                |
| Book length  | Toggle                    | No       | "Standard (24 pages)" | Standard / Extended (32 pages, premium) |

**Story Themes:**

- A Grand Adventure (child embarks on an epic quest)
- A Problem to Solve (child uses cleverness to save the day)
- A New Friend (child learns about kindness and connection)
- Believe in Yourself (child overcomes self-doubt)
- A Magical Discovery (child discovers a secret world)
- Protecting Nature (child saves the environment)
- Bravery (child faces and conquers a fear)
- Celebrating You (birthday / milestone story)

**Settings:**
Space, Enchanted Forest, Deep Ocean, Snowy Mountains, Bustling City, Ancient Kingdom, Futuristic World, Prehistoric Era, Desert Island, Magical Library

**Story Mood (visual tone guide):**
Exciting & Fun, Cozy & Warm, Epic & Grand, Silly & Playful, Mysterious & Magical

**Navigation:** Steps 1–2 available to go back. Step 4 unlocked only on forward.

---

## Step 4 — Their Look

**Purpose:** Define the child's character appearance for illustrations.

**Two Modes (user selects):**

**Mode A — Upload a Photo**

- Drag-and-drop or file picker
- Supported formats: JPG, PNG, HEIC
- Max file size: 10 MB
- AI processes the photo to extract: skin tone, hair color/style, facial features
- After upload: "We found [Name]'s look! Here's how they'll appear in the story." (shows style-transferred avatar preview)
- Option to adjust features after photo processing

**Mode B — Build an Avatar**

| Feature     | Options                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------- |
| Skin Tone   | 12-tone Fitzpatrick-extended palette (shown as circles, not described as "light/dark")        |
| Hair Style  | 20 options across textures (straight, curly, coily, wavy, locs, buns, braids, short, long...) |
| Hair Color  | Full palette including fantasy colors (for whimsy)                                            |
| Eye Color   | 12 options                                                                                    |
| Glasses     | Yes / No                                                                                      |
| Accessories | Hair accessories, freckles, birthmarks                                                        |
| Body Type   | Not included in v1 — full-body avoided to prevent sensitivity issues                          |

**Default:** User must make explicit choices — no problematic defaults.

**Validation:** At least skin tone must be selected in avatar mode. Photo processing must succeed in photo mode.

**Edge cases:** Photo processing failure → fallback to avatar builder with a warm message: _"We had trouble reading the photo — let's build [Name]'s look together!"_

---

## Step 5 — Dedication & Finishing Touches

**Purpose:** Add the emotional personal layer — who this book is from.

**Fields:**

| Field                   | Type       | Required | Default | Validation                         |
| ----------------------- | ---------- | -------- | ------- | ---------------------------------- |
| Dedication message      | Textarea   | No       | None    | 0–250 chars, character count shown |
| From name               | Text input | No       | None    | 0–50 chars                         |
| Include dedication page | Toggle     | No       | On      |                                    |
| Book language           | Dropdown   | No       | English | All supported languages            |

**Dedication preview:** As the user types, they see a styled preview of how it will appear in the book (serif font, ornamental border, warm background).

**Dedication template suggestions** (below textarea): _"For my brave explorer...", "To [Name], who makes every day magical...", "This story was made just for you, with all my love..."_

---

## Wizard Navigation Rules

- The "Back" button always preserves filled-in data
- Closing the browser mid-wizard shows a modal: "You're almost there — your book will be lost if you leave now. Save your progress?"
- If user is logged in: auto-save progress to server (recoverable on return)
- If user is not logged in: local storage save, with a nudge to sign up to save progress
- Keyboard navigation: Tab between fields, Enter to proceed, Escape to open exit confirmation

---

# 8. Dashboard

## Overview

The Dashboard is the user's home base — their personal library of magical books. It should feel warm and curated, like a beautifully organized bookshelf, not a data table.

---

## Layout (Desktop)

```
[Logo]  [Library] [Child Profiles]  [Settings] [Account Avatar]    [+ Create New Book]
─────────────────────────────────────────────────────────────────────────────────────
[Child selector row: avatar circles — Lily | Noah | + Add Child]

[Search bar: "Search your books..."]                     [Filter ▾] [Sort: Newest ▾]

┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐
│ Book Cover │  │ Book Cover │  │ Book Cover │  │ + New Book │
│            │  │            │  │            │  │            │
│ Lily's     │  │ Lily's     │  │ Noah's     │  │  Create    │
│ Space      │  │ Ocean      │  │ Dino       │  │  a new     │
│ Adventure  │  │ Quest      │  │ World      │  │  story     │
│            │  │            │  │            │  │            │
│ June 2026  │  │ May 2026   │  │ April 2026 │  │            │
│ [Read][↓]  │  │ [Read][↓]  │  │ [Read][↓]  │  │            │
└────────────┘  └────────────┘  └────────────┘  └────────────┘
```

---

## Book Card

Each book card contains:

- Cover thumbnail (full bleed)
- Book title
- Child's name
- Creation date
- Word count or page count ("24 pages")
- Quick actions on hover: Read, Download, Share, More (...)
- "More" menu: Rename, Delete, Add to Series, Gift This Book

---

## Search

- Full-text search across: book title, child name
- Searches in real time (debounced, 300ms)
- Results highlight matched text
- No results state: "No books found for '[query]' — try a different search"

---

## Filters

- By Child: dropdown with all child profiles
- By Theme: multi-select checkboxes (Adventure, Kindness, etc.)
- By Date: date range picker
- By Status: All / Downloaded / Not Downloaded / Shared

---

## Sorting

- Newest first (default)
- Oldest first
- A–Z by title
- By child's name

---

## Child Profiles

**Profiles bar** (row of avatars at top of dashboard):

- Click on child avatar → filters library to that child's books
- "All" option at the left (default)
- "+ Add Child" at the end
- Hovering shows tooltip: child's name and age

**Child Profile Detail (accessible via avatar click → "Edit Profile"):**

- Name, nickname, age, pronouns
- Saved appearance (avatar or reference photo thumbnail)
- List of books featuring this child
- Option to delete profile (confirmation required, does not delete books)

---

## Stats Widget (Optional — Premium Users)

Small widget below the child selector showing:

- Total books created
- Total pages read (if reading tracking enabled)
- Current plan
- "Next birthday: 12 days" (if birthday saved)

---

# 9. Book Reader

## Overview

The Book Reader is where the emotional payoff of the product lives. It must feel like a premium digital book experience — not a PDF viewer embedded in an iframe.

---

## Layout

**Desktop (2-page spread):**

```
[← Back]   [Title]   [🔖 Bookmark] [⛶ Fullscreen] [↓ Download] [↗ Share] [✕]
─────────────────────────────────────────────────────────────────────────────────
                    ╔═══════════╦═══════════╗
                    ║           ║           ║
                    ║  PAGE 4   ║  PAGE 5   ║
                    ║           ║           ║
                    ║ [Illus.]  ║ [Illus.]  ║
                    ║           ║           ║
                    ║  Text     ║  Text     ║
                    ║           ║           ║
                    ╠═══════════╩═══════════╣
             [ ◀ ]  ████████████░░░░░░░░   [ ▶ ]
                         Page 4-5 of 24
```

**Mobile (single page, swipe):**

- Full-screen single page
- Swipe left/right to turn pages
- Tap center to show/hide toolbar
- Double-tap to zoom
- Bottom progress bar always visible

---

## Navigation

- Left/right arrow buttons (desktop)
- Swipe gesture (mobile / tablet)
- Keyboard: left/right arrow keys (desktop)
- Page jump: click on progress bar to skip to any page
- Thumbnail strip: toggleable panel at bottom (desktop) showing mini thumbnails of all pages

---

## Zoom

- Pinch-to-zoom (touch devices)
- Ctrl + scroll wheel (desktop)
- Zoom in button in toolbar
- Min zoom: fit-to-screen. Max zoom: 300%
- Double-tap: toggles between fit-to-screen and 150%

---

## Fullscreen

- Button in toolbar
- Keyboard shortcut: F (desktop)
- Exits fullscreen: Esc, or click fullscreen button again
- In fullscreen: toolbar auto-hides after 3 seconds of inactivity, reappears on mouse move / tap

---

## Bookmarks

- Bookmark icon in toolbar → bookmarks current page
- Bookmark indicator: small ribbon icon on bookmarked page thumbnails
- Bookmarks panel: accessible from toolbar, lists all bookmarked pages with thumbnail
- Max 10 bookmarks per book

---

## Download

- Download button in toolbar
- Modal: choose resolution (Screen Quality for sharing / Print Quality 300 DPI for printing)
- Progress indicator while PDF generates (if not already cached)
- Download starts automatically when ready

---

## Sharing from Reader

- Share button in toolbar
- Share Modal (detailed in Flow 6 above)
- Option to share specific page (generates image of that spread)

---

## Paywall in Reader (Free Tier)

- After page 7: a soft overlay appears on the next page
- Overlay: blurred page + message: "This is where the adventure really takes off! Download the full book to keep reading."
- Two CTAs: "Get This Book ($12.99)" and "Subscribe for Unlimited Books ($9.99/mo)"
- Previous pages remain fully accessible — user does not lose their preview

---

## Reading Progress

- Reading position auto-saved (returns to last page on reopen)
- "Continue reading" shown on book card in library if partially read

---

# 10. Settings

## Account Settings — Structure

**Navigation:** Left sidebar on desktop, bottom tab bar on mobile.

---

## 10.1 Profile

**Fields:**

- Display name (text input)
- Email address (view only; change requires email verification)
- Profile avatar (upload or default initials avatar)
- Change password (if email/password auth)
- Connected accounts: Google / Apple (connect/disconnect)
- Account creation date (display only)

**Actions:** Save changes, Delete Account (at bottom, destructive — see confirmation flow)

---

## 10.2 Child Profiles

- List of all saved child profiles
- Edit / Delete each
- Add new child profile
- (Same as dashboard child profile management — synced)

---

## 10.3 Subscription

**Sections:**

- Current plan name and price
- Next billing date
- What's included (feature list for current plan)
- Upgrade CTA (if on free or lower plan)
- Downgrade / Cancel link (secondary, at bottom)

**Cancellation Flow:**

- User clicks "Cancel Subscription"
- Retention modal: "We're sorry to see you go. Before you cancel, did you know you have [X] books remaining at your current rate?"
- Options: "Keep My Subscription" / "Cancel Anyway"
- If cancel confirmed: confirmation, access maintained until period end, "Reactivate anytime" message

---

## 10.4 Billing

- Payment method on file (masked card number or Pay method)
- Change payment method
- Billing address
- Invoice history (list of past invoices with download link)

---

## 10.5 Language

- App interface language (dropdown): English, Spanish, French, German, Portuguese, Italian, Dutch, Japanese, Korean, Mandarin
- Default book language (separate from UI language) — same options
- RTL layout toggle (auto-enabled for Arabic/Hebrew when supported)

---

## 10.6 Notifications

**Toggle categories:**

- Email: Generation complete, Marketing, Newsletter, Seasonal promotions
- Push (if PWA installed): Generation complete, Birthday reminders
- Reminder settings: "Remind me X days before [Child]'s birthday" (per child)

---

## 10.7 Privacy

- Data download request ("Download my data")
- Account deletion ("Delete my account and all data")
- Cookie preferences
- Data sharing opt-out

---

# 11. AI Generation Experience

## Philosophy

The waiting period is not dead time — it is part of the magic. A parent who waits 3 minutes watching their child's name being woven into a story is more emotionally invested, not less. We design the wait to be anticipated, not dreaded.

---

## Generation Stages (Shown to User)

| Stage | Label Shown to User               | Approx. Duration |
| ----- | --------------------------------- | ---------------- |
| 1     | "Imagining [Name]'s story..."     | 15s              |
| 2     | "Writing the adventure..."        | 30s              |
| 3     | "Designing the cover..."          | 20s              |
| 4     | "Creating [Name]'s character..."  | 30s              |
| 5     | "Illustrating the pages..."       | 90s              |
| 6     | "Adding the finishing touches..." | 15s              |
| 7     | "Binding [Name]'s book..."        | 10s              |

Total: ~3.5 minutes average

---

## Progress Indicator Design

- Large circular or linear progress bar (themed to story setting — e.g., rocket ship moving across stars for a space book)
- The progress indicator itself changes based on the book's theme:
  - Space book: rocket traveling across a starfield
  - Ocean book: submarine descending
  - Forest book: character walking through trees
- Stage label pulses gently when transitioning between stages
- Percentage number shown in small text below the animation

---

## Partial Previews

At the 40% completion mark, a partial preview is unlocked:

- The cover appears (draft quality, low-res)
- Copy: "Here's a first look at [Name]'s cover! The full book is almost ready..."
- This is a significant engagement and retention mechanism — the user sees something real

---

## Estimated Time Display

- _"Ready in about 3 minutes"_ shown at start
- Counts down: _"About 2 minutes left"_, _"Almost ready!"_
- If generation is running slower than expected (>5 minutes): _"We're putting extra care into your book — almost there!"_
- Never show a frozen timer — always indicate activity

---

## "Email Me When Ready" Option

- Simple toggle in the progress screen
- If toggled on: user can close the tab and will receive an email with a link to their generated book
- Email arrives within 60 seconds of generation completing
- Subject: "[Name]'s book is ready! ✨"

---

## Animations

- All animations are smooth, 60fps CSS/SVG-based
- Themed to the book's chosen setting and color palette
- Subtle, not distracting — delightful background activity
- Respect prefers-reduced-motion CSS media query (switch to simple progress bar for accessibility)

---

## Retry Experience

**Soft Retry (Single Page Failure):**

- If one illustration fails to generate: silently retry (up to 3x)
- If still failing: use a style-appropriate placeholder illustration, flag for background reprocessing
- User never sees individual page failure unless the entire book fails

**Hard Retry (Full Generation Failure):**

- Error screen (see Section 12)
- "Try Again" button that restores all inputs
- No re-entry required — one click to restart generation with same inputs

---

## Failure Recovery

- All user inputs are persisted in session and account
- If generation fails: inputs are not lost
- User can retry immediately or return to dashboard and continue later
- "In Progress" state visible on dashboard for pending generations
- Background retry: system automatically reattempts failed generations once (within 30 minutes)

---

# 12. Errors

## Error Design Philosophy

Every error message should:

1. Clearly explain what happened (no technical jargon)
2. Tell the user what to do next
3. Preserve their work wherever possible
4. Feel warm, not alarming

---

## Complete Error Catalog

| Error ID | Trigger                                    | User-Facing Message                                                                                                     | Recovery Action                                              |
| -------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| E01      | Generation timeout (>10 min)               | "We're taking a little longer than expected with [Name]'s book. We'll keep working and email you when it's done."       | Auto-email on completion; "Go to Dashboard" button           |
| E02      | Generation failure (all retries exhausted) | "Something went wrong while creating [Name]'s book. Don't worry — your details are saved and no charge was made."       | "Try Again" button (restores inputs); "Contact Support" link |
| E03      | Photo face not detected                    | "We couldn't quite make out a face in that photo — try a clearer, front-facing photo, or build [Name]'s look yourself." | "Try Another Photo" / "Build Their Look"                     |
| E04      | Photo too small                            | "This photo is quite small — for the best result, use a photo at least 400px wide."                                     | "Choose a Different Photo"                                   |
| E05      | Photo file too large                       | "This file is larger than 10MB. Try a smaller image or a JPEG format."                                                  | "Choose a Different Photo"                                   |
| E06      | Unsupported file type                      | "We can't use that file type. Please upload a JPG, PNG, or HEIC photo."                                                 | "Try Again"                                                  |
| E07      | Payment declined                           | "Your card was declined. Please check your details or try a different payment method."                                  | Re-enter card / try another                                  |
| E08      | Payment processing error                   | "Something went wrong with your payment — it was not charged. Please try again."                                        | Retry payment                                                |
| E09      | Network loss during generation             | "It looks like you went offline. Your book is still being created — check back in a few minutes."                       | "Check My Library" button                                    |
| E10      | PDF download failure                       | "Your download didn't start. Try again, or we can email the PDF to you."                                                | Retry / email option                                         |
| E11      | Session expired                            | "You've been away for a while — please sign in again to continue."                                                      | Sign in prompt (data preserved)                              |
| E12      | Account already exists                     | "An account with that email already exists. Sign in instead?"                                                           | Sign in link                                                 |
| E13      | Invalid promo code                         | "That promo code doesn't look right or may have expired."                                                               | Re-enter / continue without                                  |
| E14      | Plan limit reached (free)                  | "You've reached the limit of your free plan. Upgrade to create more books."                                             | Upgrade CTA                                                  |
| E15      | Book content policy                        | "We weren't able to create a story with those inputs — try adjusting your theme or details."                            | Edit inputs in wizard                                        |
| E16      | Server error (500)                         | "Something went wrong on our end. Our team has been notified. Please try again in a few minutes."                       | Retry button; status page link                               |
| E17      | Book not found (404)                       | "This book doesn't seem to exist — it may have been deleted."                                                           | Go to Library                                                |
| E18      | Share link expired                         | "This share link has expired. Ask the owner to share it again."                                                         | Contact link                                                 |
| E19      | PDF generation failure                     | "We had trouble creating your PDF. Try again — it usually works on the second attempt."                                 | Retry PDF                                                    |

---

## Error UI Components

- **Toast notifications** (3 seconds, bottom center): for minor, transient errors (E09, E10)
- **Inline field errors**: for form validation (E03, E04, E12)
- **Full-page error screens**: for critical failures (E02, E16, E17)
- **Modal errors**: for payment issues (E07, E08)
- **Banner errors**: for account/limit issues (E14)

All error screens include:

- Friendly illustration (not a red exclamation mark)
- Primary recovery action (button)
- Secondary action (contact support link)

---

# 13. Empty States

## Philosophy

Empty states are opportunities, not dead ends. Each one should explain what the space will contain and give the user a clear, single action to fill it.

---

| Screen                         | Trigger                               | Headline                                | Subtext                                                                                   | CTA                      |
| ------------------------------ | ------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------ |
| Library — No Books             | First time user, no books yet         | "Your library is empty — for now"       | "Create your first personalized book and watch the magic happen."                         | "Create Your First Book" |
| Library — No Search Results    | Search returns nothing                | "No books found for '[query]'"          | "Try a different search, or create a new book with that name."                            | "Create a New Book"      |
| Library — Filtered, No Results | Filter returns nothing                | "No books match this filter"            | "Try a different filter or clear your current selection."                                 | "Clear Filters"          |
| Child Profiles — No Children   | No profiles saved                     | "Add your little hero"                  | "Save a child's profile to create books faster in the future."                            | "Add a Child"            |
| Bookmarks in Reader            | No bookmarks yet                      | "No bookmarks yet"                      | "Tap the bookmark icon on any page to save your place."                                   | (Dismiss)                |
| Series — No Books in Series    | Created series container but no books | "Start your series"                     | "This is where all of [Name]'s adventures will live. Create Book 1 to begin."             | "Create Book 1"          |
| Notifications                  | No notifications                      | "All caught up!"                        | "We'll notify you here when your books are ready and when there's something new for you." | (No action)              |
| Billing — No Invoices          | First-time paid user                  | "Your billing history will appear here" | "Once you're billed, you'll find your invoices and receipts here."                        | (No action)              |
| Shared With Me                 | No books shared                       | "No shared books yet"                   | "When someone shares a StoryMe book with you, it'll appear here."                         | (No action)              |

---

# 14. Success States

## Philosophy

Success states celebrate the user's action. In a product built on emotional resonance, every success should reinforce that the user did something meaningful.

---

## Success State 1 — Book Generation Complete

**Trigger:** AI generation finishes.

**Experience:**

- Full-screen animated reveal (themed to book setting)
- Confetti or sparkle animation (CSS, respects prefers-reduced-motion)
- Headline: _"[Name]'s book is ready!"_
- Subtext: _"You just created something no bookstore can sell. Open it and see."_
- Primary CTA: "Open My Book"
- Secondary CTA: "Share the Magic"

---

## Success State 2 — Purchase Complete

**Trigger:** Payment processes successfully.

**Experience:**

- Confirmation modal (not a separate page — prevents navigation confusion)
- Checkmark animation
- Headline: _"You're all set!"_
- Subtext: _"[Name]'s book is yours. Download it, read it, share it — forever."_
- CTAs: "Download PDF Now" / "Read in App"
- Background: receipt email sent automatically

---

## Success State 3 — PDF Downloaded

**Trigger:** PDF download completes.

**Experience:**

- Toast notification at bottom: _"[Name]'s book downloaded successfully!"_
- Icon: download checkmark
- Duration: 4 seconds, then fades
- No interruption to current activity

---

## Success State 4 — Book Shared

**Trigger:** Share link copied or social share initiated.

**Experience:**

- Toast: _"Share link copied to clipboard!"_
- If social share: opens native share sheet (mobile) or new tab (desktop)
- Optional: "Let us know how they react — tag us @storyme"

---

## Success State 5 — Child Profile Saved

**Trigger:** New child profile created or updated.

**Experience:**

- Inline success: form fields briefly highlight green
- Toast: _"[Name]'s profile saved!"_

---

## Success State 6 — Subscription Activated

**Trigger:** First subscription payment succeeds.

**Experience:**

- Full-page welcome screen: _"Welcome to StoryMe [Plan Name]!"_
- List of unlocked features (animated list build-up)
- CTA: "Create Your First Book" (if no books yet) or "Go to My Library"
- Background email: welcome to subscription, what's included

---

## Success State 7 — Series Created

**Trigger:** Second book in a series generated.

**Experience:**

- Success modal showing both books side by side: _"[Name]'s adventure continues!"_
- CTA: "Read Book 2" / "View the Series"

---

# 15. Subscription Model

## Guiding Principles

- The product must have a clear, irresistible free tier that creates desire for the paid version
- Pricing should feel effortless — no confusion about what you get
- The most popular plan should be obvious
- Never punish existing customers — grandfathered pricing for early adopters

---

## Free Tier

**Name:** Starter (Free)

**What's Included:**

- Create up to 1 book per month
- Read the first 8 pages in the app
- Watermarked preview (cover image only) for sharing
- 1 child profile

**What's Not Included:**

- Full book download (PDF)
- Print-quality PDF
- Multiple child profiles
- Access to premium themes
- Series feature

**Purpose:** Let users fall in love with the product before paying. The book is already created — they just can't download it without paying. This is the core freemium hook.

---

## Pay-Per-Book

**Name:** Single Book

**Price:** $12.99 per book

**What's Included:**

- Full 24-page book PDF (screen quality)
- Print-quality PDF (300 DPI)
- Permanent access in library
- Unlimited in-app reads
- Share link (no watermark)

**Best For:** Gift buyers, occasional users, testing before subscribing

---

## Monthly Subscription

**Name:** Family Plan

**Price:** $9.99/month (or $79.99/year — saves 33%)

**What's Included:**

- Unlimited books per month
- Print-quality PDF on all books
- All child profiles (unlimited)
- Series feature
- Priority generation (faster queue)
- All premium themes and settings
- Extended book option (32 pages)
- Early access to new features

**Best For:** Engaged parents who want to create regularly

**Badge:** "Most Popular" shown on pricing page

---

## Annual Plan

**Name:** Family Plan Annual

**Price:** $79.99/year ($6.67/month)

**All features of monthly, plus:**

- 2-month discount vs. monthly
- Priority customer support
- "Founding Member" badge in profile

---

## Classroom Pack (B2B Adjacent)

**Name:** Educator Pack

**Price:** $49.99 flat / classroom use case

**What's Included:**

- Create up to 30 books (one per student)
- Simplified input for each student (name, interests, appearance)
- Batch generation (all 30 books generated overnight)
- Watermarked digital PDFs included (print-quality at $2 per book additional)
- No subscription required

**Best For:** Teachers, tutors, school counselors, reading programs

---

## Enterprise / White Label (Future)

**Name:** StoryMe for Business

**Price:** Custom pricing

**Use Cases:** Book publishers, retail brands, children's brands, hospital systems (therapeutic use)

**What's Included:** White-labeled experience, API access, custom branding, volume discounts, dedicated support

---

## Pricing Page Design Principles

- Show monthly/annual toggle prominently (annual should be default view)
- Side-by-side comparison table (3 plans: Free / Single Book / Family)
- Feature rows: checkmarks and X marks
- Social proof: "Join over 250,000 families"
- FAQ at bottom: What happens if I cancel? Do books expire? Can I change plans?
- Money-back guarantee: "30-day money-back guarantee — no questions asked"

---

# 16. Viral Features

## Core Philosophy

The product is inherently shareable because the output is _beautiful and personal_. We don't need to manufacture virality — we need to remove friction from the natural desire to share.

---

## V1 — The Share Link

Every book gets a private shareable link. Recipients can read the full book in the browser (no account required). At the bottom of the shared book: _"Create a book for your child — free to start."_

This is our most powerful acquisition channel. Every shared book is a product demo.

---

## V2 — Social Cards

One-click social sharing generates:

- An Instagram-optimized image of the book cover (with child's name prominently featured)
- A short clip/GIF of 3 pages turning
- Pre-written caption: _"I made [Name] the hero of their very own book with @storyme ✨ Link in bio!"_

Parents will share these because their child's name is on the cover and it looks beautiful.

---

## V3 — "Page of the Day" Feature

Users can select their favorite page from the book and share it as a standalone image. Each image has a subtle "Made with StoryMe" watermark — organic brand exposure.

---

## V4 — The Gift Flow

When a user buys a book as a gift:

- The recipient gets a beautiful email with a digital "book opening" experience
- Bottom of the email: "Create a book for your child — made for you by [Sender Name] on StoryMe"
- Recipients convert at very high rates because they've already experienced the product's magic

---

## V5 — Referral Program

- Share a unique link: "Give your friend their first book free"
- When the friend signs up and generates a book: referring user gets a free book credit
- Simple, generous, and aligns incentives — referring users share with people who will genuinely value it

---

## V6 — Class / Group Gifting

For teachers: share a "class book" (single student) with the parents of that student as a surprise.

For families: create a book together — each family member contributes a detail (grandma adds the dedication, mom picks the theme, dad adds the pet's name).

---

## V7 — "Print & Show" Campaign

Encourage users who print their book physically to share a photo with #MyStoryMeBook. Feature the best photos on the homepage and in email newsletters. Run seasonal contests ("Show us your reading moment").

---

## V8 — Birthday Book Sharing

On the child's birthday (if saved in profile), prompt the parent to share the book on social media: _"Today is [Name]'s birthday! Here's the book we made just for them."_ Pre-built social post, one tap to share.

---

## V9 — Embedded Reader for Gift Recipients

When a grandparent buys a book as a gift and shares the link, the child can read the book in a beautiful full-screen reader in the browser with no account. If they love it, the parent account upsell happens naturally.

---

## V10 — "Send to Grandparents" Feature

A dedicated "share with family" flow that makes it trivially easy to send the book via WhatsApp, text, or email — with a template message already written. Grandparents are a major acquisition segment via children.

---

# 17. Retention Features

## Philosophy

Retention is built on two foundations: emotional attachment and habits. The emotional attachment forms the moment a child sees their book. The habit forms when we give parents a reason to come back on a predictable schedule.

---

## R1 — Birthday Reminder

On signup (or child profile creation), ask for the child's birthday. 2 weeks before, send:

- Email: _"[Name]'s birthday is coming up! Create their birthday book now."_
- Push notification (if enabled)

Birthday books are a natural, recurring purchase event.

---

## R2 — Monthly Book Prompt

For subscription users: _"It's [Month] — time for a new adventure! Here are this month's featured themes:"_ with 3 seasonal theme suggestions.

For free/pay-per-book users: _"What's [Name] into this month? We have a new Space Explorer theme just added!"_

---

## R3 — Series Continuity

Once a user creates a series, they are inherently motivated to continue it. The dashboard shows:

- "[Name]'s Adventure — Book 1 of ?" with a glowing "Book 2" placeholder card
- Occasional prompts: "It's been 3 weeks — is [Name] ready for their next adventure?"

Series users retain significantly better than single-book users.

---

## R4 — Seasonal Themes (Content Calendar)

New themes added every month aligned to cultural moments:

- January: New Year, New Adventure (new beginnings theme)
- February: The Kindness Quest (Valentine's)
- March: The St. Patrick's Day Mystery
- April: The Garden of Secrets (spring/earth)
- May: A Hero for Mom (Mother's Day)
- June: The Summer Journey
- July: The Independence Explorer
- August: Back to School (confidence theme)
- September: Autumn Magic
- October: The Friendly Halloween
- November: The Gratitude Quest (Thanksgiving)
- December: The Winter Wonderland / Holiday Story

Users who return monthly for seasonal books have the highest LTV.

---

## R5 — Sibling Milestones

When a sibling announcement is a common life event, we surface a prompt: _"Is there a new baby joining [Name]'s family? Create a 'Big Brother/Sister' story — a perfect way to prepare them for the new arrival."_

Users who create a "new sibling" book often become long-term subscribers.

---

## R6 — Reading Streaks (Gamification, Light)

Track reading sessions and show a gentle "reading streak" on the dashboard. Not gamified aggressively, but a warm: _"[Name] has been read to 5 days in a row! Keep the streak alive."_

---

## R7 — Re-engagement Email Sequence

For users who haven't opened the app in 30 days:

- Day 30: _"[Name]'s library is waiting for you — here's a new theme we think they'll love."_
- Day 45: _"Is [Name] still interested in dinosaurs? We just added the Dino Explorer theme."_
- Day 60: Personal note from "the StoryMe team" — genuine, warm, not automated-feeling

---

## R8 — Annual "Year in Books" Email

Each January: _"What a year of stories! Here's a look at the books [Name] starred in..."_ A beautifully designed email showing all the books created that year, with a cover grid. Deeply sentimental, drives social sharing and renewal intent.

---

## R9 — "Gift a Book" Prompts

Before major gift occasions (Christmas, Hanukkah, grandparent's day), prompt users to gift a book to another child. Increases purchase frequency and acquires new users via gifts.

---

## R10 — What Changed in [Name]'s World?

After 3 months, prompt users: _"[Name] is 3 months older now! Update their profile and create a new story that reflects who they are today."_ Child profiles feel like growing documentation of the child's life.

---

# 18. Accessibility

## Standards Compliance

The product targets **WCAG 2.1 AA** compliance at launch, with a roadmap to AAA for core flows.

---

## Visual Accessibility

**Color Contrast:**

- All text: minimum 4.5:1 contrast ratio against backgrounds
- Large text (>18px): minimum 3:1
- Never rely on color alone to convey information — always pair with icon or text
- All interactive elements have visible focus states

**Font Sizes:**

- Base body text: minimum 16px
- No text below 12px anywhere in the interface
- User can increase text size via browser/OS settings without layout breaking

**Typography:**

- Dyslexia-friendly font option available in reader settings (OpenDyslexic or Lexie Readable)
- Line height minimum 1.5 in body text
- Maximum line length: 80 characters

**Image Alt Text:**

- Every illustration in generated books has AI-generated descriptive alt text
- All UI icons have aria-label
- Decorative images have empty alt=""

---

## Motor Accessibility

**Keyboard Navigation:**

- All functionality accessible via keyboard alone
- Tab order logical and follows visual layout
- No keyboard traps
- All custom UI components (tile selectors, avatar builder) keyboard-navigable

**Click Targets:**

- All interactive elements minimum 44x44px tap/click area
- Sufficient spacing between interactive elements (minimum 8px)

**Drag & Drop:**

- All drag-and-drop interactions have a keyboard or click alternative

---

## Cognitive Accessibility

**Wizard Design:**

- One question per screen (no cognitive overload)
- Clear progress indicator
- "Back" always available (no commitment anxiety)
- All field labels are plain English — no jargon
- Tooltips available on hover/focus for any unclear field

**Error Messages:**

- All errors explain clearly what happened and what to do next
- No timeout pressures on forms
- Form data persisted across navigation

**Animations:**

- All animations respect `prefers-reduced-motion` CSS media query
- Animation-heavy screens (progress, reveal) have static fallback mode
- No flashing content (seizure safe — no content flashing more than 3 times per second)

---

## Assistive Technology

**Screen Readers:**

- Full ARIA landmark structure: `<nav>`, `<main>`, `<aside>`, `<header>`, `<footer>`
- Dynamic content changes (wizard steps, progress updates) announced via `aria-live`
- Generated book is readable by screen readers (text content accessible separately from images)

**Semantic HTML:**

- Headings in correct hierarchy (h1 → h2 → h3, no skipping)
- Lists use proper `<ul>/<ol>/<li>`
- Buttons are `<button>`, links are `<a>` — no div-as-button

---

## Language Accessibility

- All UI text reviewed for plain language (Flesch-Kincaid grade 8 target for UI copy)
- No idioms or culturally specific metaphors in UI copy
- All user-facing strings translatable (i18n-ready from launch)

---

## Book Accessibility (Generated Content)

Each generated book will include:

- Machine-readable text for each page (alongside illustrations)
- Alt text for each illustration (AI-generated)
- Option to download the book text as a plain text file (for screen reader users)
- Future: high-contrast illustration style option

---

# 19. Internationalization

## Phase 1 Launch Languages

| Language   | Locale       | RTL | Status |
| ---------- | ------------ | --- | ------ |
| English    | en-US, en-GB | No  | Launch |
| Spanish    | es-ES, es-MX | No  | Launch |
| French     | fr-FR        | No  | Launch |
| German     | de-DE        | No  | Launch |
| Portuguese | pt-BR        | No  | Launch |

---

## Phase 2 Languages (3–6 months post-launch)

Italian, Dutch, Polish, Swedish, Norwegian, Danish, Japanese, Korean

---

## Phase 3 Languages (6–12 months post-launch)

Mandarin Chinese (Simplified), Traditional Chinese, Arabic, Hebrew, Hindi, Turkish

---

## Internationalization Architecture

**UI Strings:**

- All UI text extracted to locale files (JSON format)
- No hardcoded English strings anywhere in codebase
- Strings reviewed by native speakers, not just machine-translated
- Locale-aware date formats, number formats, currency symbols

**Book Content:**

- Stories generated in the selected language by the AI (not translated — written natively in the target language)
- Story themes and cultural references validated by native editorial reviewers
- Children's names in books remain as entered by the user
- Age-appropriate language calibrated per locale (children's vocabulary varies by language)

**Illustrations:**

- Illustrations are language-agnostic (images only, no embedded text)
- Any text in illustrations (signs, book covers within the book) generated in the target language
- Cultural settings in story options reviewed for global relevance

**Currencies and Pricing:**

- Pricing localized per market (not just USD with currency conversion)
- VAT/GST applied per jurisdiction
- Payment methods per locale (Klarna in Nordics, iDEAL in Netherlands, etc.)

**RTL Support:**

- Full layout mirroring for Arabic and Hebrew
- Font choices appropriate for RTL scripts
- Progress bars and reading indicators reversed for RTL
- Book reading direction: right-to-left for RTL languages (page turn direction reversed)

---

## Content Localization

**Story Themes:** Reviewed for cultural sensitivity per locale. Some themes may be re-named or excluded per market.

**Names:** No validation that rejects non-English names. All Unicode characters accepted in name fields.

**Honorifics and Pronouns:** Pronoun options adapted per language (some languages have different gender conventions in story grammar).

**Child Safety Standards:** Content moderation rules calibrated per regional legal standards (COPPA/US, GDPR-K/EU, etc.).

---

# 20. Future Features

## The Next 50+ Ideas

### Audiobook & Media

1. AI-generated audiobook narration — professional voice reads the full story
2. Multi-voice narration — different voices for each character
3. Background music score that matches the book's mood and setting
4. Sound effects on each page (rustle of forest leaves, spaceship engine hum)
5. Synchronized audio + text highlighting (karaoke-style for early readers)
6. Parent narration recording — record yourself reading and attach to the book

### Interactive & Dynamic

7. Interactive story mode — children make choices at key moments (branching narrative)
8. "What happens next?" feature — child dictates what the hero does next (voice input)
9. Mini-games embedded between chapters (age-appropriate, story-themed)
10. AR page activation — point phone at page to see illustration animate
11. Hidden objects on each illustration page (seek-and-find layer)
12. Puzzle pages — illustration broken into a simple jigsaw the child solves

### Physical Products

13. Premium hardcover book printing (sewn binding, thick pages)
14. Softcover book printing (more affordable physical option)
15. Giant poster printing — a single illustration page printed large
16. Custom puzzle — illustration turned into a 50-piece jigsaw puzzle
17. Personalized bookplate stickers (adhesive name labels for books)
18. Custom bookmarks featuring the child's character

### Social & Community

19. Family reading rooms — share a book in a private space for the whole family to read together in real time
20. "Read with Me" mode — parent and grandparent can read simultaneously from different devices
21. Reaction recording — grandparent records their face while reading; attached to the book as a memory
22. Community "Story Wall" — anonymized book covers celebrated publicly (opt-in only)
23. Parent community forum — share favorites, suggest themes, vote on new content
24. "Favorite Page" voting — family members vote on their favorite illustration

### Educational & Developmental

25. Curriculum-aligned stories — themes that support specific learning standards
26. Vocabulary builder mode — age-appropriate words highlighted and defined
27. Discussion questions at end of book (for parents and teachers)
28. Comprehension quiz pages embedded in the book
29. "Read It Yourself" mode — simplified text for early readers learning to read
30. Sight words integration for pre-K books (Dolch word list)

### Personalization Depth

31. Include real places — "set the adventure in [child's hometown]"
32. Real pets as supporting characters (upload pet photo, generate pet character)
33. Extended family — include grandparent, aunt/uncle as supporting characters
34. Twin stories — two separate children, each is the hero of the same story (gift for siblings)
35. "Mood-matched" books — parent describes child's current emotional state; book addresses it
36. Scary-things story — child's real fear is the dragon they defeat (therapeutic)
37. "This week in [Name]'s life" — photo-journal style book from a week's phone photos

### Platform & Ecosystem

38. iOS native app
39. Android native app
40. Apple Watch companion (reading reminders, reading streaks)
41. Alexa / Google Home integration — "Alexa, read me [Name]'s book"
42. Kindle/e-reader EPUB export
43. iBooks Author integration
44. Siri / Google Assistant shortcut — "Hey Siri, create a book for Lily"

### Business & Scale

45. White-label platform for children's book publishers
46. Hospital program — personalized books for children undergoing medical treatment (therapeutic)
47. Library system integration — librarians create books for library programs
48. School district licensing — create books for every student school-wide
49. BookBirth — partner program with hospitals for newborn gift books
50. Corporate gifting program — companies gift books to employees' children
51. Franchise opportunity — licensed StoryMe kiosks in toy stores / libraries

### Creator & Customization

52. Style selection — choose from multiple illustration styles (watercolor, cartoon, storybook classic, modern flat)
53. Custom story starting point — parent writes the first paragraph; AI continues
54. "My words in the story" — include child's own quotes or sayings they use
55. Chapter book mode — multi-chapter format for older children (8–12)
56. Non-fiction adventure — "The Day [Name] Learned to Ride a Bike" documentary style
57. Wordless picture book mode — illustrations only, parents narrate themselves

### Safety & Trust

58. Parental review mode — parent approves every page before the book is finalized
59. Illustration content rating system — choose illustration intensity (very gentle vs. more exciting)
60. Story content guardian — parent sets keywords/topics to exclude from all stories

---

_End of Product Requirements Document_

---

**Document Version:** 1.0
**Status:** Draft for Review
**Next Steps:** UX team to produce wireframes based on Section 6–9; Engineering to review Section 7 (Wizard) for feasibility; AI team to review Section 11 (Generation Experience) for timing accuracy; Pricing committee to validate Section 15 against market research.
