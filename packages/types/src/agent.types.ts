/**
 * Agent step identifiers — mirror the AgentStep enum in schema.prisma.
 * Values must stay in sync with the pipeline state machine.
 */
export enum AgentStep {
  CharBuild = 'char_build',
  StoryPlan = 'story_plan',
  PagePlan = 'page_plan',
  ChapterGen = 'chapter_gen',
  IllustPlan = 'illust_plan',
  CharConsistency = 'char_consistency',
  ImageGen = 'image_gen',
  QaReview = 'qa_review',
  Layout = 'layout',
  PdfRender = 'pdf_render',
}

/**
 * Book lifecycle statuses — mirror the BookStatus enum in schema.prisma.
 */
export enum BookStatus {
  Created = 'created',
  CharBuild = 'char_build',
  StoryPlan = 'story_plan',
  PagePlan = 'page_plan',
  ChapterGen = 'chapter_gen',
  IllustPlan = 'illust_plan',
  ImageGen = 'image_gen',
  QaReview = 'qa_review',
  Layout = 'layout',
  PdfRender = 'pdf_render',
  Complete = 'complete',
  Failed = 'failed',
  Partial = 'partial',
  Cancelled = 'cancelled',
}

/** Visual illustration style choices presented in the wizard. */
export enum IllustrationStyle {
  Watercolor = 'watercolor',
  Comic = 'comic',
  Cartoon3d = 'cartoon_3d',
  PencilSketch = 'pencil_sketch',
}

/** Story genre choices presented in the wizard. */
export enum BookGenre {
  Adventure = 'adventure',
  Fantasy = 'fantasy',
  Friendship = 'friendship',
  Mystery = 'mystery',
  Nature = 'nature',
  Space = 'space',
  Ocean = 'ocean',
}

/** Pronouns for the child protagonist. */
export enum Pronouns {
  HeHim = 'he/him',
  SheHer = 'she/her',
  TheyThem = 'they/them',
}

/** Allowed book page lengths. */
export type BookLength = 8 | 16 | 24 | 32;

/** BullMQ job payload shared by all agent processors. */
export interface AgentJob {
  bookId: string;
  userId: string;
  traceId: string;
  /** Step-specific input data. */
  payload?: Record<string, unknown>;
}

/** Context object injected into every agent's run() call. */
export interface AgentContext {
  bookId: string;
  userId: string;
  traceId: string;
}

/** Agent log entry written to the agent_logs table. */
export interface AgentLogEntry {
  bookId: string;
  agent: string;
  step: AgentStep;
  provider?: string;
  model?: string;
  durationMs?: number;
  tokensInput?: number;
  tokensOutput?: number;
  costUsd?: number;
  attempt: number;
  status: 'success' | 'error' | 'retry';
  error?: string;
  traceId?: string;
}

/** WebSocket progress event shapes emitted during generation. */
export type WsProgressEvent =
  | { type: 'book:progress'; step: AgentStep; percentComplete: number }
  | { type: 'book:page_ready'; pageNumber: number; imageUrl: string }
  | { type: 'book:complete'; bookId: string; pdfUrl: string }
  | { type: 'book:error'; step: AgentStep; message: string };
