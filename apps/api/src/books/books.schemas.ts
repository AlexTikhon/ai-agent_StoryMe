import { z } from 'zod';
import {
  BookStatus,
  Pronouns,
  type CharacterProfile,
  type GenerationProviderOperation,
  type ImageGenerationResult,
} from '@book/types';

/**
 * Runtime shape validation for the Prisma `Json` columns on `Book`
 * (characterCard, storyPlan, bookPreview, imageGenerationResult,
 * bookLayout). These columns have no DB-level schema, so a bug in an older
 * pipeline version or a manual DB edit can leave a shape that no longer
 * matches the current `@book/types` interfaces. `books.mapper.ts` safe-parses
 * against these schemas instead of blindly casting, so a mismatch degrades
 * to `null` for that field rather than shipping a malformed object to
 * clients that trust `BookDto`'s types.
 */

const characterAppearanceSchema = z.object({
  hairColor: z.string(),
  hairStyle: z.string(),
  eyeColor: z.string(),
  skinTone: z.string(),
  distinctiveFeatures: z.array(z.string()),
});

const characterPersonalitySchema = z.object({
  traits: z.array(z.string()),
  favoriteAnimals: z.array(z.string()),
  favoriteColors: z.array(z.string()),
  favoriteToys: z.array(z.string()),
  hobbies: z.array(z.string()),
});

export const characterCardSchema = z.object({
  name: z.string(),
  nickname: z.string().optional(),
  age: z.number(),
  pronouns: z.nativeEnum(Pronouns),
  appearance: characterAppearanceSchema.optional(),
  personality: characterPersonalitySchema,
  visualAnchor: z.string(),
  narrativeDescription: z.string(),
});

const canonicalCharacterAppearanceSchema = z.object({
  age: z.number(),
  hair: z.string(),
  eyes: z.string(),
  face: z.string(),
  clothing: z.string(),
  artStyle: z.string(),
});

const characterVisualBibleSchema = z.object({
  schemaVersion: z.literal(1),
  protagonistName: z.string(),
  approximateAge: z.number(),
  appearance: z.object({ hair: z.string(), eyes: z.string(), face: z.string() }),
  defaultWardrobe: z.string(),
  visualStyle: z.string(),
  identityRules: z.array(z.string()),
  sceneFlexibilityRules: z.array(z.string()),
  fingerprint: z.string(),
});

export const characterProfileSchema = z.object({
  childName: z.string(),
  age: z.number(),
  visualDescription: z.string(),
  faceDescription: z.string(),
  hairDescription: z.string(),
  outfitDescription: z.string(),
  personalitySummary: z.string(),
  illustrationStyle: z.string(),
  consistencyPrompt: z.string(),
  hasReferencePhoto: z.boolean(),
  hasCharacterSheet: z.boolean(),
  schemaVersion: z.literal(1).optional(),
  canonicalAppearance: canonicalCharacterAppearanceSchema.optional(),
  characterFingerprint: z.string().optional(),
  lockedVisualDescription: z.string().optional(),
  negativeConstraints: z.array(z.string()).optional(),
  visualBible: characterVisualBibleSchema.optional(),
});

const chapterOutlineSchema = z.object({
  chapterNumber: z.number(),
  title: z.string(),
  summary: z.string(),
  setting: z.string(),
  emotionalArc: z.string(),
  keyEvents: z.array(z.string()),
  illustrableScenes: z.array(z.string()),
});

const illustrationPlanSchema = z.object({
  prompt: z.string(),
  negativePrompt: z.string(),
  style: z.string(),
  aspectRatio: z.string(),
  characters: z.array(z.string()),
  setting: z.string(),
  mood: z.string(),
  consistencyNotes: z.string(),
});

const pagePlanSchema = z.object({
  pageNumber: z.number(),
  chapterIndex: z.number(),
  title: z.string(),
  sceneDescription: z.string(),
  narration: z.string(),
  illustrationPrompt: z.string(),
  learningGoal: z.string(),
  storyText: z.string().optional(),
  illustration: illustrationPlanSchema.nullable().optional(),
});

