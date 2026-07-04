export const DEFAULT_API_BASE = 'http://localhost:4000/api';

/**
 * Read live (not cached at module scope) so tests can flip
 * process.env['NEXT_PUBLIC_API_URL'] / NODE_ENV between cases without
 * reloading modules. Local dev may fall back to localhost, but production
 * must never do so silently — a missing env var there means the app would
 * otherwise call an API that doesn't exist from the user's browser.
 */
export function getApiBase(): string {
  const configured = process.env['NEXT_PUBLIC_API_URL'];
  if (configured) return configured;

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'NEXT_PUBLIC_API_URL is not set. Refusing to fall back to ' +
        `${DEFAULT_API_BASE} in production — set NEXT_PUBLIC_API_URL in the deployment environment.`,
    );
  }

  return DEFAULT_API_BASE;
}
