import type {
  AgentLogSummary,
  AgentStep,
  BookGenre,
  BookLength,
  GenerationJobSummary,
  GenerationMetadata,
  IllustrationStyle,
  Pronouns,
  BookStatus,
} from './agent.types';

// ─── Character ───────────────────────────────────────────────────────────────

export interface CharacterAppearance {
  hairColor: string;
  hairStyle: string;
  eyeColor: string;
  skinTone: string;
  distinctiveFeatures: string[];
}

export interface CharacterPersonality {
  traits: string[];
  favoriteAnimals: string[];
  favoriteColors: string[];
  favoriteToys: string[];
  hobbies: string[];
}

/**
 * The primary output of the CharacterBuilderAgent.
 * `visualAnchor` is the canonical single-sentence description prepended to every image prompt.
 */
export interface CharacterCard {
  name: string;
  nickname?: string;
  age: number;
  pronouns: Pronouns;
  appearance: CharacterAppearance;
  personality: CharacterPersonality;
  /** Canonical image-prompt fragment; prepended to every illustration prompt. */
  visualAnchor: string;
  /** Full prose description for LLM story context. */
  narrativeDescription: string;
}

// ─── Story ───────────────────────────────────────────────────────────────────

export interface ChapterOutline {
  chapterNumber: number;
  title: string;
  summary: string;
  setting: string;
  emotionalArc: string;
  keyEvents: string[];
  /** One illustrable scene per page in this chapter. */
  illustrableScenes: string[];
}

export interface IllustrationPlan {
  prompt: string;
  negativePrompt: string;
  style: string;
  aspectRatio: string;
  characters: string[];
  setting: string;
  mood: string;
  consistencyNotes: string;
}

export interface PagePlan {
  pageNumber: number;
  chapterIndex: number;
  title: string;
  sceneDescription: string;
  narration: string;
  illustrationPrompt: string;
  learningGoal: string;
  storyText?: string;
  illustration?: IllustrationPlan | null;
}

export interface StoryPlan {
  title: string;
  subtitle?: string;
  theme: string;
  educationalMessage: string;
  chapters: ChapterOutline[];
  openingHook: string;
  resolution: string;
  dedicationSuggestion?: string;
  pages?: PagePlan[];
}

// ─── Book preview (render-ready PDF data contract) ───────────────────────────

export interface BookPreviewCover {
  title: string;
  subtitle: string;
  childName: string;
  illustrationPrompt: string;
}

export interface BookPreviewPage {
  pageNumber: number;
  title: string;
  text: string;
  illustrationPrompt: string;
  layout: string;
  learningGoal: string;
}

export interface BookPreviewBackCover {
  message: string;
  educationalSummary: string;
}

export interface BookPreviewMetadata {
  language: string;
  theme: string;
  childAge: number;
  totalPages: number;
  generatedBy: string;
}

export interface BookPreview {
  title: string;
  subtitle: string;
  cover: BookPreviewCover;
  pages: BookPreviewPage[];
  backCover: BookPreviewBackCover;
  metadata: BookPreviewMetadata;
}

// ─── Book content (per page) ─────────────────────────────────────────────────

export interface ImagePrompt {
  positivePrompt: string;
  negativePrompt: string;
  style: IllustrationStyle;
  aspectRatio: '4:3' | '3:4' | '1:1' | '16:9';
  mood: string;
  colorPalette: string[];
  pageNumber: number;
}

export interface Page {
  pageNumber: number;
  textContent: string;
  readingLevel: number;
  wordCount: number;
  illustrationNote: string;
  imagePrompt?: ImagePrompt;
}

export interface Chapter {
  chapterNumber: number;
  title: string;
  pages: Page[];
  /** Brief summary used as context for the next chapter. */
  summary: string;
}

// ─── QA / Layout ─────────────────────────────────────────────────────────────

