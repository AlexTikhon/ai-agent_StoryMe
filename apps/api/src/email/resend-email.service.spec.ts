import { describe, it, expect, vi } from 'vitest';
import { ResendEmailService, EmailProviderError } from './resend-email.service';

function makeFetchOk() {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => '',
  });
}

describe('ResendEmailService', () => {
  it('throws when constructed without an apiKey', () => {
    expect(() => new ResendEmailService({ apiKey: '', from: 'a@b.com' })).toThrow(
      EmailProviderError,
    );
  });

  it('throws when constructed without a from address', () => {
    expect(() => new ResendEmailService({ apiKey: 'key', from: '' })).toThrow(EmailProviderError);
  });

  it('sends a verification email with app name, link, and expiration info', async () => {
    const fetchImpl = makeFetchOk();
    const service = new ResendEmailService({
      apiKey: 'test-key',
      from: 'StoryMe <noreply@storyme.app>',
      fetchImpl,
    });

    await service.sendVerificationEmail({
      to: 'alice@example.com',
      name: 'Alice',
      token: 'raw-token',
      verificationUrl: 'http://localhost:3000/verify-email?token=raw-token',
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect(init.headers['Authorization']).toBe('Bearer test-key');
    expect(init.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(init.body as string);
    expect(body.from).toBe('StoryMe <noreply@storyme.app>');
    expect(body.to).toBe('alice@example.com');
    expect(body.subject).toMatch(/StoryMe/);
    expect(body.html).toContain('StoryMe');
    expect(body.html).toContain('http://localhost:3000/verify-email?token=raw-token');
    expect(body.html).toMatch(/24 hours/);
    expect(body.text).toContain('http://localhost:3000/verify-email?token=raw-token');
    expect(body.text).toMatch(/24 hours/);
  });

  it('sends a password reset email with app name, link, expiration, and an ignore-if-not-requested warning', async () => {
    const fetchImpl = makeFetchOk();
    const service = new ResendEmailService({
      apiKey: 'test-key',
      from: 'StoryMe <noreply@storyme.app>',
      fetchImpl,
    });

    await service.sendPasswordResetEmail({
      to: 'alice@example.com',
      name: 'Alice',
      token: 'raw-reset-token',
      resetUrl: 'http://localhost:3000/reset-password?token=raw-reset-token',
    });

    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body as string);
    expect(body.to).toBe('alice@example.com');
    expect(body.subject).toMatch(/StoryMe/);
    expect(body.html).toContain('http://localhost:3000/reset-password?token=raw-reset-token');
    expect(body.html).toMatch(/30 minutes/);
    expect(body.html).toMatch(/didn't request/);
    expect(body.text).toContain('http://localhost:3000/reset-password?token=raw-reset-token');
    expect(body.text).toMatch(/didn't request/);
  });

  it('includes reply_to only when configured', async () => {
    const fetchImpl = makeFetchOk();
    const service = new ResendEmailService({
      apiKey: 'test-key',
      from: 'StoryMe <noreply@storyme.app>',
      replyTo: 'support@storyme.app',
      fetchImpl,
    });

    await service.sendVerificationEmail({
      to: 'alice@example.com',
      token: 'raw-token',
      verificationUrl: 'http://localhost:3000/verify-email?token=raw-token',
    });

    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body as string);
    expect(body.reply_to).toBe('support@storyme.app');
  });

  it('omits reply_to when not configured', async () => {
    const fetchImpl = makeFetchOk();
    const service = new ResendEmailService({ apiKey: 'test-key', from: 'a@b.com', fetchImpl });

    await service.sendVerificationEmail({
      to: 'alice@example.com',
      token: 'raw-token',
      verificationUrl: 'http://localhost:3000/verify-email?token=raw-token',
    });

    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body as string);
    expect(body).not.toHaveProperty('reply_to');
  });

  it('throws EmailProviderError with the response status on a non-ok response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      text: async () => '{"message":"invalid from address"}',
    });
    const service = new ResendEmailService({ apiKey: 'test-key', from: 'a@b.com', fetchImpl });

    await expect(
      service.sendVerificationEmail({
        to: 'alice@example.com',
        token: 'raw-token',
        verificationUrl: 'http://localhost:3000/verify-email?token=raw-token',
      }),
    ).rejects.toThrow(/422/);
  });

  it('throws EmailProviderError without leaking the apiKey when the request errors', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('boom'));
    const service = new ResendEmailService({
      apiKey: 'super-secret-key',
      from: 'a@b.com',
      fetchImpl,
    });

    let caught: unknown;
    try {
      await service.sendPasswordResetEmail({
        to: 'alice@example.com',
        token: 'raw-reset-token',
        resetUrl: 'http://localhost:3000/reset-password?token=raw-reset-token',
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(EmailProviderError);
    expect((caught as Error).message).not.toContain('super-secret-key');
  });

  it('rejects when the request times out', async () => {
    const fetchImpl = vi.fn().mockImplementation(
      () =>
        new Promise((_, reject) => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        }),
    );
    const service = new ResendEmailService({
      apiKey: 'test-key',
      from: 'a@b.com',
      fetchImpl,
      timeoutMs: 10,
    });

    await expect(
      service.sendVerificationEmail({
        to: 'alice@example.com',
        token: 'raw-token',
        verificationUrl: 'http://localhost:3000/verify-email?token=raw-token',
      }),
    ).rejects.toThrow(EmailProviderError);
  });
});
