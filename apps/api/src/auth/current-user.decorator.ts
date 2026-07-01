import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { User } from '@prisma/client';
import type { RequestWithUser } from './request-with-user';

/**
 * Reads the user attached by DevAuthGuard. Only valid on routes guarded by
 * DevAuthGuard (or its eventual real-auth replacement).
 */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): User => {
  const request = ctx.switchToHttp().getRequest<RequestWithUser>();
  if (!request.user) {
    throw new Error('@CurrentUser() used on a route without an auth guard attaching request.user');
  }
  return request.user;
});
