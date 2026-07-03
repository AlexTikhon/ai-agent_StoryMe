import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as bcrypt from 'bcryptjs';
import { BadRequestException, ConflictException, UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { User } from '@prisma/client';
import type { Env } from '../config/env.schema';
import type { EmailService } from '../email/email.service';
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
    // Verified by default so existing login/refresh/logout tests, which
    // predate email verification, keep testing "valid session" behavior
    // rather than incidentally tripping the new EMAIL_NOT_VERIFIED gate.
    emailVerified: true,
    emailVerifiedAt: new Date('2026-01-01'),
    emailVerificationTokenHash: null,
    emailVerificationExpiresAt: null,
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
  let emailService: EmailService;
  let config: ConfigService<Env, true>;
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
      generateEmailVerificationToken: vi.fn().mockReturnValue({
        raw: 'raw-verification-token',
        hash: 'hashed-verification-token',
        expiresAt: new Date('2026-01-02'),
      }),
      hashEmailVerificationToken: vi.fn().mockReturnValue('hashed-verification-token'),
    } as unknown as TokenService;
    emailService = {
      sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
    } as unknown as EmailService;
    config = {
      get: vi.fn().mockReturnValue('http://localhost:3000'),
    } as unknown as ConfigService<Env, true>;
    service = new AuthService(prisma as never, usersService, tokenService, emailService, config);
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

    it('creates the user as unverified with only the token hash persisted, never the raw token', async () => {
      (usersService.findByEmail as Mock).mockResolvedValue(null);
      (usersService.create as Mock).mockResolvedValue(makeUser({ emailVerified: false }));
      prisma.refreshToken.create.mockResolvedValue({});

      await service.register('alice@example.com', 'Password1');

      const createArg = (usersService.create as Mock).mock.calls[0][0];
      expect(createArg.emailVerificationTokenHash).toBe('hashed-verification-token');
      expect(createArg.emailVerificationExpiresAt).toEqual(new Date('2026-01-02'));
      expect(createArg).not.toHaveProperty('rawToken');
      expect(JSON.stringify(createArg)).not.toContain('raw-verification-token');
    });

    it('sends the verification email with the raw token via EmailService', async () => {
      (usersService.findByEmail as Mock).mockResolvedValue(null);
      (usersService.create as Mock).mockResolvedValue(
        makeUser({ email: 'alice@example.com', name: 'Alice', emailVerified: false }),
      );
      prisma.refreshToken.create.mockResolvedValue({});

      await service.register('alice@example.com', 'Password1', 'Alice');

      expect(emailService.sendVerificationEmail).toHaveBeenCalledWith({
        to: 'alice@example.com',
        name: 'Alice',
        token: 'raw-verification-token',
        verificationUrl: 'http://localhost:3000/verify-email?token=raw-verification-token',
      });
    });

    it('still auto-signs the user in on success even though the account starts unverified', async () => {
      (usersService.findByEmail as Mock).mockResolvedValue(null);
      (usersService.create as Mock).mockResolvedValue(makeUser({ emailVerified: false }));
      prisma.refreshToken.create.mockResolvedValue({});

      const result = await service.register('alice@example.com', 'Password1');

      expect(result.accessToken).toBe('access-token');
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

    it('rejects a deactivated account with correct credentials, using the identical generic message', async () => {
      const passwordHash = await bcrypt.hash('Password1', 4);
      (usersService.findByEmail as Mock).mockResolvedValue(
        makeUser({ passwordHash, deactivatedAt: new Date('2026-01-01') }),
      );

      let deactivatedMessage = '';
      try {
        await service.login('alice@example.com', 'Password1');
      } catch (err) {
        deactivatedMessage = (err as UnauthorizedException).message;
      }

      expect(deactivatedMessage).toBe('Invalid email or password');
    });

    it('rejects login for an unverified account with the EMAIL_NOT_VERIFIED code', async () => {
      const passwordHash = await bcrypt.hash('Password1', 4);
      (usersService.findByEmail as Mock).mockResolvedValue(
        makeUser({ passwordHash, emailVerified: false }),
      );

      let caught: unknown;
      try {
        await service.login('alice@example.com', 'Password1');
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(UnauthorizedException);
      const response = (caught as UnauthorizedException).getResponse() as {
        error: string;
        code: string;
      };
      expect(response.code).toBe('EMAIL_NOT_VERIFIED');
      expect(response.error).toBe('Email is not verified');
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
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

    it('rejects refresh for a deactivated user, even with a valid unexpired token', async () => {
      const record = {
        id: 'rt-1',
        userId: 'u-1',
        tokenHash: 'hashed-refresh',
        family: 'family-1',
        expiresAt: new Date(Date.now() + 100_000),
        revokedAt: null,
      };
      prisma.refreshToken.findUnique.mockResolvedValue(record);
      (usersService.findById as Mock).mockResolvedValue(
        makeUser({ deactivatedAt: new Date('2026-01-01') }),
      );

      await expect(service.refresh('raw-refresh')).rejects.toThrow(UnauthorizedException);
      expect(prisma.refreshToken.update).not.toHaveBeenCalled();
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

  describe('verifyEmail', () => {
    it('verifies the user and clears the token hash/expiry for a valid token', async () => {
      const pending = makeUser({
        emailVerified: false,
        emailVerificationTokenHash: 'hashed-verification-token',
        emailVerificationExpiresAt: new Date(Date.now() + 100_000),
      });
      prisma.user.findFirst.mockResolvedValue(pending);
      prisma.user.update.mockResolvedValue({ ...pending, emailVerified: true });

      await service.verifyEmail('raw-verification-token');

      expect(tokenService.hashEmailVerificationToken).toHaveBeenCalledWith(
        'raw-verification-token',
      );
      expect(prisma.user.findFirst).toHaveBeenCalledWith({
        where: { emailVerificationTokenHash: 'hashed-verification-token' },
      });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: pending.id },
        data: {
          emailVerified: true,
          emailVerifiedAt: expect.any(Date),
          emailVerificationTokenHash: null,
          emailVerificationExpiresAt: null,
        },
      });
    });

    it('rejects an unknown token', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(service.verifyEmail('bogus-token')).rejects.toThrow(BadRequestException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('rejects an expired token', async () => {
      prisma.user.findFirst.mockResolvedValue(
        makeUser({
          emailVerified: false,
          emailVerificationTokenHash: 'hashed-verification-token',
          emailVerificationExpiresAt: new Date(Date.now() - 1000),
        }),
      );

      await expect(service.verifyEmail('raw-verification-token')).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('cannot be reused after a successful verification (hash already cleared)', async () => {
      // First call succeeds and clears the hash server-side; the second call
      // with the same raw token now finds no matching row.
      prisma.user.findFirst.mockResolvedValueOnce(
        makeUser({
          emailVerified: false,
          emailVerificationTokenHash: 'hashed-verification-token',
          emailVerificationExpiresAt: new Date(Date.now() + 100_000),
        }),
      );
      prisma.user.update.mockResolvedValue({});
      await service.verifyEmail('raw-verification-token');

      prisma.user.findFirst.mockResolvedValueOnce(null);
      await expect(service.verifyEmail('raw-verification-token')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('resendVerificationEmail', () => {
    it('issues a fresh token and invalidates the old one for an unverified account', async () => {
      const user = makeUser({
        emailVerified: false,
        emailVerificationTokenHash: 'old-hash',
        emailVerificationExpiresAt: new Date('2026-01-01'),
      });
      (usersService.findByEmail as Mock).mockResolvedValue(user);
      prisma.user.update.mockResolvedValue({});

      await service.resendVerificationEmail('alice@example.com');

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: user.id },
        data: {
          emailVerificationTokenHash: 'hashed-verification-token',
          emailVerificationExpiresAt: new Date('2026-01-02'),
        },
      });
      expect(emailService.sendVerificationEmail).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'alice@example.com', token: 'raw-verification-token' }),
      );
    });

    it('does not leak that the email is unknown', async () => {
      (usersService.findByEmail as Mock).mockResolvedValue(null);

      await service.resendVerificationEmail('nobody@example.com');

      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(emailService.sendVerificationEmail).not.toHaveBeenCalled();
    });

    it('does not leak that the account is already verified', async () => {
      (usersService.findByEmail as Mock).mockResolvedValue(makeUser({ emailVerified: true }));

      await service.resendVerificationEmail('alice@example.com');

      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(emailService.sendVerificationEmail).not.toHaveBeenCalled();
    });

    it('does not leak that the account is deactivated', async () => {
      (usersService.findByEmail as Mock).mockResolvedValue(
        makeUser({ emailVerified: false, deactivatedAt: new Date('2026-01-01') }),
      );

      await service.resendVerificationEmail('alice@example.com');

      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(emailService.sendVerificationEmail).not.toHaveBeenCalled();
    });
  });
});
