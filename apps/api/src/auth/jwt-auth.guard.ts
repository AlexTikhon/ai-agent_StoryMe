import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { TokenService } from './token.service';
import type { RequestWithUser } from './request-with-user';

const BEARER_PREFIX = 'Bearer ';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly tokenService: TokenService,
    private readonly usersService: UsersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();

    const header = request.headers.authorization;
    if (!header || !header.startsWith(BEARER_PREFIX)) {
      throw new UnauthorizedException('Missing bearer token');
    }
    const token = header.slice(BEARER_PREFIX.length).trim();
    if (!token) {
      throw new UnauthorizedException('Missing bearer token');
    }

    let payload;
    try {
      payload = this.tokenService.verifyAccessToken(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }

    // Loaded fresh from the DB rather than trusted from the payload, so a
    // deactivated account or role change takes effect immediately instead of
    // waiting for the 15-minute access token to expire.
    const user = await this.usersService.findById(payload.sub);
    if (!user || user.deactivatedAt) {
      throw new UnauthorizedException('Invalid or expired access token');
    }

    request.user = user;
    return true;
  }
}
