import { AgentStep } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageAssetStorage } from '../images/image-asset-storage';
import { claimImageAssetKey } from '../images/image-asset-storage';
import type { PdfStorage } from '../pdf/pdf-storage';
import { MockCharacterProfileProvider } from './character-profile-provider';
import { MockStoryGenerationProvider } from './story-generation-provider';
import { BookLayoutStage } from './book-layout.stage';
import { PdfPublicationStage } from './pdf-publication.stage';

vi.mock('../pdf/pdf-renderer', () => ({
  renderStorybookPdf: vi.fn().mockResolvedValue(Buffer.from('%PDF-stage-test')),
}));

import { renderStorybookPdf } from '../pdf/pdf-renderer';

const namespace = { kind: 'claim' as const, runId: 'run-1', fencingVersion: 1 };

async function makeLayout() {
  const characterProfile = await new MockCharacterProfileProvider().buildProfile({
    bookId: 'book-1',
    childName: 'Mia',
    childAge: 5,
    theme: 'friendship',
    language: 'en',
  });
  const result = await new MockStoryGenerationProvider().generateStory({
    bookId: 'book-1',
    childName: 'Mia',
    childAge: 5,
    theme: 'friendship',
    language: 'en',
    pageCount: 4,
    characterProfile,
  });
  return new BookLayoutStage().execute({
    bookId: 'book-1',
    bookPreview: result.bookPreview,
    imageGenerationResult: result.imageGenerationResult,
  });
}

describe('PdfPublicationStage', () => {
  let assets: Map<string, Buffer>;
  let imageAssetStorage: ImageAssetStorage;
  let pdfStorage: PdfStorage;
  let logger: { log: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.mocked(renderStorybookPdf).mockClear();
    assets = new Map();
    imageAssetStorage = {
      getImageAsset: vi.fn(async (key: string) => assets.get(key)),
    } as unknown as ImageAssetStorage;
    pdfStorage = {
      saveClaimPreviewPdf: vi.fn().mockResolvedValue({ url: '/preview/book-1.pdf' }),
    } as unknown as PdfStorage;
    logger = { log: vi.fn(), error: vi.fn() };
  });

  it('exposes the pdf_render orchestration step', () => {
    expect(new PdfPublicationStage().step).toBe(AgentStep.pdf_render);
  });

  it('resolves every planned image, renders and saves the claim-scoped PDF', async () => {
    const layout = await makeLayout();
    for (const entry of layout.entries) {
      assets.set(
        claimImageAssetKey('book-1', namespace, entry.kind, entry.pageNumber),
        Buffer.from(`image:${entry.id}`),
      );
    }

    const result = await new PdfPublicationStage().execute({
      bookId: 'book-1',
      bookLayout: layout,
      namespace,
      imageAssetStorage,
      pdfStorage,
      logger,
    });

    expect(result).toEqual({ previewPdfUrl: '/preview/book-1.pdf' });
    expect(imageAssetStorage.getImageAsset).toHaveBeenCalledTimes(layout.entries.length);
    expect(pdfStorage.saveClaimPreviewPdf).toHaveBeenCalledWith(
      'book-1',
      namespace,
      Buffer.from('%PDF-stage-test'),
    );
  });

  it('fails before rendering or publication when a planned illustration is missing', async () => {
    const layout = await makeLayout();
    for (const entry of layout.entries.slice(1)) {
      assets.set(
        claimImageAssetKey('book-1', namespace, entry.kind, entry.pageNumber),
        Buffer.from(`image:${entry.id}`),
      );
    }

    await expect(
      new PdfPublicationStage().execute({
        bookId: 'book-1',
        bookLayout: layout,
        namespace,
        imageAssetStorage,
        pdfStorage,
        logger,
      }),
    ).rejects.toThrow(/missing generated illustration\(s\) for cover/);

    expect(pdfStorage.saveClaimPreviewPdf).not.toHaveBeenCalled();
    expect(renderStorybookPdf).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('book book-1'));
  });
});
