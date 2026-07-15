import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Book } from '@prisma/client';
import {
  ALLOWED_CHILD_PHOTO_MIME_TYPES,
  type AllowedChildPhotoMimeType,
} from '../books/child-photo.constants';

/** Stable error code for a GenerationRun.inputSnapshot that fails validation — never the raw Zod issue list, which could echo back arbitrary stored JSON. */
export const GENERATION_INPUT_SNAPSHOT_INVALID = 'GENERATION_INPUT_SNAPSHOT_INVALID';

export class InvalidGenerationInputSnapshotError extends Error {
  readonly code = GENERATION_INPUT_SNAPSHOT_INVALID;

  constructor(runId: string, cause: unknown) {
    super(`GenerationRun ${runId} has an invalid input_snapshot — refusing to execute it.`);
    this.name = 'InvalidGenerationInputSnapshotError';
    this.cause = cause;
  }
}

const childPhotoIdentitySchema = z.object({
  assetKey: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/i),
  contentType: z.enum(ALLOWED_CHILD_PHOTO_MIME_TYPES),
  sizeBytes: z.number().int().positive(),
});

/**
 * The current GenerationInputSnapshot shape version. Bumped only if the
 * shape changes again in a way that needs its own migration path — see
 * GenerationInputSnapshotBackfillService for how a run created before this
 * field existed (or before `childPhoto` was a full identity object) is
 * migrated forward the first time it's read.
 */
export const CURRENT_SNAPSHOT_VERSION = 2 as const;

/**
 * Runtime-validated shape of a GenerationRun.input_snapshot — the immutable
 * copy of a book's generation-relevant fields at the moment the run was
 * created. `childPhoto` carries a full immutable identity (versioned asset
 * key + digest + content type + size), not just a mutable key, so a later
 * re-upload can never change what bytes an already-created run resolves to
 * (see BooksService.uploadChildPhoto, which mints a fresh key/digest per
 * upload rather than overwriting one).
 *
 * `snapshotVersion` is optional here (not required) so a snapshot that is
 * already structurally this same v2 shape but predates the field's
 * introduction still parses as current — the field only needs to
 * disambiguate from the *structurally different* legacy v1 shape (see
 * legacyGenerationInputSnapshotSchemaV1), which this schema already rejects
 * on its own (v1's flat childPhotoAssetKey/childPhotoContentType strings
 * don't satisfy `childPhoto`'s required identity-object-or-null shape).
 * buildInputSnapshot always stamps it explicitly on every newly created run.
 */
export const generationInputSnapshotSchema = z.object({
  snapshotVersion: z.literal(CURRENT_SNAPSHOT_VERSION).optional(),
  childName: z.string().nullable(),
  childAge: z.number().int().nullable(),
  language: z.string().nullable(),
  theme: z.string().nullable(),
  educationalMessage: z.string().nullable(),
  pageCount: z.number().int().nullable(),
  childPhoto: childPhotoIdentitySchema.nullable(),
});

export type GenerationInputSnapshot = z.infer<typeof generationInputSnapshotSchema>;

/**
 * The exact pre-Phase-A snapshot shape: no `snapshotVersion`, and a bare
 * uploaded-photo *key* (childPhotoAssetKey/childPhotoContentType) rather than
 * childPhoto's full versioned identity object — because this predates
 * Book.childPhotoSha256/childPhotoSizeBytes existing at all. Never executed
 * directly; GenerationInputSnapshotBackfillService.normalize migrates it to
 * the current shape (minting a fresh versioned copy of the photo, if any)
 * before a run holding one is ever handed to AgentService.
 */
export const legacyGenerationInputSnapshotSchemaV1 = z.object({
  childName: z.string().nullable(),
  childAge: z.number().int().nullable(),
  language: z.string().nullable(),
  theme: z.string().nullable(),
  educationalMessage: z.string().nullable(),
  pageCount: z.number().int().nullable(),
  childPhotoAssetKey: z.string().nullable(),
  childPhotoContentType: z.string().nullable(),
});

export type LegacyGenerationInputSnapshotV1 = z.infer<typeof legacyGenerationInputSnapshotSchemaV1>;

/**
 * Parses and validates a GenerationRun's stored `inputSnapshot` JSON against
 * the CURRENT shape only — never cast arbitrary Prisma JSON directly to
 * GenerationInputSnapshot. Throws InvalidGenerationInputSnapshotError (stable
 * code) for anything that isn't already current-shaped, *including* a
 * legacy v1 snapshot — callers that must also accept a legacy snapshot use
 * GenerationInputSnapshotBackfillService.normalize instead, which tries this
 * first and only falls back to migrating v1 on failure.
 */
export function parseGenerationInputSnapshot(
  runId: string,
  value: unknown,
): GenerationInputSnapshot {
  const result = generationInputSnapshotSchema.safeParse(value);
  if (!result.success) {
    throw new InvalidGenerationInputSnapshotError(runId, result.error);
  }
  return result.data;
}

export function buildInputSnapshot(book: Book): GenerationInputSnapshot {
  return {
    snapshotVersion: CURRENT_SNAPSHOT_VERSION,
    childName: book.childName,
    childAge: book.childAge,
    language: book.language,
    theme: book.theme,
    educationalMessage: book.educationalMessage,
    pageCount: book.pageCount,
    childPhoto:
      book.childPhotoAssetKey &&
      book.childPhotoContentType &&
      book.childPhotoSha256 &&
      book.childPhotoSizeBytes != null
        ? {
            assetKey: book.childPhotoAssetKey,
            sha256: book.childPhotoSha256,
            // Only ever written by BooksService.uploadChildPhoto, always one
            // of AllowedChildPhotoMimeType (see ChildPhotoProcessor) — the
            // column itself is a plain string since Prisma has no enum
            // shared with that type.
            contentType: book.childPhotoContentType as AllowedChildPhotoMimeType,
            sizeBytes: book.childPhotoSizeBytes,
          }
        : null,
  };
}

/** Recursively sorts every object's keys (arrays keep their order) so JSON.stringify is stable regardless of field insertion order at any nesting depth. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const sortedKeys = Object.keys(value as Record<string, unknown>).sort();
    const out: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Deterministic sha256 over a canonical (deep sorted-key) serialization — field order at any nesting level must never affect the hash. */
export function hashInputSnapshot(snapshot: GenerationInputSnapshot): string {
  const canonical = JSON.stringify(canonicalize(snapshot));
  return createHash('sha256').update(canonical).digest('hex');
}
