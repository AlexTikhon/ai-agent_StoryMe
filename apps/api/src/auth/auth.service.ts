import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import type { User } from '@prisma/client';
import { UserRole } from '@book/types';
import type { Env } from '../config/env.schema';
import { PrismaService } from '../database/prisma.service';
import { UsersService } from '../users/users.service';
import { EMAIL_SERVICE_TOKEN, type EmailService } from '../email/email.service';
import { TokenService } from './token.service';

const BCRYPT_COST = 12;

export interface AuthResult {
  user: User;
  accessToken: string;
  /** Raw refresh token — caller sets it as the HttpOnly cookie, never returns it in a response body. */
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

@Injectable()
export class AuthService {
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
    const user = await this.usersService.findByEmail(email);

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

    return this.issueTokenPair(user);
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
    const user = await this.prisma.user.findFirst({
      where: { passwordResetTokenHash: tokenHash },
    });

    if (
      !user ||
      !user.passwordResetExpiresAt ||
      user.passwordResetExpiresAt.getTime() < Date.now()
    ) {
      throw new BadRequestException({
        error: 'Invalid or expired reset token',
        message: 'Invalid or expired reset token',
        code: 'INVALID_RESET_TOKEN',
      });
    }

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        passwordResetTokenHash: null,
        passwordResetExpiresAt: null,
      },
    });

    await this.prisma.refreshToken.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async refresh(rawRefreshToken: string | undefined): Promise<AuthResult> {
    if (!rawRefreshToken) {
      throw new UnauthorizedException('Missing refresh token');
    }

    const tokenHash = this.tokenService.hashRefreshToken(rawRefreshToken);
    const record = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });

    if (!record) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (record.revokedAt) {
      // Reuse of an already-rotated-out token: treat as theft and kill the
      // whole family so the legitimate holder is forced to log in again.
      await this.prisma.refreshToken.updateMany({
        where: { family: record.family, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException('Refresh token already used');
    }

    if (record.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('Refresh token expired');
    }

    const user = await this.usersService.findById(record.userId);
    if (!user || user.deactivatedAt) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    await this.prisma.refreshToken.update({
      where: { id: record.id },
      data: { revokedAt: new Date() },
    });

    return this.issueTokenPair(user, record.family);
  }

  async logout(rawRefreshToken: string | undefined): Promise<void> {
    if (!rawRefreshToken) {
      return;
    }

    const tokenHash = this.tokenService.hashRefreshToken(rawRefreshToken);
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
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

  private buildVerificationUrl(token: string): string {
    const webAppUrl = this.config.get('WEB_APP_URL', { infer: true });
    return `${webAppUrl}/verify-email?token=${encodeURIComponent(token)}`;
  }

  private buildPasswordResetUrl(token: string): string {
    const webAppUrl = this.config.get('WEB_APP_URL', { infer: true });
    return `${webAppUrl}/reset-password?token=${encodeURIComponent(token)}`;
  }
}
