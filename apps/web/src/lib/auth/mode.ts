export type AuthMode = 'dev' | 'jwt';

/**
 * Read live (not cached at module scope) so tests can flip
 * process.env['NEXT_PUBLIC_AUTH_MODE'] between cases without reloading modules.
 * Defaults to 'jwt' to match the API's own default (env.schema.ts) — an
 * environment that forgets to set this is safe.
 */
export function getAuthMode(): AuthMode {
  return process.env['NEXT_PUBLIC_AUTH_MODE'] === 'dev' ? 'dev' : 'jwt';
}
