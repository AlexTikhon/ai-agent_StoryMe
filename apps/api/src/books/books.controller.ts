import {
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Response } from 'express';
import type { User } from '@prisma/client';
import type {
  BookDto,
  BooksPageDto,
  GenerateBookResponse,
  GenerationDiagnosticsDto,
} from '@book/types';
import { AuthModeGuard } from '../auth/auth-mode.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequireVerifiedEmailGuard } from '../auth/require-verified-email.guard';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { UserRateLimitGuard } from '../rate-limit/user-rate-limit.guard';
import { BooksService } from './books.service';
import { CreateBookDto } from './dto/create-book.dto';
import { UpdateBookDto } from './dto/update-book.dto';
import { isAllowedChildPhotoMimeType, MAX_CHILD_PHOTO_BYTES } from './child-photo.constants';

@UseGuards(AuthModeGuard, UserRateLimitGuard)
@Controller('books')
export class BooksController {
  constructor(private readonly booksService: BooksService) {}

  @Get()
  findAll(
    @CurrentUser() user: User,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ): Promise<BooksPageDto> {
    return this.booksService.findAllForUser(user.id, page, limit);
  }

  @Post()
  create(@CurrentUser() user: User, @Body() dto: CreateBookDto): Promise<BookDto> {
    return this.booksService.create(user.id, dto);
  }

  @Get(':id')
  findOne(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string): Promise<BookDto> {
    return this.booksService.findOneForUser(id, user.id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBookDto,
  ): Promise<BookDto> {
    return this.booksService.update(id, user.id, dto);
  }

  /**
   * Optional child reference photo (jpg/png/webp, up to MAX_CHILD_PHOTO_BYTES),
   * uploaded separately from book creation so the JSON create-book contract
   * stays unchanged. multer buffers in memory (never touches local disk) and
   * BooksService.uploadChildPhoto persists it via ImageAssetStorage — see
   * child-photo.constants.ts for limits.
   */
  @Post(':id/child-photo')
  @HttpCode(200)
  @UseGuards(RequireVerifiedEmailGuard)
  @RateLimit({
    windowMsEnvKey: 'CHILD_PHOTO_RATE_LIMIT_WINDOW_MS',
    maxAttemptsEnvKey: 'CHILD_PHOTO_RATE_LIMIT_MAX_ATTEMPTS',
  })
  @UseInterceptors(
    FileInterceptor('photo', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_CHILD_PHOTO_BYTES },
      fileFilter: (_req, file, callback) => {
        callback(null, isAllowedChildPhotoMimeType(file.mimetype));
      },
    }),
  )
  uploadChildPhoto(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<BookDto> {
    return this.booksService.uploadChildPhoto(user.id, id, file);
  }

  @Get(':id/pdf/preview')
  async getPreviewPdf(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const result = await this.booksService.getPreviewPdfBuffer(id, user.id);
    res.set({
      'Content-Type': result.contentType,
      'Content-Disposition': `inline; filename="${result.filename}"`,
      'Content-Length': String(result.buffer.length),
    });
    return new StreamableFile(result.buffer);
  }

  @Post(':id/generate')
  @HttpCode(200)
  @UseGuards(RequireVerifiedEmailGuard)
  @RateLimit({
    windowMsEnvKey: 'GENERATION_RATE_LIMIT_WINDOW_MS',
    maxAttemptsEnvKey: 'GENERATION_RATE_LIMIT_MAX_ATTEMPTS',
  })
  generate(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<GenerateBookResponse> {
    return this.booksService.startGeneration(user.id, id);
  }

  /** Resumes a failed book using the exact input the failed run used — see BooksService.retryGeneration. Use POST /:id/regenerate for a complete book, or to pick up edits made since a failure. */
  @Post(':id/retry-generation')
  @HttpCode(200)
  @UseGuards(RequireVerifiedEmailGuard)
  @RateLimit({
    windowMsEnvKey: 'GENERATION_RATE_LIMIT_WINDOW_MS',
    maxAttemptsEnvKey: 'GENERATION_RATE_LIMIT_MAX_ATTEMPTS',
  })
  retryGeneration(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<GenerateBookResponse> {
    return this.booksService.retryGeneration(user.id, id);
  }

  /** Replaces a failed or complete book's story/images/PDF with a fresh run built from the book's current fields — see BooksService.regenerateBook. */
  @Post(':id/regenerate')
  @HttpCode(200)
  @UseGuards(RequireVerifiedEmailGuard)
  @RateLimit({
    windowMsEnvKey: 'GENERATION_RATE_LIMIT_WINDOW_MS',
    maxAttemptsEnvKey: 'GENERATION_RATE_LIMIT_MAX_ATTEMPTS',
  })
  regenerate(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<GenerateBookResponse> {
    return this.booksService.regenerateBook(user.id, id);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.booksService.remove(id, user.id);
  }

  @Get(':id/generation-diagnostics')
  @RateLimit({
    windowMsEnvKey: 'DIAGNOSTICS_RATE_LIMIT_WINDOW_MS',
    maxAttemptsEnvKey: 'DIAGNOSTICS_RATE_LIMIT_MAX_ATTEMPTS',
  })
  getGenerationDiagnostics(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<GenerationDiagnosticsDto> {
    return this.booksService.getGenerationDiagnostics(id, user.id);
  }
}
