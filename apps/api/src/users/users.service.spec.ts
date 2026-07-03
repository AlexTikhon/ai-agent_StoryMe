import { describe, it, expect, beforeEach } from 'vitest';
import type { User } from '@prisma/client';
import { UsersService } from './users.service';
import { createMockPrisma } from '../common/test-utils/mock-prisma';

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
    emailVerifiedAt: null,
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

describe('UsersService', () => {
  let service: UsersService;
  let prisma: MockPrisma;

  beforeEach(() => {
    prisma = createMockPrisma();
    service = new UsersService(prisma as never);
  });

  describe('findOrCreateByEmail', () => {
    it('returns existing user without creating one', async () => {
      const existing = makeUser({ email: 'alice@example.com' });
      prisma.user.findUnique.mockResolvedValue(existing);

      const result = await service.findOrCreateByEmail('alice@example.com');

      expect(result).toBe(existing);
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('creates and returns a new user when not found', async () => {
      const created = makeUser({ id: 'u-2', email: 'new@example.com' });
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue(created);

      const result = await service.findOrCreateByEmail('new@example.com');

      expect(prisma.user.create).toHaveBeenCalledWith({
        data: { email: 'new@example.com', name: null },
      });
      expect(result).toBe(created);
    });

    it('passes the optional name to create', async () => {
      const created = makeUser({ email: 'named@example.com', name: 'Bob' });
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue(created);

      await service.findOrCreateByEmail('named@example.com', 'Bob');

      expect(prisma.user.create).toHaveBeenCalledWith({
        data: { email: 'named@example.com', name: 'Bob' },
      });
    });
  });

  describe('findByEmail', () => {
    it('returns null without creating a user when none exists', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      const result = await service.findByEmail('nobody@example.com');

      expect(result).toBeNull();
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('returns the existing user', async () => {
      const existing = makeUser({ email: 'alice@example.com' });
      prisma.user.findUnique.mockResolvedValue(existing);

      const result = await service.findByEmail('alice@example.com');

      expect(result).toBe(existing);
    });
  });

  describe('findById', () => {
    it('returns the user matching the id', async () => {
      const existing = makeUser({ id: 'u-9' });
      prisma.user.findUnique.mockResolvedValue(existing);

      const result = await service.findById('u-9');

      expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: 'u-9' } });
      expect(result).toBe(existing);
    });

    it('returns null when no user matches', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      const result = await service.findById('missing');

      expect(result).toBeNull();
    });
  });

  describe('create', () => {
    it('creates a password-auth user with the given passwordHash', async () => {
      const created = makeUser({ email: 'new@example.com', passwordHash: 'hashed' });
      prisma.user.create.mockResolvedValue(created);

      const result = await service.create({ email: 'new@example.com', passwordHash: 'hashed' });

      expect(prisma.user.create).toHaveBeenCalledWith({
        data: { email: 'new@example.com', passwordHash: 'hashed', name: null },
      });
      expect(result).toBe(created);
    });

    it('passes the optional name through', async () => {
      prisma.user.create.mockResolvedValue(makeUser());

      await service.create({ email: 'new@example.com', passwordHash: 'hashed', name: 'Bob' });

      expect(prisma.user.create).toHaveBeenCalledWith({
        data: { email: 'new@example.com', passwordHash: 'hashed', name: 'Bob' },
      });
    });

    it('passes the optional email verification token hash and expiry through', async () => {
      prisma.user.create.mockResolvedValue(makeUser());
      const emailVerificationExpiresAt = new Date('2026-01-02');

      await service.create({
        email: 'new@example.com',
        passwordHash: 'hashed',
        emailVerificationTokenHash: 'hashed-token',
        emailVerificationExpiresAt,
      });

      expect(prisma.user.create).toHaveBeenCalledWith({
        data: {
          email: 'new@example.com',
          passwordHash: 'hashed',
          name: null,
          emailVerificationTokenHash: 'hashed-token',
          emailVerificationExpiresAt,
        },
      });
    });
  });
});
