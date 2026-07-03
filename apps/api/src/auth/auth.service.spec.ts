import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as bcrypt from 'bcryptjs';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import type { User } from '@prisma/client';
import { AuthService } from './auth.service';
import type { UsersService } from '../users/users.service';
import type { TokenService } from './token.service';
import { createMockPrisma } from '../common/test-utils/mock-prisma';

type Mock = ReturnType<typeof vi.fn>;
type MockPrisma = ReturnType<typeof createMockPrisma>;

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'u-1',
    email: 'alice@example.com',
    passwordHash: null,
    name: null,
    locale: 'en',
    timezone: 'UTC',
    avatarUrl: null,
    oauthProvider: null,
    oauthId: null,
    plan: 'free' as User['plan'],
    credits: 3,
    creditsUpdatedAt: null,
    role: 'user' as User['role'],
    emailVerified: false,
    deactivatedAt: null,
    notifyEmailOnCompletion: true,
    notifyEmailMarketing: false,
    notifyPushOnCompletion: true,
    notifyBirthdayReminders: true,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

describe('AuthService', () => {
  let prisma: MockPrisma;
  let usersService: UsersService;
  let tokenService: TokenService;
  let service: AuthService;

  beforeEach(() => {
    prisma = createMockPrisma();
    usersService = {
      findByEmail: vi.fn(),
      findById: vi.fn(),
      create: vi.fn(),
    } as unknown as UsersService;
    tokenService = {
      signAccessToken: vi.fn().mockReturnValue('access-token'),
      generateRefreshToken: vi.fn().mockReturnValue({
        raw: 'raw-refresh',
        hash: 'hashed-refresh',
        family: 'family-1',
        expiresAt: new Date('2026-01-08'),
      }),
      hashRefreshToken: vi.fn().mockReturnValue('hashed-refresh'),
    } as unknown as TokenService;
    service = new AuthService(prisma as never, usersService, tokenService);
  });

  describe('register', () => {
    it('creates the user with a bcrypt hash, never the plaintext password', async () => {
      (usersService.findByEmail as Mock).mockResolvedValue(null);
      (usersService.create as Mock).mockResolvedValue(makeUser());
      prisma.refreshToken.create.mockResolvedValue({});

      await service.register('alice@example.com', 'Password1', 'Alice');

      const createArg = (usersService.create as Mock).mock.calls[0][0];
      expect(createArg.passwordHash).not.toBe('Password1');
      expect(await bcrypt.compare('Password1', createArg.passwordHash)).toBe(true);
    });

    it('rejects duplicate email registration with 409 ConflictException', async () => {
      (usersService.findByEmail as Mock).mockResolvedValue(makeUser());

      await expect(service.register('alice@example.com', 'Password1')).rejects.toThrow(
        ConflictException,
      );
      expect(usersService.create).not.toHaveBeenCalled();
    });

    it('issues an access token and persists a refresh token record on success', async () => {
      (usersService.findByEmail as Mock).mockResolvedValue(null);
      const created = makeUser();
      (usersService.create as Mock).mockResolvedValue(created);
      prisma.refreshToken.create.mockResolvedValue({});

      const result = await service.register('alice@example.com', 'Password1');

      expect(result.accessToken).toBe('access-token');
      expect(result.refreshToken).toBe('raw-refresh');
      expect(prisma.refreshToken.create).toHaveBeenCalledWith({
        data: {
          userId: created.id,
          tokenHash: 'hashed-refresh',
          family: 'family-1',
          expiresAt: new Date('2026-01-08'),
        },
      });
    });
  });

  describe('login', () => {
    it('succeeds and issues tokens for correct credentials', async () => {
      const passwordHash = await bcrypt.hash('Password1', 4);
      (usersService.findByEmail as Mock).mockResolvedValue(makeUser({ passwordHash }));
      prisma.refreshToken.create.mockResolvedValue({});

      const result = await service.login('alice@example.com', 'Password1');

      expect(result.accessToken).toBe('access-token');
      expect(result.refreshToken).toBe('raw-refresh');
    });

    it('rejects an unknown email and a wrong password with the identical generic message', async () => {
      const passwordHash = await bcrypt.hash('Password1', 4);

      (usersService.findByEmail as Mock).mockResolvedValueOnce(null);
      let unknownEmailMessage = '';
      try {
        await service.login('nobody@example.com', 'whatever');
      } catch (err) {
        unknownEmailMessage = (err as UnauthorizedException).message;
      }

      (usersService.findByEmail as Mock).mockResolvedValueOnce(makeUser({ passwordHash }));
      let wrongPasswordMessage = '';
      try {
        await service.login('alice@example.com', 'WrongPassword1');
      } catch (err) {
        wrongPasswordMessage = (err as UnauthorizedException).message;
      }

      expect(unknownEmailMessage.length).toBeGreaterThan(0);
      expect(unknownEmailMessage).toBe(wrongPasswordMessage);
    });

    it('rejects login for an account with no password hash (never crashes on bcrypt.compare(null))', async () => {
      (usersService.findByEmail as Mock).mockResolvedValue(makeUser({ passwordHash: null }));

      await expect(service.login('alice@example.com', 'Password1')).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('refresh', () => {
    it('rotates: revokes the presented token and issues a new one in the same family', async () => {
      const record = {
        id: 'rt-1',
        userId: 'u-1',
        tokenHash: 'hashed-refresh',
        family: 'family-1',
        expiresAt: new Date(Date.now() + 100_000),
        revokedAt: null,
      };
      prisma.refreshToken.findUnique.mockResolvedValue(record);
      (usersService.findById as Mock).mockResolvedValue(makeUser());
      prisma.refreshToken.update.mockResolvedValue({});
      prisma.refreshToken.create.mockResolvedValue({});

      const result = await service.refresh('raw-refresh');

      expect(prisma.refreshToken.update).toHaveBeenCalledWith({
        where: { id: 'rt-1' },
        data: { revokedAt: expect.any(Date) },
      });
      expect(tokenService.generateRefreshToken).toHaveBeenCalledWith('family-1');
      expect(result.accessToken).toBe('access-token');
    });

    it('rejects reuse of an already-revoked token and revokes the whole family', async () => {
      const record = {
        id: 'rt-1',
        userId: 'u-1',
        tokenHash: 'hashed-refresh',
        family: 'family-1',
        expiresAt: new Date(Date.now() + 100_000),
        revokedAt: new Date(),
      };
      prisma.refreshToken.findUnique.mockResolvedValue(record);
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 2 });

      await expect(service.refresh('raw-refresh')).rejects.toThrow(UnauthorizedException);
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { family: 'family-1', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it('rejects an expired refresh token', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue({
        id: 'rt-1',
        userId: 'u-1',
        tokenHash: 'hashed-refresh',
        family: 'family-1',
        expiresAt: new Date(Date.now() - 1000),
        revokedAt: null,
      });

      await expect(service.refresh('raw-refresh')).rejects.toThrow(UnauthorizedException);
    });

    it('rejects an unknown refresh token', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(null);

      await expect(service.refresh('raw-refresh')).rejects.toThrow(UnauthorizedException);
    });

    it('rejects when no refresh token cookie is present', async () => {
      await expect(service.refresh(undefined)).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('logout', () => {
    it('revokes the matching non-revoked refresh token', async () => {
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });

      await service.logout('raw-refresh');

      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { tokenHash: 'hashed-refresh', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it('does nothing when there is no refresh token cookie', async () => {
      await service.logout(undefined);

      expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
    });
  });
});