export const storyPlanSchema = z.object({
  title: z.string(),
  subtitle: z.string().optional(),
  theme: z.string(),
  educationalMessage: z.string(),
  chapters: z.array(chapterOutlineSchema),
  openingHook: z.string(),
  resolution: z.string(),
  dedicationSuggestion: z.string().optional(),
  pages: z.array(pagePlanSchema).optional(),
});

const bookPreviewCoverSchema = z.object({
  title: z.string(),
  subtitle: z.string(),
  childName: z.string(),
  illustrationPrompt: z.string(),
});

const bookPreviewPageSchema = z.object({
  pageNumber: z.number(),
  title: z.string(),
  text: z.string(),
  illustrationPrompt: z.string(),
  layout: z.string(),
  learningGoal: z.string(),
  version: z.number().int().positive().optional(),
});

const bookPreviewBackCoverSchema = z.object({
  message: z.string(),
  educationalSummary: z.string(),
});

const bookPreviewMetadataSchema = z.object({
  language: z.string(),
  theme: z.string(),
  childAge: z.number(),
  totalPages: z.number(),
  generatedBy: z.string(),
});

export const bookPreviewSchema = z.object({
  title: z.string(),
  subtitle: z.string(),
  cover: bookPreviewCoverSchema,
  pages: z.array(bookPreviewPageSchema),
  backCover: bookPreviewBackCoverSchema,
  metadata: bookPreviewMetadataSchema,
});

const generatedImageEntrySchema = z.object({
  id: z.string(),
  kind: z.enum(['cover', 'page', 'back_cover']),
  pageNumber: z.number().optional(),
  prompt: z.string(),
  negativePrompt: z.string().optional(),
  provider: z.literal('local_mock'),
  status: z.literal('complete'),
  imageUrl: z.string(),
  altText: z.string(),
  width: z.number(),
  height: z.number(),
  seed: z.string(),
});

const generationProviderCallMetadataSchema = z.object({
  callIndex: z.number().int().positive(),
  operation: z.enum([
    'character_profile',
    'character_sheet',
    'story',
    'story_repair',
    'illustration',
  ]),
  assetLabel: z.string().optional(),
  provider: z.enum(['mock', 'openai', 'unknown']),
  model: z.string().optional(),
  promptVersion: z.string(),
  promptHash: z.string().regex(/^[a-f0-9]{64}$/),
  attempt: z.number().int().positive(),
  durationMs: z.number().nonnegative(),
  status: z.enum(['success', 'error', 'cancelled']),
  failureKind: z
    .enum([
      'cancelled',
      'timeout',
      'rate_limit',
      'network',
      'authentication',
      'invalid_response',
      'provider_error',
      'unknown',
    ])
    .optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  httpAttempts: z.number().int().nonnegative().optional(),
  retries: z.number().int().nonnegative().optional(),
  rateLimitHits: z.number().int().nonnegative().optional(),
  rateLimitWaitMs: z.number().int().nonnegative().optional(),
  retryAfterHonoredCount: z.number().int().nonnegative().optional(),
  timeoutCount: z.number().int().nonnegative().optional(),
  estimatedCostUsd: z.number().nonnegative().optional(),
});

const generationProviderUsageSchema = z.object({
  maxPaidCalls: z.number().int().positive(),
  plannedPaidCalls: z.number().int().nonnegative(),
  actualPaidCalls: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().nonnegative().optional(),
  calls: z.array(generationProviderCallMetadataSchema),
});

const resumeDiagnosticsSchema = z.object({
  resumeMode: z.boolean(),
  requiredAssets: z.array(z.string()),
  validExistingAssets: z.array(z.string()),
  missingAssetsBeforeRetry: z.array(z.string()),
  invalidAssetsBeforeRetry: z.array(z.string()),
  reusedImageCount: z.number().int().nonnegative(),
  regeneratedImageCount: z.number().int().nonnegative(),
  skippedStoryGeneration: z.boolean(),
  skippedCharacterProfileGeneration: z.boolean(),
  skippedCharacterSheetGeneration: z.boolean(),
  skippedExistingImageGeneration: z.boolean(),
  missingAssetsAfterRetry: z.array(z.string()),
  pdfRenderAttempted: z.boolean(),
  pdfRenderSucceeded: z.boolean(),
  finalBookStatus: z.nativeEnum(BookStatus),
});

