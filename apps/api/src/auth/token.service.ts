import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { Env } from '../config/env.schema';
import { REFRESH_TOKEN_TTL_MS } from './refresh-cookie';
import type { AccessTokenPayload } from './jwt-payload';

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes
export const EMAIL_VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface GeneratedRefreshToken {
  /** Raw value — only ever sent to the client via the HttpOnly cookie. */
  raw: string;
  /** HMAC(JWT_REFRESH_SECRET, raw) — the only form persisted to the DB. */
  hash: string;
  family: string;
  expiresAt: Date;
}

export interface GeneratedEmailVerificationToken {
  /** Raw value — only ever sent to the user via the verification link/email. */
  raw: string;
  /** SHA-256(raw) — the only form persisted to the DB. */
  hash: string;
  expiresAt: Date;
}

/**
 * Refresh tokens are opaque random values, not JWTs — the DB row (and its
 * revokedAt/family columns) is the source of truth for revocation, so a
 * self-contained signed token would add no capability, only the temptation
 * to skip the DB check. JWT_REFRESH_SECRET is still put to use as the HMAC
 * key hashing the token before storage, rather than sitting reserved-but-
 * unused.
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  signAccessToken(payload: AccessTokenPayload): string {
    return this.jwtService.sign(payload, {
      secret: this.config.get('JWT_SECRET', { infer: true }),
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    });
  }

  verifyAccessToken(token: string): AccessTokenPayload {
    return this.jwtService.verify<AccessTokenPayload>(token, {
      secret: this.config.get('JWT_SECRET', { infer: true }),
    });
  }

  /** Pass the previous token's family to keep a rotation chain linked; omit to start a new one (login/register). */
  generateRefreshToken(family?: string): GeneratedRefreshToken {
    const raw = randomBytes(32).toString('hex');
    return {
      raw,
      hash: this.hashRefreshToken(raw),
      family: family ?? randomUUID(),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    };
  }

  hashRefreshToken(raw: string): string {
    return createHmac('sha256', this.config.get('JWT_REFRESH_SECRET', { infer: true }))
      .update(raw)
      .digest('hex');
  }

  /**
   * Plain SHA-256, no secret — same reasoning as the refresh token hash: this
   * hashes a high-entropy random value, not a human password, so no
   * secret-keyed HMAC or slow KDF is needed for it to resist reversal.
   */
  generateEmailVerificationToken(): GeneratedEmailVerificationToken {
    const raw = randomBytes(32).toString('hex');
    return {
      raw,
      hash: this.hashEmailVerificationToken(raw),
      expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TOKEN_TTL_MS),
    };
  }

  hashEmailVerificationToken(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }
}
