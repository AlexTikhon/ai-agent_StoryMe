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
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import type { User } from '@prisma/client';
import type {
  BookDto,
  BooksPageDto,
  GenerateBookResponse,
  GenerationDiagnosticsDto,
} from '@book/types';
import { CurrentUser } from '../auth/current-user.decorator';
import { DevAuthGuard } from '../auth/dev-auth.guard';
import { BooksService } from './books.service';
import { CreateBookDto } from './dto/create-book.dto';
import { UpdateBookDto } from './dto/update-book.dto';

@UseGuards(DevAuthGuard)
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
  findOne(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<BookDto> {
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
  generate(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<GenerateBookResponse> {
    return this.booksService.startGeneration(user.id, id);
  }

  @Post(':id/retry-generation')
  @HttpCode(200)
  retryGeneration(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<GenerateBookResponse> {
    return this.booksService.retryGeneration(user.id, id);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.booksService.remove(id, user.id);
  }

  @Get(':id/generation-diagnostics')
  getGenerationDiagnostics(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<GenerationDiagnosticsDto> {
    return this.booksService.getGenerationDiagnostics(id, user.id);
  }
}
