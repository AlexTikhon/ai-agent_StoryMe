# AI Children's Book Platform — Architecture Document

> Production-Grade Multi-Agent System
> Version 1.0 | Staff Engineer Reference Document

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [High-Level System Architecture](#2-high-level-system-architecture)
3. [Tech Stack & Rationale](#3-tech-stack--rationale)
4. [Multi-Agent AI Pipeline](#4-multi-agent-ai-pipeline)
5. [Sequence Diagrams](#5-sequence-diagrams)
6. [Data Flow](#6-data-flow)
7. [Database Schema](#7-database-schema)
8. [API Contracts](#8-api-contracts)
9. [Queue Architecture](#9-queue-architecture)
10. [Storage Architecture](#10-storage-architecture)
11. [AI Pipeline Deep Dive](#11-ai-pipeline-deep-dive)
12. [Prompt Templates](#12-prompt-templates)
13. [Context Management Strategy](#13-context-management-strategy)
14. [Character Memory Strategy](#14-character-memory-strategy)
15. [Illustration Consistency Strategy](#15-illustration-consistency-strategy)
16. [PDF Rendering Strategy](#16-pdf-rendering-strategy)
17. [Folder Structure](#17-folder-structure)
18. [Caching Strategy](#18-caching-strategy)
19. [Retry Logic & Error Handling](#19-retry-logic--error-handling)
20. [Monitoring & Logging](#20-monitoring--logging)
21. [Security & Authentication](#21-security--authentication)
22. [Cost Optimization](#22-cost-optimization)
23. [Scalability](#23-scalability)
24. [Deployment — Docker & Kubernetes](#24-deployment--docker--kubernetes)
25. [CI/CD Pipeline](#25-cicd-pipeline)
26. [Testing Strategy](#26-testing-strategy)
27. [Design Decisions & Trade-offs](#27-design-decisions--trade-offs)

---

## 1. Executive Summary

The **AI Children's Book Platform** is a production-grade, multi-tenant SaaS that generates
fully personalized, professionally illustrated children's books on demand. A parent provides
a short profile of their child; within minutes the system delivers a print-ready PDF that
places that exact child — by name, appearance, personality, and world — as the hero of a
coherent, age-appropriate story with consistent AI illustrations.

### Core Innovation

Unlike a single-prompt LLM call, the platform is built as a **directed multi-agent pipeline**
where each agent owns a specific creative or engineering concern:

- Story coherence is owned by the **Story Planner** + **Chapter Writer** agents
- Visual consistency is enforced by the **Character Consistency Agent** across every page
- Layout and typography are handled independently by the **Layout Agent**
- Quality gates are applied before the PDF is assembled

This separation allows independent regeneration of any single concern (text, illustration,
layout) without rerunning the full pipeline.

### Scale Target

- Phase 1: 0–50k books/month (single region, vertical scaling)
- Phase 2: 50k–500k books/month (multi-region, horizontal scaling)
- Phase 3: 500k+ books/month (global CDN, Kubernetes autoscaling)

---

## 2. High-Level System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CLIENT LAYER                                    │
│                                                                              │
│   ┌─────────────────────┐          ┌──────────────────────────────────────┐ │
│   │   Next.js Web App   │          │   Mobile (future — React Native)     │ │
│   │   (SSR + CSR)       │          │                                      │ │
│   └──────────┬──────────┘          └──────────────────────────────────────┘ │
└──────────────┼──────────────────────────────────────────────────────────────┘
               │ HTTPS
               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              API GATEWAY LAYER                               │
│                                                                              │
│   ┌──────────────────────────────────────────────────────────────────────┐  │
│   │               Nginx / Cloudflare (rate limiting, TLS, CDN)          │  │
│   └───────────────────────────────┬──────────────────────────────────────┘  │
└───────────────────────────────────┼─────────────────────────────────────────┘
                                    │
               ┌────────────────────┼────────────────────┐
               │                    │                    │
               ▼                    ▼                    ▼
┌──────────────────────┐ ┌─────────────────────┐ ┌─────────────────────────┐
│   NestJS API Server  │ │  WebSocket Server   │ │   Next.js API Routes    │
│   (REST + Auth)      │ │  (real-time status) │ │   (BFF layer)           │
└──────────┬───────────┘ └──────────┬──────────┘ └─────────────────────────┘
           │                        │
           ▼                        ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                          ORCHESTRATION LAYER                                  │
│                                                                               │
│   ┌────────────────────────────────────────────────────────────────────────┐ │
│   │                    Book Orchestrator Service                           │ │
│   │   (coordinates agent pipeline, manages state machine, handles retries) │ │
│   └────────────────────────────────┬───────────────────────────────────────┘ │
└───────────────────────────────────┼──────────────────────────────────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    │               │               │
                    ▼               ▼               ▼
        ┌──────────────────┐  ┌──────────┐  ┌────────────────┐
        │  BullMQ Queues   │  │  Redis   │  │  PostgreSQL    │
        │  (job routing)   │  │  (cache) │  │  (persistence) │
        └────────┬─────────┘  └──────────┘  └────────────────┘
                 │
     ┌───────────┼──────────────────────────────────────────┐
     │           │    AGENT WORKER POOL                     │
     │           ▼                                          │
     │  ┌─────────────────────────────────────────────────┐ │
     │  │  Agent Workers (separate Node.js processes)     │ │
     │  │                                                  │ │
     │  │  ┌──────────────┐  ┌──────────────────────────┐ │ │
     │  │  │ CharBuilder  │  │    Story Planner         │ │ │
     │  │  └──────────────┘  └──────────────────────────┘ │ │
     │  │  ┌──────────────┐  ┌──────────────────────────┐ │ │
     │  │  │ ChapterWriter│  │  IllustrationPromptGen   │ │ │
     │  │  └──────────────┘  └──────────────────────────┘ │ │
     │  │  ┌──────────────┐  ┌──────────────────────────┐ │ │
     │  │  │ ImageGenAgent│  │  CharConsistencyAgent    │ │ │
     │  │  └──────────────┘  └──────────────────────────┘ │ │
     │  │  ┌──────────────┐  ┌──────────────────────────┐ │ │
     │  │  │ LayoutAgent  │  │  QualityReviewAgent      │ │ │
     │  │  └──────────────┘  └──────────────────────────┘ │ │
     │  │  ┌──────────────┐                               │ │
     │  │  │ PDFGenerator │                               │ │
     │  │  └──────────────┘                               │ │
     │  └─────────────────────────────────────────────────┘ │
     └───────────────────────────────────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                          EXTERNAL AI PROVIDERS                                │
│                                                                               │
│   ┌───────────────┐  ┌────────────────┐  ┌──────────────┐  ┌─────────────┐  │
│   │  Anthropic    │  │  OpenAI        │  │  fal.ai /    │  │  ElevenLabs │  │
│   │  Claude 4.x   │  │  GPT-4o        │  │  Flux / DALL │  │  (audio)    │  │
│   │  (story/QA)   │  │  (fallback)    │  │  -E 3        │  │  (future)   │  │
│   └───────────────┘  └────────────────┘  └──────────────┘  └─────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                             STORAGE LAYER                                     │
│                                                                               │
│   ┌──────────────────────────────┐   ┌─────────────────────────────────────┐ │
│   │   Cloudflare R2              │   │   CDN (Cloudflare)                  │ │
│   │   - raw images               │   │   - PDFs served to users            │ │
│   │   - PDFs                     │   │   - public preview thumbnails       │ │
│   │   - EPUB (future)            │   └─────────────────────────────────────┘ │
│   │   - audio (future)           │                                           │
│   └──────────────────────────────┘                                           │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Tech Stack & Rationale

### 3.1 Frontend

| Technology                          | Version         | Why                                                                                                     |
| ----------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------- |
| **Next.js**                         | 15 (App Router) | SSR for SEO on marketing pages; RSC for fast initial load of book previewer; built-in API routes as BFF |
| **React**                           | 19              | Concurrent rendering for smooth page flip animation                                                     |
| **TypeScript**                      | 5.x             | End-to-end type safety shared with backend via tRPC or OpenAPI codegen                                  |
| **TailwindCSS**                     | 4.x             | Rapid UI iteration; purges to tiny CSS bundle                                                           |
| **Zustand**                         | 5.x             | Lightweight client state (wizard steps, active book session)                                            |
| **React Query (TanStack)**          | 5.x             | Server state, polling for job status, background refetch                                                |
| **Framer Motion**                   | 11.x            | Book page-flip animations, cover reveal                                                                 |
| **React-PDF (@react-pdf/renderer)** | 3.x             | Client-side PDF preview in browser before download                                                      |

**Key trade-off:** Next.js App Router vs. plain Vite SPA.
We choose Next.js because the marketing funnel (landing, examples, pricing) benefits enormously
from SSR/SEO, and we can colocate the BFF layer. A Vite SPA would require a separate SSR solution.

---

### 3.2 Backend

| Technology                          | Why                                                                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **NestJS** (Node.js + TypeScript)   | Modular DI architecture maps perfectly to our agent modules. Decorator-based validation. First-class support for BullMQ, WebSocket, Guards. |
| **FastAPI** (Python — Image Worker) | Image generation + ML preprocessing is Python-native. FastAPI handles async image jobs efficiently with Pydantic validation.                |
| **Prisma ORM**                      | Type-safe DB client, migrations, relations; codegen keeps types in sync                                                                     |
| **BullMQ**                          | Redis-backed queue with priorities, rate limiting, concurrency control, retries with backoff — critical for AI job orchestration            |
| **Socket.io**                       | Real-time progress events back to client during book generation (page-by-page streaming)                                                    |
| **Zod**                             | Schema validation at API boundaries; shared with frontend                                                                                   |

**Why NestJS over FastAPI for the main API?**
The orchestration layer is TypeScript-native (same language as frontend, shared types via monorepo).
Python FastAPI is isolated to the image worker only where ML libraries are needed.

---

### 3.3 AI Layer

| Provider                                       | Role                                                 | Why                                                                                                                     |
| ---------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Claude claude-sonnet-4-6 / claude-opus-4-8** | Story planning, chapter writing, quality review      | Best narrative coherence and instruction-following for long-form creative content. Extended thinking for plot planning. |
| **GPT-4o**                                     | Fallback for story; illustration prompt optimization | Provider redundancy; GPT-4o vision for quality review of images                                                         |
| **Gemini 2.5 Pro**                             | Multi-language translation, secondary fallback       | Superior multilingual capabilities for non-English books                                                                |
| **fal.ai → Flux 1.1 Pro**                      | Illustration generation                              | Best quality/speed/cost ratio for stylized children's illustrations. Supports LoRA for character consistency.           |
| **DALL-E 3**                                   | Fallback image generation                            | OpenAI platform reliability as backup                                                                                   |
| **ElevenLabs**                                 | Audiobook narration (future)                         | Best child-friendly TTS voices                                                                                          |

---

### 3.4 Infrastructure

| Technology                          | Why                                                                                    |
| ----------------------------------- | -------------------------------------------------------------------------------------- |
| **PostgreSQL 16**                   | JSONB for flexible agent outputs; pgvector for character embedding similarity search   |
| **Redis 7**                         | BullMQ queues + job state cache + rate limit counters + session cache                  |
| **Cloudflare R2**                   | S3-compatible, zero egress fees (critical at scale — PDFs are large). Integrated CDN.  |
| **Docker + Docker Compose**         | Dev/prod parity                                                                        |
| **Kubernetes (GKE/EKS)**            | Autoscaling agent workers independently; node pools for GPU (future)                   |
| **OpenTelemetry + Grafana + Tempo** | Distributed tracing across agent pipeline; critical for debugging multi-agent failures |
| **Sentry**                          | Error tracking with source maps                                                        |
| **GitHub Actions**                  | CI/CD                                                                                  |

---

## 4. Multi-Agent AI Pipeline

### 4.1 Agent Roles & Responsibilities

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        AGENT PIPELINE OVERVIEW                               │
│                                                                               │
│  INPUT: BookRequest (child profile + preferences)                            │
│                                                                               │
│  ┌─────────────────┐                                                         │
│  │  1. CHARACTER   │  Builds canonical character card:                       │
│  │     BUILDER     │  visual description, personality traits,                │
│  │     AGENT       │  speech patterns, appearance details                    │
│  └────────┬────────┘                                                         │
│           │  CharacterCard                                                   │
│           ▼                                                                  │
│  ┌─────────────────┐                                                         │
│  │  2. STORY       │  Creates: title, synopsis, chapter outline,            │
│  │     PLANNER     │  moral arc, scene list, illustratable moments          │
│  │     AGENT       │  (uses CharacterCard as context)                       │
│  └────────┬────────┘                                                         │
│           │  StoryPlan                                                       │
│           ▼                                                                  │
│  ┌─────────────────┐  ┌─────────────────────────────────────────────────┐   │
│  │  3. CHAPTER     │  │  Runs in parallel per chapter                   │   │
│  │     WRITER      │  │  Input: StoryPlan + CharacterCard + prev chapter │   │
│  │     AGENT       │  │  Output: Chapter text + page breaks + dialogues  │   │
│  └────────┬────────┘  └─────────────────────────────────────────────────┘   │
│           │  [Chapter[]]                                                     │
│           ▼                                                                  │
│  ┌─────────────────┐  ┌─────────────────────────────────────────────────┐   │
│  │  4. ILLUST.     │  │  Per page: generates detailed image prompt      │   │
│  │     PROMPT      │  │  Input: page text + CharacterCard + style prefs │   │
│  │     GENERATOR   │  │  Output: structured ImagePrompt with            │   │
│  └────────┬────────┘  │  character anchors + scene + mood + style      │   │
│           │  [ImagePrompt[]]     └─────────────────────────────────────┘    │
│           ▼                                                                  │
│  ┌─────────────────┐                                                         │
│  │  5. CHARACTER   │  Injects character LoRA tokens into all prompts        │
│  │     CONSIST.    │  Cross-checks prompts for visual continuity            │
│  │     AGENT       │  Ensures same hair/eyes/clothes across all pages       │
│  └────────┬────────┘                                                         │
│           │  [EnrichedImagePrompt[]]                                         │
│           ▼                                                                  │
│  ┌─────────────────┐  ┌─────────────────────────────────────────────────┐   │
│  │  6. IMAGE       │  │  Parallel image generation (rate-limited)       │   │
│  │     GENERATION  │  │  Calls fal.ai Flux API                          │   │
│  │     AGENT       │  │  Stores raw images in R2                        │   │
│  └────────┬────────┘  └─────────────────────────────────────────────────┘   │
│           │  [GeneratedImage[]]                                              │
│           ▼                                                                  │
│  ┌─────────────────┐                                                         │
│  │  7. QUALITY     │  Reviews each page (text + image):                     │
│  │     REVIEW      │  - age-appropriate content check                       │
│  │     AGENT       │  - character consistency score                         │
│  │                 │  - text-image alignment score                          │
│  │                 │  - reading level validation                            │
│  └────────┬────────┘                                                         │
│           │  QualityReport (pass | regenerate_image | regenerate_text)      │
│           ▼                                                                  │
│  ┌─────────────────┐                                                         │
│  │  8. LAYOUT      │  Composites page: text + image + decorations          │
│  │     AGENT       │  Applies typography rules for age/language             │
│  │                 │  Generates per-page JSON layout spec                  │
│  └────────┬────────┘                                                         │
│           │  [PageLayout[]]                                                  │
│           ▼                                                                  │
│  ┌─────────────────┐                                                         │
│  │  9. PDF         │  Renders final PDF from PageLayout specs              │
│  │     GENERATOR   │  Embeds fonts, optimizes images                       │
│  │                 │  Uploads to R2, returns signed URL                    │
│  └─────────────────┘                                                         │
│                                                                               │
│  OUTPUT: BookResult { pdfUrl, previewUrl, metadata }                        │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 Agent Interfaces (TypeScript)

```typescript
// Core types shared across all agents

interface CharacterCard {
  name: string;
  age: number;
  gender: string;
  appearance: {
    hairColor: string;
    hairStyle: string;
    eyeColor: string;
    skinTone: string;
    height: string;
    distinctiveFeatures: string[];
  };
  personality: string[];
  speechPatterns: string[];
  favoriteItems: string[]; // toys, colors, animals — woven into story
  visualAnchor: string; // single canonical visual description for image prompts
}

interface StoryPlan {
  title: string;
  synopsis: string;
  educationalGoal: string;
  moralArc: string;
  chapters: ChapterOutline[];
  illustrableScenes: SceneSpec[];
  coverScene: SceneSpec;
}

interface ChapterOutline {
  number: number;
  title: string;
  summary: string;
  keyMoment: string;
  emotionalBeat: string;
  suggestedSpread: 'full-page' | 'half-page' | 'double-spread';
}

interface Chapter {
  number: number;
  title: string;
  pages: Page[];
}

interface Page {
  pageNumber: number;
  text: string;
  readingLevel: number; // Flesch-Kincaid grade
  wordCount: number;
  illustrationNote: string; // art director note for this page
}

interface ImagePrompt {
  pageNumber: number;
  positivePrompt: string;
  negativePrompt: string;
  characterAnchor: string; // injected character LoRA/description
  style: IllustrationStyle;
  mood: string;
  colorPalette: string[];
  aspectRatio: '4:3' | '16:9' | '1:1' | '3:4';
}

interface GeneratedImage {
  pageNumber: number;
  r2Key: string;
  url: string;
  seed: number; // stored for deterministic regeneration
  model: string;
  promptHash: string;
}

interface QualityReport {
  pageNumber: number;
  passed: boolean;
  issues: QualityIssue[];
  consistencyScore: number; // 0–1
  alignmentScore: number; // 0–1
  action: 'pass' | 'regen_image' | 'regen_text' | 'regen_both';
}

interface PageLayout {
  pageNumber: number;
  layoutTemplate: LayoutTemplate;
  textBlocks: TextBlock[];
  imageSpec: ImageSpec;
  decorations: Decoration[];
  backgroundColor: string;
  fonts: FontSpec;
}
```

### 4.3 Orchestrator State Machine

```
                     ┌─────────┐
                     │ CREATED │
                     └────┬────┘
                          │ start()
                          ▼
                   ┌────────────┐
                   │ CHAR_BUILD │
                   └─────┬──────┘
                         │ success
                         ▼
                   ┌────────────┐
                   │ STORY_PLAN │
                   └─────┬──────┘
                         │ success
                         ▼
                  ┌─────────────┐
                  │ CHAPTER_GEN │◄─── parallel workers per chapter
                  └──────┬──────┘
                         │ all chapters done
                         ▼
                  ┌─────────────┐
                  │ ILLUST_PLAN │◄─── parallel prompt gen per page
                  └──────┬──────┘
                         │ all prompts done
                         ▼
                  ┌──────────────┐
                  │ CHAR_CONSIST │ (enrich all prompts)
                  └──────┬───────┘
                         │
                         ▼
                  ┌──────────────┐
                  │  IMAGE_GEN   │◄─── parallel, rate-limited
                  └──────┬───────┘
                         │ all images done
                         ▼
                  ┌──────────────┐
              ┌──►│  QA_REVIEW   │
              │   └──────┬───────┘
              │          │ issues found
              │          ├─────────────────────────────┐
              │          │                             ▼
              │          │ pass             ┌────────────────────┐
              │          │                  │  REGEN (per page)  │──┐
              │          │                  └────────────────────┘  │
              │          │                         regen done        │
              └──────────┼─────────────────────────────────────────┘
                         │ all passed
                         ▼
                   ┌───────────┐
                   │  LAYOUT   │
                   └─────┬─────┘
                         │
                         ▼
                  ┌─────────────┐
                  │ PDF_RENDER  │
                  └──────┬──────┘
                         │
                         ▼
                   ┌──────────┐
                   │ COMPLETE │
                   └──────────┘

  On any step: ERROR ──► FAILED (with partial state saved for resume)
```

---

## 5. Sequence Diagrams

### 5.1 Book Generation — Happy Path

```
Client          API Server      Orchestrator    BullMQ          AgentWorkers     R2
  │                 │               │              │                 │            │
  │ POST /books     │               │              │                 │            │
  ├────────────────►│               │              │                 │            │
  │                 │ createBook()  │              │                 │            │
  │                 ├──────────────►│              │                 │            │
  │                 │               │ enqueue()    │                 │            │
  │                 │               ├─────────────►│                 │            │
  │                 │  bookId       │              │                 │            │
  │◄────────────────┤               │              │                 │            │
  │                 │               │              │ char:build job  │            │
  │  WS: progress   │               │              ├────────────────►│            │
  │◄─── ─ ─ ─ ─ ─ ─│─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  │                 │            │
  │                 │               │              │                 │            │
  │                 │               │              │  CharacterCard  │            │
  │                 │               │◄─────────────┼─────────────────┤            │
  │                 │               │ enqueue      │                 │            │
  │                 │               ├─────────────►│ story:plan job  │            │
  │                 │               │              ├────────────────►│            │
  │                 │               │              │   StoryPlan     │            │
  │                 │               │◄─────────────┼─────────────────┤            │
  │                 │               │ enqueue N    │                 │            │
  │                 │               ├─────────────►│ chapter:write   │            │
  │                 │               │              ├────────────────►│ (parallel) │
  │  WS: chapters   │               │              │  Chapter[]      │            │
  │◄─── ─ ─ ─ ─ ─ ─│─ ─ ─ ─ ─ ─ ─ │              │◄────────────────┤            │
  │                 │               │ enqueue N    │                 │            │
  │                 │               ├─────────────►│ illust:prompt   │            │
  │                 │               │              ├────────────────►│            │
  │                 │               │              │ ImagePrompt[]   │            │
  │                 │               │◄─────────────┼─────────────────┤            │
  │                 │               │ enqueue N    │                 │            │
  │                 │               ├─────────────►│ image:gen       │            │
  │                 │               │              ├────────────────►│ fal.ai call│
  │  WS: image done │               │              │                 ├───────────►│
  │◄─── ─ ─ ─ ─ ─ ─│─ ─ ─ ─ ─ ─ ─ │              │ GeneratedImage[]│  store     │
  │                 │               │◄─────────────┼─────────────────┤───────────►│
  │                 │               │ enqueue      │                 │            │
  │                 │               ├─────────────►│ qa:review       │            │
  │                 │               │              ├────────────────►│            │
  │                 │               │              │ QualityReport   │            │
  │                 │               │◄─────────────┼─────────────────┤            │
  │                 │               │ enqueue      │                 │            │
  │                 │               ├─────────────►│ layout:compose  │            │
  │                 │               │              ├────────────────►│            │
  │                 │               │              │ PageLayout[]    │            │
  │                 │               │◄─────────────┼─────────────────┤            │
  │                 │               │ enqueue      │                 │            │
  │                 │               ├─────────────►│ pdf:render      │            │
  │                 │               │              ├────────────────►│ upload PDF │
  │                 │               │              │                 ├───────────►│
  │                 │               │              │   pdfUrl        │            │
  │                 │               │◄─────────────┼─────────────────┤            │
  │  WS: COMPLETE   │               │              │                 │            │
  │◄─── ─ ─ ─ ─ ─ ─│◄──────────────┤              │                 │            │
  │                 │               │              │                 │            │
```

### 5.2 Partial Regeneration (user requests redo of page 5 illustration)

```
Client         API Server      Orchestrator     IllustAgent   CharConsistAgent  R2
  │                │               │               │               │            │
  │ PATCH /books/  │               │               │               │            │
  │  {bookId}/     │               │               │               │            │
  │  pages/5/      │               │               │               │            │
  │  regen-image   │               │               │               │            │
  ├───────────────►│               │               │               │            │
  │                │ regenPage()   │               │               │            │
  │                ├──────────────►│               │               │            │
  │                │               │ load cached   │               │            │
  │                │               │ CharacterCard │               │            │
  │                │               │ + ImagePrompt │               │            │
  │                │               ├──────────────►│               │            │
  │                │               │               │ enrich prompt │            │
  │                │               │               ├──────────────►│            │
  │                │               │               │ enriched      │            │
  │                │               │               │◄──────────────┤            │
  │                │               │               │ new seed      │            │
  │                │               │               │ fal.ai call   │            │
  │                │               │               ├──────────────────────────►│
  │                │               │               │ new image     │            │
  │                │               │               │◄──────────────────────────┤
  │                │               │ run QA on page│               │            │
  │                │               ├──────────────►│               │            │
  │                │               │ pass          │               │            │
  │                │               │◄──────────────┤               │            │
  │                │               │ re-render PDF │               │            │
  │                │               │ (page 5 only, │               │            │
  │                │               │  merge)       │               │            │
  │  new PDF URL   │               │               │               │            │
  │◄───────────────┤◄──────────────┤               │               │            │
```

---

## 6. Data Flow

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  USER INPUT                                                                   │
│  BookRequest {                                                                │
│    childName, age, gender, appearance, personality,                          │
│    favoriteAnimals, favoriteColors, favoriteToys,                            │
│    hobbies, educationalGoal, genre, bookLength,                              │
│    illustrationStyle, language                                               │
│  }                                                                           │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  VALIDATION LAYER (Zod)                                                       │
│  - sanitize all string inputs                                                 │
│  - validate age range (2–12)                                                  │
│  - validate book length (8, 16, 24, 32 pages)                                │
│  - detect PII, profanity, harmful intent                                      │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  BOOK RECORD (PostgreSQL)                                                     │
│  books { id, userId, status, request (JSONB), result (JSONB), ... }          │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │
                          ┌─────┴──────┐
                          │  BullMQ    │
                          │  Job Queue │
                          └─────┬──────┘
                                │
            ┌───────────────────┼───────────────────┐
            ▼                   ▼                   ▼
    ┌───────────────┐  ┌────────────────┐  ┌──────────────────┐
    │  Agent reads  │  │  Agent writes  │  │  Agent publishes │
    │  from DB +    │  │  output to DB  │  │  progress via    │
    │  Redis cache  │  │  (JSONB cols)  │  │  Redis pub/sub   │
    └───────────────┘  └────────────────┘  └──────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  BINARY ASSETS (Cloudflare R2)                                                │
│  r2://books/{bookId}/images/page-{n}.png                                     │
│  r2://books/{bookId}/book.pdf                                                │
│  r2://books/{bookId}/cover.png                                               │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  DELIVERY (Cloudflare CDN)                                                    │
│  cdn.bookplatform.com/books/{bookId}/book.pdf                                │
│  Signed URLs with 24h expiry for PDF downloads                               │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 7. Database Schema

```sql
-- Users & Auth
CREATE TABLE users (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email        TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  name         TEXT,
  oauth_provider TEXT,
  oauth_id     TEXT,
  plan         TEXT NOT NULL DEFAULT 'free', -- free | pro | enterprise
  credits      INTEGER NOT NULL DEFAULT 3,
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);

-- Books (top-level record)
CREATE TABLE books (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'created',
  -- status enum: created | char_build | story_plan | chapter_gen |
  --              illust_plan | image_gen | qa_review | layout |
  --              pdf_render | complete | failed | partial

  -- Input
  request       JSONB NOT NULL,    -- full BookRequest object

  -- Agent outputs (stored as JSONB for schema flexibility)
  character_card      JSONB,
  story_plan          JSONB,
  chapters            JSONB,       -- Chapter[]
  image_prompts       JSONB,       -- ImagePrompt[]
  quality_report      JSONB,       -- QualityReport[]
  page_layouts        JSONB,       -- PageLayout[]

  -- Result
  pdf_r2_key    TEXT,
  pdf_url       TEXT,
  cover_url     TEXT,
  page_count    INTEGER,

  -- Metadata
  generation_time_ms  INTEGER,
  total_cost_usd      DECIMAL(10, 6),
  ai_model_versions   JSONB,       -- {story: "claude-sonnet-4-6", image: "flux-1.1-pro"}

  error_message TEXT,
  retry_count   INTEGER DEFAULT 0,

  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_books_user_id ON books(user_id);
CREATE INDEX idx_books_status ON books(status);

-- Individual pages (for partial regeneration)
CREATE TABLE book_pages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id       UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  page_number   INTEGER NOT NULL,

  text_content  TEXT,
  reading_level DECIMAL(3,1),

  image_prompt  JSONB,
  image_r2_key  TEXT,
  image_url     TEXT,
  image_seed    BIGINT,           -- for deterministic regen

  layout_spec   JSONB,

  qa_passed     BOOLEAN,
  qa_scores     JSONB,
  regen_count   INTEGER DEFAULT 0,

  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now(),

  UNIQUE(book_id, page_number)
);

-- Character cards (reusable across book series)
CREATE TABLE character_cards (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  card          JSONB NOT NULL,   -- CharacterCard
  visual_anchor TEXT NOT NULL,    -- canonical image prompt fragment
  lora_weights  TEXT,             -- path to trained LoRA (future)
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- Book series
CREATE TABLE series (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  character_card_id UUID REFERENCES character_cards(id),
  book_ids      UUID[] NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- Credit transactions
CREATE TABLE credit_transactions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id),
  book_id       UUID REFERENCES books(id),
  amount        INTEGER NOT NULL,  -- negative = deduct, positive = add
  reason        TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- Audit log
CREATE TABLE agent_logs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id       UUID NOT NULL REFERENCES books(id),
  agent         TEXT NOT NULL,
  step          TEXT NOT NULL,
  duration_ms   INTEGER,
  tokens_used   INTEGER,
  cost_usd      DECIMAL(10,6),
  status        TEXT NOT NULL,   -- success | error | retry
  error         TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_agent_logs_book_id ON agent_logs(book_id);
```

---

## 8. API Contracts

### 8.1 REST Endpoints

```
Authentication
──────────────
POST   /api/auth/register
POST   /api/auth/login
POST   /api/auth/logout
POST   /api/auth/refresh
POST   /api/auth/google          (OAuth)

Books
──────
POST   /api/books                Create book generation job
GET    /api/books                List user's books (paginated)
GET    /api/books/:id            Get book status + metadata
DELETE /api/books/:id            Delete book

Regeneration
────────────
PATCH  /api/books/:id/pages/:n/regen-image    Regenerate single page image
PATCH  /api/books/:id/pages/:n/regen-text     Regenerate single page text
PATCH  /api/books/:id/pages/:n/regen-all      Regenerate page (text + image)
POST   /api/books/:id/regenerate              Regenerate full book (new seed)

Downloads
─────────
GET    /api/books/:id/download/pdf            Returns signed R2 URL (24h)
GET    /api/books/:id/download/epub           (future)
GET    /api/books/:id/preview/:pageN          Page thumbnail

Series
──────
POST   /api/series                            Create series
GET    /api/series                            List user's series
POST   /api/series/:id/books                 Add book to series (inherits character)

Characters
──────────
GET    /api/characters                        List saved character cards
GET    /api/characters/:id                    Get character card
DELETE /api/characters/:id                    Delete character card

Credits & Billing
─────────────────
GET    /api/credits/balance
GET    /api/credits/transactions
POST   /api/billing/checkout                  Stripe checkout session
POST   /api/billing/webhook                   Stripe webhook handler

Admin
─────
GET    /api/admin/books                       All books (paginated)
GET    /api/admin/stats                       Platform metrics
PATCH  /api/admin/books/:id/refund            Refund credits
```

### 8.2 Request / Response Contracts

```typescript
// POST /api/books
interface CreateBookRequest {
  childName: string; // 1–50 chars
  age: number; // 2–12
  gender: 'boy' | 'girl' | 'nonbinary';
  appearance: {
    hairColor: string;
    hairStyle: string;
    eyeColor: string;
    skinTone: string;
    height?: 'tall' | 'average' | 'short';
    distinctiveFeatures?: string[];
  };
  personality: string[]; // max 5 traits
  favoriteAnimals: string[]; // max 3
  favoriteColors: string[]; // max 3
  favoriteToys: string[]; // max 3
  hobbies: string[]; // max 5
  educationalGoal: string; // free text, max 200 chars
  genre: BookGenre; // 'adventure' | 'fantasy' | 'friendship' | 'mystery' | 'nature'
  bookLength: 8 | 16 | 24 | 32;
  illustrationStyle: IllustrationStyle;
  language: string; // BCP-47 code: 'en', 'es', 'fr', 'de', 'ru', etc.
}

interface CreateBookResponse {
  bookId: string;
  estimatedMinutes: number;
  creditsCharged: number;
  wsChannel: string; // WebSocket channel to subscribe for progress
}

// GET /api/books/:id
interface BookStatusResponse {
  id: string;
  status: BookStatus;
  progress: {
    currentStep: string;
    completedSteps: string[];
    percentComplete: number;
  };
  result?: {
    pdfUrl: string;
    coverUrl: string;
    title: string;
    pageCount: number;
    generationTimeMs: number;
  };
  error?: string;
  createdAt: string;
}

// WebSocket progress events
interface WsProgressEvent {
  type: 'book:progress' | 'book:complete' | 'book:error' | 'page:ready';
  bookId: string;
  step?: string;
  pageNumber?: number;
  pageImageUrl?: string;
  percentComplete?: number;
  error?: string;
  result?: BookResult;
}
```

---

## 9. Queue Architecture

### 9.1 Queue Topology

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           BULLMQ QUEUE TOPOLOGY                              │
│                                                                               │
│  Priority: HIGH (interactive regen) > NORMAL (new book) > LOW (batch)       │
│                                                                               │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  Queue: book:orchestrate       (1 worker, handles state transitions)   │  │
│  │  Queue: agent:char-build       (5 workers)                            │  │
│  │  Queue: agent:story-plan       (5 workers)                            │  │
│  │  Queue: agent:chapter-write    (20 workers, most parallelizable)      │  │
│  │  Queue: agent:illust-prompt    (10 workers)                           │  │
│  │  Queue: agent:image-gen        (10 workers, rate-limited by API)      │  │
│  │  Queue: agent:qa-review        (10 workers)                           │  │
│  │  Queue: agent:layout           (10 workers)                           │  │
│  │  Queue: agent:pdf-render       (5 workers, memory-intensive)          │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                               │
│  Retry Policy (per queue):                                                   │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  attempts: 3                                                           │  │
│  │  backoff: { type: 'exponential', delay: 2000 }                        │  │
│  │  removeOnComplete: { age: 3600, count: 1000 }                        │  │
│  │  removeOnFail: { age: 86400 }                                         │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                               │
│  Rate Limiting (image:gen queue):                                            │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  max: 50 requests per 60 seconds (fal.ai tier limit)                  │  │
│  │  implemented via BullMQ rate limiter middleware                        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 9.2 Job Data Contract

```typescript
interface AgentJob<T> {
  bookId: string;
  userId: string;
  step: AgentStep;
  input: T;
  priority: 'high' | 'normal' | 'low';
  traceId: string; // OpenTelemetry trace propagation
  attempt: number;
}
```

---

## 10. Storage Architecture

### 10.1 R2 Bucket Layout

```
bucket: ai-children-books-prod
├── books/
│   └── {bookId}/
│       ├── cover.png                  (1024×1536, cover image)
│       ├── cover-thumb.webp           (300×450, CDN thumbnail)
│       ├── book.pdf                   (final PDF, ~5–20MB)
│       ├── book-preview.pdf           (first 3 pages, watermarked)
│       ├── images/
│       │   ├── page-01.png            (raw generated image)
│       │   ├── page-01-optimized.webp (web delivery)
│       │   ├── page-02.png
│       │   └── ...
│       └── epub/                      (future)
│           └── book.epub
│
├── characters/
│   └── {characterCardId}/
│       ├── reference.png              (character reference sheet)
│       └── lora/                      (future: trained LoRA weights)
│           └── weights.safetensors
│
└── assets/
    ├── fonts/                         (embedded in PDFs)
    ├── decorations/                   (page border SVGs)
    └── templates/                     (page layout templates)
```

### 10.2 Access Patterns

| Asset                | Access Pattern                 | TTL          |
| -------------------- | ------------------------------ | ------------ |
| Book PDF download    | Signed URL, user-authenticated | 24h          |
| Page image (preview) | Public CDN URL                 | Permanent    |
| Cover thumbnail      | Public CDN URL                 | Permanent    |
| In-progress images   | Private, API-proxied           | Job lifetime |

---

## 11. AI Pipeline Deep Dive

### 11.1 Character Builder Agent

**Model:** Claude claude-sonnet-4-6
**Input:** Raw BookRequest
**Output:** CharacterCard + visualAnchor string

**Responsibilities:**

- Normalize appearance descriptions into precise, image-prompt-friendly language
- Infer cultural context from name/language to avoid visual stereotyping
- Generate the canonical `visualAnchor` — a single, dense visual description used consistently across ALL image prompts
- Define speech patterns and vocabulary level for the chapter writer

**Key design:** The `visualAnchor` is the single source of truth for all illustration consistency.
Example: `"Emma, 6-year-old girl, curly red hair with freckles, bright green eyes, wearing blue dungarees and yellow rain boots, cheerful expression"`

---

### 11.2 Story Planner Agent

**Model:** Claude claude-opus-4-8 with extended thinking (budget: 5000 tokens)
**Input:** BookRequest + CharacterCard
**Output:** StoryPlan

**Responsibilities:**

- Create a three-act narrative structure appropriate for child's age
- Embed the educational goal organically into the plot
- Define exactly which moments should be illustrated (max 1 per page spread)
- Plan emotional beats for consistent tone across chapters
- Generate scene descriptions that are visually concrete for the image model

**Why Opus with extended thinking?**
Story coherence is the most cognitively demanding step. Extended thinking allows the model
to plan the full story arc before committing to the outline, dramatically reducing incoherent
plot progressions. The 5000-token thinking budget adds ~$0.04/book — justified by quality.

---

### 11.3 Chapter Writer Agent

**Model:** Claude claude-sonnet-4-6 (cost/quality balance)
**Input:** ChapterOutline + CharacterCard + PreviousChapterSummary
**Output:** Chapter (pages with text)
**Parallelism:** All chapters written concurrently

**Context management:**

- Each worker receives: system prompt + character card + story plan + previous chapter summary (NOT full text)
- This keeps context window lean while preserving narrative continuity
- After writing, generates its own 200-token summary for the next chapter

**Reading level enforcement:**

- Target Flesch-Kincaid grade level calculated from child's age: `grade = age - 4`
- Post-processing validation using `flesch-kincaid` npm package
- Auto-simplification pass if score is too high

---

### 11.4 Illustration Prompt Generator Agent

**Model:** Claude claude-sonnet-4-6
**Input:** Page text + CharacterCard + IllustrationStyle + ColorPalette
**Output:** Structured ImagePrompt
**Parallelism:** All pages concurrently

**Core task:** Translate narrative prose into precise, image-model-optimized prompts.

The agent follows a strict prompt template to produce:

1. **Scene description** — what is happening in the illustration
2. **Character positioning** — where the character is in the frame
3. **Emotional tone** — facial expression and body language
4. **Environment details** — setting, lighting, time of day
5. **Style tokens** — consistent style tags for the image model

---

### 11.5 Character Consistency Agent

**Model:** Claude claude-sonnet-4-6
**Input:** All ImagePrompts[] + CharacterCard.visualAnchor
**Output:** Enriched ImagePrompts[] with character anchor injected

**The consistency problem:**
Text-to-image models generate a different "random" character each time unless anchored.
This agent solves it with a two-layer strategy:

**Layer 1 — Prompt injection:**
Prepends the canonical `visualAnchor` to every image prompt in exactly the same format.
The model learns to treat it as a fixed subject anchor.

**Layer 2 — Cross-prompt audit:**
Reads all N prompts simultaneously and flags any that might produce inconsistent
appearance (e.g., one prompt says "blonde hair" when the character has red hair).
Corrects these before sending to image generation.

**Future — Layer 3 — LoRA fine-tuning:**
For users who upload a real photo of their child, train a Flux LoRA on that photo.
The LoRA ID is stored in the CharacterCard and injected as a model weight.
This achieves near-perfect character consistency.

---

### 11.6 Image Generation Agent

**Model:** fal.ai → Flux 1.1 Pro
**Input:** EnrichedImagePrompt
**Output:** GeneratedImage (R2 key + URL)
**Parallelism:** Concurrent, rate-limited to 50 req/min

**Why Flux over DALL-E 3 as primary?**

- Flux 1.1 Pro: $0.04/image at 1024px, superior illustration quality
- DALL-E 3: $0.04/image (1024px), good quality but less controllable style
- Flux supports LoRA injection (critical for future character consistency)
- fal.ai provides 99.9% uptime SLA and faster inference

**Seed management:**
Every generation stores the `seed` value. This enables:

- Deterministic regeneration for debugging
- Subtle variation regeneration (same seed ± small delta)

---

### 11.7 Quality Review Agent

**Model:** GPT-4o Vision (multimodal)
**Input:** Page text + GeneratedImage (as base64)
**Output:** QualityReport

**Checks performed:**

1. **Content safety** — no age-inappropriate content (nudity, violence, scary imagery)
2. **Character consistency** — does the illustrated character match the CharacterCard?
3. **Text-image alignment** — does the illustration match what the text describes?
4. **Art quality** — blurriness, artifacts, deformed anatomy detection
5. **Reading level** — final Flesch-Kincaid validation

**Why GPT-4o Vision here instead of Claude?**
GPT-4o Vision has strong image understanding and is cheaper for rapid QA checks
($0.00085/1k tokens vs $0.003). Each QA call is ~500 tokens = $0.0004/page.

---

### 11.8 Layout Agent

**Model:** Deterministic (no LLM)
**Input:** QA-approved pages (text + image URLs)
**Output:** PageLayout[]

This is pure code, not AI. The layout engine:

- Selects a layout template based on page type (cover, chapter-start, body, ending)
- Applies typography rules (font size = 24pt for age 4–6, 18pt for age 7–9, 14pt for age 10–12)
- Places text blocks and image frames according to the template
- Handles text overflow by adjusting font size or splitting to next page
- Outputs a JSON spec consumed by the PDF renderer

---

### 11.9 PDF Generator Agent

**Technology:** Node.js + PDFKit (server-side) or @react-pdf/renderer
**Input:** PageLayout[] + all image R2 keys
**Output:** PDF file uploaded to R2

**Why PDFKit over React PDF for server-side?**
PDFKit gives lower-level control over image embedding, font subsetting, and bleed/crop marks
needed for print-ready PDF/X-1a standard. React PDF is better for the browser preview.

**PDF specifications:**

- Format: PDF 1.4 (broad compatibility)
- Color: sRGB for digital, CMYK conversion available for print
- Resolution: 300 DPI (print-ready)
- Bleed: 3mm (for professional printing)
- Fonts: embedded subset (no missing font issues)
- Images: lossless PNG preserved, JPEG compressed at 85% quality

---

## 12. Prompt Templates

### 12.1 System Prompt — Story Planner

```
You are a world-class children's book author and story architect.
You create age-appropriate stories where real children are the heroes.

CHILD PROFILE:
Name: {childName}
Age: {age} years old
Appearance: {visualAnchor}
Personality: {personality}
Loves: {favoriteAnimals}, {favoriteColors}, {favoriteToys}
Hobbies: {hobbies}

STORY REQUIREMENTS:
Genre: {genre}
Educational Goal: {educationalGoal}
Length: {bookLength} pages ({chapterCount} chapters)
Language: {language}
Reading Level: Grade {gradeLevel} ({age-4} — {age-2})

YOUR TASK:
Create a complete story plan. The child named {childName} MUST be the protagonist.
Weave their personal details organically into the world. Their favorite {favoriteAnimal}
should appear naturally, their love of {favoriteColor} reflected in their world.

The educational goal ({educationalGoal}) must emerge from the plot, not be stated directly.

Return ONLY valid JSON matching the StoryPlan interface. No markdown, no explanation.
```

### 12.2 System Prompt — Chapter Writer

```
You are writing chapter {chapterNumber} of a children's book for {childName}, age {age}.

CHARACTER CARD:
{characterCard}

STORY PLAN:
{storyPlan}

PREVIOUS CHAPTER SUMMARY:
{previousChapterSummary}

THIS CHAPTER OUTLINE:
{chapterOutline}

WRITING RULES:
- Target reading level: Grade {gradeLevel} (Flesch-Kincaid)
- Maximum {wordsPerPage} words per page
- Short sentences. Active voice. Vivid action words.
- {childName} must speak and act authentically for their personality
- Each page should end with a mild cliffhanger or transition
- Include 1 illustratable moment per page (described in the illustrationNote field)
- Language: {language}

Return ONLY valid JSON matching the Chapter interface.
```

### 12.3 System Prompt — Illustration Prompt Generator

```
You are an art director creating image generation prompts for a children's book.

PAGE TEXT:
{pageText}

CHARACTER (always include this exactly):
{visualAnchor}

ILLUSTRATION STYLE: {illustrationStyle}
- watercolor: soft edges, visible brush strokes, pastel palette
- cartoon: bold outlines, saturated colors, expressive faces
- realistic: painterly, detailed, storybook realism
- minimalist: clean shapes, flat colors, geometric

DOMINANT COLORS: {colorPalette}

TASK: Create a single illustration prompt for this page.
The character must be the visual focus.
Scene should directly reflect the page text.

Return valid JSON matching the ImagePrompt interface.
Positive prompt max 200 words. Negative prompt max 50 words.
```

---

## 13. Context Management Strategy

### Problem

A 32-page book with chapters = large accumulated context. Naive full-context passing
hits token limits and inflates cost.

### Strategy: Hierarchical Context Compression

```
Level 0: Full BookRequest (always available, ~500 tokens)
    │
    ▼
Level 1: CharacterCard (~200 tokens) — distilled from BookRequest
    │
    ▼
Level 2: StoryPlan (~800 tokens) — structural skeleton, always available
    │
    ▼
Level 3: ChapterSummary (~200 tokens/chapter) — distilled after writing
    │        NOT the full chapter text
    ▼
Level 4: Page text (~100 tokens/page) — only for adjacent pages

Rule: Each agent receives only the context level(s) it needs.
- ChapterWriter: Level 0 + 1 + 2 + previous Level 3 only
- IllustrationPromptGen: Level 1 + current page text only
- QualityReview: page text + image only (no story context needed)
```

### Token Budget per Book (32 pages, 4 chapters)

| Agent               | Input Tokens | Output Tokens | Total              |
| ------------------- | ------------ | ------------- | ------------------ |
| CharBuilder         | ~400         | ~200          | 600                |
| StoryPlanner        | ~800         | ~1000         | 1800               |
| ChapterWriter ×4    | ~1200 each   | ~800 each     | 8000               |
| IllustPromptGen ×32 | ~400 each    | ~200 each     | 19200              |
| CharConsistency     | ~6400        | ~6400         | 12800              |
| QAReview ×32        | ~1000 each   | ~200 each     | 38400              |
| **Total**           |              |               | **~80,800 tokens** |

**Estimated LLM cost per 32-page book: ~$0.25–0.40** (Claude Sonnet pricing)

---

## 14. Character Memory Strategy

### Per-Book Memory

The `CharacterCard` is the canonical character memory. It is:

1. Generated once by CharBuilder
2. Stored in `books.character_card` (JSONB)
3. Cached in Redis for the duration of the job
4. Injected into EVERY downstream agent as immutable context

### Cross-Book (Series) Memory

When a book is part of a series:

1. The CharacterCard is stored in `character_cards` table
2. New books in the same series load the card from DB
3. The story planner receives a "previous books summary" (~200 tokens) from series history
4. Character card is never modified — immutable per series

### Future: Photo-Based Character Memory

```
User uploads child photo
    │
    ▼
Face extraction + preprocessing
    │
    ▼
fal.ai LoRA training (~10 min, ~50 training steps)
    │
    ▼
LoRA weights stored in R2
    │
    ▼
character_cards.lora_weights = "r2://characters/{id}/lora/weights.safetensors"
    │
    ▼
Injected into every image prompt as: <lora:character_id:0.8>
```

---

## 15. Illustration Consistency Strategy

### Problem

Standard diffusion models have no memory — each image is statistically independent.
The character looks different on every page.

### Strategy: Multi-Layer Consistency System

**Layer 1 — Prompt anchoring (implemented Day 1)**
The `visualAnchor` string is prepended to every image prompt identically.
Forces the model to start from the same visual description.
Achieves ~70% consistency.

**Layer 2 — Style token normalization (implemented Day 1)**
Consistent style prefix: `"children's book illustration, {style}, {palette}, --ar 4:3"`
Applied uniformly. Prevents style drift across pages.

**Layer 3 — Seed correlation (implemented Day 1)**
The first successful page image stores its seed.
Subsequent pages use the same seed base + page offset.
Encourages the model toward similar "aesthetic neighborhood."

**Layer 4 — Cross-prompt audit (implemented Day 1)**
CharConsistencyAgent reads ALL prompts and flags contradictions.
Prevents scenarios where page 3 says "blue coat" but page 7 says "red coat."

**Layer 5 — LoRA fine-tuning (Phase 2)**
Train a character-specific LoRA. Inject for pixel-perfect consistency.

**Layer 6 — IP-Adapter / reference image (Phase 2)**
Use the first generated character image as a reference image for all subsequent pages
via fal.ai's IP-Adapter support.

---

## 16. PDF Rendering Strategy

### Architecture: Two-Phase Rendering

**Phase 1: Browser Preview (React PDF)**

- Runs in the client via `@react-pdf/renderer`
- Renders from PageLayout JSON (lightweight, no image re-fetch)
- Allows user to see live preview before final PDF is ready
- Lower resolution, no bleed marks

**Phase 2: Print-Ready PDF (Server PDFKit)**

- Runs in pdf:render worker
- Downloads full-resolution images from R2
- Embeds fonts (Google Fonts subset)
- Applies bleed marks, crop marks
- Exports PDF/X-1a for print-on-demand compatibility

### Page Layout Templates

```
Template A: TEXT LEFT, IMAGE RIGHT
┌──────────────────────────────────┐
│ Chapter 1                        │
│                                  │
│ Emma woke up one morning...      │  ┌──────────────┐
│ She looked out the window...     │  │              │
│ Something magical was            │  │   IMAGE      │
│ happening in the garden.         │  │              │
│                                  │  └──────────────┘
└──────────────────────────────────┘

Template B: FULL IMAGE, TEXT OVERLAY BOTTOM
┌──────────────────────────────────────┐
│                                      │
│                                      │
│            FULL IMAGE                │
│                                      │
│                                      │
│──────────────────────────────────────│
│  "Look!" said Emma. "A rainbow!"     │
└──────────────────────────────────────┘

Template C: DOUBLE-SPREAD (2 pages)
┌──────────────────┬───────────────────┐
│                  │                   │
│   LEFT PAGE      │   RIGHT PAGE      │
│   TEXT           │   IMAGE           │
│                  │                   │
└──────────────────┴───────────────────┘

Template D: COVER
┌──────────────────────────────────────┐
│                                      │
│            FULL BLEED IMAGE          │
│                                      │
│  ╔══════════════════════════════╗    │
│  ║   EMMA AND THE MAGIC FOREST  ║    │
│  ║   A story for Emma, age 6    ║    │
│  ╚══════════════════════════════╝    │
│                                      │
└──────────────────────────────────────┘
```

---

## 17. Folder Structure

```
ai-book-platform/
│
├── apps/
│   ├── web/                          # Next.js frontend
│   │   ├── app/
│   │   │   ├── (marketing)/          # Landing, pricing, examples (SSR)
│   │   │   ├── (app)/                # Authenticated app (dashboard, wizard)
│   │   │   │   ├── create/           # Book creation wizard
│   │   │   │   ├── books/            # Book list + reader
│   │   │   │   │   └── [id]/
│   │   │   │   │       ├── page.tsx  # Book detail / reader
│   │   │   │   │       └── edit/     # Page regeneration UI
│   │   │   │   └── series/
│   │   │   └── api/                  # Next.js API routes (BFF)
│   │   ├── components/
│   │   │   ├── book-wizard/          # Multi-step form
│   │   │   ├── book-reader/          # Page flip viewer
│   │   │   ├── book-preview/         # React PDF preview
│   │   │   └── ui/                   # Design system components
│   │   ├── hooks/
│   │   ├── stores/                   # Zustand stores
│   │   ├── lib/
│   │   │   ├── api.ts               # API client (generated from OpenAPI)
│   │   │   └── ws.ts                # WebSocket client
│   │   └── public/
│   │
│   └── api/                          # NestJS backend
│       ├── src/
│       │   ├── modules/
│       │   │   ├── auth/
│       │   │   ├── books/
│       │   │   │   ├── books.controller.ts
│       │   │   │   ├── books.service.ts
│       │   │   │   ├── books.repository.ts
│       │   │   │   └── books.module.ts
│       │   │   ├── characters/
│       │   │   ├── series/
│       │   │   ├── credits/
│       │   │   └── billing/
│       │   │
│       │   ├── orchestrator/         # Core orchestration engine
│       │   │   ├── orchestrator.service.ts
│       │   │   ├── state-machine.ts
│       │   │   └── orchestrator.module.ts
│       │   │
│       │   ├── agents/               # Agent definitions + queue processors
│       │   │   ├── base.agent.ts     # Abstract base class
│       │   │   ├── char-builder/
│       │   │   │   ├── char-builder.agent.ts
│       │   │   │   ├── char-builder.prompt.ts
│       │   │   │   └── char-builder.types.ts
│       │   │   ├── story-planner/
│       │   │   ├── chapter-writer/
│       │   │   ├── illust-prompt-gen/
│       │   │   ├── char-consistency/
│       │   │   ├── image-gen/
│       │   │   ├── qa-review/
│       │   │   ├── layout/
│       │   │   └── pdf-gen/
│       │   │
│       │   ├── queue/
│       │   │   ├── queue.module.ts
│       │   │   └── queues.config.ts
│       │   │
│       │   ├── storage/              # R2 / S3 abstraction
│       │   │   └── storage.service.ts
│       │   │
│       │   ├── ai-providers/         # LLM + image API wrappers
│       │   │   ├── anthropic.service.ts
│       │   │   ├── openai.service.ts
│       │   │   ├── fal.service.ts
│       │   │   └── ai-provider.module.ts
│       │   │
│       │   ├── ws/                   # WebSocket gateway
│       │   │   └── ws.gateway.ts
│       │   │
│       │   └── common/
│       │       ├── middleware/
│       │       ├── guards/
│       │       ├── filters/
│       │       └── interceptors/
│       │
│       ├── prisma/
│       │   ├── schema.prisma
│       │   └── migrations/
│       │
│       └── test/
│
├── packages/                         # Shared code (monorepo)
│   ├── types/                        # Shared TypeScript interfaces
│   │   └── src/
│   │       ├── book.types.ts
│   │       ├── agent.types.ts
│   │       └── api.types.ts
│   │
│   └── pdf-renderer/                 # Shared PDF rendering logic
│       └── src/
│           ├── templates/
│           └── renderer.ts
│
├── workers/
│   └── image-worker/                 # Python FastAPI (image generation)
│       ├── src/
│       │   ├── main.py
│       │   ├── fal_client.py
│       │   └── consistency.py
│       ├── requirements.txt
│       └── Dockerfile
│
├── infra/
│   ├── docker/
│   │   ├── docker-compose.yml        # Full stack local dev
│   │   ├── docker-compose.prod.yml
│   │   └── Dockerfiles per service
│   ├── k8s/
│   │   ├── base/
│   │   └── overlays/
│   │       ├── staging/
│   │       └── production/
│   └── terraform/                    # Cloud infra (GKE + R2 + CloudSQL)
│
├── .github/
│   └── workflows/
│       ├── ci.yml
│       ├── deploy-staging.yml
│       └── deploy-prod.yml
│
├── pnpm-workspace.yaml               # Monorepo workspace
├── turbo.json                        # Turborepo build config
└── docker-compose.yml                # Dev orchestration
```

---

## 18. Caching Strategy

### Cache Layers

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  LAYER 1: CDN (Cloudflare)                                                   │
│  - Completed PDF files: cache indefinitely (immutable, content-addressed)   │
│  - Page thumbnails: cache 30 days                                           │
│  - Cover images: cache 30 days                                              │
│  Hit rate target: 95%+ for completed books                                  │
└─────────────────────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────────────────────┐
│  LAYER 2: Redis (Application Cache)                                          │
│                                                                               │
│  Key patterns:                                                                │
│  book:{bookId}:character_card    TTL: job lifetime + 1h                     │
│  book:{bookId}:story_plan        TTL: job lifetime + 1h                     │
│  book:{bookId}:status            TTL: 1h (polling cache)                    │
│  user:{userId}:credits           TTL: 60s (balance cache)                   │
│  rate_limit:{userId}             TTL: rolling 60s window                    │
└─────────────────────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────────────────────┐
│  LAYER 3: LLM Prompt Caching (Anthropic API)                                │
│  - System prompts are large and stable → cache prefix                       │
│  - CharacterCard is prepended to all story calls → cache hit                │
│  - Estimated 40% token reduction via prompt caching                         │
│  - Cached at Anthropic side, transparent to our code                        │
└─────────────────────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────────────────────┐
│  LAYER 4: Result Deduplication (future)                                      │
│  - Hash {childName+age+genre+educationalGoal} for similar requests          │
│  - For demo/preview: return cached example book immediately                 │
│  - Only applies to exact duplicate requests (privacy-safe)                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 19. Retry Logic & Error Handling

### Retry Tiers

```typescript
// Tier 1: Transient errors (network, rate limits) — auto retry
const RETRY_TRANSIENT = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000, maxDelay: 30000 },
  retryableErrors: [429, 500, 502, 503, 504],
};

// Tier 2: Quality failures — regenerate with modified prompt
const RETRY_QUALITY = {
  attempts: 2,
  strategy: 'modify_prompt', // inject negative feedback into prompt
  maxRegenPerPage: 3,
};

// Tier 3: Model failure — fallback to alternate provider
const FALLBACK_CHAIN = {
  story: ['claude-sonnet-4-6', 'gpt-4o', 'gemini-2.5-pro'],
  image: ['fal-flux-1.1-pro', 'dall-e-3'],
  review: ['gpt-4o', 'claude-sonnet-4-6'],
};
```

### Error Taxonomy

| Error Type             | Recovery                                                    |
| ---------------------- | ----------------------------------------------------------- |
| API rate limit (429)   | BullMQ rate limiter, exponential backoff                    |
| API timeout            | Retry with same input, max 3×                               |
| API provider down      | Automatic failover to next provider in chain                |
| QA quality failure     | Regenerate page with feedback injected into prompt          |
| Content policy block   | Flag for human review, refund credits, notify user          |
| PDF render failure     | Retry with reduced image quality                            |
| Storage upload failure | Retry with exponential backoff                              |
| Partial book failure   | Save progress to DB, allow resume from last successful step |

### Dead Letter Queue

All jobs that exhaust retries → `dlq:failed-jobs` queue.

- Alert sent to on-call via PagerDuty
- Job state preserved in DB for manual replay
- User receives email notification with automatic credit refund

---

## 20. Monitoring & Logging

### Observability Stack

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  OpenTelemetry SDK (in every service)                                        │
│  - Automatic instrumentation: HTTP, DB queries, Redis, BullMQ               │
│  - Manual spans: per-agent timing, token counts, cost tracking              │
│  - TraceID propagated through BullMQ job data                               │
└─────────────────────────────────────────────────────────────────────────────┘
         │ OTLP export
         ▼
┌──────────────────────┐   ┌────────────────────┐   ┌────────────────────────┐
│  Grafana Tempo        │   │  Grafana Loki      │   │  Grafana               │
│  (distributed traces) │   │  (structured logs) │   │  (dashboards)          │
└──────────────────────┘   └────────────────────┘   └────────────────────────┘
```

### Key Metrics to Track

**Business metrics:**

- Books generated per hour / day
- Success rate (% of books that complete without error)
- Average generation time per book
- Revenue per book (credits charged)

**AI pipeline metrics:**

- Token usage per agent per book
- Cost per book (breakdown by agent + provider)
- QA failure rate per page type
- Regeneration rate (% pages regenerated)
- Character consistency score distribution

**Infrastructure metrics:**

- Queue depth per agent queue
- Worker CPU / memory / GPU utilization
- API provider latency (p50, p95, p99)
- Rate limit hit frequency

### Alerting Rules

| Condition               | Severity | Action                              |
| ----------------------- | -------- | ----------------------------------- |
| Book success rate < 90% | P1       | PagerDuty                           |
| Queue depth > 1000 jobs | P2       | Slack                               |
| fal.ai error rate > 5%  | P2       | Slack + auto-enable DALL-E fallback |
| Cost per book > $2.00   | P2       | Slack                               |
| DLQ depth > 0           | P3       | Slack                               |

### Structured Log Format

```json
{
  "timestamp": "2025-01-15T10:30:00Z",
  "level": "info",
  "service": "chapter-writer-agent",
  "traceId": "abc123",
  "bookId": "book-uuid",
  "userId": "user-uuid",
  "agentStep": "chapter_write",
  "chapterNumber": 2,
  "tokensUsed": 1247,
  "costUsd": 0.0019,
  "durationMs": 3421,
  "model": "claude-sonnet-4-6",
  "status": "success"
}
```

---

## 21. Security & Authentication

### Authentication Flow

```
User                  Next.js BFF              NestJS API         Database
  │                       │                        │                  │
  │ POST /auth/login       │                        │                  │
  ├──────────────────────►│                        │                  │
  │                       │ POST /api/auth/login   │                  │
  │                       ├───────────────────────►│                  │
  │                       │                        │ verify hash      │
  │                       │                        ├─────────────────►│
  │                       │                        │ user             │
  │                       │                        │◄─────────────────┤
  │                       │                        │ issue tokens     │
  │                       │  {accessToken (15m),   │                  │
  │                       │◄──refreshToken (7d)}───┤                  │
  │  Set-Cookie: refresh  │                        │                  │
  │◄──────────────────────┤                        │                  │
  │  { accessToken }      │                        │                  │
```

**Token strategy:**

- Access token: JWT, 15-minute expiry, stored in memory (not localStorage)
- Refresh token: opaque token, 7-day expiry, stored in HttpOnly Secure cookie
- Refresh token stored hashed in DB (bcrypt), invalidated on logout

### Security Controls

| Control            | Implementation                                                        |
| ------------------ | --------------------------------------------------------------------- |
| Input sanitization | Zod schemas at every API boundary                                     |
| Prompt injection   | Sanitize user inputs before LLM injection; wrap in XML tags           |
| Content safety     | Pre-generation: Claude's built-in refusals. Post-generation: QA agent |
| Rate limiting      | Per-user: 3 books/hour. Global: nginx rate limiting                   |
| CORS               | Whitelist production domains only                                     |
| Secrets            | Doppler / AWS Secrets Manager (never in code or .env committed)       |
| API keys           | Rotated quarterly, per-environment                                    |
| PII in logs        | User email/name stripped from all log lines                           |
| R2 access          | All assets private; served via signed URLs (24h expiry)               |
| SQL injection      | Prisma ORM (parameterized queries, no raw SQL in hot paths)           |
| OWASP Top 10       | Quarterly security review + automated scanning                        |
| CSP headers        | Strict-Transport-Security, Content-Security-Policy, X-Frame-Options   |

---

## 22. Cost Optimization

### Cost per 32-page book (target: < $0.80)

| Component                        | Unit Cost        | Count       | Total       |
| -------------------------------- | ---------------- | ----------- | ----------- |
| Claude Sonnet (story + chapters) | $0.003/1k tokens | ~15k tokens | $0.045      |
| Claude Opus (story planning)     | $0.015/1k tokens | ~2k tokens  | $0.030      |
| GPT-4o Vision (QA)               | $0.005/1k tokens | ~16k tokens | $0.080      |
| fal.ai Flux images               | $0.04/image      | 33 images   | $1.320      |
| **Total AI cost**                |                  |             | **~$1.475** |
| Infrastructure per book          |                  |             | ~$0.05      |
| **Total cost per book**          |                  |             | **~$1.525** |

**Sell at $6.99/book → ~78% margin**

### Optimization Levers

1. **Prompt caching** — Anthropic prefix caching for system prompts: ~40% LLM token savings
2. **Image dimensions** — Use 768px for preview, only 1024px for final PDF. Saves ~30% image cost
3. **Model routing** — Route simple chapters (early pages) to Haiku, complex climax chapters to Sonnet
4. **QA batching** — Batch 4 pages per QA call instead of 1-per-page. 75% QA token reduction
5. **Volume discounts** — Negotiate with fal.ai at 100k+ images/month (est. 25% discount)
6. **LoRA sharing** — Users who reuse the same character card don't re-run CharBuilder

### Credit Pricing Model

| Plan         | Price      | Credits    | Books       | Cost/book to us | Margin      |
| ------------ | ---------- | ---------- | ----------- | --------------- | ----------- |
| Free         | $0         | 3 credits  | 1 (8-page)  | $0.50           | Loss leader |
| Starter      | $9.99/mo   | 10 credits | 2 (16-page) | $0.90 each      | 81%         |
| Pro          | $24.99/mo  | 30 credits | 4 (32-page) | $1.52 each      | 78%         |
| Pay per book | $6.99/book | 1 credit   | 1 (32-page) | $1.52           | 78%         |

---

## 23. Scalability

### Phase 1: 0–10k books/month (Vertical)

```
Single server deployment:
- 1× API server (4 CPU, 8GB RAM)
- 1× worker server (8 CPU, 16GB RAM, all agent workers)
- 1× PostgreSQL (managed, db.t3.medium)
- 1× Redis (managed, cache.t3.medium)
- Cloudflare R2 (serverless)
```

### Phase 2: 10k–100k books/month (Horizontal)

```
Kubernetes deployment:
- API: 3 pods, HPA (CPU > 70%)
- Orchestrator: 2 pods
- Agent workers: separate Deployment per queue
  - image-gen: 5–20 pods (autoscale on queue depth)
  - chapter-writer: 5–15 pods
  - others: 2–5 pods
- PostgreSQL: read replicas for reporting queries
- Redis: Redis Cluster (3 shards)
```

### Phase 3: 100k–1M books/month (Multi-region)

```
Multi-region active-active:
- US, EU, APAC regions
- CDN serves books from nearest region
- Global PostgreSQL (PlanetScale or Neon with multi-region)
- Regional Redis clusters
- Book jobs routed to user's region
- Cross-region replication for completed books only
```

### Bottleneck Analysis

| Bottleneck             | Limit                 | Mitigation                                     |
| ---------------------- | --------------------- | ---------------------------------------------- |
| fal.ai rate limit      | 50 req/min            | BullMQ rate limiter + multiple API accounts    |
| Claude API rate limit  | 1M tokens/min         | Multiple API keys + request batching           |
| PostgreSQL writes      | ~10k writes/sec       | Connection pooling (PgBouncer) + read replicas |
| PDF rendering (memory) | ~2GB per job          | Dedicated PDF worker nodes; streaming render   |
| R2 upload bandwidth    | Effectively unlimited | No concern                                     |

---

## 24. Deployment — Docker & Kubernetes

### docker-compose.yml (development)

```yaml
version: '3.9'

services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: bookplatform
      POSTGRES_USER: dev
      POSTGRES_PASSWORD: devpassword
    ports: ['5432:5432']
    volumes: [postgres_data:/var/lib/postgresql/data]

  redis:
    image: redis:7-alpine
    ports: ['6379:6379']
    command: redis-server --maxmemory 512mb --maxmemory-policy allkeys-lru

  api:
    build: ./apps/api
    environment:
      DATABASE_URL: postgresql://dev:devpassword@postgres:5432/bookplatform
      REDIS_URL: redis://redis:6379
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
      OPENAI_API_KEY: ${OPENAI_API_KEY}
      FAL_API_KEY: ${FAL_API_KEY}
      R2_ACCOUNT_ID: ${R2_ACCOUNT_ID}
      R2_ACCESS_KEY: ${R2_ACCESS_KEY}
      R2_SECRET_KEY: ${R2_SECRET_KEY}
    ports: ['4000:4000']
    depends_on: [postgres, redis]
    volumes: ['./apps/api/src:/app/src'] # hot reload

  worker:
    build: ./apps/api
    command: npm run start:worker
    environment:
      <<: *api-env
    depends_on: [postgres, redis, api]
    deploy:
      replicas: 2

  web:
    build: ./apps/web
    ports: ['3000:3000']
    environment:
      NEXT_PUBLIC_API_URL: http://localhost:4000
      NEXT_PUBLIC_WS_URL: ws://localhost:4000
    volumes: ['./apps/web/src:/app/src']

  image-worker:
    build: ./workers/image-worker
    environment:
      FAL_API_KEY: ${FAL_API_KEY}
    ports: ['8000:8000']

volumes:
  postgres_data:
```

### Kubernetes Manifests Structure

```yaml
# k8s/base/api-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  replicas: 3
  selector:
    matchLabels: { app: api }
  template:
    spec:
      containers:
        - name: api
          image: gcr.io/bookplatform/api:${VERSION}
          resources:
            requests: { cpu: '500m', memory: '512Mi' }
            limits: { cpu: '2000m', memory: '2Gi' }
          env:
            - name: ANTHROPIC_API_KEY
              valueFrom:
                secretKeyRef:
                  name: ai-secrets
                  key: anthropic-api-key
---
# k8s/base/worker-hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: image-gen-worker
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: image-gen-worker
  minReplicas: 2
  maxReplicas: 20
  metrics:
    - type: External
      external:
        metric:
          name: bullmq_queue_depth
          selector:
            matchLabels:
              queue: agent:image-gen
        target:
          type: AverageValue
          averageValue: '10' # scale up when >10 jobs per pod
```

---

## 25. CI/CD Pipeline

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main, develop]
  pull_request:

jobs:
  lint-typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v3
      - run: pnpm install --frozen-lockfile
      - run: pnpm turbo lint typecheck

  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env: { POSTGRES_PASSWORD: test }
      redis:
        image: redis:7-alpine
    steps:
      - run: pnpm turbo test
      - run: pnpm turbo test:integration

  build-images:
    needs: [lint-typecheck, test]
    runs-on: ubuntu-latest
    steps:
      - uses: docker/build-push-action@v5
        with:
          context: ./apps/api
          push: true
          tags: gcr.io/bookplatform/api:${{ github.sha }}

  deploy-staging:
    needs: build-images
    if: github.ref == 'refs/heads/develop'
    runs-on: ubuntu-latest
    steps:
      - run: kubectl set image deployment/api api=gcr.io/bookplatform/api:${{ github.sha }}
      - run: kubectl rollout status deployment/api

  deploy-prod:
    needs: build-images
    if: github.ref == 'refs/heads/main'
    environment: production # requires manual approval
    runs-on: ubuntu-latest
    steps:
      - run: kubectl set image deployment/api api=gcr.io/bookplatform/api:${{ github.sha }}
      - run: kubectl rollout status deployment/api --timeout=5m
```

**Deploy strategy:** Blue/green deployment for zero-downtime.
New version deployed to green cluster, traffic switched after health checks pass.

---

## 26. Testing Strategy

### Test Pyramid

```
                    ┌─────────────────┐
                    │   E2E Tests     │  5%
                    │  (Playwright)   │
                    └────────┬────────┘
               ┌─────────────┴─────────────┐
               │    Integration Tests       │  25%
               │ (real DB, mock AI APIs)    │
               └────────────┬──────────────┘
        ┌────────────────────┴────────────────────┐
        │             Unit Tests                   │  70%
        │  (agents, validators, layout engine)     │
        └─────────────────────────────────────────┘
```

### Unit Tests

```typescript
// Each agent has full unit test coverage
describe('CharacterBuilderAgent', () => {
  it('generates valid CharacterCard from BookRequest', async () => {
    const mockLLM = createMockLLM({ response: validCharacterCardJson });
    const agent = new CharBuilderAgent(mockLLM);
    const card = await agent.run(sampleBookRequest);
    expect(CharacterCardSchema.safeParse(card).success).toBe(true);
  });

  it('handles LLM JSON parse errors gracefully', async () => {
    const mockLLM = createMockLLM({ response: 'invalid json' });
    const agent = new CharBuilderAgent(mockLLM);
    await expect(agent.run(sampleBookRequest)).rejects.toThrow(AgentParseError);
  });
});
```

### Integration Tests

- Full pipeline smoke test with mock AI providers (deterministic fixtures)
- DB transaction tests (book creation + page creation atomicity)
- Queue worker tests (job enqueue → process → DB state)
- R2 upload/download tests against MinIO (local S3 emulator)

### E2E Tests

```
Playwright tests covering:
1. Book creation wizard → submission → polling → PDF download
2. Page regeneration flow
3. Authentication flow (register → login → logout)
4. Credit deduction on book creation
5. Series creation and book inheritance
```

### AI-Specific Testing

```typescript
// Snapshot testing for prompt templates
describe('StoryPlannerPrompt', () => {
  it('matches expected prompt structure', () => {
    const prompt = buildStoryPlannerPrompt(sampleRequest, sampleCharCard);
    expect(prompt).toMatchSnapshot(); // prevents accidental prompt regression
  });
});

// Output schema validation (contract tests against real APIs in CI with small budget)
describe('StoryPlannerAgent — contract test', () => {
  it(
    'real Claude output validates against StoryPlan schema',
    async () => {
      const plan = await realAgent.run(sampleRequest);
      expect(StoryPlanSchema.safeParse(plan).success).toBe(true);
    },
    { timeout: 30000 },
  );
});
```

---

## 27. Design Decisions & Trade-offs

### Decision 1: NestJS vs FastAPI for main backend

**Chose NestJS.** Reasoning: Full TypeScript stack means shared types across BE and FE via monorepo.
NestJS's module system maps directly to our agent modules. FastAPI is used only for the
image worker where Python ML libraries are needed.

**Trade-off:** NestJS is heavier than FastAPI for pure API throughput, but at our scale
(book generation is I/O bound, not CPU bound) this is irrelevant.

---

### Decision 2: Multi-agent pipeline vs single mega-prompt

**Chose multi-agent.** A single prompt for a 32-page book would be:

- Unreliable (one failure = full regeneration)
- Expensive (can't cache intermediate results)
- Unscalable (can't parallelize chapter writing)
- Inflexible (can't offer "regenerate page 5 illustration only")

**Trade-off:** Higher orchestration complexity. Mitigated by the state machine + BullMQ.

---

### Decision 3: Flux (fal.ai) vs DALL-E 3 as primary image model

**Chose Flux 1.1 Pro via fal.ai.** Reasons:

1. Better stylistic control for illustration styles
2. LoRA support (critical for Phase 2 character consistency)
3. Same cost, higher quality
4. fal.ai SLA is production-grade

**Trade-off:** Less platform lock-in safety vs OpenAI (which has broader enterprise support).
Mitigated by keeping DALL-E 3 as automatic fallback.

---

### Decision 4: Store agent outputs as JSONB in PostgreSQL

**Chose JSONB in Postgres.** Reasons:

- Agent output schemas evolve frequently during development
- Avoids premature normalization of deeply nested structures
- pgvector can be added for future semantic search over generated stories
- Single DB to manage in production

**Trade-off:** No column-level indexing on agent output fields (except via JSONB operators).
Acceptable because agent outputs are rarely queried — they're retrieved by bookId.

---

### Decision 5: PDF rendering on server (PDFKit) vs client (React PDF)

**Chose both, for different purposes.**

- Client-side React PDF: instant preview, zero server load
- Server PDFKit: print-quality output, proper CMYK/bleed for print-on-demand

**Trade-off:** Dual PDF implementations to maintain. Mitigated by sharing the PageLayout
JSON spec — both renderers consume the same layout data.

---

### Decision 6: Cloudflare R2 vs AWS S3

**Chose Cloudflare R2.** Critical reason: **zero egress fees**.
At 1M books/month, each PDF ~8MB → 8TB/month egress.
AWS S3 egress: $0.09/GB × 8000 GB = **$720/month** just for downloads.
R2 egress: **$0** (included in CDN).

**Trade-off:** Less mature ecosystem, fewer integrations. Acceptable given the massive cost difference.

---

_This architecture document was designed to serve millions of users at production scale._
_Version 1.0 — Ready for implementation by an engineering team of 3–5 engineers._
