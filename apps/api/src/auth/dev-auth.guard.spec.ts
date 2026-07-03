import { describe, it, expect, vi } from 'vitest';
import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { User } from '@prisma/client';
import type { Env } from '../config/env.schema';
import type { UsersService } from '../users/users.service';
import { DevAuthGuard } from './dev-auth.guard';
import type { RequestWithUser } from './request-with-user';

function createConfig(nodeEnv: Env['NODE_ENV']): ConfigService<Env, true> {
  return { get: () => nodeEnv } as unknown as ConfigService<Env, true>;
}

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

describe('DevAuthGuard', () => {
  it('throws when NODE_ENV is production, before checking headers', async () => {
    const usersService = { findOrCreateByEmail: vi.fn() } as unknown as UsersService;
    const guard = new DevAuthGuard(usersService, createConfig('production'));
    const { context } = createContext({ 'x-user-email': 'a@example.com' });

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    expect(usersService.findOrCreateByEmail).not.toHaveBeenCalled();
  });

  it('rejects a missing x-user-email header outside production', async () => {
    const usersService = { findOrCreateByEmail: vi.fn() } as unknown as UsersService;
    const guard = new DevAuthGuard(usersService, createConfig('development'));
    const { context } = createContext({});

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a syntactically invalid x-user-email header', async () => {
    const usersService = { findOrCreateByEmail: vi.fn() } as unknown as UsersService;
    const guard = new DevAuthGuard(usersService, createConfig('development'));
    const { context } = createContext({ 'x-user-email': 'not-an-email' });

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('attaches the resolved user to request.user and allows the request through outside production', async () => {
    const user = { id: 'u-1', email: 'a@example.com' } as User;
    const usersService = {
      findOrCreateByEmail: vi.fn().mockResolvedValue(user),
    } as unknown as UsersService;
    const guard = new DevAuthGuard(usersService, createConfig('development'));
    const { context, request } = createContext({
      'x-user-email': 'a@example.com',
      'x-user-name': 'Alice',
    });

    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(request.user).toBe(user);
    expect(usersService.findOrCreateByEmail).toHaveBeenCalledWith('a@example.com', 'Alice');
  });
});
