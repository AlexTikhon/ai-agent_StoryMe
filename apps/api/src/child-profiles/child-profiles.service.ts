import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { ChildProfile } from '@prisma/client';
import type { ChildProfileDto, ChildProfilesPageDto } from '@book/types';
import { PrismaService } from '../database/prisma.service';
import type { CreateChildProfileDto } from './dto/create-child-profile.dto';
import type { UpdateChildProfileDto } from './dto/update-child-profile.dto';

export const MAX_ACTIVE_CHILD_PROFILES = 20;

function toChildProfileDto(profile: ChildProfile): ChildProfileDto {
  return {
    id: profile.id,
    name: profile.name,
    age: profile.age,
    createdAt: profile.createdAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString(),
  };
}

@Injectable()
export class ChildProfilesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAllForUser(userId: string, page: number, limit: number): Promise<ChildProfilesPageDto> {
    const safeLimit = Math.min(Math.max(1, limit), MAX_ACTIVE_CHILD_PROFILES);
    const safePage = Math.max(1, page);
    const where = { userId, deletedAt: null } as const;
    const [total, profiles] = await Promise.all([
      this.prisma.childProfile.count({ where }),
      this.prisma.childProfile.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
      }),
    ]);
    return { items: profiles.map(toChildProfileDto), page: safePage, limit: safeLimit, total };
  }

  async create(userId: string, dto: CreateChildProfileDto): Promise<ChildProfileDto> {
    const activeCount = await this.prisma.childProfile.count({
      where: { userId, deletedAt: null },
    });
    if (activeCount >= MAX_ACTIVE_CHILD_PROFILES) {
      throw new ConflictException(
        `A maximum of ${MAX_ACTIVE_CHILD_PROFILES} child profiles is allowed`,
      );
    }
    return toChildProfileDto(
      await this.prisma.childProfile.create({
        data: { userId, name: dto.name.trim(), age: dto.age },
      }),
    );
  }

  async findOneForUser(id: string, userId: string): Promise<ChildProfileDto> {
    return toChildProfileDto(await this.findOwnedActiveOrThrow(id, userId));
  }

  async update(id: string, userId: string, dto: UpdateChildProfileDto): Promise<ChildProfileDto> {
    await this.findOwnedActiveOrThrow(id, userId);
    const result = await this.prisma.childProfile.updateMany({
      where: { id, userId, deletedAt: null },
      data: {
        ...dto,
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
      },
    });
    if (result.count === 0) throw new NotFoundException('Child profile not found');
    return toChildProfileDto(await this.findOwnedActiveOrThrow(id, userId));
  }

  async remove(id: string, userId: string): Promise<void> {
    const result = await this.prisma.childProfile.updateMany({
      where: { id, userId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (result.count === 0) throw new NotFoundException('Child profile not found');
  }

  /** Missing, deleted, and differently-owned profiles deliberately share the same 404. */
  async findOwnedActiveOrThrow(id: string, userId: string): Promise<ChildProfile> {
    const profile = await this.prisma.childProfile.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!profile) throw new NotFoundException('Child profile not found');
    return profile;
  }
}
