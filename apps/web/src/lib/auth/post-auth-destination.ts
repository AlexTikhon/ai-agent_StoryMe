export const DEFAULT_POST_AUTH_DESTINATION = '/dashboard';
export const INTERACTIVE_CATALOGUE_PATH = '/dashboard/interactive';

const MAX_DESTINATION_LENGTH = 512;
// Placeholder origin used only to normalise relative paths; never navigated to.
const PARSE_BASE = 'http://storyme.invalid';

// Control characters (incl. tab/newline/DEL) and backslashes, which browsers
// treat as path separators in some contexts.
const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f\\]/;

/**
 * Resolves a user-supplied post-authentication destination to a safe internal
 * dashboard path. Anything absent, external, protocol-relative, malformed or
 * that normalises outside /dashboard falls back to /dashboard.
 */
export function resolvePostAuthDestination(raw: string | null | undefined): string {
  if (!raw || raw.length > MAX_DESTINATION_LENGTH) return DEFAULT_POST_AUTH_DESTINATION;
  if (!raw.startsWith('/') || raw.startsWith('//') || FORBIDDEN_CHARS.test(raw)) {
    return DEFAULT_POST_AUTH_DESTINATION;
  }

  let url: URL;
  try {
    url = new URL(raw, PARSE_BASE);
  } catch {
    return DEFAULT_POST_AUTH_DESTINATION;
  }

  const insideDashboard =
    url.origin === PARSE_BASE &&
    (url.pathname === '/dashboard' || url.pathname.startsWith('/dashboard/'));
  if (!insideDashboard) return DEFAULT_POST_AUTH_DESTINATION;

  const resolved = `${url.pathname}${url.search}`;
  return resolved.length > MAX_DESTINATION_LENGTH ? DEFAULT_POST_AUTH_DESTINATION : resolved;
}

/**
 * Builds a login/register link that carries the destination only when it is a
 * valid non-default one, so default navigation keeps its plain URLs.
 */
export function authPageHref(page: '/login' | '/register', rawNext: string | null | undefined) {
  const destination = resolvePostAuthDestination(rawNext);
  return destination === DEFAULT_POST_AUTH_DESTINATION
    ? page
    : `${page}?next=${encodeURIComponent(destination)}`;
}
