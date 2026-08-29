import { NotFoundException } from '@nestjs/common';
import type { Book, ChildProfile } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockPrisma } from '../common/test-utils/mock-prisma';
import { BookCrudService } from './book-crud.service';

function makeBook(overrides: Partial<Book> = {}): Book {
  return {
    id: 'book-1',
    userId: 'user-1',
    childProfileId: null,
    status: 'created',
    title: "Mia's Story",
    childName: 'Mia',
    childAge: 5,
    language: 'en',
    theme: 'friendship',
    educationalMessage: null,
    pageCount: 6,
    deletedAt: null,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    ...overrides,
  } as unknown as Book;
}

function makeProfile(): ChildProfile {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    userId: 'user-1',
    name: 'Saved Mia',
    age: 7,
    deletedAt: null,
  } as ChildProfile;
}

describe('BookCrudService child-profile integration', () => {
  const prisma = createMockPrisma();
  const service = new BookCrudService(prisma as never);

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.$transaction.mockImplementation((callback: (tx: typeof prisma) => unknown) =>
      callback(prisma),
    );
  });

  it('keeps one-off book creation backward compatible', async () => {
    prisma.book.create.mockResolvedValue(makeBook());
    await service.create('user-1', {
      title: "Mia's Story",
      childName: 'Mia',
      childAge: 5,
      theme: 'friendship',
    });
    expect(prisma.childProfile.findFirst).not.toHaveBeenCalled();
    expect(prisma.book.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ childName: 'Mia', childAge: 5 }),
    });
  });

  it('copies owned active profile values and persists the relation on create', async () => {
    const profile = makeProfile();
    prisma.childProfile.findFirst.mockResolvedValue(profile);
    prisma.book.create.mockResolvedValue(
      makeBook({ childProfileId: profile.id, childName: profile.name, childAge: profile.age }),
    );

    const result = await service.create('user-1', {
      childProfileId: profile.id,
      title: "Mia's Story",
      childName: 'client value is ignored',
      childAge: 1,
      theme: 'friendship',
    });

    expect(prisma.childProfile.findFirst).toHaveBeenCalledWith({
      where: { id: profile.id, userId: 'user-1', deletedAt: null },
    });
    expect(prisma.book.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        childProfileId: profile.id,
        childName: 'Saved Mia',
        childAge: 7,
      }),
    });
    expect(result.childProfileId).toBe(profile.id);
  });

  it('rejects a deleted or foreign profile without leaking its existence', async () => {
    prisma.childProfile.findFirst.mockResolvedValue(null);
    await expect(
      service.create('user-1', {
        childProfileId: makeProfile().id,
        title: "Mia's Story",
        childName: 'Mia',
        childAge: 5,
        theme: 'friendship',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.book.create).not.toHaveBeenCalled();
  });

  it('reapplies current profile values only when the profile is explicitly selected on update', async () => {
    const profile = makeProfile();
    prisma.book.findFirst
      .mockResolvedValueOnce(makeBook({ childName: 'Old snapshot', childAge: 5 }))
      .mockResolvedValueOnce(
        makeBook({ childProfileId: profile.id, childName: profile.name, childAge: profile.age }),
      );
    prisma.childProfile.findFirst.mockResolvedValue(profile);
    prisma.book.updateMany.mockResolvedValue({ count: 1 });

    await service.update('book-1', 'user-1', {
      childProfileId: profile.id,
      childName: 'stale client copy',
      childAge: 5,
    });

    expect(prisma.book.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: 'book-1', userId: 'user-1' }),
      data: expect.objectContaining({
        childProfileId: profile.id,
        childName: profile.name,
        childAge: profile.age,
      }),
    });
  });

  it('explicit null switches to manual details', async () => {
    prisma.book.findFirst
      .mockResolvedValueOnce(makeBook({ childProfileId: makeProfile().id }))
      .mockResolvedValueOnce(makeBook({ childName: 'Manual Mia', childAge: 6 }));
    prisma.book.updateMany.mockResolvedValue({ count: 1 });

    await service.update('book-1', 'user-1', {
      childProfileId: null,
      childName: 'Manual Mia',
      childAge: 6,
    });

    expect(prisma.childProfile.findFirst).not.toHaveBeenCalled();
    expect(prisma.book.updateMany).toHaveBeenCalledWith({
      where: expect.any(Object),
      data: expect.objectContaining({ childProfileId: null, childName: 'Manual Mia', childAge: 6 }),
    });
  });
});
