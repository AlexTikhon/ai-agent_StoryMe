import { Logger } from '@nestjs/common';
import type {
  EmailService,
  PasswordResetEmailPayload,
  VerificationEmailPayload,
} from './email.service';

const APP_NAME = 'StoryMe';
const RESEND_API_URL = 'https://api.resend.com/emails';
const DEFAULT_TIMEOUT_MS = 10_000;

export class EmailProviderError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'EmailProviderError';
  }
}

export interface ResendEmailServiceOptions {
  apiKey: string;
  /** e.g. "StoryMe <noreply@storyme.app>" — must be a verified sender/domain in Resend. */
  from: string;
  replyTo?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Real transactional email adapter backed by the Resend HTTP API
 * (https://resend.com/docs/api-reference/emails/send-email). Implements the
 * same EmailService contract as ConsoleEmailService — selected only via
 * createEmailService (email-provider.factory.ts) when EMAIL_PROVIDER=resend
 * is explicitly set, so AuthService never branches on which provider is
 * active. Never logs the raw verification/reset link (it embeds the raw
 * token) — only the recipient and email kind, unlike ConsoleEmailService
 * which intentionally logs the link for local/dev inspection.
 */
export class ResendEmailService implements EmailService {
  private readonly logger = new Logger(ResendEmailService.name);
  private readonly apiKey: string;
  private readonly from: string;
  private readonly replyTo: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ResendEmailServiceOptions) {
    if (!options.apiKey) {
      throw new EmailProviderError('ResendEmailService requires an apiKey');
    }
    if (!options.from) {
      throw new EmailProviderError('ResendEmailService requires a from address');
    }
    this.apiKey = options.apiKey;
    this.from = options.from;
    this.replyTo = options.replyTo;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async sendVerificationEmail(payload: VerificationEmailPayload): Promise<void> {
    const greeting = payload.name ? `Hi ${escapeHtml(payload.name)},` : 'Hi,';
    const subject = `Verify your email for ${APP_NAME}`;
    const html = [
      `<p>${greeting}</p>`,
      `<p>Thanks for signing up for ${APP_NAME}! Please confirm your email address to finish setting up your account.</p>`,
      `<p><a href="${escapeHtml(payload.verificationUrl)}">Verify my email</a></p>`,
      `<p>This link expires in 24 hours. If you didn't create a ${APP_NAME} account, you can safely ignore this email.</p>`,
    ].join('\n');
    const text = [
      payload.name ? `Hi ${payload.name},` : 'Hi,',
      '',
      `Thanks for signing up for ${APP_NAME}! Confirm your email address using the link below:`,
      payload.verificationUrl,
      '',
      `This link expires in 24 hours. If you didn't create a ${APP_NAME} account, you can safely ignore this email.`,
    ].join('\n');

    await this.send(payload.to, subject, html, text, 'verification');
  }

  async sendPasswordResetEmail(payload: PasswordResetEmailPayload): Promise<void> {
    const greeting = payload.name ? `Hi ${escapeHtml(payload.name)},` : 'Hi,';
    const subject = `Reset your ${APP_NAME} password`;
    const html = [
      `<p>${greeting}</p>`,
      `<p>We received a request to reset your ${APP_NAME} password.</p>`,
      `<p><a href="${escapeHtml(payload.resetUrl)}">Reset my password</a></p>`,
      `<p>This link expires in 30 minutes. If you didn't request a password reset, you can safely ignore this email — your password will not be changed.</p>`,
    ].join('\n');
    const text = [
      payload.name ? `Hi ${payload.name},` : 'Hi,',
      '',
      `We received a request to reset your ${APP_NAME} password. Use the link below to choose a new one:`,
      payload.resetUrl,
      '',
      `This link expires in 30 minutes. If you didn't request a password reset, you can safely ignore this email — your password will not be changed.`,
    ].join('\n');

    await this.send(payload.to, subject, html, text, 'password reset');
  }

  private async send(
    to: string,
    subject: string,
    html: string,
    text: string,
    kind: string,
  ): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(RESEND_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          from: this.from,
          to,
          subject,
          html,
          text,
          ...(this.replyTo ? { reply_to: this.replyTo } : {}),
        }),
        signal: controller.signal,
      });
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      this.logger.error(`Failed to send ${kind} email: reason=${isAbort ? 'timeout' : 'network'}`);
      throw new EmailProviderError(
        `Resend request failed (${isAbort ? 'timeout' : 'network error'})`,
        err,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      this.logger.error(`Failed to send ${kind} email: status=${response.status}`);
      throw new EmailProviderError(
        `Resend request failed with status ${response.status}: ${bodyText.slice(0, 500)}`,
      );
    }

    this.logger.log(`Sent ${kind} email to=${to}`);
  }
}
