import { describe, it, expect } from 'vitest';
import { ConsoleEmailService } from './console-email.service';

describe('ConsoleEmailService', () => {
  it('does not throw and records the payload instead of sending real email', async () => {
    const service = new ConsoleEmailService();

    await service.sendVerificationEmail({
      to: 'alice@example.com',
      name: 'Alice',
      token: 'raw-token',
      verificationUrl: 'http://localhost:3000/verify-email?token=raw-token',
    });

    expect(service.getLastVerificationEmail('alice@example.com')).toEqual({
      to: 'alice@example.com',
      name: 'Alice',
      token: 'raw-token',
      verificationUrl: 'http://localhost:3000/verify-email?token=raw-token',
    });
  });

  it('returns undefined for a recipient with no sent email', () => {
    const service = new ConsoleEmailService();

    expect(service.getLastVerificationEmail('nobody@example.com')).toBeUndefined();
  });

  it('keeps only the most recent email per recipient', async () => {
    const service = new ConsoleEmailService();

    await service.sendVerificationEmail({
      to: 'alice@example.com',
      token: 'first-token',
      verificationUrl: 'http://localhost:3000/verify-email?token=first-token',
    });
    await service.sendVerificationEmail({
      to: 'alice@example.com',
      token: 'second-token',
      verificationUrl: 'http://localhost:3000/verify-email?token=second-token',
    });

    expect(service.getLastVerificationEmail('alice@example.com')?.token).toBe('second-token');
  });
});
