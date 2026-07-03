import { describe, it, expect, vi } from 'vitest';
import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import type { User } from '@prisma/client';
import type { UsersService } from '../users/users.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import type { TokenService } from './token.service';
import type { RequestWithUser } from './request-with-user';

function createContext(headers: Record<string, string>): {
  context: ExecutionContext;
  request: RequestWithUser;
} {
  const request = { headers } as unknown as RequestWithUser;
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

describe('JwtAuthGuard', () => {
  it('rejects a missing Authorization header', async () => {
    const tokenService = { verifyAccessToken: vi.fn() } as unknown as TokenService;
    const usersService = { findById: vi.fn() } as unknown as UsersService;
    const guard = new JwtAuthGuard(tokenService, usersService);
    const { context } = createContext({});

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    expect(tokenService.verifyAccessToken).not.toHaveBeenCalled();
  });

  it('rejects a header without the Bearer prefix', async () => {
    const tokenService = { verifyAccessToken: vi.fn() } as unknown as TokenService;
    const usersService = { findById: vi.fn() } as unknown as UsersService;
    const guard = new JwtAuthGuard(tokenService, usersService);
    const { context } = createContext({ authorization: 'Basic abc123' });

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects an invalid/expired token', async () => {
    const tokenService = {
      verifyAccessToken: vi.fn().mockImplementation(() => {
        throw new Error('jwt expired');
      }),
    } as unknown as TokenService;
    const usersService = { findById: vi.fn() } as unknown as UsersService;
    const guard = new JwtAuthGuard(tokenService, usersService);
    const { context } = createContext({ authorization: 'Bearer bad.token.value' });

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    expect(usersService.findById).not.toHaveBeenCalled();
  });

  it('rejects a valid token whose user no longer exists', async () => {
    const tokenService = {
      verifyAccessToken: vi
        .fn()
        .mockReturnValue({ sub: 'u-1', email: 'a@example.com', role: 'user' }),
    } as unknown as TokenService;
    const usersService = { findById: vi.fn().mockResolvedValue(null) } as unknown as UsersService;
    const guard = new JwtAuthGuard(tokenService, usersService);
    const { context } = createContext({ authorization: 'Bearer good.token.value' });

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a valid token whose user has been deactivated', async () => {
    const deactivatedUser = {
      id: 'u-1',
      email: 'a@example.com',
      deactivatedAt: new Date('2026-01-01T00:00:00.000Z'),
    } as User;
    const tokenService = {
      verifyAccessToken: vi
        .fn()
        .mockReturnValue({ sub: 'u-1', email: 'a@example.com', role: 'user' }),
    } as unknown as TokenService;
    const usersService = {
      findById: vi.fn().mockResolvedValue(deactivatedUser),
    } as unknown as UsersService;
    const guard = new JwtAuthGuard(tokenService, usersService);
    const { context } = createContext({ authorization: 'Bearer good.token.value' });

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('attaches the fresh DB user to request.user for a valid token', async () => {
    const user = { id: 'u-1', email: 'a@example.com' } as User;
    const tokenService = {
      verifyAccessToken: vi
        .fn()
        .mockReturnValue({ sub: 'u-1', email: 'a@example.com', role: 'user' }),
    } as unknown as TokenService;
    const usersService = { findById: vi.fn().mockResolvedValue(user) } as unknown as UsersService;
    const guard = new JwtAuthGuard(tokenService, usersService);
    const { context, request } = createContext({ authorization: 'Bearer good.token.value' });

    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(request.user).toBe(user);
    expect(usersService.findById).toHaveBeenCalledWith('u-1');
  });

  it('ignores an x-user-email header entirely — it is not a recognized credential in jwt mode', async () => {
    const tokenService = { verifyAccessToken: vi.fn() } as unknown as TokenService;
    const usersService = { findById: vi.fn() } as unknown as UsersService;
    const guard = new JwtAuthGuard(tokenService, usersService);
    const { context } = createContext({ 'x-user-email': 'attacker@example.com' });

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    expect(usersService.findById).not.toHaveBeenCalled();
  });
});
