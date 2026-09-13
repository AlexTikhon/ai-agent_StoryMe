import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { Prisma, RefreshTokenRevocationReason, type User } from '@prisma/client';
import { UserRole } from '@book/types';
import type { Env } from '../config/env.schema';
import { PrismaService } from '../database/prisma.service';
import { UsersService } from '../users/users.service';
import { EMAIL_SERVICE_TOKEN, type EmailService } from '../email/email.service';
import { TokenService } from './token.service';

const BCRYPT_COST = 12;

/**
 * How long after rotating out a refresh token we still tolerate one more
 * presentation of it as a benign race rather than theft. Multi-tab browsers
 * can have two tabs read the same pre-rotation cookie and both attempt to
 * refresh within milliseconds of each other. The loser receives the single
 * child already created by the winning transaction; it never creates another
 * descendant. Terminal revocation reasons never enter this grace path.
 */
const REFRESH_REUSE_GRACE_MS = 10_000;
const AUTH_TRANSACTION_RETRIES = 3;

export interface AuthResult {
  user: User;
  accessToken: string;
  /** Raw refresh token — caller sets it as the HttpOnly cookie, never returns it in a response body. */
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly tokenService: TokenService,
    @Inject(EMAIL_SERVICE_TOKEN) private readonly emailService: EmailService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async register(email: string, password: string, name?: string): Promise<AuthResult> {
    const existing = await this.usersService.findByEmail(email);
    if (existing) {
      throw new ConflictException('Email is already registered');
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    const verification = this.tokenService.generateEmailVerificationToken();
    const user = await this.usersService.create({
      email,
      passwordHash,
      name,
      emailVerificationTokenHash: verification.hash,
      emailVerificationExpiresAt: verification.expiresAt,
    });

    await this.emailService.sendVerificationEmail({
      to: user.email,
      name: user.name,
      token: verification.raw,
      verificationUrl: this.buildVerificationUrl(verification.raw),
    });

    // Registration still auto-signs the user in (existing behavior — see
    // docs/auth-architecture.md §12.4); only a subsequent explicit login()
    // is gated on verification, below.
    return this.issueTokenPair(user);
  }

  async login(email: string, password: string): Promise<AuthResult> {
    try {
      const user = await this.usersService.findByEmail(email);

      // Temporary diagnostics for production auth debugging — never logs the
      // password or any token, only existence/shape of the looked-up record.
      this.logger.log(`Login attempt: userFound=${!!user} hasPasswordHash=${!!user?.passwordHash}`);

      // Generic message in every branch, including deactivated — do not reveal
      // whether the email exists or the account's deactivation state.
      if (
        !user ||
        user.deactivatedAt ||
        !user.passwordHash ||
        !(await bcrypt.compare(password, user.passwordHash))
      ) {
        throw new UnauthorizedException('Invalid email or password');
      }

      if (!user.emailVerified) {
        throw new UnauthorizedException({
          error: 'Email is not verified',
          message: 'Email is not verified',
          code: 'EMAIL_NOT_VERIFIED',
        });
      }

      return await this.issueTokenPair(user);
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      // Anything else here is unexpected (DB/connection error, missing
      // migration, bcrypt failure, etc.) — log its exact type so it's
      // diagnosable in Railway logs, then rethrow unchanged so the global
      // exception filter still returns a generic 500 (no internals leaked
      // to the client).
      this.logger.error(`Unexpected error during login: ${this.describeError(error)}`);
      throw error;
    }
  }

  /** Rejects invalid/expired tokens; clears the token hash so it cannot be replayed after success. */
  async verifyEmail(rawToken: string): Promise<void> {
    const tokenHash = this.tokenService.hashEmailVerificationToken(rawToken);
    const user = await this.prisma.user.findFirst({
      where: { emailVerificationTokenHash: tokenHash },
    });

    if (
      !user ||
      !user.emailVerificationExpiresAt ||
      user.emailVerificationExpiresAt.getTime() < Date.now()
    ) {
      throw new BadRequestException('Invalid or expired verification token');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerified: true,
        emailVerifiedAt: new Date(),
        emailVerificationTokenHash: null,
        emailVerificationExpiresAt: null,
      },
    });
  }

  /**
   * Always resolves the same way regardless of whether the email exists, is
   * already verified, or belongs to a deactivated account — callers (the
   * controller) must not branch on this to avoid leaking account existence.
   */
  async resendVerificationEmail(email: string): Promise<void> {
    const user = await this.usersService.findByEmail(email);
    if (!user || user.emailVerified || user.deactivatedAt) {
      return;
    }

    const verification = this.tokenService.generateEmailVerificationToken();
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerificationTokenHash: verification.hash,
        emailVerificationExpiresAt: verification.expiresAt,
      },
    });

    await this.emailService.sendVerificationEmail({
      to: user.email,
      name: user.name,
      token: verification.raw,
      verificationUrl: this.buildVerificationUrl(verification.raw),
    });
  }

  /**
   * Always resolves the same way regardless of whether the email exists or
   * belongs to a deactivated account — callers (the controller) must not
   * branch on this to avoid leaking account existence.
   */
  async requestPasswordReset(email: string): Promise<void> {
    const user = await this.usersService.findByEmail(email);
    if (!user || user.deactivatedAt) {
      return;
    }

    const reset = this.tokenService.generatePasswordResetToken();
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordResetTokenHash: reset.hash,
        passwordResetExpiresAt: reset.expiresAt,
        passwordResetRequestedAt: new Date(),
      },
    });

    await this.emailService.sendPasswordResetEmail({
      to: user.email,
      name: user.name,
      token: reset.raw,
      resetUrl: this.buildPasswordResetUrl(reset.raw),
    });
  }

  /**
   * Rejects invalid/expired tokens; clears the token hash so it cannot be
   * replayed after success, and revokes every persisted refresh token for
   * the account so a stolen session can't outlive a password reset.
   */
  async resetPassword(rawToken: string, newPassword: string): Promise<void> {
    const tokenHash = this.tokenService.hashPasswordResetToken(rawToken);
    const nextPasswordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
    return this.resetPasswordTransaction(tokenHash, nextPasswordHash);
  }

  async refresh(rawRefreshToken: string | undefined): Promise<AuthResult> {
    if (!rawRefreshToken) {
      throw new UnauthorizedException('Missing refresh token');
    }
    return this.refreshTransaction(rawRefreshToken);
  }

  async logout(rawRefreshToken: string | undefined): Promise<void> {
    if (!rawRefreshToken) {
      return;
    }
    return this.logoutTransaction(rawRefreshToken);
  }

  private async resetPasswordTransaction(tokenHash: string, passwordHash: string): Promise<void> {
    const consumed = await this.withSerializableRetry(async (tx) => {
      const now = new Date();
      const user = await tx.user.findFirst({
        where: {
          passwordResetTokenHash: tokenHash,
          passwordResetExpiresAt: { gt: now },
        },
        select: { id: true },
      });
      if (!user) return false;
      const update = await tx.user.updateMany({
        where: {
          id: user.id,
          passwordResetTokenHash: tokenHash,
          passwordResetExpiresAt: { gt: now },
        },
        data: {
          passwordHash,
          passwordResetTokenHash: null,
          passwordResetExpiresAt: null,
        },
      });
      if (update.count !== 1) return false;
      await tx.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: {
          revokedAt: now,
          revocationReason: RefreshTokenRevocationReason.password_reset,
        },
      });
      return true;
    });
    if (!consumed) this.throwInvalidResetToken();
  }

  private async refreshTransaction(rawRefreshToken: string): Promise<AuthResult> {
    const tokenHash = this.tokenService.hashRefreshToken(rawRefreshToken);
    const outcome = await this.withSerializableRetry(async (tx) => {
      const now = new Date();
      const record = await tx.refreshToken.findUnique({ where: { tokenHash } });
      if (!record) throw new UnauthorizedException('Invalid refresh token');
      if (record.expiresAt.getTime() <= now.getTime()) {
        throw new UnauthorizedException('Refresh token expired');
      }
      const user = await tx.user.findUnique({ where: { id: record.userId } });
      if (!user || user.deactivatedAt) throw new UnauthorizedException('Invalid refresh token');

      if (record.revokedAt) {
        if (record.revocationReason !== RefreshTokenRevocationReason.rotation) {
          throw new UnauthorizedException('Refresh token revoked');
        }
        if (now.getTime() - record.revokedAt.getTime() > REFRESH_REUSE_GRACE_MS) {
          await tx.refreshToken.updateMany({
            where: { family: record.family, revokedAt: null },
            data: {
              revokedAt: now,
              revocationReason: RefreshTokenRevocationReason.compromise,
            },
          });
          return { compromised: true } as const;
        }
        const child = await tx.refreshToken.findUnique({ where: { rotatedFromId: record.id } });
        if (!child || child.revokedAt || child.expiresAt.getTime() <= now.getTime()) {
          throw new UnauthorizedException('Refresh token already used');
        }
        const refresh = this.tokenService.deriveRotatedRefreshToken(
          rawRefreshToken,
          record.family,
          child.expiresAt,
        );
        return { result: this.authResult(user, refresh) } as const;
      }

      const refresh = this.tokenService.deriveRotatedRefreshToken(rawRefreshToken, record.family);
      const claimed = await tx.refreshToken.updateMany({
        where: { id: record.id, revokedAt: null, expiresAt: { gt: now } },
        data: {
          revokedAt: now,
          revocationReason: RefreshTokenRevocationReason.rotation,
        },
      });
      if (claimed.count !== 1) throw new RetryableAuthConflict();
      await tx.refreshToken.create({
        data: {
          userId: user.id,
          tokenHash: refresh.hash,
          family: refresh.family,
          expiresAt: refresh.expiresAt,
          rotatedFromId: record.id,
        },
      });
      return { result: this.authResult(user, refresh) } as const;
    });
    if ('compromised' in outcome) throw new UnauthorizedException('Refresh token already used');
    return outcome.result;
  }

  private async logoutTransaction(rawRefreshToken: string): Promise<void> {
    const tokenHash = this.tokenService.hashRefreshToken(rawRefreshToken);
    await this.withSerializableRetry(async (tx) => {
      const record = await tx.refreshToken.findUnique({ where: { tokenHash } });
      if (!record) return;
      await tx.refreshToken.updateMany({
        where: { family: record.family, revokedAt: null },
        data: {
          revokedAt: new Date(),
          revocationReason: RefreshTokenRevocationReason.logout,
        },
      });
    });
  }

  private async issueTokenPair(user: User, family?: string): Promise<AuthResult> {
    const accessToken = this.tokenService.signAccessToken({
      sub: user.id,
      email: user.email,
      role: user.role as unknown as UserRole,
    });

    const refresh = this.tokenService.generateRefreshToken(family);
    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: refresh.hash,
        family: refresh.family,
        expiresAt: refresh.expiresAt,
      },
    });

    return {
      user,
      accessToken,
      refreshToken: refresh.raw,
      refreshTokenExpiresAt: refresh.expiresAt,
    };
  }

  private authResult(user: User, refresh: { raw: string; expiresAt: Date }): AuthResult {
    return {
      user,
      accessToken: this.tokenService.signAccessToken({
        sub: user.id,
        email: user.email,
        role: user.role as unknown as UserRole,
      }),
      refreshToken: refresh.raw,
      refreshTokenExpiresAt: refresh.expiresAt,
    };
  }

  private throwInvalidResetToken(): never {
    throw new BadRequestException({
      error: 'Invalid or expired reset token',
      message: 'Invalid or expired reset token',
      code: 'INVALID_RESET_TOKEN',
    });
  }

  private async withSerializableRetry<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; attempt <= AUTH_TRANSACTION_RETRIES; attempt++) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        const retryable =
          error instanceof RetryableAuthConflict ||
          (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034');
        if (!retryable || attempt === AUTH_TRANSACTION_RETRIES) throw error;
      }
    }
    throw new UnauthorizedException('Authentication transaction could not be completed');
  }

  /** Formats an unknown caught error as `Name (code): message` for logs — never includes stack/PII. */
  private describeError(error: unknown): string {
    if (error instanceof Error) {
      const code = (error as { code?: unknown }).code;
      return typeof code === 'string'
        ? `${error.name} (${code}): ${error.message}`
        : `${error.name}: ${error.message}`;
    }
    return String(error);
  }

  private buildVerificationUrl(token: string): string {
    const webAppUrl = this.config.get('WEB_APP_URL', { infer: true });
    return `${webAppUrl}/verify-email?token=${encodeURIComponent(token)}`;
  }

  private buildPasswordResetUrl(token: string): string {
    const webAppUrl = this.config.get('WEB_APP_URL', { infer: true });
    return `${webAppUrl}/reset-password?token=${encodeURIComponent(token)}`;
  }
}

class RetryableAuthConflict extends Error {}
