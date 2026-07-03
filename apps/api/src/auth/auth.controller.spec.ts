import { describe, it, expect, vi } from 'vitest';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import type { User } from '@prisma/client';
import { UserRole } from '@book/types';
import type { Env } from '../config/env.schema';
import { AuthController } from './auth.controller';
import { AuthRateLimitGuard } from './auth-rate-limit.guard';
import type { AuthService } from './auth.service';
import { REFRESH_COOKIE_NAME } from './refresh-cookie';

const USER = {
  id: 'u-1',
  email: 'alice@example.com',
  name: 'Alice',
  role: 'user',
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
} as unknown as User;

function createConfig(nodeEnv: Env['NODE_ENV'] = 'development'): ConfigService<Env, true> {
  return { get: () => nodeEnv } as unknown as ConfigService<Env, true>;
}

function createResponse(): Response {
  return { cookie: vi.fn(), clearCookie: vi.fn() } as unknown as Response;
}

describe('AuthController', () => {
  describe('register', () => {
    it('returns the access token + user and sets the refresh cookie', async () => {
      const authService = {
        register: vi.fn().mockResolvedValue({
          user: USER,
          accessToken: 'access-token',
          refreshToken: 'raw-refresh',
          refreshTokenExpiresAt: new Date(),
        }),
      } as unknown as AuthService;
      const controller = new AuthController(authService, createConfig());
      const res = createResponse();

      const result = await controller.register(
        { email: 'alice@example.com', password: 'Password1', name: 'Alice' },
        res,
      );

      expect(authService.register).toHaveBeenCalledWith('alice@example.com', 'Password1', 'Alice');
      expect(result).toEqual({
        accessToken: 'access-token',
        user: {
          id: 'u-1',
          email: 'alice@example.com',
          name: 'Alice',
          role: UserRole.User,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      });
      expect(res.cookie).toHaveBeenCalledWith(
        REFRESH_COOKIE_NAME,
        'raw-refresh',
        expect.objectContaining({ httpOnly: true, path: '/api/auth' }),
      );
    });
  });

  describe('login', () => {
    it('returns the access token + user and sets the refresh cookie', async () => {
      const authService = {
        login: vi.fn().mockResolvedValue({
          user: USER,
          accessToken: 'access-token',
          refreshToken: 'raw-refresh',
          refreshTokenExpiresAt: new Date(),
        }),
      } as unknown as AuthService;
      const controller = new AuthController(authService, createConfig());
      const res = createResponse();

      const result = await controller.login(
        { email: 'alice@example.com', password: 'Password1' },
        res,
      );

      expect(authService.login).toHaveBeenCalledWith('alice@example.com', 'Password1');
      expect(result.accessToken).toBe('access-token');
      expect(res.cookie).toHaveBeenCalled();
    });
  });

  describe('refresh', () => {
    it('reads the refresh cookie from the request and rotates it', async () => {
      const authService = {
        refresh: vi.fn().mockResolvedValue({
          user: USER,
          accessToken: 'new-access-token',
          refreshToken: 'new-raw-refresh',
          refreshTokenExpiresAt: new Date(),
        }),
      } as unknown as AuthService;
      const controller = new AuthController(authService, createConfig());
      const res = createResponse();
      const req = { cookies: { [REFRESH_COOKIE_NAME]: 'old-raw-refresh' } } as unknown as Request;

      const result = await controller.refresh(req, res);

      expect(authService.refresh).toHaveBeenCalledWith('old-raw-refresh');
      expect(result.accessToken).toBe('new-access-token');
      expect(res.cookie).toHaveBeenCalledWith(
        REFRESH_COOKIE_NAME,
        'new-raw-refresh',
        expect.any(Object),
      );
    });

    it('propagates a rejection (e.g. missing/invalid/reused cookie) without setting a cookie', async () => {
      const authService = {
        refresh: vi.fn().mockRejectedValue(new Error('Invalid refresh token')),
      } as unknown as AuthService;
      const controller = new AuthController(authService, createConfig());
      const res = createResponse();
      const req = { cookies: {} } as unknown as Request;

      await expect(controller.refresh(req, res)).rejects.toThrow('Invalid refresh token');
      expect(res.cookie).not.toHaveBeenCalled();
    });
  });

  describe('logout', () => {
    it('revokes the refresh token and clears the cookie', async () => {
      const authService = {
        logout: vi.fn().mockResolvedValue(undefined),
      } as unknown as AuthService;
      const controller = new AuthController(authService, createConfig());
      const res = createResponse();
      const req = { cookies: { [REFRESH_COOKIE_NAME]: 'raw-refresh' } } as unknown as Request;

      await controller.logout(req, res);

      expect(authService.logout).toHaveBeenCalledWith('raw-refresh');
      expect(res.clearCookie).toHaveBeenCalledWith(REFRESH_COOKIE_NAME, { path: '/api/auth' });
    });
  });

  describe('AuthRateLimitGuard wiring', () => {
    it.each(['register', 'login', 'refresh', 'logout'] as const)(
      'applies AuthRateLimitGuard to %s',
      (method) => {
        const guards: unknown[] =
          Reflect.getMetadata(GUARDS_METADATA, AuthController.prototype[method]) ?? [];
        expect(guards).toContain(AuthRateLimitGuard);
      },
    );

    it('does not apply AuthRateLimitGuard to getMe (not a brute-force target)', () => {
      const guards: unknown[] =
        Reflect.getMetadata(GUARDS_METADATA, AuthController.prototype.getMe) ?? [];
      expect(guards).not.toContain(AuthRateLimitGuard);
    });
  });

  describe('getMe', () => {
    it('returns the current user as a DTO', () => {
      const authService = {} as unknown as AuthService;
      const controller = new AuthController(authService, createConfig());

      const result = controller.getMe(USER);

      expect(result.id).toBe('u-1');
      expect(result.email).toBe('alice@example.com');
    });
  });
});