export interface QualityScore {
  pageNumber: number;
  consistency: number;
  alignment: number;
  safety: number;
  ageAppropriateness: number;
  action: 'pass' | 'regen_image' | 'regen_text' | 'flag';
  notes?: string;
}

export interface QualityReport {
  scores: QualityScore[];
  overallPassed: boolean;
  flaggedPages: number[];
}

export interface PageRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FontSpec {
  family: string;
  size: number;
  weight: 400 | 500 | 600 | 700 | 800;
  lineHeight: number;
  letterSpacing: number;
  direction?: 'ltr' | 'rtl';
}

export interface PageLayout {
  pageNumber: number;
  template: 'COVER' | 'CHAPTER_START' | 'BODY_TEXT_LEFT' | 'BODY_FULL_IMAGE' | 'ENDING';
  imageRegion: PageRegion;
  textBlocks: Array<{
    content: string;
    region: PageRegion;
    font: FontSpec;
    alignment: 'left' | 'center' | 'right';
  }>;
  backgroundColor: string;
  backgroundGradient?: string;
}

// ─── Phase 2H: Layout engine data contract ────────────────────────────────────

export type BookTrimSize = 'square_8x8';

export type BookLayoutStatus = 'complete';

export type BookLayoutKind = 'cover' | 'page' | 'back_cover';

export type BookPageLayoutTemplate =
  | 'cover_full_bleed'
  | 'image_top_text_bottom'
  | 'text_left_image_right'
  | 'image_left_text_right'
  | 'back_cover_summary';

export interface LayoutBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutTextBlock {
  box: LayoutBox;
  text: string;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  align: 'left' | 'center' | 'right';
  verticalAlign: 'top' | 'middle' | 'bottom';
  color: string;
}

export interface LayoutImageBlock {
  box: LayoutBox;
  imageUrl: string;
  altText: string;
  objectFit: 'cover' | 'contain';
}

export interface BookLayoutEntry {
  id: string;
  kind: BookLayoutKind;
  pageNumber?: number;
  template: BookPageLayoutTemplate;
  trimSize: BookTrimSize;
  canvas: {
    width: number;
    height: number;
    unit: 'px';
  };
  safeArea: LayoutBox;
  bleed: number;
  textBlock?: LayoutTextBlock;
  imageBlock?: LayoutImageBlock;
  notes: string[];
}

export interface BookLayout {
  status: BookLayoutStatus;
  trimSize: BookTrimSize;
  entries: BookLayoutEntry[];
  metadata: {
    title: string;
    childName: string;
    totalPages: number;
    generatedAt: string;
  };
}

// ─── Generated image result (future real pipeline) ────────────────────────────

export interface GeneratedImage {
  r2Key: string;
  url: string;
  seed: number;
  model: string;
  timingMs: number;
  pageNumber: number;
}

// ─── Phase 2G: Mock/local image generation ────────────────────────────────────

export interface GeneratedImageEntry {
  id: string;
  kind: 'cover' | 'page' | 'back_cover';
  pageNumber?: number;
  prompt: string;
  negativePrompt?: string;
  provider: 'local_mock';
  status: 'complete';
  imageUrl: string;
  altText: string;
  width: number;
  height: number;
  seed: string;
}

export interface ImageGenerationResult {
  provider: 'local_mock';
  status: 'complete';
  images: GeneratedImageEntry[];
  createdAt: string;
}

// ─── Book request (wizard output / API input) ─────────────────────────────────

export interface ChildProfile {
  name: string;
  nickname?: string;
  age: number;
  pronouns: Pronouns;
  appearance: CharacterAppearance;
  personality: CharacterPersonality;
  birthday?: string;
  photoAssetId?: string;
}

export interface BookRequest {
  childProfile: ChildProfile;
  genre: BookGenre;
  illustrationStyle: IllustrationStyle;
  colorPalette: string[];
  educationalGoal: string;
  bookLength: BookLength;
  language: string;
  dedicationText?: string;
  childProfileId?: string;
  characterCardId?: string;
  seriesId?: string;
}

