import { ConflictException, NotFoundException } from '@nestjs/common';
import type { ChildProfile } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockPrisma } from '../common/test-utils/mock-prisma';
import { ChildProfilesService, MAX_ACTIVE_CHILD_PROFILES } from './child-profiles.service';

function makeProfile(overrides: Partial<ChildProfile> = {}): ChildProfile {
  return {
    id: 'profile-1',
    userId: 'user-1',
    name: 'Mia',
    nickname: null,
    age: 5,
    pronouns: 'they_them',
    avatarConfig: null,
    photoAssetId: null,
    birthday: null,
    deletedAt: null,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-02T00:00:00.000Z'),
    ...overrides,
  } as ChildProfile;
}

describe('ChildProfilesService', () => {
  const prisma = createMockPrisma();
  const service = new ChildProfilesService(prisma as never);

  beforeEach(() => vi.clearAllMocks());

  it('creates with the authenticated owner and returns only the safe projection', async () => {
    prisma.childProfile.count.mockResolvedValue(0);
    prisma.childProfile.create.mockResolvedValue(
      makeProfile({ photoAssetId: 'internal-upload-id', avatarConfig: { private: true } }),
    );

    const result = await service.create('user-1', { name: 'Mia', age: 5 });

    expect(prisma.childProfile.create).toHaveBeenCalledWith({
      data: { userId: 'user-1', name: 'Mia', age: 5 },
    });
    expect(result).toEqual({
      id: 'profile-1',
      name: 'Mia',
      age: 5,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-02T00:00:00.000Z',
    });
    expect(result).not.toHaveProperty('photoAssetId');
    expect(result).not.toHaveProperty('userId');
  });

  it('enforces the active-profile cap', async () => {
    prisma.childProfile.count.mockResolvedValue(MAX_ACTIVE_CHILD_PROFILES);
    await expect(service.create('user-1', { name: 'Mia', age: 5 })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.childProfile.create).not.toHaveBeenCalled();
  });

  it('lists only active owned profiles with bounded pagination', async () => {
    prisma.childProfile.count.mockResolvedValue(1);
    prisma.childProfile.findMany.mockResolvedValue([makeProfile()]);

    const page = await service.findAllForUser('user-1', 0, 999);

    expect(prisma.childProfile.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', deletedAt: null },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      skip: 0,
      take: 20,
    });
    expect(page).toMatchObject({ page: 1, limit: 20, total: 1 });
  });

  it('uses the same not-found result for a missing, deleted, or foreign profile', async () => {
    prisma.childProfile.findFirst.mockResolvedValue(null);
    await expect(service.findOneForUser('profile-1', 'user-2')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.childProfile.findFirst).toHaveBeenCalledWith({
      where: { id: 'profile-1', userId: 'user-2', deletedAt: null },
    });
  });

  it('updates only an active owned row', async () => {
    prisma.childProfile.findFirst
      .mockResolvedValueOnce(makeProfile())
      .mockResolvedValueOnce(makeProfile({ name: 'Mila', age: 6 }));
    prisma.childProfile.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.update('profile-1', 'user-1', { name: 'Mila', age: 6 });

    expect(prisma.childProfile.updateMany).toHaveBeenCalledWith({
      where: { id: 'profile-1', userId: 'user-1', deletedAt: null },
      data: { name: 'Mila', age: 6 },
    });
    expect(result).toMatchObject({ name: 'Mila', age: 6 });
  });

  it('soft-deletes without touching books', async () => {
    prisma.childProfile.updateMany.mockResolvedValue({ count: 1 });
    await service.remove('profile-1', 'user-1');
    expect(prisma.childProfile.updateMany).toHaveBeenCalledWith({
      where: { id: 'profile-1', userId: 'user-1', deletedAt: null },
      data: { deletedAt: expect.any(Date) },
    });
    expect(prisma.book.updateMany).not.toHaveBeenCalled();
    expect(prisma.book.deleteMany).not.toHaveBeenCalled();
  });
});
