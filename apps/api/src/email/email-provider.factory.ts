import { Logger } from '@nestjs/common';
import type { EmailService } from './email.service';
import { ConsoleEmailService } from './console-email.service';
import { ResendEmailService } from './resend-email.service';

export type EmailProviderName = 'console' | 'resend';

const logger = new Logger('EmailProviderFactory');

/**
 * Selects the EmailService implementation from env. Defaults to console
 * (ConsoleEmailService — logs instead of sending) so local dev, tests, and
 * CI never send real email unless EMAIL_PROVIDER=resend is explicitly set.
 * Takes an explicit env map (defaulting to process.env) so provider
 * selection is unit-testable without mutating global state, mirroring
 * createStoryGenerationProvider (story-generation-provider.factory.ts).
 */
export function createEmailService(env: NodeJS.ProcessEnv = process.env): EmailService {
  const raw = env['EMAIL_PROVIDER']?.trim().toLowerCase();

  if (!raw || raw === 'console') {
    logger.log('Email provider selected: console');
    return new ConsoleEmailService();
  }

  if (raw !== 'resend') {
    throw new Error(`Unknown EMAIL_PROVIDER "${raw}" (expected "console" or "resend")`);
  }

  const apiKey = env['RESEND_API_KEY'];
  const from = env['EMAIL_FROM'];
  const missing: string[] = [];
  if (!apiKey) missing.push('RESEND_API_KEY');
  if (!from) missing.push('EMAIL_FROM');
  if (missing.length > 0) {
    throw new Error(
      `EMAIL_PROVIDER=resend requires the following environment variable(s): ${missing.join(', ')}`,
    );
  }

  logger.log(`Email provider selected: resend from=${from}`);
  return new ResendEmailService({
    apiKey: apiKey!,
    from: from!,
    ...(env['EMAIL_REPLY_TO'] ? { replyTo: env['EMAIL_REPLY_TO'] } : {}),
  });
}
