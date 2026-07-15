/** Upload limits for the optional child reference photo (Phase: personalized characters). */
export const MAX_CHILD_PHOTO_BYTES = 5 * 1024 * 1024;

/** Mirrors the ImageAssetContentType values usable for an uploaded photo (svg excluded — never a valid photo upload). */
export const ALLOWED_CHILD_PHOTO_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export type AllowedChildPhotoMimeType = (typeof ALLOWED_CHILD_PHOTO_MIME_TYPES)[number];

export function isAllowedChildPhotoMimeType(
  mimetype: string,
): mimetype is AllowedChildPhotoMimeType {
  return (ALLOWED_CHILD_PHOTO_MIME_TYPES as readonly string[]).includes(mimetype);
}

/** Stable error code for a loaded child-photo asset whose bytes don't match the sha256/size recorded in the GenerationInputSnapshot at run-creation time — never used for a merely-missing asset (see CHILD_PHOTO_MISSING). */
export const CHILD_PHOTO_INTEGRITY_MISMATCH = 'CHILD_PHOTO_INTEGRITY_MISMATCH';
