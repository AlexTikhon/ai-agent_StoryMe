import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { MAX_BOOK_PAGE_COUNT, type BookDto, type PublishedBookImageId } from '@book/types';
import {
  childPhotoAssetKey,
  IMAGE_ASSET_STORAGE_TOKEN,
  type ImageAssetContentType,
  type ImageAssetStorage,
} from '../images/image-asset-storage';
import { ChildPhotoProcessor } from '../images/child-photo-processor';
import { PrismaService } from '../database/prisma.service';
import { getPublishedPreviewPdf, PDF_STORAGE_TOKEN, type PdfStorage } from '../pdf/pdf-storage';
import {
  resolvePublishedImageNamespace,
  resolvePublishedPdfNamespace,
} from '../agent/generation-artifact-namespace';
import { toBookDto } from './books.mapper';
import { BookCrudService, EDITABLE_BOOK_STATUSES } from './book-crud.service';
import { publishedImageKey } from './published-page-image-key';

export interface PublishedImageResult {
  buffer: Buffer;
  contentType: ImageAssetContentType;
  filename: string;
}

interface ParsedPublishedImageId {
  id: PublishedBookImageId;
  kind: 'cover' | 'page' | 'back_cover';
  pageNumber?: number;
}

const IMAGE_FILE_EXTENSIONS: Record<ImageAssetContentType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
};

export function parsePublishedImageId(imageId: string): ParsedPublishedImageId {
  if (imageId === 'cover') return { id: imageId, kind: 'cover' };
  if (imageId === 'back-cover') return { id: imageId, kind: 'back_cover' };

  const pageMatch = /^page-([1-9]\d*)$/.exec(imageId);
  const pageNumber = pageMatch ? Number(pageMatch[1]) : NaN;
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > MAX_BOOK_PAGE_COUNT) {
    throw new BadRequestException(
      `Invalid image id â€” use cover, back-cover, or page-1 through page-${MAX_BOOK_PAGE_COUNT}`,
    );
  }
  return { id: `page-${pageNumber}`, kind: 'page', pageNumber };
}

function detectImageContentType(buffer: Buffer): ImageAssetContentType | null {
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }

  const prefix = buffer
    .subarray(0, 4096)
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trimStart();
  if (prefix.startsWith('<svg') || (prefix.startsWith('<?xml') && /<svg(?:\s|>)/i.test(prefix))) {
    return 'image/svg+xml';
  }
  return null;
}

@Injectable()
export class BookAssetService {
  constructor(
    private readonly crud: BookCrudService,
    private readonly prisma: PrismaService,
    @Inject(PDF_STORAGE_TOKEN) private readonly pdfStorage: PdfStorage,
    @Inject(IMAGE_ASSET_STORAGE_TOKEN) private readonly imageStorage: ImageAssetStorage,
    private readonly childPhotoProcessor: ChildPhotoProcessor,
  ) {}

  async uploadChildPhoto(
    userId: string,
    bookId: string,
    file: Express.Multer.File | undefined,
  ): Promise<BookDto> {
    const book = await this.crud.findOwnedOrThrow(bookId, userId);
    if (!EDITABLE_BOOK_STATUSES.has(book.status)) {
      throw new ConflictException('Child photo cannot be uploaded while generation is in progress');
    }
    if (!file) {
      throw new BadRequestException(
        'No photo file provided, or the file was rejected — use jpg/png/webp under 5MB',
      );
    }

    const { buffer, contentType } = await this.childPhotoProcessor.process(file.buffer);
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const key = childPhotoAssetKey(bookId, randomUUID());
    await this.imageStorage.saveImageAsset(key, buffer, contentType);
    const result = await this.prisma.book.updateMany({
      where: { id: bookId, userId, deletedAt: null, status: { in: [...EDITABLE_BOOK_STATUSES] } },
      data: {
        childPhotoAssetKey: key,
        childPhotoContentType: contentType,
        childPhotoSha256: sha256,
        childPhotoSizeBytes: buffer.length,
      },
    });
    if (result.count === 0) {
      throw new ConflictException('Child photo cannot be uploaded while generation is in progress');
    }
    return toBookDto(await this.crud.findOwnedOrThrow(bookId, userId));
  }

  async getPreviewPdfBuffer(
    bookId: string,
    userId: string,
  ): Promise<{ buffer: Buffer; contentType: 'application/pdf'; filename: string }> {
    const book = await this.crud.findOwnedOrThrow(bookId, userId);
    const namespace = resolvePublishedPdfNamespace(book);
    if (namespace.kind === 'not_ready') {
      throw new ConflictException('PDF not ready — book generation is not complete');
    }
    const result = await getPublishedPreviewPdf(this.pdfStorage, bookId, namespace);
    if (!result) throw new NotFoundException('PDF file not found in storage');
    return result;
  }

  async getPublishedImage(
    bookId: string,
    userId: string,
    rawImageId: string,
  ): Promise<PublishedImageResult> {
    const image = parsePublishedImageId(rawImageId);
    const book = await this.crud.findOwnedOrThrow(bookId, userId);
    const namespace = resolvePublishedImageNamespace(book);
    if (namespace.kind === 'not_ready') {
      throw new ConflictException('Images not ready â€” book generation is not complete');
    }

    const pageOverride =
      image.kind === 'page'
        ? await this.prisma.bookPage.findUnique({
            where: { bookId_pageNumber: { bookId, pageNumber: image.pageNumber! } },
            select: { imageR2Key: true },
          })
        : null;
    const key = publishedImageKey(
      bookId,
      namespace,
      image.kind,
      image.pageNumber,
      pageOverride?.imageR2Key
        ? new Map([[image.pageNumber!, pageOverride.imageR2Key]])
        : new Map(),
    );
    const buffer = await this.imageStorage.getImageAsset(key);
    if (!buffer) throw new NotFoundException('Published image not found in storage');

    const contentType = detectImageContentType(buffer);
    if (!contentType) {
      throw new InternalServerErrorException('Published image has an unsupported stored format');
    }
    return {
      buffer,
      contentType,
      filename: `${image.id}.${IMAGE_FILE_EXTENSIONS[contentType]}`,
    };
  }
}
