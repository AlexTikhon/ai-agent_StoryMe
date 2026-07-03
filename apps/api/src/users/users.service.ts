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

  /** Looks up by email without creating one. Returns null when no user exists. */
  async findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  async findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  /** Creates a password-auth user. Email must already be confirmed unique by the caller. */
  async create(data: {
    email: string;
    passwordHash: string;
    name?: string | undefined;
    emailVerificationTokenHash?: string | undefined;
    emailVerificationExpiresAt?: Date | undefined;
  }): Promise<User> {
    return this.prisma.user.create({
      data: {
        email: data.email,
        passwordHash: data.passwordHash,
        name: data.name ?? null,
        ...(data.emailVerificationTokenHash
          ? { emailVerificationTokenHash: data.emailVerificationTokenHash }
          : {}),
        ...(data.emailVerificationExpiresAt
          ? { emailVerificationExpiresAt: data.emailVerificationExpiresAt }
          : {}),
      },
    });
  }
}
