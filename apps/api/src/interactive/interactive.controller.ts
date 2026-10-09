import { Body, Controller, Get, HttpCode, Inject, Param, Post, UseGuards } from '@nestjs/common';
import type { User } from '@prisma/client';
import { AuthModeGuard } from '../auth/auth-mode.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { UserRateLimitGuard } from '../rate-limit/user-rate-limit.guard';
import { InteractiveService } from './interactive.service';
import type { PublicSessionView } from './public-view';
import {
  createSessionBodySchema,
  parseRequest,
  sessionIdSchema,
  submitChoiceBodySchema,
} from './requests';

/**
 * Bodies are taken as `unknown` and parsed with strict zod schemas (see
 * requests.ts) so malformed input gets the stable INVALID_REQUEST code and no
 * client-supplied events, state or owner id can pass through. The owner is
 * always the authenticated user.
 */
@UseGuards(AuthModeGuard, UserRateLimitGuard)
@Controller('interactive/sessions')
export class InteractiveController {
  constructor(@Inject(InteractiveService) private readonly interactive: InteractiveService) {}

  @Post()
  create(@CurrentUser() user: User, @Body() body: unknown): Promise<PublicSessionView> {
    const { scenarioId } = parseRequest(createSessionBodySchema, body);
    return this.interactive.createSession(user.id, scenarioId);
  }

  @Get(':id')
  findOne(@CurrentUser() user: User, @Param('id') id: string): Promise<PublicSessionView> {
    return this.interactive.getSession(user.id, parseRequest(sessionIdSchema, id));
  }

  @Post(':id/choices')
  @HttpCode(200)
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
