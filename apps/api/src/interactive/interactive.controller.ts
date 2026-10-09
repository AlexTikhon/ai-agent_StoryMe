import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import type { InteractivePresentationDto, InteractiveSessionListDto } from '@book/types';
import { AuthModeGuard } from '../auth/auth-mode.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { UserRateLimitGuard } from '../rate-limit/user-rate-limit.guard';
import { InteractiveService } from './interactive.service';
import type { PublicSessionView } from './public-view';
import {
  createSessionBodySchema,
  listSessionsQuerySchema,
  parseRequest,
  presentationQuerySchema,
  sessionIdSchema,
  submitChoiceBodySchema,
} from './requests';

/**
 * Bodies are taken as `unknown` and parsed with strict zod schemas (see
 * requests.ts) so malformed input gets the stable INVALID_REQUEST code and no
 * client-supplied events, state or owner id can pass through. The owner is
 * always the authenticated user.
 *
 * Request budgets (INTERACTIVE_*_RATE_LIMIT_*) count attempts, idempotent
 * retries included. UserRateLimitGuard keys each counter by controller+handler,
 * so the list and single-session reads share a configuration, not a counter.
 */
@UseGuards(AuthModeGuard, UserRateLimitGuard)
@Controller('interactive/sessions')
export class InteractiveController {
  constructor(@Inject(InteractiveService) private readonly interactive: InteractiveService) {}

  @Post()
  @RateLimit({
    windowMsEnvKey: 'INTERACTIVE_CREATE_RATE_LIMIT_WINDOW_MS',
    maxAttemptsEnvKey: 'INTERACTIVE_CREATE_RATE_LIMIT_MAX_ATTEMPTS',
  })
  create(@CurrentUser() user: User, @Body() body: unknown): Promise<PublicSessionView> {
    const command = parseRequest(createSessionBodySchema, body);
    return this.interactive.createSession(user.id, command);
  }

  @Get()
  @RateLimit({
    windowMsEnvKey: 'INTERACTIVE_READ_RATE_LIMIT_WINDOW_MS',
    maxAttemptsEnvKey: 'INTERACTIVE_READ_RATE_LIMIT_MAX_ATTEMPTS',
  })
  list(@CurrentUser() user: User, @Query() query: unknown): Promise<InteractiveSessionListDto> {
    return this.interactive.listSessions(user.id, parseRequest(listSessionsQuerySchema, query));
  }

  @Get(':id')
  @RateLimit({
    windowMsEnvKey: 'INTERACTIVE_READ_RATE_LIMIT_WINDOW_MS',
    maxAttemptsEnvKey: 'INTERACTIVE_READ_RATE_LIMIT_MAX_ATTEMPTS',
  })
  findOne(@CurrentUser() user: User, @Param('id') id: string): Promise<PublicSessionView> {
    return this.interactive.getSession(user.id, parseRequest(sessionIdSchema, id));
  }

  /**
   * Artwork metadata for the session's current scene. Read-only: it resolves
   * the owned session through the same public-view read as findOne. Artwork
   * files themselves are public static assets; only this metadata is
   * authenticated, so it must never be cached by shared caches.
   */
  @Get(':id/presentation')
  @Header('Cache-Control', 'private, no-store')
  @RateLimit({
    windowMsEnvKey: 'INTERACTIVE_READ_RATE_LIMIT_WINDOW_MS',
    maxAttemptsEnvKey: 'INTERACTIVE_READ_RATE_LIMIT_MAX_ATTEMPTS',
  })
  presentation(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Query() query: unknown,
  ): Promise<InteractivePresentationDto> {
    const sessionId = parseRequest(sessionIdSchema, id);
    const { expectedRevision } = parseRequest(presentationQuerySchema, query);
    return this.interactive.getPresentation(user.id, sessionId, expectedRevision);
  }

  @Post(':id/choices')
  @HttpCode(200)
  @RateLimit({
    windowMsEnvKey: 'INTERACTIVE_CHOICE_RATE_LIMIT_WINDOW_MS',
    maxAttemptsEnvKey: 'INTERACTIVE_CHOICE_RATE_LIMIT_MAX_ATTEMPTS',
  })
  choose(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<PublicSessionView> {
    const sessionId = parseRequest(sessionIdSchema, id);
    const command = parseRequest(submitChoiceBodySchema, body);
    return this.interactive.submitChoice(user.id, sessionId, command);
  }
}
