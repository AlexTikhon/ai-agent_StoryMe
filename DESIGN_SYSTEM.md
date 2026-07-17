# Design System

## StoryMe — Visual Language & UI Engineering Reference

**Version 1.0 | Design System Document**
**Prepared by: Design Systems Team | Date: June 2026**

> This document is the single source of truth for all visual decisions. It bridges UX Specification and Frontend Engineering. A designer can build the full UI in Figma from this document. A frontend engineer can implement it without inventing visual rules.
>
> Companion documents: `PRD.md` · `UX_SPEC.md` · `ARCHITECTURE.md` · `ROADMAP.md`

---

# Table of Contents

1. Design Principles
2. Design Foundations
3. Color System
4. Typography System
5. Iconography
6. Illustration Style
7. Elevation System
8. Motion System
9. Component Design Language
10. Forms Design
11. Empty States
12. Error States
13. Loading States
14. Success States
15. Responsive UI Rules
16. Accessibility
17. Design Tokens
18. Theme Strategy
19. Component Naming Convention
20. Design System Governance

---

# 1. Design Principles

## 1.1 The Guiding Metaphor: "Apple Meets Pixar"

Every visual decision is filtered through a single metaphor: **Apple's restraint applied to Pixar's emotional depth.**

Apple contributes: precision, whitespace, trust, hierarchy, and the sense that every pixel is intentional.

Pixar contributes: warmth, character, joy, storytelling through visuals, and the feeling that something magical is possible.

The result is a product that parents find sophisticated and trustworthy, while children find delightful and inviting. It avoids both the cold sterility of enterprise software and the visual noise of toy-store aesthetics.

---

## 1.2 Principle 1 — Emotion Is Information

In StoryMe, visual design carries emotional content, not just structural content. Color, typography weight, illustration style, and motion all communicate emotional state — anticipation during generation, delight at reveal, warmth during reading.

**Implication:** Don't default to neutral when emotional is appropriate. The book reveal screen should feel celebratory. The dedication page preview should feel intimate. The error state should feel reassuring.

**Rule:** Every screen has an emotional target. Design to hit it.

---

## 1.3 Principle 2 — The Child Sees, The Parent Judges

The child's first impression is visual: illustration quality, their name on the cover, the richness of the world. The parent's first impression is trustworthiness: layout clarity, pricing transparency, professional typography, responsive quality.

**Implication:** The product must win two audiences simultaneously. The reading experience (reader, book reveal) is child-forward. The purchasing and account experience (checkout, settings) is parent-forward.

**Rule:** Book-facing surfaces lean warm and expressive. App-facing surfaces lean clean and professional.

---

## 1.4 Principle 3 — Whitespace Is Structure

Generous whitespace is not empty space — it is visual breathing room that signals quality and helps parents trust the product. Crowded layouts feel cheap. Premium products give elements room.

**Implication:** Increase margin and padding beyond what feels "enough." Default to more space, not less. The spacing scale steps up in multiples of 4px but leans toward the larger end.

**Rule:** When in doubt, add space.

---

## 1.5 Principle 4 — One Moment Per Screen

Each screen communicates one thing. The generation screen communicates anticipation. The reveal communicates joy. The paywall communicates value. Cluttered screens dilute the emotional target.

**Implication:** Remove elements that don't serve the screen's primary purpose. Resist the urge to add promotions, tips, or secondary information to screens designed for a single moment.

**Rule:** Ask "what is the one thing this screen must make the user feel?" — then design for that and only that.

---

## 1.6 Principle 5 — Consistency Creates Trust

Parents are trusting this platform with photos of their children and their credit cards. Consistent visual behavior — predictable button placement, consistent color usage, familiar component behavior — builds subconscious trust.

**Implication:** Never deviate from established patterns without a strong reason. If an action is always a primary button, it is always a primary button. If an error is always red, it is always red.

**Rule:** The design system is the contract. Honor it.

---

## 1.7 Principle 6 — Delight Without Distraction

Micro-interactions, animations, and delightful details are welcome when they enhance the emotional moment. They are not welcome when they slow down a task or draw attention away from content.

**Implication:** Animation in the generation screen builds anticipation. Animation on a settings form adds noise. Know the context.

**Rule:** Delight is contextual. It is most appropriate at moments of achievement and discovery.

---

## 1.8 Principle 7 — Accessible by Design, Not by Retrofit

Accessibility decisions — contrast ratios, touch targets, focus states, motion preferences — are made at the design level, not added after implementation.

**Implication:** The color palette is designed with contrast ratios baked in. The spacing scale guarantees touch target compliance. Focus rings are part of the visual design, not a browser default override.

**Rule:** If it doesn't pass WCAG AA at design time, it doesn't ship.

---

# 2. Design Foundations

## 2.1 Base Unit

All spacing, sizing, and layout measurements derive from a **base unit of 4px**. Every measurement in the system is a multiple of 4.

```
1 unit  = 4px
2 units = 8px
4 units = 16px
6 units = 24px
8 units = 32px
...
```

---

## 2.2 Spacing Scale

| Token       | Multiplier | px    | rem      | Common Use                               |
| ----------- | ---------- | ----- | -------- | ---------------------------------------- |
| `space-0`   | 0          | 0px   | 0        | —                                        |
| `space-px`  | —          | 1px   | —        | Hairline borders                         |
| `space-0.5` | —          | 2px   | 0.125rem | Micro gaps                               |
| `space-1`   | ×1         | 4px   | 0.25rem  | Icon padding, badge gaps                 |
| `space-2`   | ×2         | 8px   | 0.5rem   | Inline element gaps, tight padding       |
| `space-3`   | ×3         | 12px  | 0.75rem  | Input vertical padding                   |
| `space-4`   | ×4         | 16px  | 1rem     | Default padding, list gaps               |
| `space-5`   | ×5         | 20px  | 1.25rem  | Card padding (mobile)                    |
| `space-6`   | ×6         | 24px  | 1.5rem   | Card padding (desktop), section dividers |
| `space-8`   | ×8         | 32px  | 2rem     | Component gaps                           |
| `space-10`  | ×10        | 40px  | 2.5rem   | Section padding (compact)                |
| `space-12`  | ×12        | 48px  | 3rem     | Section padding (standard)               |
| `space-16`  | ×16        | 64px  | 4rem     | Page section gaps                        |
| `space-20`  | ×20        | 80px  | 5rem     | Large section separators                 |
| `space-24`  | ×24        | 96px  | 6rem     | Hero padding                             |
| `space-32`  | ×32        | 128px | 8rem     | Extra large hero areas                   |

---

## 2.3 Grid System

### Desktop (≥1024px)

- **Columns:** 12
- **Gutter:** 24px
- **Margin:** 48px (each side)
- **Max content width:** 1200px
- **Max wide content:** 1440px (hero sections, full-bleed)

### Tablet (768px – 1023px)

- **Columns:** 8
- **Gutter:** 20px
- **Margin:** 32px (each side)

### Mobile (< 768px)

- **Columns:** 4
- **Gutter:** 16px
- **Margin:** 16px (each side)

### Contextual Grids

| Context           | Grid                                                         |
| ----------------- | ------------------------------------------------------------ |
| Wizard            | 1 column, max-width 560px, centered                          |
| Dashboard         | CSS Grid, auto-fill (see column count table in UX Spec §7.2) |
| Reader            | Viewport-filling, no grid                                    |
| Settings          | 2-column (240px sidebar + content) on desktop                |
| Landing marketing | 12-col, max 1440px                                           |
| Checkout          | 1-column, max-width 480px, centered                          |

---

## 2.4 Container Widths

| Token            | Width  | Use                                       |
| ---------------- | ------ | ----------------------------------------- |
| `container-xs`   | 480px  | Auth pages, checkout, narrow wizard steps |
| `container-sm`   | 640px  | Wizard steps, confirmation screens        |
| `container-md`   | 768px  | Content pages, blog posts                 |
| `container-lg`   | 1024px | Settings, compact dashboard               |
| `container-xl`   | 1200px | Main dashboard, standard pages            |
| `container-2xl`  | 1440px | Landing page, full-width marketing        |
| `container-full` | 100%   | Reader, generation screen                 |

---

## 2.5 Vertical Rhythm

All vertical spacing between text elements follows a consistent rhythm based on the line-height scale. The rhythm unit is **8px** for body content, **4px** for compact UI.

Relationships:

- Paragraph to paragraph: `space-4` (16px)
- Heading to following paragraph: `space-3` (12px)
- Section to section: `space-12` (48px) desktop / `space-8` (32px) mobile
- Label to input: `space-2` (8px)
- Input to input: `space-5` (20px)
- Input to submit button: `space-6` (24px)

---

## 2.6 Safe Areas

On mobile, respect device safe areas for:

- Bottom navigation: add `env(safe-area-inset-bottom)` padding
- Top bar on notched devices: `env(safe-area-inset-top)`
- Reader fullscreen: extend background to edges but keep content within safe area

---

# 3. Color System

## 3.1 Palette Philosophy

The palette is built on three decisions:

1. **Warm over cool.** Every neutral leans warm (stone/sand undertones, not blue-gray). This gives the product a paper-like, bookish warmth. It aligns with the product's identity as a storytelling platform.

2. **Deep violet as brand primary.** Violet sits between the cool authority of blue and the warm creativity of purple. It reads as magical without being garish. At deeper tones, it reads as sophisticated and trustworthy to parents.

3. **Amber as celebration accent.** Warm amber/gold appears exclusively at moments of joy — success states, sparkle animations, book reveal. It creates a Pavlovian association: amber means something good happened.

---

## 3.2 Primary Palette — Story Violet

| Token        | Hex       | HSL           | Use                                   |
| ------------ | --------- | ------------- | ------------------------------------- |
| `violet-50`  | `#F8F5FF` | 265° 100% 98% | Tinted background surfaces            |
| `violet-100` | `#EEE8FF` | 263° 100% 96% | Hover backgrounds, tinted panels      |
| `violet-200` | `#D9CEFF` | 262° 100% 90% | Chip backgrounds, subtle fills        |
| `violet-300` | `#BBA8FF` | 261° 100% 83% | Decorative, illustration accents      |
| `violet-400` | `#9879F8` | 258° 90% 72%  | Disabled primary, lighter interactive |
| `violet-500` | `#7B54F0` | 256° 83% 64%  | Hover on primary button               |
| `violet-600` | `#6535E0` | 254° 74% 55%  | **Primary brand color — CTAs, links** |
| `violet-700` | `#5122C4` | 252° 70% 45%  | Pressed state, active nav             |
| `violet-800` | `#3E19A0` | 251° 72% 36%  | Dark accent, deep UI                  |
| `violet-900` | `#2D1180` | 249° 76% 29%  | Very dark, decorative only            |
| `violet-950` | `#180960` | 247° 80% 21%  | Near-black for themed overlays        |

