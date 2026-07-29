import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import type { BookDeletionRequestDto } from '@book/types';
import { AuthModeGuard } from '../auth/auth-mode.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequireVerifiedEmailGuard } from '../auth/require-verified-email.guard';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { UserRateLimitGuard } from '../rate-limit/user-rate-limit.guard';
import { BookHardDeletionService } from './book-hard-deletion.service';
import { RequestBookHardDeleteDto } from './dto/request-book-hard-delete.dto';

@UseGuards(AuthModeGuard, UserRateLimitGuard, RequireVerifiedEmailGuard)
@Controller('books')
export class BookDeletionController {
  constructor(private readonly deletionService: BookHardDeletionService) {}

  @Post(':id/hard-delete')
  @HttpCode(202)
  @RateLimit({
    windowMsEnvKey: 'HARD_DELETE_RATE_LIMIT_WINDOW_MS',
    maxAttemptsEnvKey: 'HARD_DELETE_RATE_LIMIT_MAX_ATTEMPTS',
  })
  request(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) bookId: string,
    @Body() dto: RequestBookHardDeleteDto,
  ): Promise<BookDeletionRequestDto> {
    return this.deletionService.request(user.id, user.role, bookId, dto.confirmation);
  }

  @Get('deletion-requests/:requestId')
  getStatus(
    @CurrentUser() user: User,
    @Param('requestId', ParseUUIDPipe) requestId: string,
  ): Promise<BookDeletionRequestDto> {
    return this.deletionService.getStatus(user.id, requestId);
  }
}
