import { describe, it, expect, beforeEach } from 'vitest';
import { JwtService } from '@nestjs/jwt';
import type { ConfigService } from '@nestjs/config';
import { UserRole } from '@book/types';
import type { Env } from '../config/env.schema';
import { TokenService, ACCESS_TOKEN_TTL_SECONDS } from './token.service';

function createConfig(overrides: Partial<Env> = {}): ConfigService<Env, true> {
  const values: Partial<Env> = {
    JWT_SECRET: 'a-secret-that-is-at-least-32-chars-long!!',
    JWT_REFRESH_SECRET: 'refresh-secret-that-is-at-least-32-chars!!',
    ...overrides,
  };
  return { get: (key: string) => values[key as keyof Env] } as unknown as ConfigService<Env, true>;
}

describe('TokenService', () => {
  let service: TokenService;

  beforeEach(() => {
    service = new TokenService(new JwtService(), createConfig());
  });

  describe('access tokens', () => {
    it('signs a token verifiable with the same secret', () => {
      const token = service.signAccessToken({
        sub: 'u-1',
        email: 'a@example.com',
        role: UserRole.User,
      });
      const payload = service.verifyAccessToken(token);

      expect(payload.sub).toBe('u-1');
      expect(payload.email).toBe('a@example.com');
      expect(payload.role).toBe(UserRole.User);
    });

    it('rejects a token signed with a different secret', () => {
      const other = new TokenService(
        new JwtService(),
        createConfig({ JWT_SECRET: 'a-totally-different-secret-32-chars!!' }),
      );
      const token = other.signAccessToken({
        sub: 'u-1',
        email: 'a@example.com',
        role: UserRole.User,
      });

      expect(() => service.verifyAccessToken(token)).toThrow();
    });

    it('rejects an expired token', () => {
      const jwt = new JwtService();
      const expired = jwt.sign(
        { sub: 'u-1', email: 'a@example.com', role: UserRole.User },
        { secret: 'a-secret-that-is-at-least-32-chars-long!!', expiresIn: -1 },
      );

      expect(() => service.verifyAccessToken(expired)).toThrow();
    });

    it('sets a 15 minute expiry', () => {
      expect(ACCESS_TOKEN_TTL_SECONDS).toBe(15 * 60);
    });
  });

  describe('refresh tokens', () => {
    it('generates a random raw value and a deterministic HMAC hash', () => {
      const a = service.generateRefreshToken();
      const b = service.generateRefreshToken();

      expect(a.raw).not.toBe(b.raw);
      expect(a.hash).toBe(service.hashRefreshToken(a.raw));
      expect(a.hash).not.toBe(a.raw);
    });

    it('starts a new family when none is given', () => {
      const a = service.generateRefreshToken();
      const b = service.generateRefreshToken();

      expect(a.family).not.toBe(b.family);
    });

    it('keeps the same family when rotating', () => {
      const first = service.generateRefreshToken();
      const rotated = service.generateRefreshToken(first.family);

      expect(rotated.family).toBe(first.family);
      expect(rotated.raw).not.toBe(first.raw);
    });

    it('hashes depend on JWT_REFRESH_SECRET', () => {
      const other = new TokenService(
        new JwtService(),
        createConfig({ JWT_REFRESH_SECRET: 'a-totally-different-refresh-secret-32!!' }),
      );
      const raw = service.generateRefreshToken().raw;

      expect(service.hashRefreshToken(raw)).not.toBe(other.hashRefreshToken(raw));
    });
  });

  describe('email verification tokens', () => {
    it('generates a random raw value and a deterministic hash', () => {
      const a = service.generateEmailVerificationToken();
      const b = service.generateEmailVerificationToken();

      expect(a.raw).not.toBe(b.raw);
      expect(a.hash).toBe(service.hashEmailVerificationToken(a.raw));
      expect(a.hash).not.toBe(a.raw);
    });

    it('sets a 24 hour expiry', () => {
      const before = Date.now();
      const token = service.generateEmailVerificationToken();
      const hours = (token.expiresAt.getTime() - before) / (60 * 60 * 1000);

      expect(hours).toBeGreaterThan(23.9);
      expect(hours).toBeLessThanOrEqual(24);
    });

    it('hash does not depend on JWT_REFRESH_SECRET (plain SHA-256, not HMAC)', () => {
      const other = new TokenService(
        new JwtService(),
        createConfig({ JWT_REFRESH_SECRET: 'a-totally-different-refresh-secret-32!!' }),
      );
      const raw = service.generateEmailVerificationToken().raw;

      expect(service.hashEmailVerificationToken(raw)).toBe(other.hashEmailVerificationToken(raw));
    });
  });

  describe('password reset tokens', () => {
    it('generates a random raw value and a deterministic hash', () => {
      const a = service.generatePasswordResetToken();
      const b = service.generatePasswordResetToken();

      expect(a.raw).not.toBe(b.raw);
      expect(a.hash).toBe(service.hashPasswordResetToken(a.raw));
      expect(a.hash).not.toBe(a.raw);
    });

    it('sets a 30 minute expiry', () => {
      const before = Date.now();
      const token = service.generatePasswordResetToken();
      const minutes = (token.expiresAt.getTime() - before) / (60 * 1000);

      expect(minutes).toBeGreaterThan(29.9);
      expect(minutes).toBeLessThanOrEqual(30);
    });

    it('hash does not depend on JWT_REFRESH_SECRET (plain SHA-256, not HMAC)', () => {
      const other = new TokenService(
        new JwtService(),
        createConfig({ JWT_REFRESH_SECRET: 'a-totally-different-refresh-secret-32!!' }),
      );
      const raw = service.generatePasswordResetToken().raw;

      expect(service.hashPasswordResetToken(raw)).toBe(other.hashPasswordResetToken(raw));
    });
  });
});
