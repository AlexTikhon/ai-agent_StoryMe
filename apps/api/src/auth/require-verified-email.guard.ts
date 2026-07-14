import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import type { RequestWithUser } from './request-with-user';

/**
 * Blocks paid/expensive operations (generation, child-photo processing) for
 * an account whose email isn't verified — must run after an auth guard has
 * populated request.user (AuthModeGuard).
 *
 * Skipped entirely in AUTH_MODE=dev: DevAuthGuard's synthetic users
 * (UsersService.findOrCreateByEmail) are created with the schema default
 * emailVerified=false and have no real verification flow, so enforcing this
 * there would 403 every local dev/demo generation. Only meaningful (and only
 * enforced) in jwt mode.
 */
@Injectable()
export class RequireVerifiedEmailGuard implements CanActivate {
  constructor(private readonly config: ConfigService<Env, true>) {}

  canActivate(context: ExecutionContext): boolean {
    if (this.config.get('AUTH_MODE', { infer: true }) !== 'jwt') {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    if (!request.user?.emailVerified) {
      throw new ForbiddenException({
        error: 'Email is not verified',
        message: 'Email is not verified',
        code: 'EMAIL_NOT_VERIFIED',
      });
    }

    return true;
  }
}
