// In-memory only — never localStorage/sessionStorage, so an XSS payload can't
// exfiltrate a long-lived credential. Lost on full page reload by design;
// AuthProvider restores it via POST /api/auth/refresh (HttpOnly cookie) on mount.
let accessToken: string | null = null;

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
}
