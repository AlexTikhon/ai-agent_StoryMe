import { Injectable } from '@nestjs/common';
import type { User } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Looks up a user by email, creating one on first sight. Backs the dev-only
   * auth flow where any caller can mint a session by claiming an email.
   */
  async findOrCreateByEmail(email: string, name?: string): Promise<User> {
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      return existing;
    }
    const data = {
      email,
      name: name ?? null,
    };

    return this.prisma.user.create({ data });
  }
}
