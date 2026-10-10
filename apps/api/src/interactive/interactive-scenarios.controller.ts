import { Controller, Get, Header, Inject, Query, UseGuards } from '@nestjs/common';
import type { InteractiveScenarioCatalogueDto } from '@book/types';
import { AuthModeGuard } from '../auth/auth-mode.guard';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { UserRateLimitGuard } from '../rate-limit/user-rate-limit.guard';
import { InteractiveService } from './interactive.service';
import { catalogueQuerySchema, parseRequest } from './requests';

/**
 * The published-scenario catalogue. Read-only and identical for every user, but
 * authenticated like the rest of the interactive API and counted against the
 * shared read budget. The body is the allowlisted catalogue DTO only.
 */
@UseGuards(AuthModeGuard, UserRateLimitGuard)
@Controller('interactive/scenarios')
export class InteractiveScenariosController {
  constructor(@Inject(InteractiveService) private readonly interactive: InteractiveService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @RateLimit({
    windowMsEnvKey: 'INTERACTIVE_READ_RATE_LIMIT_WINDOW_MS',
    maxAttemptsEnvKey: 'INTERACTIVE_READ_RATE_LIMIT_MAX_ATTEMPTS',
  })
  list(@Query() query: unknown): InteractiveScenarioCatalogueDto {
    parseRequest(catalogueQuerySchema, query);
    return this.interactive.listScenarios();
  }
}
