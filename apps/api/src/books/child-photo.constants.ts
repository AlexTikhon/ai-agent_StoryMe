/** Upload limits for the optional child reference photo (Phase: personalized characters). */
export const MAX_CHILD_PHOTO_BYTES = 5 * 1024 * 1024;

/** Mirrors the ImageAssetContentType values usable for an uploaded photo (svg excluded — never a valid photo upload). */
export const ALLOWED_CHILD_PHOTO_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export type AllowedChildPhotoMimeType = (typeof ALLOWED_CHILD_PHOTO_MIME_TYPES)[number];

export function isAllowedChildPhotoMimeType(mimetype: string): mimetype is AllowedChildPhotoMimeType {
  return (ALLOWED_CHILD_PHOTO_MIME_TYPES as readonly string[]).includes(mimetype);
}
