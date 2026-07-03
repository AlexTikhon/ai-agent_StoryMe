import type { UserRole } from '@book/types';

/** Claims signed into the short-lived access token. */
export interface AccessTokenPayload {
  sub: string;
  email: string;
  role: UserRole;
}
