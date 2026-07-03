import { describe, it, expect } from 'vitest';
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
});
