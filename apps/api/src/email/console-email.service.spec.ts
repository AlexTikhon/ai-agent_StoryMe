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

  it('does not throw and records password reset payloads separately from verification payloads', async () => {
    const service = new ConsoleEmailService();

    await service.sendPasswordResetEmail({
      to: 'alice@example.com',
      name: 'Alice',
      token: 'raw-reset-token',
      resetUrl: 'http://localhost:3000/reset-password?token=raw-reset-token',
    });

    expect(service.getLastPasswordResetEmail('alice@example.com')).toEqual({
      to: 'alice@example.com',
      name: 'Alice',
      token: 'raw-reset-token',
      resetUrl: 'http://localhost:3000/reset-password?token=raw-reset-token',
    });
    expect(service.getLastVerificationEmail('alice@example.com')).toBeUndefined();
  });

  it('returns undefined for a password reset recipient with no sent email', () => {
    const service = new ConsoleEmailService();

    expect(service.getLastPasswordResetEmail('nobody@example.com')).toBeUndefined();
  });

  it('keeps only the most recent password reset email per recipient', async () => {
    const service = new ConsoleEmailService();

    await service.sendPasswordResetEmail({
      to: 'alice@example.com',
      token: 'first-reset-token',
      resetUrl: 'http://localhost:3000/reset-password?token=first-reset-token',
    });
    await service.sendPasswordResetEmail({
      to: 'alice@example.com',
      token: 'second-reset-token',
      resetUrl: 'http://localhost:3000/reset-password?token=second-reset-token',
    });

    expect(service.getLastPasswordResetEmail('alice@example.com')?.token).toBe(
      'second-reset-token',
    );
  });
});
