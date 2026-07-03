import { Injectable, Logger } from '@nestjs/common';
import type {
  EmailService,
  PasswordResetEmailPayload,
  VerificationEmailPayload,
} from './email.service';

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

  async sendVerificationEmail(payload: VerificationEmailPayload): Promise<void> {
    this.sent.set(payload.to, payload);
    this.logger.log(`Verification email for ${payload.to}: ${payload.verificationUrl}`);
    await Promise.resolve();
  }

  async sendPasswordResetEmail(payload: PasswordResetEmailPayload): Promise<void> {
    this.passwordResetSent.set(payload.to, payload);
    this.logger.log(`Password reset email for ${payload.to}: ${payload.resetUrl}`);
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
