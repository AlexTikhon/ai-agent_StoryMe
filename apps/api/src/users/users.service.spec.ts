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
});