**Primary = `violet-600` (#6535E0)**

---

## 3.3 Secondary Palette — Celebration Amber

| Token       | Hex       | HSL          | Use                               |
| ----------- | --------- | ------------ | --------------------------------- |
| `amber-50`  | `#FFFCF0` | 45° 100% 97% | Tinted success backgrounds        |
| `amber-100` | `#FFF5CC` | 44° 100% 90% | Celebration surface               |
| `amber-200` | `#FFE99A` | 44° 100% 81% | Highlight backgrounds             |
| `amber-300` | `#FFD966` | 45° 100% 70% | Sparkle accents, star elements    |
| `amber-400` | `#FFC833` | 45° 100% 60% | Bright celebration                |
| `amber-500` | `#F5A800` | 42° 100% 48% | **Secondary brand / celebration** |
| `amber-600` | `#CC8800` | 40° 100% 40% | Amber text on light               |
| `amber-700` | `#A36A00` | 39° 100% 32% | Dark amber                        |
| `amber-800` | `#7A4E00` | 38° 100% 24% | Very dark amber                   |
| `amber-900` | `#523300` | 38° 100% 16% | Decorative only                   |

**Celebration accent = `amber-500` (#F5A800)**

---

## 3.4 Neutral Palette — Warm Stone

Deliberately warm (not blue-gray). Evokes the warmth of paper, books, and physical storytelling materials.

| Token       | Hex       | HSL         | Use                             |
| ----------- | --------- | ----------- | ------------------------------- |
| `stone-50`  | `#FAFAF8` | 60° 10% 98% | Page background                 |
| `stone-100` | `#F5F4F1` | 50° 10% 96% | Subtle surface                  |
| `stone-200` | `#E8E6E1` | 45° 10% 90% | Borders, dividers               |
| `stone-300` | `#D6D3CC` | 45° 8% 82%  | Disabled borders                |
| `stone-400` | `#A8A49B` | 43° 6% 63%  | Placeholder text, icons (muted) |
| `stone-500` | `#79746A` | 40° 6% 45%  | Secondary text                  |
| `stone-600` | `#57524A` | 38° 7% 32%  | Body text (secondary)           |
| `stone-700` | `#3F3A33` | 36° 9% 23%  | Body text (primary)             |
| `stone-800` | `#28241E` | 34° 13% 14% | Headings                        |
| `stone-900` | `#1A1714` | 32° 13% 9%  | Near-black                      |
| `stone-950` | `#0D0B09` | 30° 17% 5%  | True near-black                 |

---

## 3.5 Semantic Colors

### Success — Leaf Green

| Token           | Hex       | Use                      |
| --------------- | --------- | ------------------------ |
| `success-light` | `#ECFDF5` | Background tint          |
| `success-base`  | `#16A34A` | Icons, text, borders     |
| `success-dark`  | `#15803D` | Text on light success bg |
| `success-fill`  | `#22C55E` | Success indicators       |

### Warning — Warm Amber

| Token           | Hex       | Use                      |
| --------------- | --------- | ------------------------ |
| `warning-light` | `#FFFBEB` | Background tint          |
| `warning-base`  | `#D97706` | Icons, text, borders     |
| `warning-dark`  | `#B45309` | Text on light warning bg |
| `warning-fill`  | `#F59E0B` | Warning indicators       |

### Danger — Warm Red

| Token          | Hex       | Use                                       |
| -------------- | --------- | ----------------------------------------- |
| `danger-light` | `#FEF2F2` | Background tint                           |
| `danger-base`  | `#DC2626` | Icons, text, borders, destructive buttons |
| `danger-dark`  | `#B91C1C` | Text on light danger bg                   |
| `danger-fill`  | `#EF4444` | Error indicators                          |

### Info — Violet-adjacent Blue

| Token        | Hex       | Use                   |
| ------------ | --------- | --------------------- |
| `info-light` | `#EFF6FF` | Background tint       |
| `info-base`  | `#2563EB` | Icons, text, borders  |
| `info-dark`  | `#1D4ED8` | Text on light info bg |
| `info-fill`  | `#60A5FA` | Info indicators       |

---

## 3.6 Background & Surface Colors

| Token             | Hex       | Use                                           |
| ----------------- | --------- | --------------------------------------------- |
| `bg-base`         | `#FDFCFB` | Main page background (very slightly warm)     |
| `bg-surface`      | `#FFFFFF` | Cards, modals, elevated surfaces              |
| `bg-subtle`       | `#F5F4F1` | Inset panels, code blocks, striped rows       |
| `bg-muted`        | `#ECEAE5` | Hover on subtle, pressed subtle               |
| `bg-inverse`      | `#1A1714` | Dark overlays, tooltips, dark-themed surfaces |
| `bg-brand`        | `#6535E0` | Brand-colored sections                        |
| `bg-brand-subtle` | `#F8F5FF` | Light violet surface                          |

---

## 3.7 Border Colors

| Token            | Hex       | Use                                       |
| ---------------- | --------- | ----------------------------------------- |
| `border-subtle`  | `#E8E6E1` | Default card borders, dividers            |
| `border-default` | `#D6D3CC` | Input borders (default state)             |
| `border-strong`  | `#A8A49B` | Focused inputs (secondary), table borders |
| `border-inverse` | `#3F3A33` | Borders on dark backgrounds               |
| `border-brand`   | `#6535E0` | Focused input, active components          |
| `border-danger`  | `#DC2626` | Error state input borders                 |
| `border-success` | `#16A34A` | Success state borders                     |

---

## 3.8 Text Colors

| Token               | Hex       | Use                                   |
| ------------------- | --------- | ------------------------------------- |
| `text-primary`      | `#28241E` | Main body text, headings              |
| `text-secondary`    | `#57524A` | Supporting text, labels               |
| `text-muted`        | `#79746A` | Placeholder, disabled text, captions  |
| `text-disabled`     | `#A8A49B` | Disabled elements                     |
| `text-inverse`      | `#FDFCFB` | Text on dark backgrounds              |
| `text-brand`        | `#6535E0` | Links, brand text                     |
| `text-brand-subtle` | `#7B54F0` | Interactive text on light backgrounds |
| `text-danger`       | `#DC2626` | Error messages                        |
| `text-success`      | `#15803D` | Success messages                      |
| `text-warning`      | `#D97706` | Warning messages                      |

---

## 3.9 Overlay Colors

| Token                | Value                     | Use                       |
| -------------------- | ------------------------- | ------------------------- |
| `overlay-light`      | `rgba(253,252,251, 0.85)` | Blur overlay over content |
| `overlay-dark`       | `rgba(26,23,20, 0.60)`    | Modal backdrop            |
| `overlay-dark-heavy` | `rgba(26,23,20, 0.80)`    | Fullscreen overlay        |
| `overlay-brand`      | `rgba(101,53,224, 0.08)`  | Brand hover tint          |
| `overlay-paywall`    | `rgba(253,252,251, 0.92)` | Paywall blur overlay      |

---

## 3.10 Gradients

| Token                    | Value                                                               | Use                                   |
| ------------------------ | ------------------------------------------------------------------- | ------------------------------------- |
| `gradient-brand`         | `linear-gradient(135deg, #6535E0 0%, #9879F8 100%)`                 | Hero sections, cover art backgrounds  |
| `gradient-celebration`   | `linear-gradient(135deg, #F5A800 0%, #FFD966 100%)`                 | Success banners, reveal overlay       |
| `gradient-warm-fade`     | `linear-gradient(180deg, #FDFCFB 0%, #F5F4F1 100%)`                 | Page section transitions              |
| `gradient-surface-fade`  | `linear-gradient(180deg, transparent 0%, #FDFCFB 100%)`             | Fade-out at end of scrollable content |
| `gradient-cover-overlay` | `linear-gradient(180deg, transparent 40%, rgba(26,23,20,0.7) 100%)` | Text overlay on book covers           |

---

## 3.11 Illustration Color Palette

These colors are used in UI illustrations (empty states, wizard backgrounds, marketing art) — not the AI-generated book content.

| Role                | Hex                   | Notes                      |
| ------------------- | --------------------- | -------------------------- |
| Sky/atmosphere      | `#C4ADFB` → `#EDE9FE` | Gradient backgrounds       |
| Ground/surface      | `#D6B896` → `#F5DEB3` | Warm earth tones           |
| Foliage             | `#4ADE80` → `#86EFAC` | Friendly, not harsh greens |
| Water               | `#38BDF8` → `#BAE6FD` | Soft ocean/sky blues       |
| Character warm skin | `#FBBF8C`             | Mid-range, warm            |
| Character cool skin | `#F5CCB0`             | Lighter, cooler            |
| Character dark skin | `#8D5524`             | Rich, deep                 |
| Fire/magic/energy   | `#F5A800` → `#FF7B2E` | Adventure, action          |
| Night/space         | `#2D1180` → `#180960` | Deep violet-indigo sky     |
| Book/paper          | `#FFF8E7` → `#F5DEB3` | Warm cream                 |

---

## 3.12 Dark Mode Strategy

Dark mode is **v1.1 scope** (not at launch). The token system is designed for dark mode from day one, ensuring no retrofitting is required.

**Dark mode color shifts:**

| Light token            | Dark mode value | Principle                      |
| ---------------------- | --------------- | ------------------------------ |
| `bg-base`              | `#0D0B09`       | Very dark warm black           |
| `bg-surface`           | `#1A1714`       | Dark warm brown-black          |
| `bg-subtle`            | `#28241E`       | Elevated surface               |
| `text-primary`         | `#F5F4F1`       | Near-white, warm               |
| `text-secondary`       | `#A8A49B`       | Muted warm gray                |
| `border-subtle`        | `#3F3A33`       | Dark border                    |
| `violet-600` (primary) | `#9879F8`       | Lightened for dark bg contrast |

**Implementation:** CSS custom properties in `:root` (light) and `.dark` / `[data-theme="dark"]` (dark). All color references use semantic tokens, never raw hex values in components.

---

## 3.13 Contrast Requirements

| Pair                           | Minimum Ratio | Checked Against                |
| ------------------------------ | ------------- | ------------------------------ |
| `text-primary` on `bg-base`    | 12.5:1 ✓      | WCAG AAA                       |
| `text-secondary` on `bg-base`  | 5.8:1 ✓       | WCAG AA                        |
| `text-muted` on `bg-base`      | 4.6:1 ✓       | WCAG AA (barely)               |
| `text-disabled` on `bg-base`   | 2.9:1         | Below AA — decorative use only |
| `text-inverse` on `bg-inverse` | 14:1 ✓        | WCAG AAA                       |
| White text on `violet-600`     | 5.2:1 ✓       | WCAG AA                        |
| White text on `violet-500`     | 4.5:1 ✓       | WCAG AA minimum                |
| White text on `violet-400`     | 3.1:1 ✗       | Fail — never use               |
| `text-brand` on `bg-base`      | 6.8:1 ✓       | WCAG AA                        |
| `text-danger` on `bg-base`     | 5.5:1 ✓       | WCAG AA                        |

**Rule:** Never use violet-400 or lighter as the background for white text. Never use text-disabled for meaningful text content.

---

## 3.14 Color Usage Rules

**Do:**

- Use `violet-600` exclusively for primary CTAs
- Use `amber-500` exclusively for celebration/success moments
- Use semantic tokens (`text-primary`, `bg-surface`) in components — never raw hex
- Use warm stone neutrals for body text and UI chrome
- Use `violet-50`/`violet-100` for tinted panel backgrounds

**Don't:**

- Mix cool grays (blue-gray) with the warm stone palette
- Use more than 2 brand colors on a single screen
- Use gradients on interactive elements (buttons, inputs)
- Apply `amber-500` to error states (it will be confused with celebration)
- Use pure `#000000` black — always use `stone-900` or `stone-950`
- Use pure `#FFFFFF` white for body backgrounds — use `bg-base` (`#FDFCFB`)

---

# 4. Typography System

## 4.1 Font Families

### Display — Fraunces

**Use:** Hero headlines, marketing copy, book-facing display text, wizard step titles.

Fraunces is a variable optical-size serif with a warm, expressive personality. At large sizes it is dramatic and editorial. At small sizes it remains legible and distinctive. It evokes the world of books and storytelling without feeling antiquated.

- Source: Google Fonts (free, variable font)
- Variable axes: `wght` (100–900), `SOFT` (0–100), `WONK` (0–1)
- Recommended settings: `SOFT=0`, `WONK=0` for UI use (balanced form)
- Fallback: Georgia, "Times New Roman", serif

### UI Sans — Plus Jakarta Sans

**Use:** All UI text — labels, body, buttons, inputs, navigation, settings, forms.

Plus Jakarta Sans is a geometric humanist sans with a subtly warm personality (vs. the cooler, more neutral Inter). It communicates clarity and professionalism without feeling clinical. Designed for both marketing and UI contexts.

- Source: Google Fonts (free, variable font)
- Variable axis: `wght` (200–800)
- Fallback: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif

### Book Serif — Lora

**Use:** The generated book's interior text (in the reader). Only used within the book reader component for the story body text.

Lora is a contemporary serif well-optimized for screen reading. It gives the book content a proper literary feel — distinct from the UI chrome, signaling that the reader has entered a different context (a book, not a web app).

- Source: Google Fonts (free)
- Fallback: Georgia, serif

### Accessibility Alternative — OpenDyslexic

**Use:** Reader text when user enables "Dyslexia-friendly" toggle in reader settings.

- Source: Self-hosted (opendyslexic.org, free)

---

## 4.2 Font Loading Strategy

```html
<!-- Preconnect for Google Fonts -->
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />

<!-- Load only needed weights/styles -->
<link
  href="https://fonts.googleapis.com/css2?
  family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600;0,9..144,700;1,9..144,400
  &family=Plus+Jakarta+Sans:wght@400;500;600;700
  &family=Lora:ital,wght@0,400;0,600;1,400
  &display=swap"
  rel="stylesheet"
/>
```

Font-display: `swap` — text is visible immediately, swaps when font loads.

---

## 4.3 Type Scale

Base: 16px. Scale ratio: Major Third (1.25).

| Token       | Size (px) | Size (rem) | Family            | Weight | Line Height  | Letter Spacing | Use                                 |
| ----------- | --------- | ---------- | ----------------- | ------ | ------------ | -------------- | ----------------------------------- |
| `text-xs`   | 12        | 0.75rem    | Plus Jakarta Sans | 400    | 1.5 (18px)   | +0.02em        | Captions, legal, metadata           |
| `text-sm`   | 14        | 0.875rem   | Plus Jakarta Sans | 400    | 1.5 (21px)   | +0.01em        | Secondary body, labels, helper text |
| `text-base` | 16        | 1rem       | Plus Jakarta Sans | 400    | 1.625 (26px) | 0              | Primary body text                   |
| `text-lg`   | 18        | 1.125rem   | Plus Jakarta Sans | 400    | 1.5 (27px)   | -0.01em        | Large body, intro text              |
| `text-xl`   | 20        | 1.25rem    | Plus Jakarta Sans | 600    | 1.4 (28px)   | -0.01em        | Card titles, section labels         |
| `text-2xl`  | 24        | 1.5rem     | Plus Jakarta Sans | 600    | 1.35 (32px)  | -0.02em        | Sub-headings                        |
| `text-3xl`  | 30        | 1.875rem   | Fraunces          | 600    | 1.25 (37px)  | -0.02em        | Page headings                       |
| `text-4xl`  | 36        | 2.25rem    | Fraunces          | 700    | 1.2 (43px)   | -0.03em        | Major headings                      |
| `text-5xl`  | 48        | 3rem       | Fraunces          | 700    | 1.1 (53px)   | -0.03em        | Landing hero (mobile)               |
| `text-6xl`  | 60        | 3.75rem    | Fraunces          | 700    | 1.05 (63px)  | -0.04em        | Landing hero (desktop)              |
| `text-7xl`  | 72        | 4.5rem     | Fraunces          | 800    | 1.0 (72px)   | -0.04em        | Large marketing moments             |

---

## 4.4 Heading Styles

```
H1: text-5xl/text-6xl · Fraunces 700 · text-primary
H2: text-4xl · Fraunces 700 · text-primary
H3: text-3xl · Fraunces 600 · text-primary
H4: text-2xl · Plus Jakarta Sans 600 · text-primary
H5: text-xl · Plus Jakarta Sans 600 · text-secondary
H6: text-lg · Plus Jakarta Sans 600 · text-secondary
```

**Key rule:** H1–H3 use Fraunces (editorial, expressive). H4–H6 use Plus Jakarta Sans (pragmatic, UI-oriented). This distinction reinforces the "emotional but professional" duality.

---

## 4.5 Specialized Text Styles

| Style          | Spec                                 | Use                             |
| -------------- | ------------------------------------ | ------------------------------- |
| `label-sm`     | 12px / PJS 600 / +0.05em / uppercase | Form labels, filter headers     |
| `label-base`   | 14px / PJS 600 / +0.01em             | Input labels, card labels       |
| `button-sm`    | 14px / PJS 600 / 0                   | Small buttons                   |
| `button-base`  | 16px / PJS 600 / 0                   | Default buttons                 |
| `button-lg`    | 18px / PJS 700 / -0.01em             | Large buttons (wizard CTA)      |
| `caption`      | 12px / PJS 400 / +0.02em             | Image captions, timestamps      |
| `overline`     | 11px / PJS 700 / +0.12em / uppercase | Eyebrow labels (above headings) |
| `book-body`    | 18px / Lora 400 / 1.8 / 0            | Book reader interior text       |
| `book-body-lg` | 20px / Lora 400 / 1.9 / 0            | Book reader (large text mode)   |
| `dedication`   | 20px / Lora 400 italic / 1.6         | Dedication page text in book    |
| `tag-label`    | 13px / PJS 600 / +0.01em             | Tags, chips, badges             |

---

## 4.6 Responsive Typography

On mobile (< 768px), scale down the larger type sizes to preserve hierarchy within the smaller viewport:

| Token (desktop)   | Mobile override   |
| ----------------- | ----------------- |
| `text-6xl` (60px) | `text-4xl` (36px) |
| `text-5xl` (48px) | `text-3xl` (30px) |
| `text-4xl` (36px) | `text-3xl` (30px) |
| `text-3xl` (30px) | `text-2xl` (24px) |

Body text (`text-base` = 16px) does not scale down — 16px is already the minimum comfortable size for mobile reading.

**Implementation:** Use Tailwind responsive prefixes or CSS clamp():

```css
font-size: clamp(2rem, 4vw + 1rem, 3.75rem); /* text-5xl → text-6xl fluid */
```

---

## 4.7 Font Weight Usage Rules

| Weight | Token            | Use                                        |
| ------ | ---------------- | ------------------------------------------ |
| 400    | `font-normal`    | Body text, secondary labels, captions      |
| 500    | `font-medium`    | Nav items, slightly emphasized body        |
| 600    | `font-semibold`  | Buttons, card titles, labels, sub-headings |
| 700    | `font-bold`      | Headings (H3, H4), primary emphasis        |
| 800    | `font-extrabold` | Hero headlines only (Fraunces)             |

**Rule:** Never use weight below 400 in UI. Weight 300 (light) is for editorial/marketing contexts only, never functional UI.

---

# 5. Iconography

## 5.1 Icon Library

**Primary library: Lucide Icons** (lucide.dev)

Lucide is chosen because:

- Open source (ISC license)
- Consistent 24px artboard, 1.5px stroke width
- 1000+ icons covering all needed UI states
- Available as React components, SVG, and web font
- Actively maintained, growing library

**Custom icon additions** (StoryMe-specific, not in Lucide):

- `book-sparkle`: book with sparkle overlay (used in nav, empty states)
- `wand-star`: magic wand with star (used in generation, CTA)
- `child-avatar`: simplified child silhouette
- `cover-art`: framed illustration thumbnail

Custom icons must match Lucide's stroke width (1.5px) and visual style.

---

## 5.2 Icon Sizes

| Token      | Size | Use                                       |
| ---------- | ---- | ----------------------------------------- |
| `icon-xs`  | 12px | Inline in small text, badge indicators    |
| `icon-sm`  | 16px | Inline in body text, compact UI           |
| `icon-md`  | 20px | Button icons (default), form icons        |
| `icon-lg`  | 24px | Navigation icons, toolbar icons           |
| `icon-xl`  | 32px | Feature callouts, large UI icons          |
| `icon-2xl` | 48px | Illustration-adjacent icons, empty states |
| `icon-3xl` | 64px | Hero icons (very rare)                    |

---

## 5.3 Stroke Width Rules

| Context             | Stroke width | Note                                          |
| ------------------- | ------------ | --------------------------------------------- |
| Default UI          | 1.5px        | All Lucide icons default                      |
| Emphasized UI       | 2px          | Navigation active state, important indicators |
| Delicate/decorative | 1px          | Background decorative use only                |

Never scale stroke width proportionally when resizing icons. Stroke width stays at 1.5px regardless of display size (achieved by scaling SVG viewBox, not stroke).

---

## 5.4 Filled vs. Outlined

| State                | Style                                     | Example                          |
| -------------------- | ----------------------------------------- | -------------------------------- |
| Default / inactive   | Outlined (stroke only)                    | Nav icons, toolbar icons         |
| Active / selected    | Filled (or outlined + solid accent color) | Active tab icon, selected filter |
| Notification / alert | Filled                                    | Notification bell with badge     |
| Empty state          | Outlined (large, muted color)             | Empty library icon               |
| Celebration/success  | Filled + amber accent                     | Success checkmark                |

---

## 5.5 Icon Color Usage

| Context                          | Color token                |
| -------------------------------- | -------------------------- |
| Default nav icon                 | `text-muted` (`stone-400`) |
| Active nav icon                  | `violet-600`               |
| Button icon (on filled button)   | `text-inverse`             |
| Button icon (on outlined button) | `violet-600`               |
| Danger action icon               | `danger-base`              |
| Success icon                     | `success-base`             |
| Muted/decorative                 | `stone-300`                |
| On dark background               | `text-inverse`             |

---

## 5.6 Icon Accessibility

- All standalone icons (not paired with visible text) require `aria-label` or `title`
- Decorative icons (redundant with adjacent text) use `aria-hidden="true"`
- Icon buttons minimum touch target: 44×44px (icon is smaller, padding compensates)
- Colored icons: never rely on color alone to convey meaning — pair with text or shape

---

# 6. Illustration Style

## 6.1 Philosophy

StoryMe's illustration language is **"Dimensional Warmth."**

Not flat 2D vector art — too corporate and cold.
Not photo-realistic — too harsh and literal.
Not cartoon — too childish and untrustworthy.

Instead: a style that suggests dimension, light, and texture, while remaining clearly illustrated (not photographic). Think of the look of high-end animated films' development art, or the interior artwork of a premium Penguin children's picture book.

**Visual reference points:**

- Pixar concept art (warm light, rounded forms, expressive but not exaggerated)
- Chronicle Books children's titles (editorial illustration, clean but human)
- Apple's illustration style for health/education contexts
- Studio Ghibli's background art (depth, atmosphere, warmth)

---

## 6.2 Illustration Types

### Type 1 — Book Cover Art

Generated by AI for each book. Must feel like a real picture book cover:

- Rich, saturated background (setting-appropriate)
- Child character centered or slightly off-center, looking outward
- Title text integrated into the illustration (handlettered aesthetic)
- Warm light source (usually upper-left or upper-center)
- Fine grain texture overlay (≈10% opacity, adds print quality)
- Aspect ratio: 3:4 (portrait book cover)

### Type 2 — Book Interior Illustrations

Generated by AI, one per page spread. Must feel:

- Consistent with the cover style (same color grading, same character model)
- Dynamic compositions (varies per page — close-up, wide shot, action)
- Warm, slightly soft focus on backgrounds (depth-of-field suggestion)
- Characters have consistent features page-to-page

### Type 3 — UI Illustrations (Wizard, Empty States, Marketing)

Created by a human illustrator or AI with human art direction. Must:

- Match the book illustration aesthetic (dimensional warmth)
- Use the illustration color palette defined in §3.11
- Avoid showing specific child faces (wizard backgrounds are abstract world scenes)
- Be available in 3 sizes: mobile (320px wide), tablet (640px), desktop (960px)
- Include a `prefers-reduced-motion` static fallback for animated variants

### Type 4 — Icon Illustrations (Large decorative icons)

Used in empty states, success screens. Style:

- Monochromatic or 2-tone (uses brand violet palette)
- Consistent stroke weight with Lucide icons (1.5px → scaled)
- Simple, clear silhouettes
- Not photorealistic

---

## 6.3 Wizard Step Illustrations

Each wizard step has a companion illustration that fills the right half of the desktop layout and sits above the form on mobile. These illustrations are abstract scene-setters (no specific child character) that evoke the magic of the story world.

| Step                | Illustration Scene                                                     |
| ------------------- | ---------------------------------------------------------------------- |
| Step 1 — Name       | Open book with light emanating from pages, floating name letters       |
| Step 2 — World      | Whimsical map/globe of story settings, floating interest icons         |
| Step 3 — Story      | Split-scene of different themes (space / ocean / forest) with doorways |
| Step 4 — Look       | Artist's palette with illustrated character silhouettes emerging       |
| Step 5 — Dedication | Open letter / envelope with ribbon, warm golden light                  |

---

## 6.4 Empty State Illustrations

Each empty state has a dedicated illustration. Style: warm, inviting, uses the illustration palette. Not sad, not stark. Welcoming.

| Empty State         | Illustration                                                       |
| ------------------- | ------------------------------------------------------------------ |
| No books in library | Open empty bookshelf with a single glowing spot for the first book |
| No search results   | Magnifying glass looking at a gentle question mark amid pages      |
| No child profiles   | Abstract outline of a child shape, ready to be filled              |
| No bookmarks        | Open book with a single falling ribbon                             |

---

## 6.5 Visual Consistency Rules

1. **Light source:** All illustrations use a warm light source from the upper-left or upper-center. No cool blue light.
2. **Shadows:** Soft, warm-tinted shadows (not black). Use `rgba(26,23,20, 0.15)` as a starting point.
3. **Outline style:** Characters have very subtle outline (darker shade of their surface color, not black)
4. **Color temperature:** Illustrations should feel warm overall. Cool colors (blues, greens) are present but in supporting roles.
5. **Grain texture:** A subtle grain overlay (5–12% opacity noise texture) on all illustrations adds print quality.
6. **Aspect consistency:** Within a book, all illustrations use the same aspect ratio and maintain consistent horizon line placement.

---

# 7. Elevation System

## 7.1 Shadow Scale

Shadows use a warm tint (`rgba(26,23,20, …)`) instead of pure black. This keeps shadows harmonious with the warm neutral palette.

| Token                 | CSS Value                                                            | Use                          |
| --------------------- | -------------------------------------------------------------------- | ---------------------------- |
| `shadow-none`         | `none`                                                               | Flat, no elevation           |
| `shadow-xs`           | `0 1px 2px rgba(26,23,20, 0.06), 0 1px 1px rgba(26,23,20, 0.04)`     | Subtle card lift, tags       |
| `shadow-sm`           | `0 2px 4px rgba(26,23,20, 0.08), 0 1px 2px rgba(26,23,20, 0.06)`     | Default card                 |
| `shadow-md`           | `0 4px 8px rgba(26,23,20, 0.10), 0 2px 4px rgba(26,23,20, 0.06)`     | Hover state cards, dropdowns |
| `shadow-lg`           | `0 8px 16px rgba(26,23,20, 0.12), 0 4px 8px rgba(26,23,20, 0.06)`    | Modals, floating panels      |
| `shadow-xl`           | `0 16px 32px rgba(26,23,20, 0.14), 0 8px 16px rgba(26,23,20, 0.08)`  | Bottom sheets, popovers      |
| `shadow-2xl`          | `0 32px 64px rgba(26,23,20, 0.18), 0 16px 32px rgba(26,23,20, 0.10)` | Book cover, hero elements    |
| `shadow-focus`        | `0 0 0 3px rgba(101,53,224, 0.35)`                                   | Keyboard focus ring          |
| `shadow-focus-danger` | `0 0 0 3px rgba(220,38,38, 0.30)`                                    | Error state focus ring       |
| `shadow-inner`        | `inset 0 2px 4px rgba(26,23,20, 0.08)`                               | Pressed input, active state  |

---

## 7.2 Border Radius Scale

| Token         | Value  | Use                                            |
| ------------- | ------ | ---------------------------------------------- |
| `radius-none` | 0px    | Full-bleed images, edge-to-edge elements       |
| `radius-sm`   | 4px    | Badges, small tags, code blocks                |
| `radius-md`   | 8px    | Buttons, inputs, dropdown items                |
| `radius-lg`   | 12px   | Cards, panels, modals (inner elements)         |
| `radius-xl`   | 16px   | Large cards, modals                            |
| `radius-2xl`  | 20px   | Drawers, large panels                          |
| `radius-3xl`  | 24px   | Feature cards, book card image container       |
| `radius-4xl`  | 32px   | Pill buttons (full-pill), avatar containers    |
| `radius-full` | 9999px | Avatar circles, toggle pills, circular buttons |

---

## 7.3 Component Elevation Decisions

| Component       | Default shadow | Hover shadow                | Pressed shadow                 |
| --------------- | -------------- | --------------------------- | ------------------------------ |
| Card (standard) | `shadow-sm`    | `shadow-md`                 | `shadow-xs`                    |
| Book Card       | `shadow-md`    | `shadow-lg` + lift (-2px Y) | `shadow-sm`                    |
| Modal           | `shadow-xl`    | —                           | —                              |
| Dropdown        | `shadow-lg`    | —                           | —                              |
| Toast           | `shadow-lg`    | —                           | —                              |
| Tooltip         | `shadow-md`    | —                           | —                              |
| Button (filled) | `shadow-xs`    | `shadow-sm`                 | `shadow-none` + `shadow-inner` |
| Bottom Sheet    | `shadow-2xl`   | —                           | —                              |
| Floating action | `shadow-lg`    | `shadow-xl`                 | `shadow-md`                    |

---

## 7.4 Border Usage

Borders are used alongside (or instead of) shadows to define component boundaries.

| Situation              | Border                 | Shadow         |
| ---------------------- | ---------------------- | -------------- |
| Card on white surface  | `border-subtle` (1px)  | `shadow-sm`    |
| Card on subtle surface | `border-subtle` (1px)  | none           |
| Modal                  | none                   | `shadow-xl`    |
| Input (default)        | `border-default` (1px) | none           |
| Input (focused)        | `border-brand` (2px)   | `shadow-focus` |
| Dropdown               | `border-subtle` (1px)  | `shadow-lg`    |

**Rule:** Never use both a strong border AND a strong shadow on the same element — they compete. Light border + medium shadow OR no border + strong shadow.

---

# 8. Motion System

The motion system is documented fully in `UX_SPEC.md §8`. This section adds the visual design layer — what animations look like, not just their duration/easing.

## 8.1 Animation Principles

1. **Motion has meaning.** Every animation communicates something: entrance (element is important), exit (element is done), progress (something is happening), success (something good happened).
2. **Motion follows hierarchy.** Large, important transitions are slower. Small, frequent interactions are instant.
3. **Motion is warm.** Easing functions have a slightly springy quality at key moments — not robotic linear, not over-bouncy.
4. **Motion respects preference.** All animations check `prefers-reduced-motion`.

---

## 8.2 Duration Scale

| Token                 | ms      | Use                                 |
| --------------------- | ------- | ----------------------------------- |
| `duration-instant`    | 80ms    | Button press, tag toggle            |
| `duration-fast`       | 150ms   | Color/border transitions, page turn |
| `duration-normal`     | 200ms   | Modal open/close, dropdown          |
| `duration-medium`     | 300ms   | Drawer, bottom sheet, wizard step   |
| `duration-slow`       | 500ms   | Section reveals, heavy transitions  |
| `duration-deliberate` | 700ms   | Book cover entry                    |
| `duration-story`      | 1500ms+ | Narrative sequences (book reveal)   |

---

## 8.3 Easing Reference

```css
--ease-linear: linear;
--ease-default: cubic-bezier(0.4, 0, 0.2, 1); /* Material standard */
--ease-in: cubic-bezier(0.4, 0, 1, 1); /* Exiting elements */
--ease-out: cubic-bezier(0, 0, 0.2, 1); /* Entering elements */
--ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1); /* Playful entrances */
--ease-book: cubic-bezier(0.22, 1, 0.36, 1); /* Book reveal, smooth decel */
--ease-decelerate: cubic-bezier(0, 0, 0, 1); /* Drawer, bottom sheet */
```

---

## 8.4 Book Reveal Visual Description

The reveal is the emotional peak of the product. The animation must feel like unwrapping a gift.

**Background:** Particle system begins (200ms before book appears). Particles match story theme:

- Space: white/amber star dots floating upward
- Ocean: soft blue bubble circles floating upward
- Forest: green leaf shapes drifting
- Default: violet sparkle dots

**Book entry:** Cover appears at `scale(0.7)` from the center, scales up to `scale(1.05)` (slight overshoot), settles at `scale(1.0)`. Easing: `ease-spring`. Duration: 700ms.

**Cover shadow:** Grows from `shadow-sm` → `shadow-2xl` during entry, giving a sense of the book materializing in space.

**Title text:** Fades in and slides up (8px) 500ms into the sequence.

**Reduced motion:** Book cover fades in at scale(1.0) with no overshoot. Particles disabled.

---

## 8.5 Page Turn Visual Description

**Standard:** The outgoing page slides out to the left (translateX: 0 → -32px) while fading out. The incoming page slides in from the right (translateX: +32px → 0) while fading in. Both animate simultaneously.

**Mobile swipe:** Page follows finger directly (no animation until release). On release, either:

- Complete (velocity > 300px/s or position > 35% of width): page slides to completion with `ease-out` 150ms
- Return (velocity < threshold): page springs back to original with `ease-spring` 200ms

---

## 8.6 Reduced Motion Implementation

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

JavaScript check for components with JS-driven animation:

```js
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
```

---

# 9. Component Design Language

## 9.1 Button

### Visual Anatomy

```
[  Icon?  Label  Icon?  ]
   ←—— padding-x ——→
        ↑ padding-y
```

### Size Specifications

| Size | Height | Padding X | Padding Y | Font       | Radius      | Icon size |
| ---- | ------ | --------- | --------- | ---------- | ----------- | --------- |
| `xs` | 28px   | 10px      | 4px       | 12px / 600 | `radius-md` | 12px      |
| `sm` | 32px   | 14px      | 6px       | 14px / 600 | `radius-md` | 16px      |
| `md` | 40px   | 16px      | 10px      | 16px / 600 | `radius-md` | 18px      |
| `lg` | 48px   | 20px      | 12px      | 18px / 700 | `radius-lg` | 20px      |
| `xl` | 56px   | 28px      | 16px      | 20px / 700 | `radius-lg` | 22px      |

### Variants & Visual States

**Primary (filled violet)**

- Default: `bg: violet-600`, `text: white`, `shadow-xs`
- Hover: `bg: violet-500`, `shadow-sm`, `translateY(-1px)`
- Pressed: `bg: violet-700`, `shadow-none`, `shadow-inner`
- Disabled: `bg: stone-200`, `text: stone-400`, no shadow, cursor-not-allowed
- Loading: same as default + spinner replaces leading icon, label becomes "Loading..."

**Secondary (outlined violet)**

- Default: `border: violet-600 (2px)`, `text: violet-600`, `bg: transparent`
- Hover: `bg: violet-50`, `border: violet-500`
- Pressed: `bg: violet-100`, `border: violet-700`
- Disabled: `border: stone-200`, `text: stone-400`

**Ghost (text only)**

- Default: `text: violet-600`, no border, no bg
- Hover: `bg: violet-50`
- Pressed: `bg: violet-100`
- Disabled: `text: stone-400`

**Danger (filled red)**

- Default: `bg: danger-base`, `text: white`
- Hover: `bg: danger-dark`, slight lift
- Pressed: darker, inset shadow

**Neutral (subtle gray)**

- Default: `bg: stone-100`, `text: stone-700`
- Hover: `bg: stone-200`
- Used for: secondary destructive, cancel buttons

### Full-Width Rule

Wizard CTAs and checkout submit buttons use `width: 100%`. All other buttons use intrinsic width (hug content).

### Icon-only Buttons

When label is absent, ensure equal padding on all sides. Minimum 44×44px touch area.

### Don't

- Never use gradient fills on buttons
- Never use violet-400 or lighter as primary button background
- Never disable a button without indicating why (tooltip or adjacent error message)

---

## 9.2 Input

### Visual Anatomy

```
Label text                    [Optional tag]
┌─────────────────────────────────────────┐
│ [Icon]  Placeholder or value            │
└─────────────────────────────────────────┘
Helper text or error message
```

### Specifications

- Height: 40px (`md`), 48px (`lg`), 36px (`sm`)
- Padding: 12px vertical, 14px horizontal; icon adds 8px before content
- Border: 1px `border-default` (stone-300)
- Border radius: `radius-md` (8px)
- Background: `bg-surface` (white)
- Font: Plus Jakarta Sans 16px / 400

### States

| State     | Border               | Background   | Shadow                | Text                      |
| --------- | -------------------- | ------------ | --------------------- | ------------------------- |
| Empty     | `border-default`     | `bg-surface` | none                  | Placeholder: `text-muted` |
| Filled    | `border-default`     | `bg-surface` | none                  | `text-primary`            |
| Focused   | `border-brand` 2px   | `bg-surface` | `shadow-focus`        | `text-primary`            |
| Error     | `border-danger` 2px  | `bg-surface` | `shadow-focus-danger` | `text-primary`            |
| Success   | `border-success` 2px | `bg-surface` | none                  | `text-primary`            |
| Disabled  | `border-subtle`      | `bg-subtle`  | none                  | `text-disabled`           |
| Read-only | `border-subtle`      | `bg-subtle`  | none                  | `text-secondary`          |

### Label

- Position: above input, `space-2` (8px) gap
- Style: `label-base` (14px / PJS 600)
- Color: `text-secondary` (default), `text-primary` (focused), `text-danger` (error)
- Required indicator: red asterisk `text-danger` appended after label text

### Helper/Error Text

- Position: below input, `space-2` (8px) gap
- Helper: `text-xs`, `text-muted`
- Error: `text-xs`, `text-danger`, with error icon (12px) prepended

---

## 9.3 Textarea

Inherits all Input visual rules. Additional:

- Min height: 96px
- Resize: vertical only (`resize: vertical`)
- Auto-grow: JS-based height expansion to content (max 240px, then internal scroll)
- Character count: `text-xs text-muted`, right-aligned below textarea; turns `text-danger` when within 20 chars of limit

---

## 9.4 Checkbox

Size: 18×18px square, `radius-sm` (4px)

| State              | Border                          | Background   | Icon                           |
| ------------------ | ------------------------------- | ------------ | ------------------------------ |
| Unchecked          | `border-default` 2px            | white        | —                              |
| Checked            | `violet-600` 2px                | `violet-600` | White checkmark (Lucide, 12px) |
| Indeterminate      | `violet-600` 2px                | `violet-600` | White minus (12px)             |
| Focused            | `border-brand` + `shadow-focus` | —            | —                              |
| Disabled unchecked | `border-subtle`                 | `bg-subtle`  | —                              |
| Disabled checked   | `stone-300`                     | `stone-200`  | Stone checkmark                |

Label: right of checkbox, `space-3` (12px) gap. Click on label toggles checkbox.

---

## 9.5 Radio Button

Size: 20×20px circle

| State      | Border                          | Background  | Inner dot                 |
| ---------- | ------------------------------- | ----------- | ------------------------- |
| Unselected | `border-default` 2px            | white       | —                         |
| Selected   | `violet-600` 2px                | white       | `violet-600` circle, 10px |
| Focused    | `border-brand` + `shadow-focus` | —           | —                         |
| Disabled   | `border-subtle`                 | `bg-subtle` | —                         |

---

## 9.6 Switch / Toggle

Size: 44×24px pill container

| State        | Track color                   | Thumb position         | Thumb color |
| ------------ | ----------------------------- | ---------------------- | ----------- |
| Off          | `stone-300`                   | Left (4px from left)   | White       |
| On           | `violet-600`                  | Right (4px from right) | White       |
| Off/focused  | `stone-400` + `shadow-focus`  | Left                   | White       |
| On/focused   | `violet-500` + `shadow-focus` | Right                  | White       |
| Disabled off | `stone-200`                   | Left                   | `stone-100` |
| Disabled on  | `violet-200`                  | Right                  | White       |

Transition: `duration-fast` (150ms), `ease-default`. Thumb slides smoothly.

---

## 9.7 Select (Dropdown)

Visually identical to Input but with a `chevron-down` icon (Lucide, 16px, `text-muted`) at the right edge.

Custom dropdown list:

- Background: `bg-surface`
- Border: `border-subtle` 1px
- Shadow: `shadow-lg`
- Radius: `radius-xl` (16px)
- Option height: 40px
- Option hover: `bg-subtle`
- Option selected: `bg-brand-subtle`, `text-brand`, checkmark right-aligned

---

## 9.8 Avatar

Circular image container. Used for child profile photos, account avatar.

| Size  | Diameter | Font (initials) | Border              |
| ----- | -------- | --------------- | ------------------- |
| `xs`  | 24px     | 10px            | —                   |
| `sm`  | 32px     | 12px            | —                   |
| `md`  | 40px     | 14px            | 2px `border-subtle` |
| `lg`  | 56px     | 18px            | 2px `border-subtle` |
| `xl`  | 80px     | 24px            | 3px `border-subtle` |
| `2xl` | 128px    | 36px            | 4px `border-subtle` |

**Fallback (no photo):** Background = gradient from `violet-400` to `violet-600`. Initials centered in `text-inverse`, `font-semibold`.

**Active/selected state (child profile strip):** 3px ring in `violet-600`, 2px gap between avatar and ring.

---

## 9.9 Badge

Small informational label. Not interactive.

| Variant   | Background      | Text             | Border          |
| --------- | --------------- | ---------------- | --------------- |
| `default` | `stone-100`     | `text-secondary` | `border-subtle` |
| `brand`   | `violet-100`    | `violet-700`     | none            |
| `success` | `success-light` | `success-dark`   | none            |
| `warning` | `warning-light` | `warning-dark`   | none            |
| `danger`  | `danger-light`  | `danger-dark`    | none            |
| `amber`   | `amber-100`     | `amber-700`      | none            |

Sizes: `sm` (18px height, 8px padding) · `md` (22px, 10px) · `lg` (26px, 12px)
Radius: `radius-full`
Font: `tag-label` (13px / 600)

---

## 9.10 Chip / Tag

Interactive selectable label. Used in TagPicker (interests), filter chips, genre tags.

| State              | Background                                | Border           | Text             |
| ------------------ | ----------------------------------------- | ---------------- | ---------------- |
| Unselected         | `bg-surface`                              | `border-default` | `text-secondary` |
| Selected           | `violet-100`                              | `violet-600` 2px | `violet-700`     |
| Hover (unselected) | `bg-subtle`                               | `border-strong`  | `text-primary`   |
| Hover (selected)   | `violet-200`                              | `violet-600` 2px | `violet-700`     |
| Disabled           | `bg-subtle`                               | `border-subtle`  | `text-disabled`  |
| Dismissable        | Same as selected + × icon (14px) at right | —                | —                |

Height: 36px · Padding: 8px 14px · Radius: `radius-full` · Font: `tag-label`

---

## 9.11 Card

Base container for grouped content.

| Property   | Value                          |
| ---------- | ------------------------------ |
| Background | `bg-surface`                   |
| Border     | `border-subtle` 1px            |
| Radius     | `radius-xl` (16px)             |
| Shadow     | `shadow-sm`                    |
| Padding    | 20px (mobile) / 24px (desktop) |

**Interactive card (clickable):**

- Hover: `shadow-md`, `translateY(-2px)`, `border-stone-300`
- Transition: `duration-fast` (150ms)
- Cursor: pointer

**Section card (non-interactive):**

- No hover state
- Used in settings, checkout summary

---

## 9.12 Book Card

Extends base card with book-specific anatomy.

```
┌──────────────────────────┐
│                          │
│    Book Cover Image      │  ← 3:4 aspect ratio, fills full width
│    radius-xl (top only)  │     radius-xl on top corners
│                          │
├──────────────────────────┤
│  Book Title              │  ← text-lg / semibold, 2 lines max
│  Child name · Page count │  ← text-sm / text-muted
│  June 2026               │  ← text-xs / text-muted
├──────────────────────────┤  ← appears on hover/focus
│ [Read]  [↓]  [···]       │  ← action bar
└──────────────────────────┘
```

**Cover image:** `object-fit: cover`, `object-position: center top` (ensures face is not cropped). Background while loading: `bg-subtle` gradient.

**Status overlay (generating):**

- Semi-transparent dark overlay over cover
- Centered: spinner + "Creating..." text
- Pulsing border: `violet-400` 2px, animation: pulse 1.5s infinite

**Status overlay (failed):**

- Error red overlay tint
- Centered: `alert-circle` icon + "Failed — try again" link

**Hover action bar:** `bg-surface/95` (frosted), `border-top: border-subtle`. Appears with fade (150ms).

---

## 9.13 Pricing Card

Used on pricing page and checkout.

```
┌─────────────────────────────┐
│  [Badge: "Most Popular"]    │  ← amber-100 badge, top-center
│                             │
│  Plan Name                  │  ← text-2xl / Fraunces 700
│  Short description          │  ← text-sm / text-muted
│                             │
│  $9.99                      │  ← text-5xl / Fraunces 800
│  / month                    │  ← text-sm / text-muted
│                             │
│  ✓ Feature 1                │
│  ✓ Feature 2                │
│  ✓ Feature 3                │
│                             │
│  [Primary CTA Button]       │  ← full-width
└─────────────────────────────┘
```

**Featured/recommended plan:**

- Border: `violet-600` 2px (instead of `border-subtle`)
- Shadow: `shadow-lg` (instead of `shadow-sm`)
- "Most Popular" badge: `amber-100` background, `amber-700` text

---

## 9.14 Modal

**Visual rules:**

- Background: `bg-surface`
- Border radius: `radius-2xl` (20px)
- Shadow: `shadow-xl`
- Max widths: 480px (`sm`), 560px (`md`), 720px (`lg`)
- Padding: 24px (all sides)

**Header:** Title (`text-xl` / 600), × close button (top-right, `icon-lg`)
**Footer:** Right-aligned buttons, `space-3` (12px) gap between them
**Backdrop:** `overlay-dark`, click to close (unless `disableBackdropClose`)

**Bottom sheet (mobile):**

- Slides up from bottom
- Rounded top corners only: `radius-3xl` top-left + top-right
- Drag handle: centered at top, 32×4px pill, `stone-300`
- Max height: 85vh

---

## 9.15 Toast

**Visual rules:**

- Background: `stone-900` (near-black, warm)
- Text: `text-inverse`
- Border radius: `radius-xl` (16px)
- Shadow: `shadow-lg`
- Min width: 280px · Max width: 400px (mobile: full-width minus 32px margin)
- Padding: 14px 16px

**Anatomy:**

```
[ Icon (20px)  Message text              [×] ]
```

**Variants:**

- `default`: `stone-900` bg
- `success`: `success-base` bg, white text, white checkmark
- `error`: `danger-base` bg, white text, white alert icon
- `warning`: `amber-600` bg, white text

**Action link:** Optional right-aligned text link in `violet-300` color (on dark bg)

---

## 9.16 Tooltip

- Background: `stone-900`
- Text: `text-inverse`, `text-xs`
- Radius: `radius-md` (8px)
- Padding: 6px 10px
- Shadow: `shadow-md`
- Max width: 240px
- Arrow: 6px triangle, same color as background

Appears after 300ms hover delay. Disappears immediately on mouse-leave.

---

## 9.17 Navigation Header

```
┌──────────────────────────────────────────────────────────────────────┐
│ [StoryMe Logo]  Library  Children ▾         + Create Book  [?] [A]   │
└──────────────────────────────────────────────────────────────────────┘
```

Height: 64px desktop / 56px mobile
Background: `bg-surface`, `border-bottom: border-subtle 1px`
Shadow on scroll: `shadow-xs` (appears after 8px scroll)
Logo: Left-aligned, 32px height, `space-6` (24px) from left edge
Nav links: `text-base` / 500 / `text-secondary`; active: `text-brand` + 2px underline
Primary CTA: Button `md` `primary` variant, right-aligned, `space-6` from right

---

## 9.18 Bottom Navigation (Mobile)

Height: 60px + safe area inset
Background: `bg-surface`
Border top: `border-subtle` 1px
Tabs: Equal thirds; icon centered + label below (12px / 500)
Active: `violet-600` icon + label; Inactive: `stone-400` icon, no label on smallest breakpoints
Central "Create" tab: slightly larger icon (28px vs 24px), brand color fill always

---

## 9.19 Book Viewer (Reader)

The reader sits in its own visual context. The UI chrome is minimal.

**Reader background:** `#0D0B09` (very dark warm black). This contrast makes illustrations pop.

**Spread container:** Book pages have a white background (`bg-surface`) with `shadow-2xl`. On dark reader bg, this creates the impression of holding a physical book.

**Toolbar:** Translucent — `rgba(253,252,251, 0.92)` with `backdrop-filter: blur(20px)`. This is the iOS-glass treatment — elegant, non-intrusive.

**Page shadow:** Each page in a spread has a subtle inner shadow on the binding edge: `inset -4px 0 12px rgba(26,23,20,0.12)` (right page) and `inset 4px 0 12px rgba(26,23,20,0.12)` (left page).

**Progress bar:** 4px height, `violet-600` fill on `stone-800` track. Positioned at very bottom of reader.

---

## 9.20 Theme Selector (Wizard Step 3)

Tile grid of story theme options. Each tile:

```
┌────────────────────────┐
│                        │
│  [Theme Illustration]  │  ← 56px square illustration
│                        │
│  Grand Adventure       │  ← text-base / 600
│  Embark on a quest     │  ← text-sm / text-muted
│                        │
└────────────────────────┘
```

Default: `bg-surface`, `border-subtle 1px`, `radius-xl`, `shadow-xs`
Hover: `shadow-md`, `translateY(-2px)`, border becomes `stone-300`
Selected: `border: violet-600 2px`, `bg: violet-50`, top-right checkmark badge (16px, violet-600)

---

## 9.21 Avatar Builder

Organized into tabbed sections. Active tab uses `violet-600` text + 2px bottom border.

**Skin tone picker:**

- 12 circles, 36px diameter each, 4×3 grid
- No labels (accessible via aria-label)
- Selected: 3px ring in `violet-600`, 2px gap
- Hover: scale(1.08), `duration-fast`

**Hair style grid:**

- 20 illustrated thumbnails, 64×64px each, 5 columns
- Each thumbnail shows a hair style silhouette on a neutral head
- Selected: `violet-600` border 2px, checkmark overlay
- Hover: scale(1.05)

---

# 10. Forms Design

## 10.1 Field Spacing

- Label to field: `space-2` (8px)
- Field to helper/error: `space-2` (8px)
- Field to next field: `space-5` (20px)
- Field group (related fields in a row): `space-4` (16px) between fields
- Section to section (within a form): `space-8` (32px)
- Last field to submit button: `space-6` (24px)

## 10.2 Labels

- All fields have visible labels (no placeholder-as-label anti-pattern)
- Label style: `label-base` (14px / PJS 600 / `text-secondary`)
- Required fields: red asterisk `*` after label text, `text-danger`
- Optional fields: "(optional)" in `text-xs text-muted` appended after label
- Label position: always above the field (never inside or to the left)

## 10.3 Validation Strategy

**Real-time validation:** Trigger only on `blur` (when user leaves the field), not on every keystroke. Exception: character count (shows in real-time).

**After first submit attempt:** Validation triggers on every change (so user can see errors resolve as they type).

**Inline error messages:**

- Appear below the field, `space-2` gap
- `text-xs text-danger`
- Prepended with `alert-circle` icon (12px, `danger-base`)
- Input border changes to `border-danger` 2px
- Input gains `shadow-focus-danger`

**Success messages (inline):**

- Appear when field validates successfully after error state
- `text-xs text-success`
- Prepended with `check-circle` icon (12px, `success-base`)
- Border: `border-success` 2px
- Duration: shows for 2 seconds, then returns to normal state

## 10.4 Disabled Fields

- Background: `bg-subtle`
- Border: `border-subtle`
- Text: `text-disabled`
- Cursor: `not-allowed`
- Never show hover or focus states
- Always pair with a visible explanation why it's disabled (tooltip or adjacent text)

## 10.5 Wizard Forms

Wizard steps are NOT standard forms. They follow additional rules:

- One input group per screen maximum (can have multiple related fields but a single "topic")
- No visible form `<submit>` behavior — the "Continue" button is the action
- Error states appear inline, but the Continue button also shows a toast if validation fails on click: "Please fill in [Name]'s name to continue"
- No asterisks (all wizard fields are either required-by-design or clearly labeled optional)
- Touch-screen optimizations: inputs auto-focus where reasonable (after step transition), keyboards open appropriately

---

# 11. Empty States

## 11.1 Visual Design

Empty states follow a consistent 3-part structure:

```
        [Illustration]
              ↑
         space-6 (24px)

    Headline (text-2xl / Fraunces 600)
         space-2 (8px)

  Supporting text (text-base / text-secondary)
         space-6 (24px)

     [Primary CTA Button]
  [Optional secondary text link]
```

**Container:** Centered in the available content area, both vertically and horizontally. Max width 400px. Top/bottom padding: `space-16` (64px) minimum.

**Illustration size:** 160px × 160px (desktop), 120px × 120px (mobile).

---

## 11.2 Copy Style

Headline: Warm, forward-looking. Never states the problem — states the possibility.

- ✓ "Your library is empty — for now"
- ✗ "No books found"

Subtext: One or two sentences. Explains what will be here and what to do.

- ✓ "Create your first personalized book and watch the magic happen."
- ✗ "You haven't created any books yet. Click the button below to create a book."

---

## 11.3 Empty State Catalog

| Context            | Illustration            | Headline                          | Subtext                                                           | CTA                      |
| ------------------ | ----------------------- | --------------------------------- | ----------------------------------------------------------------- | ------------------------ |
| Library, no books  | Glowing empty bookshelf | "Your library is empty — for now" | "Create [Name]'s first adventure and start your collection."      | "Create Your First Book" |
| Search, no results | Magnifying glass + page | "No books found for '[query]'"    | "Try a different search or create a new book."                    | "Create a New Book"      |
| Filter, no results | Empty grid              | "No books match these filters"    | "Try adjusting your filters."                                     | "Clear Filters"          |
| No child profiles  | Outlined child shape    | "Add your little hero"            | "Save a profile to make future books even faster."                | "Add a Child"            |
| Bookmarks (reader) | Open book + ribbon      | "No bookmarks yet"                | "Tap the ribbon icon on any page to save it."                     | —                        |
| Notifications      | Checkmark circle        | "All caught up!"                  | "We'll let you know when something needs your attention."         | —                        |
| Billing history    | Receipt                 | "No invoices yet"                 | "Your billing history will appear here after your first payment." | —                        |

---

# 12. Error States

## 12.1 Visual Hierarchy of Errors

Errors have four visual tiers, from least to most intrusive:

**Tier 1 — Inline field error:** Below a specific input. No interruption to flow.

**Tier 2 — Toast error:** Brief message for transient failures (failed copy, brief network error). Bottom of screen, auto-dismisses.

**Tier 3 — Banner error:** Full-width bar below the header for persistent warnings (subscription payment failed, account limit reached). Stays until dismissed or resolved.

**Tier 4 — Full-page error:** Replaces the content area for critical failures (404, 500, generation failure). Has a single recovery CTA.

---

## 12.2 Error Visual Design

**All error UI uses:**

- `danger-base` (`#DC2626`) for text, icons, borders
- `danger-light` (`#FEF2F2`) for background tints
- `alert-circle` Lucide icon (never a generic × or exclamation)
- Friendly, specific copy (never "An error occurred")
- At minimum one recovery action

**Inline errors:**

- `text-xs text-danger`
- `alert-circle` icon (12px) prepended
- Input border: `border-danger` 2px
- Never show more than one inline error per field at a time

**Toast errors:**

- `danger-base` background
- White text, white icon
- Auto-dismiss: 6 seconds (longer than success toasts — users need to read errors)
- "Retry" action link when applicable

**Full-page error:**

- Illustration: warm, friendly (character looking puzzled, not distressed)
- Headline: Plain language description (max 8 words)
- Body: 1–2 sentences explaining what happened and that it's not the user's fault
- Primary CTA: The most useful recovery action
- Secondary: Contact support link

---

# 13. Loading States

## 13.1 Skeleton Loaders

Used whenever content is loading and takes >300ms.

**Design rules:**

- Skeleton dimensions exactly match the content they represent
- Color: `stone-200` base, `stone-100` shimmer highlight
- Shimmer: animated left-to-right gradient sweep (1.5s, linear, infinite)
- Radius: matches the component being loaded
- Never use placeholder text ("Loading...") in skeleton — use shape blocks only

**Book card skeleton:**

```
┌──────────────────────────┐
│                          │
│    [Rectangle block]     │  ← 3:4 ratio, cover placeholder
│                          │
├──────────────────────────┤
│  [Text block 80%]        │  ← title placeholder
│  [Text block 50%]        │  ← metadata placeholder
│  [Text block 30%]        │  ← date placeholder
└──────────────────────────┘
```

**Dashboard loading:** Shows 8 book card skeletons in the grid.

**Reader page loading:** Single large rectangle (page dimensions) with shimmer.

---

## 13.2 Generation Progress UI

The generation progress screen is the most elaborate loading experience in the product. Its visual design must communicate:

1. Something meaningful is happening (not stuck)
2. How long it will take (approximately)
3. What stage is currently active

Refer to `UX_SPEC.md §13` for behavioral specification. Visual design:

- Full-screen, themed background illustration (static, mood-matched to story setting)
- Foreground: centered card (`bg-surface/95`, `shadow-xl`, `radius-2xl`, max-width 480px)
- Stage label: `text-2xl / Fraunces 600`, cycles with fade transition
- Progress bar: 8px height, `violet-600` fill, `stone-200` track, `radius-full`
- Stage timeline: vertical list, left-aligned, 16px `icon-md` per stage, connecting vertical line in `stone-200`

---

## 13.3 Button Loading State

- Label changes to "Loading..." (or action-specific: "Creating...", "Processing...")
- Spinner (16px, white) prepended before label text
- Button remains full-width (no size change)
- Button is disabled (pointer-events: none)
- No visual layout shift

---

# 14. Success States

## 14.1 Visual Celebration Rules

Success states use the `amber` palette for celebration moments and `success` green for functional confirmations.

**Amber (celebration):** Used for book generation complete, subscription activated, first book created. These are emotionally significant moments.

**Green (functional):** Used for profile saved, PDF downloaded, settings updated. These are task-completion moments.

**Never use:** Confetti for task-completion success (saving a profile does not warrant confetti). Reserve animation-heavy celebrations for the book reveal and subscription activation.

---

## 14.2 Success State Catalog

| Event                    | Visual Treatment                   | Animation                      |
| ------------------------ | ---------------------------------- | ------------------------------ |
| Book generation complete | Full-screen reveal (§8.4)          | Particles + book scale entry   |
| Purchase complete        | Modal: green checkmark + amber CTA | Checkmark draw-in (SVG, 400ms) |
| PDF downloaded           | Toast: `success` variant           | Slide up, auto-dismiss 3s      |
| Profile saved            | Inline green checkmark + toast     | Toast slide-up                 |
| Share link copied        | Toast: "Link copied!"              | Slide-up, 2s auto-dismiss      |
| Subscription activated   | Full-page welcome screen           | Animated feature list build    |
| Series Book 2 created    | Modal: two books side by side      | Gentle scale-in on Book 2      |

---

# 15. Responsive UI Rules

## 15.1 Design Starting Point

All components are designed at 375px (iPhone SE2 / standard mobile) first. Desktop is an enhancement, not the default.

## 15.2 Typography Responsive Scale

| Token           | Mobile (< 768px)   | Desktop (≥ 1024px)             |
| --------------- | ------------------ | ------------------------------ |
| Hero headline   | `text-4xl` (36px)  | `text-6xl` (60px)              |
| Page heading    | `text-3xl` (30px)  | `text-4xl` (36px)              |
| Section heading | `text-2xl` (24px)  | `text-3xl` (30px)              |
| Body            | `text-base` (16px) | `text-base` (16px) — no change |
| Caption         | `text-xs` (12px)   | `text-xs` (12px) — no change   |

## 15.3 Spacing Responsive Rules

Section padding:

- Mobile: `space-8` (32px) top/bottom
- Tablet: `space-12` (48px)
- Desktop: `space-16` (64px)

Card padding:

- Mobile: `space-4` (16px)
- Desktop: `space-6` (24px)

Page horizontal margin:

- Mobile: `space-4` (16px)
- Tablet: `space-8` (32px)
- Desktop: `space-12` (48px)

## 15.4 Touch Target Compliance

On mobile all interactive elements must meet 44×44px minimum. Enforcement:

- Buttons: height ≥ 44px (enforced by size scale; `sm` at 32px uses 12px vertical padding to extend touch area)
- Icon buttons: min 44×44px bounding box via padding
- Links in body text: min 44px height line (achieved by line-height)
- Tag chips: 36px height + 4px invisible padding extension above/below

## 15.5 Component Adaptations Summary

| Component           | Desktop                           | Mobile                               |
| ------------------- | --------------------------------- | ------------------------------------ |
| Navigation          | Top header                        | Bottom tab bar                       |
| Modal               | Centered dialog                   | Full-width bottom sheet              |
| Dropdown            | Positioned below trigger          | Full-screen bottom sheet             |
| Settings            | 2-column (sidebar + content)      | Single column, nested routes         |
| Wizard              | 50/50 split (form + illustration) | Full-screen form, illustration above |
| Reader              | 2-page spread                     | Single page, swipe                   |
| Book card grid      | 4 columns                         | 2 columns                            |
| Avatar builder      | Tabbed panels side-by-side        | Accordion sections                   |
| Generation progress | Timeline visible                  | Timeline hidden, stage label only    |

---

# 16. Accessibility

Accessibility specification is detailed in `UX_SPEC.md §9`. This section covers visual design requirements only.

## 16.1 Color Contrast (Visual Design)

All text and interactive elements pass WCAG 2.1 AA. Key color pairs verified:

| Foreground                 | Background             | Ratio  | Pass  |
| -------------------------- | ---------------------- | ------ | ----- |
| `text-primary` (#28241E)   | `bg-base` (#FDFCFB)    | 12.5:1 | ✓ AAA |
| `text-secondary` (#57524A) | `bg-base`              | 5.8:1  | ✓ AA  |
| White                      | `violet-600` (#6535E0) | 5.2:1  | ✓ AA  |
| `text-brand` (#6535E0)     | `bg-base`              | 6.8:1  | ✓ AA  |
| `text-danger` (#DC2626)    | `bg-base`              | 5.5:1  | ✓ AA  |

## 16.2 Focus Ring Design

Focus rings are a designed element, not a browser default:

- Color: `violet-600` at 35% opacity (`rgba(101,53,224, 0.35)`)
- Width: 3px
- Offset: 2px
- Style: `box-shadow: 0 0 0 2px bg-base, 0 0 0 5px rgba(101,53,224,0.35)` (double ring: white gap + violet ring)

This "offset ring" technique works on any background color.

## 16.3 Minimum Touch Targets

All interactive elements ≥ 44×44px. When visual size is smaller, padding extends the touch area without visual change. This is enforced in the component system, not left to individual implementation.

---

# 17. Design Tokens

## 17.1 Token Naming Convention

```
[category]-[property]-[variant]-[state]

Examples:
color-background-surface
color-text-primary
color-border-brand-focused
space-component-card-padding-x
radius-component-button-md
shadow-elevation-modal
duration-animation-modal-enter
```

For implementation (Tailwind / CSS custom properties):

```css
/* Category prefixes */
--color-*       /* All color tokens */
--space-*       /* Spacing tokens */
--radius-*      /* Border radius tokens */
--shadow-*      /* Box shadow tokens */
--font-*        /* Font family, size, weight */
--leading-*     /* Line height */
--tracking-*    /* Letter spacing */
--duration-*    /* Animation duration */
--ease-*        /* Animation easing */
--z-*           /* Z-index */
--opacity-*     /* Opacity values */
```

---

## 17.2 Complete Token Reference

### Color Tokens

```css
:root {
  /* Brand */
  --color-violet-50: #f8f5ff;
  --color-violet-100: #eee8ff;
  --color-violet-200: #d9ceff;
  --color-violet-300: #bba8ff;
  --color-violet-400: #9879f8;
  --color-violet-500: #7b54f0;
  --color-violet-600: #6535e0;
  --color-violet-700: #5122c4;
  --color-violet-800: #3e19a0;
  --color-violet-900: #2d1180;
  --color-violet-950: #180960;

  /* Celebration */
  --color-amber-50: #fffcf0;
  --color-amber-100: #fff5cc;
  --color-amber-200: #ffe99a;
  --color-amber-300: #ffd966;
  --color-amber-400: #ffc833;
  --color-amber-500: #f5a800;
  --color-amber-600: #cc8800;
  --color-amber-700: #a36a00;

  /* Neutral */
  --color-stone-50: #fafaf8;
  --color-stone-100: #f5f4f1;
  --color-stone-200: #e8e6e1;
  --color-stone-300: #d6d3cc;
  --color-stone-400: #a8a49b;
  --color-stone-500: #79746a;
  --color-stone-600: #57524a;
  --color-stone-700: #3f3a33;
  --color-stone-800: #28241e;
  --color-stone-900: #1a1714;
  --color-stone-950: #0d0b09;

  /* Semantic — Background */
  --color-bg-base: #fdfcfb;
  --color-bg-surface: #ffffff;
  --color-bg-subtle: #f5f4f1;
  --color-bg-muted: #eceae5;
  --color-bg-inverse: #1a1714;
  --color-bg-brand: #6535e0;
  --color-bg-brand-subtle: #f8f5ff;

  /* Semantic — Text */
  --color-text-primary: #28241e;
  --color-text-secondary: #57524a;
  --color-text-muted: #79746a;
  --color-text-disabled: #a8a49b;
  --color-text-inverse: #fdfcfb;
  --color-text-brand: #6535e0;
  --color-text-brand-subtle: #7b54f0;
  --color-text-danger: #dc2626;
  --color-text-success: #15803d;
  --color-text-warning: #d97706;

  /* Semantic — Border */
  --color-border-subtle: #e8e6e1;
  --color-border-default: #d6d3cc;
  --color-border-strong: #a8a49b;
  --color-border-inverse: #3f3a33;
  --color-border-brand: #6535e0;
  --color-border-danger: #dc2626;
  --color-border-success: #16a34a;

  /* Semantic — Status */
  --color-success-light: #ecfdf5;
  --color-success-base: #16a34a;
  --color-success-dark: #15803d;
  --color-warning-light: #fffbeb;
  --color-warning-base: #d97706;
  --color-warning-dark: #b45309;
  --color-danger-light: #fef2f2;
  --color-danger-base: #dc2626;
  --color-danger-dark: #b91c1c;
  --color-info-light: #eff6ff;
  --color-info-base: #2563eb;
}
```

### Spacing Tokens

```css
:root {
  --space-px: 1px;
  --space-0: 0px;
  --space-0-5: 2px;
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-7: 28px;
  --space-8: 32px;
  --space-9: 36px;
  --space-10: 40px;
  --space-11: 44px;
  --space-12: 48px;
  --space-14: 56px;
  --space-16: 64px;
  --space-20: 80px;
  --space-24: 96px;
  --space-32: 128px;
}
```

### Typography Tokens

```css
:root {
  --font-display: 'Fraunces', Georgia, serif;
  --font-sans: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif;
  --font-serif: 'Lora', Georgia, serif;

  --text-xs: 0.75rem; /* 12px */
  --text-sm: 0.875rem; /* 14px */
  --text-base: 1rem; /* 16px */
  --text-lg: 1.125rem; /* 18px */
  --text-xl: 1.25rem; /* 20px */
  --text-2xl: 1.5rem; /* 24px */
  --text-3xl: 1.875rem; /* 30px */
  --text-4xl: 2.25rem; /* 36px */
  --text-5xl: 3rem; /* 48px */
  --text-6xl: 3.75rem; /* 60px */
  --text-7xl: 4.5rem; /* 72px */

  --font-normal: 400;
  --font-medium: 500;
  --font-semibold: 600;
  --font-bold: 700;
  --font-extrabold: 800;

  --leading-tight: 1.2;
  --leading-snug: 1.35;
  --leading-normal: 1.5;
  --leading-relaxed: 1.625;
  --leading-loose: 1.8;

  --tracking-tighter: -0.04em;
  --tracking-tight: -0.02em;
  --tracking-normal: 0em;
  --tracking-wide: +0.02em;
  --tracking-wider: +0.05em;
  --tracking-widest: +0.12em;
}
```

### Radius Tokens

```css
:root {
  --radius-none: 0px;
  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-xl: 16px;
  --radius-2xl: 20px;
  --radius-3xl: 24px;
  --radius-4xl: 32px;
  --radius-full: 9999px;
}
```

### Shadow Tokens

```css
:root {
  --shadow-none: none;
  --shadow-xs: 0 1px 2px rgba(26, 23, 20, 0.06), 0 1px 1px rgba(26, 23, 20, 0.04);
  --shadow-sm: 0 2px 4px rgba(26, 23, 20, 0.08), 0 1px 2px rgba(26, 23, 20, 0.06);
  --shadow-md: 0 4px 8px rgba(26, 23, 20, 0.1), 0 2px 4px rgba(26, 23, 20, 0.06);
  --shadow-lg: 0 8px 16px rgba(26, 23, 20, 0.12), 0 4px 8px rgba(26, 23, 20, 0.06);
  --shadow-xl: 0 16px 32px rgba(26, 23, 20, 0.14), 0 8px 16px rgba(26, 23, 20, 0.08);
  --shadow-2xl: 0 32px 64px rgba(26, 23, 20, 0.18), 0 16px 32px rgba(26, 23, 20, 0.1);
  --shadow-inner: inset 0 2px 4px rgba(26, 23, 20, 0.08);
  --shadow-focus: 0 0 0 2px var(--color-bg-surface), 0 0 0 5px rgba(101, 53, 224, 0.35);
  --shadow-focus-danger: 0 0 0 2px var(--color-bg-surface), 0 0 0 5px rgba(220, 38, 38, 0.3);
}
```

### Motion Tokens

```css
:root {
  --duration-instant: 80ms;
  --duration-fast: 150ms;
  --duration-normal: 200ms;
  --duration-medium: 300ms;
  --duration-slow: 500ms;
  --duration-deliberate: 700ms;

  --ease-linear: linear;
  --ease-default: cubic-bezier(0.4, 0, 0.2, 1);
  --ease-in: cubic-bezier(0.4, 0, 1, 1);
  --ease-out: cubic-bezier(0, 0, 0.2, 1);
  --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
  --ease-book: cubic-bezier(0.22, 1, 0.36, 1);
  --ease-decelerate: cubic-bezier(0, 0, 0, 1);
}
```

### Z-Index Tokens

```css
:root {
  --z-base: 0;
  --z-raised: 10;
  --z-dropdown: 100;
  --z-sticky: 200;
  --z-overlay: 300;
  --z-modal: 400;
  --z-drawer: 450;
  --z-toast: 500;
  --z-tooltip: 600;
}
```

### Breakpoint Tokens

```css
/* Used in Tailwind config or media queries */
--breakpoint-xs: 375px;
--breakpoint-sm: 640px;
--breakpoint-md: 768px;
--breakpoint-lg: 1024px;
--breakpoint-xl: 1280px;
--breakpoint-2xl: 1536px;
```

### Opacity Tokens

```css
:root {
  --opacity-0: 0;
  --opacity-10: 0.1;
  --opacity-20: 0.2;
  --opacity-40: 0.4;
  --opacity-60: 0.6;
  --opacity-80: 0.8;
  --opacity-90: 0.9;
  --opacity-95: 0.95;
  --opacity-100: 1;

  /* Semantic */
  --opacity-disabled: 0.4;
  --opacity-overlay: 0.6;
  --opacity-backdrop: 0.85;
  --opacity-frosted: 0.92;
}
```

---

## 17.3 Tailwind CSS Integration

Map tokens to Tailwind config:

```js
// tailwind.config.js
module.exports = {
  theme: {
    extend: {
      colors: {
        violet: {
          50: '#F8F5FF',
          100: '#EEE8FF',
          200: '#D9CEFF',
          300: '#BBA8FF',
          400: '#9879F8',
          500: '#7B54F0',
          600: '#6535E0',
          700: '#5122C4',
          800: '#3E19A0',
          900: '#2D1180',
          950: '#180960',
        },
        amber: {/* as above */},
        stone: {/* as above */},
        // Semantic shortcuts
        brand: '#6535E0',
        surface: '#FFFFFF',
        base: '#FDFCFB',
      },
      fontFamily: {
        display: ['Fraunces', 'Georgia', 'serif'],
        sans: ['Plus Jakarta Sans', 'system-ui', 'sans-serif'],
        serif: ['Lora', 'Georgia', 'serif'],
      },
      borderRadius: {
        sm: '4px',
        md: '8px',
        lg: '12px',
        xl: '16px',
        '2xl': '20px',
        '3xl': '24px',
        '4xl': '32px',
      },
      boxShadow: {
        xs: '0 1px 2px rgba(26,23,20,.06)',
        sm: '0 2px 4px rgba(26,23,20,.08)',
        md: '0 4px 8px rgba(26,23,20,.10)',
        lg: '0 8px 16px rgba(26,23,20,.12)',
        xl: '0 16px 32px rgba(26,23,20,.14)',
        '2xl': '0 32px 64px rgba(26,23,20,.18)',
        focus: '0 0 0 2px #fff, 0 0 0 5px rgba(101,53,224,.35)',
      },
      transitionDuration: {
        instant: '80ms',
        fast: '150ms',
        normal: '200ms',
        medium: '300ms',
        slow: '500ms',
      },
    },
  },
};
```

---

# 18. Theme Strategy

## 18.1 Light Theme (Default — v1.0)

The default theme uses warm-white backgrounds (`#FDFCFB`), warm stone neutrals, and the violet/amber brand palette. All tokens defined in §17.2 apply to this theme.

---

## 18.2 Dark Theme (v1.1)

Dark mode uses the same semantic tokens, overridden for the `.dark` class:

```css
.dark {
  --color-bg-base: #0d0b09;
  --color-bg-surface: #1a1714;
  --color-bg-subtle: #28241e;
  --color-bg-muted: #3f3a33;
  --color-text-primary: #f5f4f1;
  --color-text-secondary: #a8a49b;
  --color-text-muted: #79746a;
  --color-border-subtle: #3f3a33;
  --color-border-default: #57524a;
  /* Brand colors lighten for dark bg readability */
  --color-text-brand: #9879f8;
  --color-bg-brand: #3e19a0;
  --color-bg-brand-subtle: #2d1180;
}
```

**Dark mode illustration adaptation:**

- Illustrations have dark-mode variants (darker backgrounds, same composition)
- Book cover art is unchanged (it is its own world)
- Empty state illustrations use lighter strokes on dark background

---

## 18.3 Seasonal Themes (v1.2+)

Seasonal themes layer color shifts on top of the base token system, without structural changes.

| Season         | Primary shift                         | Accent shift                   | Background                |
| -------------- | ------------------------------------- | ------------------------------ | ------------------------- |
| Winter/Holiday | `violet-600` → deep emerald `#065F46` | Amber → warm gold `#F5A800`    | Cool white `#F8FAFA`      |
| Spring         | `violet-600` → soft rose `#9D174D`    | Amber → petal pink `#FBCFE8`   | Warm white (base)         |
| Summer         | `violet-600` → ocean teal `#0E7490`   | Amber → sunny yellow `#FDE047` | Warm white (base)         |
| Autumn         | `violet-600` → deep pumpkin `#9A3412` | Amber → maple gold (same)      | Slightly warmer `#FFF8F0` |

Seasonal themes are applied as a CSS class (`[data-season="winter"]`) and only affect the landing page, emails, and wizard backgrounds — never the core app UI (settings, checkout, etc.).

---

## 18.4 Future Brand Themes

For white-label and enterprise clients (v2.0+), the design system must support full re-theming via token override:

Only the following tokens need to be overridden for a full re-theme:

- `violet-600` (primary brand)
- `violet-50` through `violet-200` (light tints)
- `violet-700` (pressed state)
- `amber-500` (if client wants different celebration color)

All other colors (neutrals, semantic, backgrounds) remain fixed — they are brand-neutral by design.

---

# 19. Component Naming Convention

## 19.1 Component Naming Rules

Components use **PascalCase** for the component name. Format:

```
[Domain?][Component][Variant?]

Examples:
Button
ButtonGroup
BookCard
BookCardSkeleton
WizardStep
WizardProgressBar
ReaderToolbar
ReaderPageSpread
ChildAvatarPicker
ChildProfileCard
PricingCard
PricingCardFeatured
```

**Prefixes by domain:**

- No prefix: Generic UI primitives (Button, Input, Modal, Toast)
- `Book*`: Book content components (BookCard, BookCover, BookSpread)
- `Reader*`: Reader-specific (ReaderToolbar, ReaderProgressBar)
- `Wizard*`: Wizard-specific (WizardShell, WizardStep, WizardProgressBar)
- `Child*`: Child profile related (ChildAvatar, ChildProfileCard, ChildAvatarPicker)
- `Pricing*`: Pricing UI (PricingCard, PricingToggle)
- `Auth*`: Authentication (AuthModal, AuthForm)

---

## 19.2 Variant Naming

Variants are passed as props using camelCase strings:

```tsx
// Size variants
size = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

// Visual variants
variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'neutral';

// State variants (controlled by prop when not automatic)
status = 'loading' | 'success' | 'error' | 'disabled';

// Semantic variants (for cards, badges)
intent = 'default' | 'brand' | 'success' | 'warning' | 'danger' | 'amber';
```

---

## 19.3 File Structure

```
src/
  components/
    ui/              ← Primitive components (Button, Input, Modal...)
    book/            ← Book-specific components (BookCard, BookCover...)
    reader/          ← Reader components (ReaderToolbar...)
    wizard/          ← Wizard components (WizardShell, WizardStep...)
    child/           ← Child profile components
    layout/          ← Layout components (Header, Footer, Sidebar...)
    auth/            ← Auth components
    forms/           ← Form-level components (WizardForm, CheckoutForm...)
    feedback/        ← Toast, Alert, EmptyState, ErrorState...
  tokens/
    colors.ts        ← Color token exports
    typography.ts    ← Type token exports
    spacing.ts       ← Spacing token exports
    motion.ts        ← Motion token exports
  styles/
    globals.css      ← CSS custom properties, global resets
    tokens.css       ← All CSS custom properties
```

---

## 19.4 State Naming

CSS state classes follow BEM-adjacent patterns using `data-*` attributes (preferred over class-based states for accessibility integration):

```html
<!-- State via data attributes -->
<button data-variant="primary" data-size="md" data-loading="true"></button>

<!-- State via Tailwind data- variants -->
<button class="data-[loading=true]:cursor-wait data-[loading=true]:opacity-80"></button>
```

State order in component props/docs: `default → hover → focused → active/pressed → disabled → loading → error → success`

---

## 19.5 Icon Naming

Icons from Lucide keep their original camelCase naming (`ChevronDown`, `AlertCircle`, `Download`).

Custom StoryMe icons use the same convention with a `Story` prefix:

- `StoryBook` — open book with sparkle
- `StoryWand` — magic wand
- `StoryChild` — child silhouette

---

# 20. Design System Governance

## 20.1 Component Lifecycle

Every component goes through four stages:

```
Proposal → Experimental → Stable → Deprecated

[New need identified]
       ↓
   Proposal (issue in design-system repo)
       ↓
   Design review (1 designer + 1 engineer)
       ↓
   Experimental (released, flagged as experimental, API may change)
       ↓
   Stable (API locked, documented, safe to use in production)
       ↓
   Deprecated (replacement exists, 2-version warning period)
       ↓
   Removed
```

**Experimental components:** Available in the library but labeled `@experimental` in docs. Not covered by API stability guarantee.

**Stable components:** API is semver-stable. Breaking changes require major version bump and migration guide.

---

## 20.2 Versioning

The design system follows semantic versioning:

```
MAJOR.MINOR.PATCH

MAJOR: Breaking change (component API change, token rename, component removed)
MINOR: New component or token added (backwards-compatible)
PATCH: Bug fix, visual refinement, documentation update
```

The Figma library version is kept in sync with the code library version. When the code releases v1.3.0, the Figma library tags the corresponding frame.

---

## 20.3 Deprecation Policy

1. **Announcement:** Deprecated component/token gets `@deprecated` tag in docs + code JSDoc
2. **Warning period:** Minimum 2 minor versions (e.g., deprecated in 1.3 → removed no earlier than 1.5)
3. **Migration guide:** Every deprecation includes a migration path to the replacement
4. **Automated warning:** ESLint rule or TypeScript deprecation comment warns engineers at usage site

---

## 20.4 Review Process

**To add a new component:**

1. Create a GitHub issue with: use case, mockup, API proposal, affected screens
2. Design review: Is this genuinely reusable (used in 3+ places)? Or is it a one-off?
3. Engineering review: API completeness, accessibility requirements, token usage
4. Implementation in `experimental` branch
5. Design QA: Review against Figma spec
6. Promote to `stable`

**To modify a stable component:**

1. Non-breaking visual change: PATCH, no review needed if within design token constraints
2. Breaking API change: MAJOR, requires migration guide + 2-sprint notice

---

## 20.5 Documentation Standards

Every stable component must have:

- **Purpose:** 1-sentence description
- **When to use / When not to use**
- **Visual anatomy:** Labeled diagram
- **All variants:** Visual + code examples
- **All states:** Visual representation
- **Props table:** Name, type, default, description
- **Accessibility notes:** ARIA, keyboard
- **Responsive behavior**
- **Do/Don't examples:** At least 2 of each

Documentation lives in Storybook (code) and Figma (design). Both must be updated simultaneously.

---

## 20.6 Contribution Rules

**Designers:**

- All new components designed in the shared Figma library (not in individual project files)
- Use autolayout + component properties (no detached components)
- Use tokens from the token library (no raw hex values in Figma)
- Annotate interactions using Figma prototyping or FigJam notes

**Engineers:**

- All components use design tokens (CSS custom properties or Tailwind tokens) — no hardcoded values
- All components export TypeScript prop types
- All interactive components have keyboard support before PR is mergeable
- All components include a Storybook story covering every documented state

**Both:**

- No component ships without design QA (engineer's implementation reviewed against Figma) and engineering QA (designer verifies all states and interactions in the browser)

---

_End of Design System Document_

---

**Document Version:** 1.0
**Status:** Ready for Design & Engineering Implementation

**Companion documents:**

- [PRD.md](PRD.md) — What the product does
- [UX_SPEC.md](UX_SPEC.md) — How users interact with it
- [ARCHITECTURE.md](ARCHITECTURE.md) — How it's built technically
- [ROADMAP.md](ROADMAP.md) — When it's built

**Immediate next steps:**

- Design team: Build Figma token library from §17.2, import fonts (§4.1), implement component library starting with §9.1–9.6
- Engineering team: Configure Tailwind from §17.3, establish CSS custom property layer, scaffold component folder structure from §19.3
- Both: Align on Storybook setup for design-system documentation
