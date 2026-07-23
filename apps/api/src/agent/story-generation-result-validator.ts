import {
  NO_TEXT_IN_IMAGE_INSTRUCTION,
  PRESERVE_APPEARANCE_INSTRUCTION,
  type StoryGenerationResult,
} from './story-generation-provider';

export class StoryGenerationResultValidationError extends Error {
  constructor(readonly reason: string) {
    super(`Story generation result failed deterministic validation: ${reason}`);
    this.name = 'StoryGenerationResultValidationError';
  }
}

function expectedPageNumbers(pageCount: number): number[] {
  return Array.from({ length: pageCount }, (_, index) => index + 1);
}

function assertExactPageNumbers(label: string, actual: number[], expected: number[]): void {
  if (
    actual.length !== expected.length ||
    actual.some((pageNumber, index) => pageNumber !== expected[index])
  ) {
    throw new StoryGenerationResultValidationError(
      `${label} page numbers must be contiguous from 1 to ${expected.length}`,
    );
  }
}

/**
 * Cross-artifact validator behind both mock and OpenAI providers. Individual
 * providers validate shapes; this validates that the story plan, preview and
 * image plan describe exactly the same complete book.
 */
export function validateStoryGenerationResult(
  result: StoryGenerationResult,
  expectedPageCount: number,
): void {
  const expected = expectedPageNumbers(expectedPageCount);
  assertExactPageNumbers(
    'storyPlan',
    result.storyPlan.pages.map((page) => page.pageNumber),
    expected,
  );
  assertExactPageNumbers(
    'bookPreview',
    result.bookPreview.pages.map((page) => page.pageNumber),
    expected,
  );

  if (result.bookPreview.metadata.totalPages !== expectedPageCount) {
    throw new StoryGenerationResultValidationError(
      `bookPreview.metadata.totalPages must equal ${expectedPageCount}`,
    );
  }

  const images = result.imageGenerationResult.images;
  const covers = images.filter((image) => image.kind === 'cover');
  const backCovers = images.filter((image) => image.kind === 'back_cover');
  const pageImages = images.filter((image) => image.kind === 'page');
  if (covers.length !== 1 || backCovers.length !== 1 || images.length !== expectedPageCount + 2) {
    throw new StoryGenerationResultValidationError(
      'image plan must contain exactly one cover, one image per page, and one back cover',
    );
  }
  assertExactPageNumbers(
    'image plan',
    pageImages.map((image) => image.pageNumber ?? -1),
    expected,
  );

  const ids = new Set(images.map((image) => image.id));
  if (ids.size !== images.length) {
    throw new StoryGenerationResultValidationError('image plan ids must be unique');
  }

  for (const image of images) {
    if (
      image.prompt.trim() === '' ||
      image.seed.trim() === '' ||
      !image.prompt.includes(NO_TEXT_IN_IMAGE_INSTRUCTION) ||
      !image.prompt.includes(PRESERVE_APPEARANCE_INSTRUCTION)
    ) {
      throw new StoryGenerationResultValidationError(
        'every image prompt must be non-empty and include the character/text safety instructions',
      );
    }
  }
}
