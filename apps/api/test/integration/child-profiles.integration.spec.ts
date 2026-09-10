import { randomUUID } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import { GenerationRunKind, GenerationRunStatus } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildInputSnapshot, hashInputSnapshot } from '../../src/agent/generation-input-snapshot';
import { BookCrudService } from '../../src/books/book-crud.service';
import { ChildProfilesService } from '../../src/child-profiles/child-profiles.service';
import { PrismaService } from '../../src/database/prisma.service';

describe('Child profiles and immutable book/run snapshots (real Postgres)', () => {
  const prisma = new PrismaService();
  const profiles = new ChildProfilesService(prisma);
  const books = new BookCrudService(prisma);
  const userIds: string[] = [];

  beforeAll(async () => prisma.$connect());
  afterAll(async () => prisma.$disconnect());

  afterEach(async () => {
    if (userIds.length === 0) return;
    await prisma.book.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.childProfile.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    userIds.length = 0;
  });

  async function createUser(): Promise<string> {
    const user = await prisma.user.create({
      data: { email: `profiles-${randomUUID()}@example.test` },
    });
    userIds.push(user.id);
    return user.id;
  }

  it('creates, lists, reads, updates, and soft-deletes only the authenticated owner profile', async () => {
    const ownerId = await createUser();
    const otherId = await createUser();
    const created = await profiles.create(ownerId, { name: '  Mia  ', age: 5 });

    expect(created).toMatchObject({ name: 'Mia', age: 5 });
    expect((await profiles.findAllForUser(ownerId, 1, 20)).items).toHaveLength(1);
    expect(await profiles.findOneForUser(created.id, ownerId)).toMatchObject({ id: created.id });
    await expect(profiles.findOneForUser(created.id, otherId)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    const updated = await profiles.update(created.id, ownerId, { name: 'Mila', age: 6 });
    expect(updated).toMatchObject({ name: 'Mila', age: 6 });
    await expect(profiles.update(created.id, otherId, { age: 7 })).rejects.toBeInstanceOf(
      NotFoundException,
    );

    await profiles.remove(created.id, ownerId);
    expect((await profiles.findAllForUser(ownerId, 1, 20)).items).toHaveLength(0);
    await expect(profiles.findOneForUser(created.id, ownerId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('copies selected values into Book and preserves Book/run/retry snapshots across profile changes', async () => {
    const userId = await createUser();
    const profile = await profiles.create(userId, { name: 'Mia', age: 5 });
    const created = await books.create(userId, {
      childProfileId: profile.id,
      title: "Mia's Story",
      childName: 'ignored client name',
      childAge: 1,
      theme: 'friendship',
    });
    expect(created).toMatchObject({ childProfileId: profile.id, childName: 'Mia', childAge: 5 });

    const bookRow = await prisma.book.findUniqueOrThrow({ where: { id: created.id } });
    const originalSnapshot = buildInputSnapshot(bookRow);
    const originalHash = hashInputSnapshot(originalSnapshot);
    const firstRun = await prisma.generationRun.create({
      data: {
        bookId: bookRow.id,
        userId,
        kind: GenerationRunKind.initial,
        status: GenerationRunStatus.failed,
        inputSnapshot: originalSnapshot as unknown as Prisma.InputJsonValue,
        inputHash: originalHash,
        failedAt: new Date(),
      },
    });

    await profiles.update(profile.id, userId, { name: 'Mila', age: 7 });
    const unchangedBook = await prisma.book.findUniqueOrThrow({ where: { id: created.id } });
    expect(unchangedBook).toMatchObject({ childName: 'Mia', childAge: 5 });
    const unchangedRun = await prisma.generationRun.findUniqueOrThrow({
      where: { id: firstRun.id },
    });
    expect(unchangedRun.inputSnapshot).toEqual(originalSnapshot);
    expect(unchangedRun.inputHash).toBe(originalHash);

    const reapplied = await books.update(created.id, userId, { childProfileId: profile.id });
    expect(reapplied).toMatchObject({ childName: 'Mila', childAge: 7 });

    const retryRun = await prisma.generationRun.create({
      data: {
        bookId: created.id,
        userId,
        kind: GenerationRunKind.retry,
        retryOfRunId: firstRun.id,
        inputSnapshot: unchangedRun.inputSnapshot as Prisma.InputJsonValue,
        inputHash: unchangedRun.inputHash,
      },
    });
    expect(retryRun.inputSnapshot).toEqual(originalSnapshot);

    await profiles.remove(profile.id, userId);
    const preservedBook = await prisma.book.findUniqueOrThrow({ where: { id: created.id } });
    expect(preservedBook).toMatchObject({
      childProfileId: profile.id,
      childName: 'Mila',
      childAge: 7,
    });
    expect(await prisma.generationRun.findUnique({ where: { id: firstRun.id } })).not.toBeNull();
  });

  it('keeps the manual one-off path profile-free', async () => {
    const userId = await createUser();
    const created = await books.create(userId, {
      title: "Noah's Story",
      childName: 'Noah',
      childAge: 4,
      theme: 'kindness',
    });
    expect(created).toMatchObject({ childProfileId: null, childName: 'Noah', childAge: 4 });
  });
});
