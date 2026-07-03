import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import { DevAuthGuard } from './dev-auth.guard';
import { JwtAuthGuard } from './jwt-auth.guard';

/**
 * Picks the active auth strategy from AUTH_MODE at request time, so
 * protected controllers (BooksController, AuthController#getMe) need no code
 * change to switch between local dev convenience and real JWT auth — only an
 * env var. DevAuthGuard itself still refuses to run outside dev (see its own
 * NODE_ENV check) as a second safety net if AUTH_MODE=dev is ever set by
 * mistake in a deployed environment.
 */
@Injectable()
export class AuthModeGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly devAuthGuard: DevAuthGuard,
    private readonly jwtAuthGuard: JwtAuthGuard,
  ) {}

  canActivate(context: ExecutionContext): boolean | Promise<boolean> {
    const mode = this.config.get('AUTH_MODE', { infer: true });
    if (mode === 'dev') {
      return this.devAuthGuard.canActivate(context);
    }
    return this.jwtAuthGuard.canActivate(context);
  }
}