// ─── AI model version tracking ────────────────────────────────────────────────

export interface AiModelVersions {
  story: string;
  image: string;
  qa?: string;
}

// ─── Phase 1A: simple book-draft creation flow ────────────────────────────────

/** Languages supported by the Phase 1A draft-creation form. Mirrors BookLanguage in schema.prisma. */
export enum SupportedLanguage {
  English = 'en',
  Russian = 'ru',
  Polish = 'pl',
}

/**
 * Phase 4A: shared page-count bounds for the book creation input contract.
 * Applied by CreateBookDto validation, BooksService normalization, and both
 * StoryGenerationProviders (mock and OpenAI) — a single source of truth so
 * the API-accepted range and the generation pipeline's target never drift.
 * Coincidentally matches the default REAL_GENERATION_MAX_PAGES cost
 * guardrail (apps/api/src/images/image-generation-provider.factory.ts), but
 * that guardrail is independently configurable via env and caps real image
 * generation cost, not the book creation input contract.
 */
export const MIN_BOOK_PAGE_COUNT = 4;
export const MAX_BOOK_PAGE_COUNT = 12;
export const DEFAULT_BOOK_PAGE_COUNT = 6;

/** API-facing shape of a Book in the Phase 1A simple draft flow. */
export interface BookDto {
  id: string;
  userId: string;
  title: string | null;
  childName: string | null;
  childAge: number | null;
  language: SupportedLanguage | null;
  theme: string | null;
  /** User-supplied desired educational message/lesson (Phase 4A). Distinct from the generated storyPlan.educationalMessage. */
  educationalMessage: string | null;
  /** Target story page count (Phase 4A), bounded by MIN_BOOK_PAGE_COUNT/MAX_BOOK_PAGE_COUNT. Null until a book is created under the Phase 4A contract. */
  pageCount: number | null;
  status: BookStatus;
  characterCard?: CharacterCard | null;
  storyPlan?: StoryPlan | null;
  bookPreview?: BookPreview | null;
  imageGenerationResult?: ImageGenerationResult | null;
  bookLayout?: BookLayout | null;
  /** Local URL served at /files/books/<bookId>/storybook.pdf (Phase 2J+). null until pdf_render completes. */
  previewPdfUrl?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateBookInput {
  title: string;
  childName: string;
  childAge: number;
  /** Optional — BooksService defaults to SupportedLanguage.English when omitted. */
  language?: SupportedLanguage;
  theme: string;
  /** Optional — bounded free text guiding the story's lesson/takeaway. */
  educationalMessage?: string;
  /** Optional — bounded by MIN_BOOK_PAGE_COUNT/MAX_BOOK_PAGE_COUNT; defaults to DEFAULT_BOOK_PAGE_COUNT when omitted. */
  pageCount?: number;
}

export type UpdateBookInput = Partial<CreateBookInput>;

/** Paginated response for GET /books */
export interface BooksPageDto {
  items: BookDto[];
  page: number;
  limit: number;
  total: number;
}

/** Response from POST /books/:id/generate */
export interface GenerateBookResponse {
  book: BookDto;
}

/**
 * Response from GET /books/:id/generation-diagnostics — safe, non-secret
 * inspection data for debugging a book's generation run. Never includes
 * OPENAI_API_KEY, prompts, generated image bytes/base64, or raw provider
 * responses.
 */
export interface GenerationDiagnosticsDto {
  bookId: string;
  status: BookStatus;
  failedStep?: AgentStep | null;
  errorMessage?: string | null;
  generationMetadata: GenerationMetadata;
  recentLogs: AgentLogSummary[];
  previewPdfUrl?: string | null;
  /** Latest GenerationJob for this book (Phase 3I), or null if none exists yet. */
  latestJob?: GenerationJobSummary | null;
}
