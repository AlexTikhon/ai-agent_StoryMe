import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import type { Env } from '../config/env.schema';
import type { RequestWithUser } from '../auth/request-with-user';
import { RATE_LIMITER_TOKEN, type RateLimiter } from './rate-limiter.interface';
import { RATE_LIMIT_KEY, type RateLimitOptions } from './rate-limit.decorator';

/**
 * Generic per-authenticated-user rate limit guard, driven by @RateLimit()
 * metadata on the handler. Must run after an auth guard has populated
 * request.user (AuthModeGuard) — keys on userId rather than IP/email, since
 * these routes are already authenticated and a shared IP (NAT, office
 * network) must not throttle unrelated users.
 *
 * A handler with no @RateLimit() metadata is allowed through untouched, so
 * this guard is safe to apply controller-wide.
 */
@Injectable()
export class UserRateLimitGuard implements CanActivate {
  constructor(
    @Inject(RATE_LIMITER_TOKEN) private readonly rateLimiter: RateLimiter,
    private readonly config: ConfigService<Env, true>,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.get<RateLimitOptions | undefined>(
      RATE_LIMIT_KEY,
      context.getHandler(),
    );
    if (!options) return true;

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const response = context.switchToHttp().getResponse<Response>();
    const windowMs = this.config.get(options.windowMsEnvKey, { infer: true }) as number;
    const maxAttempts = this.config.get(options.maxAttemptsEnvKey, { infer: true }) as number;

    const userId = request.user?.id;
    if (!userId) {
      // No authenticated user on the request — an auth guard ahead of this
      // one should already have rejected the request; nothing meaningful to
      // key a per-user budget on, so let it through rather than throttling
      // by a shared/absent identity.
      return true;
    }

    const scope = `${context.getClass().name}.${context.getHandler().name}`;
    const result = await this.rateLimiter.consume(`${scope}:user:${userId}`, windowMs, maxAttempts);

    if (!result.allowed) {
      response.setHeader('Retry-After', Math.ceil(result.retryAfterMs / 1000).toString());
      throw new HttpException(
        { error: 'Too many requests', code: 'RATE_LIMITED' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }
}
