import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { isEmail } from 'class-validator';
import { UsersService } from '../users/users.service';
import type { RequestWithUser } from './request-with-user';

/**
 * DEVELOPMENT AUTH ONLY — there is no credential verification here. The
 * caller's identity is taken on faith from the `x-user-email` header, and a
 * matching user is created automatically on first use.
 *
 * Replace with real auth (session/JWT) before production. Callers downstream
 * (controllers, @CurrentUser) only depend on `request.user` being populated,
 * so swapping the guard implementation later requires no other changes.
 */
@Injectable()
export class DevAuthGuard implements CanActivate {
  constructor(private readonly usersService: UsersService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
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
