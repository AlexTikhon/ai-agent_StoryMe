import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { BookDto } from '@book/types';
import {
  childPhotoAssetKey,
  IMAGE_ASSET_STORAGE_TOKEN,
  type ImageAssetStorage,
} from '../images/image-asset-storage';
import { ChildPhotoProcessor } from '../images/child-photo-processor';
import { PrismaService } from '../database/prisma.service';
import { getPublishedPreviewPdf, PDF_STORAGE_TOKEN, type PdfStorage } from '../pdf/pdf-storage';
import { resolvePublishedPdfNamespace } from '../agent/generation-artifact-namespace';
import { toBookDto } from './books.mapper';
import { BookCrudService, EDITABLE_BOOK_STATUSES } from './book-crud.service';

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
}
