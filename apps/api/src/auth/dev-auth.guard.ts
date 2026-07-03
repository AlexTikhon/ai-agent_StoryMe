import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isEmail } from 'class-validator';
import type { Env } from '../config/env.schema';
import { UsersService } from '../users/users.service';
import type { RequestWithUser } from './request-with-user';

/**
 * DEVELOPMENT AUTH ONLY — there is no credential verification here. The
 * caller's identity is taken on faith from the `x-user-email` header, and a
 * matching user is created automatically on first use.
 *
 * Refuses to run when NODE_ENV=production, independent of AUTH_MODE, so a
 * misconfigured deployment fails loudly instead of silently accepting
 * impersonation headers. Callers downstream (controllers, @CurrentUser) only
 * depend on `request.user` being populated, so swapping the guard
 * implementation (see AuthModeGuard/JwtAuthGuard) requires no other changes.
 */
@Injectable()
export class DevAuthGuard implements CanActivate {
  constructor(
    private readonly usersService: UsersService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.config.get('NODE_ENV', { infer: true }) === 'production') {
      throw new UnauthorizedException('Dev auth is disabled in production');
    }

    const request = context.switchToHttp().getRequest<RequestWithUser>();

    const email = request.headers['x-user-email'];
    const name = request.headers['x-user-name'];

    if (typeof email !== 'string' || !isEmail(email)) {
      throw new UnauthorizedException('Missing or invalid x-user-email header (dev auth)');
    }

    request.user = await this.usersService.findOrCreateByEmail(
      email,
      typeof name === 'string' && name.trim().length > 0 ? name : undefined,
    );

    return true;
  }
}
