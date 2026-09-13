// In-memory only — never localStorage/sessionStorage, so an XSS payload can't
// exfiltrate a long-lived credential. Lost on full page reload by design;
// AuthProvider restores it via POST /api/auth/refresh (HttpOnly cookie) on mount.
let accessToken: string | null = null;
let sessionEpoch = 0;

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getSessionEpoch(): number {
  return sessionEpoch;
}

/** Claims ownership of subsequent async session writes. Login, registration,
 * and logout call this before awaiting network work. */
export function advanceSessionEpoch(): number {
  sessionEpoch += 1;
  return sessionEpoch;
}

export function setAccessTokenForEpoch(token: string | null, epoch: number): boolean {
  if (epoch !== sessionEpoch) return false;
  accessToken = token;
  return true;
}
