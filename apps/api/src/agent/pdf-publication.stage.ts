import { AgentStep } from '@prisma/client';
import type { BookLayout, BookLayoutEntry } from '@book/types';
import { buildImageBufferResolver, type ImageAssetStorage } from '../images/image-asset-storage';
import { renderStorybookPdf, type ImageBufferResolver } from '../pdf/pdf-renderer';
import type { PdfStorage } from '../pdf/pdf-storage';
import type { ClaimArtifactNamespace } from './generation-artifact-namespace';
import type { GenerationStage } from './generation-stage';

interface StageLogger {
  log(message: string): void;
  error(message: string): void;
}

export interface PdfPublicationStageInput {
  readonly bookId: string;
  readonly bookLayout: BookLayout;
  readonly namespace: ClaimArtifactNamespace;
  readonly imageAssetStorage: ImageAssetStorage;
  readonly pdfStorage: PdfStorage;
  readonly logger: StageLogger;
}

export interface PdfPublicationStageOutput {
  readonly previewPdfUrl: string;
}

function describeEntry(entry: BookLayoutEntry): string {
  return entry.kind === 'page' && entry.pageNumber != null
    ? `page ${entry.pageNumber}`
    : entry.kind;
}

/**
 * Refuses to render placeholders in place of planned illustrations.
 */
function assertAllImagesResolved(
  logger: StageLogger,
  bookId: string,
  layout: BookLayout,
  resolveImageBuffer: ImageBufferResolver,
): void {
  const missing: string[] = [];

  for (const entry of layout.entries) {
    if (!entry.imageBlock) continue;
    const label = describeEntry(entry);
    const buffer = resolveImageBuffer(entry.imageBlock, entry);
    if (!buffer) {
      logger.error(
        `Missing generated illustration for ${label} (entry ${entry.id}, book ${bookId}) — no bytes found in image storage.`,
      );
      missing.push(label);
    } else {
      logger.log(
        `Resolved illustration for ${label} (entry ${entry.id}, book ${bookId}): ${entry.imageBlock.imageUrl}, ${buffer.length} bytes.`,
      );
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Cannot render PDF for book ${bookId}: missing generated illustration(s) for ${missing.join(', ')}. ` +
        'Check the image_gen step logs above for provider/storage errors.',
    );
  }
}

export class PdfPublicationStage implements GenerationStage<
  PdfPublicationStageInput,
  PdfPublicationStageOutput
> {
  readonly step = AgentStep.pdf_render;

  async execute({
    bookId,
    bookLayout,
    namespace,
    imageAssetStorage,
    pdfStorage,
    logger,
  }: PdfPublicationStageInput): Promise<PdfPublicationStageOutput> {
    const resolveImageBuffer = await buildImageBufferResolver(
      imageAssetStorage,
      bookId,
      bookLayout.entries,
      namespace,
    );
    assertAllImagesResolved(logger, bookId, bookLayout, resolveImageBuffer);
    logger.log(
      `Rendering PDF for book ${bookId}: ${bookLayout.entries.length} pages — ${bookLayout.entries.map(describeEntry).join(', ')}.`,
    );
    const buffer = await renderStorybookPdf(bookLayout, { resolveImageBuffer });
    logger.log(`PDF rendered for book ${bookId}: ${buffer.length} bytes.`);
    // Claim-scoped storage is intentionally not publication: the coordinator
    // publishes this URL only after the attempt wins its terminal fencing
    // transaction. A stale attempt can therefore leave only an orphaned claim
    // artifact, never overwrite the visible book PDF.
    const saved = await pdfStorage.saveClaimPreviewPdf(bookId, namespace, buffer);
    return { previewPdfUrl: saved.url };
  }
}

export const pdfPublicationStage = new PdfPublicationStage();
