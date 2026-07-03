import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import type { Env } from '../config/env.schema';
import { RateLimiterService } from '../rate-limit/rate-limiter.service';

/**
 * Applies AUTH_RATE_LIMIT_WINDOW_MS / AUTH_RATE_LIMIT_MAX_ATTEMPTS to
 * whichever route it's attached to via @UseGuards. Keyed on the handler
 * (so register/login/refresh/logout each get their own independent budget),
 * the client IP, and the request's email field when present — so a
 * credential-stuffing run against one email doesn't exhaust the budget for
 * every other user sharing that IP, while an attacker rotating emails from
 * one IP still hits the plain IP+route budget.
 *
 * Response body on 429 is intentionally generic (no "N attempts left for
 * this email" detail) to avoid leaking whether an email is registered.
 */
@Injectable()
export class AuthRateLimitGuard implements CanActivate {
  constructor(
    private readonly rateLimiter: RateLimiterService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();

    const windowMs = this.config.get('AUTH_RATE_LIMIT_WINDOW_MS', { infer: true });
    const maxAttempts = this.config.get('AUTH_RATE_LIMIT_MAX_ATTEMPTS', { infer: true });

    const scope = `${context.getClass().name}.${context.getHandler().name}`;
    const key = this.buildKey(scope, request);
    const result = this.rateLimiter.consume(key, windowMs, maxAttempts);

    if (!result.allowed) {
      response.setHeader('Retry-After', Math.ceil(result.retryAfterMs / 1000).toString());
      throw new HttpException(
        { error: 'Too many requests', code: 'RATE_LIMITED' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }

  private buildKey(scope: string, request: Request): string {
    const ip = request.ip ?? 'unknown';
    const email = this.extractEmail(request.body);
    return email ? `${scope}:${ip}:${email}` : `${scope}:${ip}`;
  }

  private extractEmail(body: unknown): string | undefined {
    if (typeof body !== 'object' || body === null || !('email' in body)) {
      return undefined;
    }
    const value = (body as Record<string, unknown>)['email'];
    return typeof value === 'string' ? value.trim().toLowerCase() : undefined;
  }
}
