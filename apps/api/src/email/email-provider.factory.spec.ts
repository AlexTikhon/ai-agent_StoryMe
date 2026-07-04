import { describe, it, expect, vi, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';
import { createEmailService } from './email-provider.factory';
import { ConsoleEmailService } from './console-email.service';
import { ResendEmailService } from './resend-email.service';

describe('createEmailService', () => {
  it('defaults to ConsoleEmailService when EMAIL_PROVIDER is unset', () => {
    const service = createEmailService({} as NodeJS.ProcessEnv);
    expect(service).toBeInstanceOf(ConsoleEmailService);
  });

  it('defaults to ConsoleEmailService when EMAIL_PROVIDER is empty', () => {
    const service = createEmailService({ EMAIL_PROVIDER: '' } as unknown as NodeJS.ProcessEnv);
    expect(service).toBeInstanceOf(ConsoleEmailService);
  });

  it('returns ConsoleEmailService when explicitly set to "console"', () => {
    const service = createEmailService({
      EMAIL_PROVIDER: 'console',
    } as unknown as NodeJS.ProcessEnv);
    expect(service).toBeInstanceOf(ConsoleEmailService);
  });

  it('is case-insensitive for the provider name', () => {
    const service = createEmailService({
      EMAIL_PROVIDER: 'CONSOLE',
    } as unknown as NodeJS.ProcessEnv);
    expect(service).toBeInstanceOf(ConsoleEmailService);
  });

  it('throws a clear error when selecting resend without RESEND_API_KEY or EMAIL_FROM', () => {
    expect(() =>
      createEmailService({ EMAIL_PROVIDER: 'resend' } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/RESEND_API_KEY/);
    expect(() =>
      createEmailService({ EMAIL_PROVIDER: 'resend' } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/EMAIL_FROM/);
  });

  it('throws a clear error when selecting resend with only RESEND_API_KEY set', () => {
    expect(() =>
      createEmailService({
        EMAIL_PROVIDER: 'resend',
        RESEND_API_KEY: 'test-key',
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/EMAIL_FROM/);
  });

  it('returns ResendEmailService when selected with RESEND_API_KEY and EMAIL_FROM', () => {
    const service = createEmailService({
      EMAIL_PROVIDER: 'resend',
      RESEND_API_KEY: 'test-key',
      EMAIL_FROM: 'StoryMe <noreply@storyme.app>',
    } as unknown as NodeJS.ProcessEnv);
    expect(service).toBeInstanceOf(ResendEmailService);
  });

  it('throws a clear error for an unknown provider name', () => {
    expect(() =>
      createEmailService({ EMAIL_PROVIDER: 'sendgrid' } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/Unknown EMAIL_PROVIDER/);
  });

  describe('production console fallback', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('still returns ConsoleEmailService (does not throw) when unconfigured in production', () => {
      const service = createEmailService({
        NODE_ENV: 'production',
      } as unknown as NodeJS.ProcessEnv);
      expect(service).toBeInstanceOf(ConsoleEmailService);
    });

    it('logs an error at selection time and suppresses the raw link when sent, without EMAIL_DEBUG_LOG_LINKS', async () => {
      const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

      const service = createEmailService({
        NODE_ENV: 'production',
      } as unknown as NodeJS.ProcessEnv) as ConsoleEmailService;
      expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/EMAIL_PROVIDER is not configured/));

      await service.sendVerificationEmail({
        to: 'alice@example.com',
        token: 'raw-token',
        verificationUrl: 'https://ai-agent-story-me-web.vercel.app/verify-email?token=raw-token',
      });

      // In-memory record is still kept for inspection; only the log line is suppressed.
      expect(service.getLastVerificationEmail('alice@example.com')?.token).toBe('raw-token');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/not delivered.*alice@example\.com/));
      expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('raw-token'));
    });

    it('logs the raw link in production when EMAIL_DEBUG_LOG_LINKS=true', async () => {
      const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      const service = createEmailService({
        NODE_ENV: 'production',
        EMAIL_DEBUG_LOG_LINKS: 'true',
      } as unknown as NodeJS.ProcessEnv) as ConsoleEmailService;

      await service.sendVerificationEmail({
        to: 'alice@example.com',
        token: 'raw-token',
        verificationUrl: 'https://ai-agent-story-me-web.vercel.app/verify-email?token=raw-token',
      });

      expect(service.getLastVerificationEmail('alice@example.com')?.token).toBe('raw-token');
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('raw-token'));
    });
  });
});
