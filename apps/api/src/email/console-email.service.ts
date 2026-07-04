import { Injectable, Logger } from '@nestjs/common';
import type {
  EmailService,
  PasswordResetEmailPayload,
  VerificationEmailPayload,
} from './email.service';

export interface ConsoleEmailServiceOptions {
  /**
   * Whether to log the raw verification/reset link (contains a live token).
   * Defaults to true for local/dev/test convenience. The factory
   * (email-provider.factory.ts) sets this to false in production unless
   * EMAIL_DEBUG_LOG_LINKS=true, so a misconfigured deploy doesn't leak
   * tokens into shared log infrastructure by default.
   */
  logLinks?: boolean;
}

/**
 * Development/no-op adapter: logs the email instead of sending it through a
 * real transport, and keeps the most recently sent payload per recipient in
 * memory so tests and local/dev tooling can retrieve the verification/reset
 * link/token deterministically. Never wire this in front of real user
 * traffic in production — see docs/auth-architecture.md.
 */
@Injectable()
export class ConsoleEmailService implements EmailService {
  private readonly logger = new Logger(ConsoleEmailService.name);
  private readonly sent = new Map<string, VerificationEmailPayload>();
  private readonly passwordResetSent = new Map<string, PasswordResetEmailPayload>();
  private readonly logLinks: boolean;

  constructor(options: ConsoleEmailServiceOptions = {}) {
    this.logLinks = options.logLinks ?? true;
  }

  async sendVerificationEmail(payload: VerificationEmailPayload): Promise<void> {
    this.sent.set(payload.to, payload);
    if (this.logLinks) {
      this.logger.log(`Verification email for ${payload.to}: ${payload.verificationUrl}`);
    } else {
      this.logger.warn(
        `Verification email not delivered (no email provider configured) to=${payload.to}`,
      );
    }
    await Promise.resolve();
  }

  async sendPasswordResetEmail(payload: PasswordResetEmailPayload): Promise<void> {
    this.passwordResetSent.set(payload.to, payload);
    if (this.logLinks) {
      this.logger.log(`Password reset email for ${payload.to}: ${payload.resetUrl}`);
    } else {
      this.logger.warn(
        `Password reset email not delivered (no email provider configured) to=${payload.to}`,
      );
    }
    await Promise.resolve();
  }

  /** Test/dev-only inspection hook — not part of the EmailService contract. */
  getLastVerificationEmail(to: string): VerificationEmailPayload | undefined {
    return this.sent.get(to);
  }

  /** Test/dev-only inspection hook — not part of the EmailService contract. */
  getLastPasswordResetEmail(to: string): PasswordResetEmailPayload | undefined {
    return this.passwordResetSent.get(to);
  }
}
