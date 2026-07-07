import { z } from 'zod';
import { Pronouns } from '@book/types';

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
  appearance: characterAppearanceSchema,
  personality: characterPersonalitySchema,
  visualAnchor: z.string(),
  narrativeDescription: z.string(),
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

export const imageGenerationResultSchema = z.object({
  provider: z.literal('local_mock'),
  status: z.literal('complete'),
  images: z.array(generatedImageEntrySchema),
  createdAt: z.string(),
  imageByteProvider: z.string().nullable().optional(),
});

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
