import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import type { BookDto } from '@book/types';
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
  findAll(@CurrentUser() user: User): Promise<BookDto[]> {
    return this.booksService.findAllForUser(user.id);
  }

  @Post()
  create(@CurrentUser() user: User, @Body() dto: CreateBookDto): Promise<BookDto> {
    return this.booksService.create(user.id, dto);
  }

  @Get(':id')
  findOne(@CurrentUser() user: User, @Param('id') id: string): Promise<BookDto> {
    return this.booksService.findOneForUser(id, user.id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: UpdateBookDto,
  ): Promise<BookDto> {
    return this.booksService.update(id, user.id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@CurrentUser() user: User, @Param('id') id: string): Promise<void> {
    return this.booksService.remove(id, user.id);
  }
}
