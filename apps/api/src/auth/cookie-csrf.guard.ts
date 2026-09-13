import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { Env } from '../config/env.schema';

/**
 * Origin policy for endpoints authorized by an ambient refresh cookie.
 * Browser POSTs must carry an exact configured Origin. Non-browser callers
 * that omit Origin/Fetch Metadata must opt in with a custom header, which a
 * cross-site simple POST cannot set without a successful CORS preflight.
 */
@Injectable()
export class CookieCsrfGuard implements CanActivate {
  constructor(private readonly config: ConfigService<Env, true>) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const origin = request.get('origin');
    const fetchSite = request.get('sec-fetch-site');
    const allowed = new Set(
      this.config
        .get('ALLOWED_ORIGINS', { infer: true })
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    );

    if (origin) {
      if (allowed.has(origin)) return true;
      throw new ForbiddenException({
        error: 'Cross-site cookie request rejected',
        code: 'COOKIE_CSRF_REJECTED',
      });
    }

    if (fetchSite === 'same-origin') return true;
    if (!fetchSite && request.get('x-storyme-csrf') === '1') return true;
    throw new ForbiddenException({
      error: 'Cookie request origin could not be verified',
      code: 'COOKIE_CSRF_REJECTED',
    });
  }
}
