import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Env } from '../config/env.schema';
import { RATE_LIMITER_TOKEN, type RateLimiter, type RateLimitResult } from '../rate-limit/rate-limiter.interface';

/**
 * Applies AUTH_RATE_LIMIT_WINDOW_MS / AUTH_RATE_LIMIT_MAX_ATTEMPTS to
 * whichever route it's attached to via @UseGuards. Keyed on the handler
 * (so register/login/refresh/logout each get their own independent budget)
 * and enforces TWO independent budgets per request when an email is present
 * on the body:
 *   1. route + IP           — stops an attacker rotating emails from one IP
 *   2. route + IP + email   — stops a credential-stuffing run against one
 *      email from exhausting the budget for every other user sharing that IP
 * Both are consumed on every request; the request is rejected if EITHER is
 * exceeded. Previously only one of the two keys was ever built, so an
 * attacker who supplied a (rotating) email never hit the IP-wide budget at
 * all — see auth-rate-limit.guard.spec.ts for the regression test.
 *
 * The email is hashed (sha256) before it ever becomes part of a Redis key,
 * so raw emails never sit in Redis keyspace/logs.
 *
 * Response body on 429 is intentionally generic (no "N attempts left for
 * this email" detail) to avoid leaking whether an email is registered.
 */
@Injectable()
export class AuthRateLimitGuard implements CanActivate {
  constructor(
    @Inject(RATE_LIMITER_TOKEN) private readonly rateLimiter: RateLimiter,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();

    const windowMs = this.config.get('AUTH_RATE_LIMIT_WINDOW_MS', { infer: true });
    const maxAttempts = this.config.get('AUTH_RATE_LIMIT_MAX_ATTEMPTS', { infer: true });
    const ipMaxAttempts = this.config.get('AUTH_RATE_LIMIT_IP_MAX_ATTEMPTS', { infer: true });

    const scope = `${context.getClass().name}.${context.getHandler().name}`;
    const ip = request.ip ?? 'unknown';
    const email = this.extractEmail(request.body);

    const results: RateLimitResult[] = [
      await this.rateLimiter.consume(`${scope}:ip:${ip}`, windowMs, ipMaxAttempts),
    ];
    if (email) {
      results.push(
        await this.rateLimiter.consume(
          `${scope}:ip-email:${ip}:${this.hashEmail(email)}`,
          windowMs,
          maxAttempts,
        ),
      );
    }

    const blocked = results.find((result) => !result.allowed);
    if (blocked) {
      response.setHeader('Retry-After', Math.ceil(blocked.retryAfterMs / 1000).toString());
      throw new HttpException(
        { error: 'Too many requests', code: 'RATE_LIMITED' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }

  private extractEmail(body: unknown): string | undefined {
    if (typeof body !== 'object' || body === null || !('email' in body)) {
      return undefined;
    }
    const value = (body as Record<string, unknown>)['email'];
    return typeof value === 'string' ? value.trim().toLowerCase() : undefined;
  }

  private hashEmail(email: string): string {
    return createHash('sha256').update(email).digest('hex');
  }
}