const imageGenerationFailureDetailSchema = z.object({
  assetLabel: z.string(),
  provider: z.enum(['mock', 'openai', 'unknown']),
  model: z.string().optional(),
  failureKind: z
    .enum([
      'cancelled',
      'timeout',
      'rate_limit',
      'network',
      'authentication',
      'invalid_response',
      'provider_error',
      'unknown',
    ])
    .optional(),
  httpStatus: z.number().int().optional(),
  errorType: z.string().optional(),
  errorCode: z.string().optional(),
  message: z.string(),
  attempts: z.number().int().nonnegative(),
  limiterRetries: z.number().int().nonnegative(),
  limiterWaitMs: z.number().nonnegative(),
  characterReferenceSupplied: z.boolean(),
  requestMode: z.enum(['text-to-image', 'character-reference-edit']),
  timeoutMs: z.number().nonnegative().optional(),
  elapsedMs: z.number().nonnegative().optional(),
  retryDecision: z.string().optional(),
});

export const imageGenerationResultSchema = z.object({
  provider: z.literal('local_mock'),
  status: z.literal('complete'),
  images: z.array(generatedImageEntrySchema),
  createdAt: z.string(),
  imageByteProvider: z.string().nullable().optional(),
  generatedImageCount: z.number().int().nonnegative().optional(),
  failedImageCount: z.number().int().nonnegative().optional(),
  lastImageError: z.string().optional(),
  characterReferenceAvailable: z.boolean().optional(),
  characterReferenceUsedForImages: z.boolean().optional(),
  imageGenerationMode: z.enum(['text-to-image', 'character-reference-edit', 'mixed']).optional(),
  characterReferenceLoadError: z.string().optional(),
  resume: resumeDiagnosticsSchema.optional(),
  imageFailures: z.array(imageGenerationFailureDetailSchema).optional(),
  providerUsage: generationProviderUsageSchema.optional(),
});

// Bidirectional type assertions make future shared/runtime drift fail the API
// typecheck while retaining ordinary inferred Zod schemas at call sites.
type Assert<T extends true> = T;
type EqualContract<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type _CharacterProfileContract = Assert<
  EqualContract<keyof z.infer<typeof characterProfileSchema>, keyof CharacterProfile>
>;
type _ImageGenerationResultContract = Assert<
  EqualContract<keyof z.infer<typeof imageGenerationResultSchema>, keyof ImageGenerationResult>
>;
type _GenerationProviderOperationContract = Assert<
  EqualContract<
    z.infer<typeof generationProviderCallMetadataSchema>['operation'],
    GenerationProviderOperation
  >
>;

const layoutBoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

const layoutTextBlockSchema = z.object({
  box: layoutBoxSchema,
  text: z.string(),
  fontFamily: z.string(),
  fontSize: z.number(),
  lineHeight: z.number(),
  align: z.enum(['left', 'center', 'right']),
  verticalAlign: z.enum(['top', 'middle', 'bottom']),
  color: z.string(),
});

const layoutImageBlockSchema = z.object({
  box: layoutBoxSchema,
  imageUrl: z.string(),
  altText: z.string(),
  objectFit: z.enum(['cover', 'contain']),
});

const bookLayoutEntrySchema = z.object({
  id: z.string(),
  kind: z.enum(['cover', 'page', 'back_cover']),
  pageNumber: z.number().optional(),
  template: z.enum([
    'cover_full_bleed',
    'image_top_text_bottom',
    'text_left_image_right',
    'image_left_text_right',
    'text_only',
    'back_cover_summary',
  ]),
  trimSize: z.literal('square_8x8'),
  canvas: z.object({
    width: z.number(),
    height: z.number(),
    unit: z.literal('px'),
  }),
  safeArea: layoutBoxSchema,
  bleed: z.number(),
  textBlock: layoutTextBlockSchema.optional(),
  imageBlock: layoutImageBlockSchema.optional(),
  notes: z.array(z.string()),
});

export const bookLayoutSchema = z.object({
  status: z.literal('complete'),
  trimSize: z.literal('square_8x8'),
  entries: z.array(bookLayoutEntrySchema),
  metadata: z.object({
    title: z.string(),
    childName: z.string(),
    totalPages: z.number(),
    generatedAt: z.string(),
  }),
});
