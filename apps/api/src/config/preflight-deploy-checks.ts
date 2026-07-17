import { envSchema, type Env } from './env.schema';
import { readCloudConfig } from '../pdf/pdf-storage';

/**
 * Which process this preflight run is validating — the two deployed
 * entrypoints (`apps/api/src/main.ts` / `apps/api/src/worker.ts`) have
 * different env requirements (see the environment ownership matrix in
 * `docs/private-demo-deploy.md` §3.2), so a config valid for one can be
 * invalid for the other.
 */
export type PreflightRole = 'api' | 'worker';

const ROLES: readonly PreflightRole[] = ['api', 'worker'];

export function isPreflightRole(value: string): value is PreflightRole {
  return (ROLES as readonly string[]).includes(value);
}

/**
 * A single preflight finding. `message` is always safe to print to a
 * terminal or CI log — it names only env var identifiers and static
 * guidance, never a value read from the environment being validated (see
 * "Safety requirements" in the Phase F1 task — this is deploy tooling, not a
 * debugging aid, so it must stay safe even run against real secrets).
 */
export interface PreflightIssue {
  /** Stable, grep-able identifier — not shown to the user, useful for tests/tooling. */
  code: string;
  message: string;
}

export interface PreflightResult {
  ok: boolean;
  issues: PreflightIssue[];
}

/** Extra, optional web-side context this API-scoped preflight can still cross-check when present in the same env (see §3.1's "API and web URL/prefix consistency" invariant). Never required. */
export interface PreflightWebContext {
  nextPublicApiUrl?: string;
  nextPublicAuthMode?: string;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function originOf(value: string): string | null {
  try {
    const u = new URL(value);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

function issue(code: string, message: string): PreflightIssue {
  return { code, message };
}

// ─── Individual invariant checks (pure functions of the parsed Env) ────────

export function checkNodeEnv(env: Env): PreflightIssue[] {
  if (env.NODE_ENV !== 'production') {
    return [
      issue(
        'node_env_not_production',
        'NODE_ENV must be set to "production" for a public production/staging deployment. ' +
          'Several other safety guards (email provider gating, the PDF-storage worker guard) ' +
          'only activate when NODE_ENV=production, so leaving it unset/development silently ' +
          'disables them too.',
      ),
    ];
  }
  return [];
}

export function checkAuthMode(env: Env): PreflightIssue[] {
  if (env.AUTH_MODE !== 'jwt') {
    return [
      issue(
        'auth_mode_not_jwt',
        'AUTH_MODE must be "jwt" for any publicly reachable deployment. "dev" (DevAuthGuard) ' +
          'trusts a plain x-user-email header with no credential check — anyone who can reach ' +
          'this API can impersonate any user. Set AUTH_MODE=jwt (and the matching ' +
          'NEXT_PUBLIC_AUTH_MODE=jwt on the web app).',
      ),
    ];
  }
  return [];
}

export function checkWebAppUrlHttps(env: Env): PreflightIssue[] {
  if (!isHttpsUrl(env.WEB_APP_URL)) {
    return [
      issue(
        'web_app_url_not_https',
        'WEB_APP_URL must be an https:// URL for a public deployment — it is embedded directly ' +
          'into verification/reset email links, and an http:// link sent to a real user is both ' +
          "insecure and inconsistent with the refresh cookie's Secure flag (which requires HTTPS " +
          'in production).',
      ),
    ];
  }
  return [];
}

export function checkAllowedOrigins(env: Env): PreflightIssue[] {
  const found: PreflightIssue[] = [];
  const origins = env.ALLOWED_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  if (origins.includes('*')) {
    found.push(
      issue(
        'allowed_origins_wildcard',
        'ALLOWED_ORIGINS must not contain "*" — CORS is configured with credentials: true, so a ' +
          'wildcard origin would let any site make authenticated requests using a signed-in ' +
          "user's cookie/token. List only the specific deployed web origin(s), comma-separated.",
      ),
    );
  }

  const webOrigin = originOf(env.WEB_APP_URL);
  if (webOrigin && !origins.includes('*') && !origins.includes(webOrigin)) {
    found.push(
      issue(
        'allowed_origins_missing_web_app_url',
        'ALLOWED_ORIGINS does not contain the origin derived from WEB_APP_URL. The two should ' +
          'normally agree: WEB_APP_URL is where verification/reset links point, and ' +
          'ALLOWED_ORIGINS is the CORS allowlist the web app must be in to call this API at all. ' +
          "Add the deployed web app's exact origin to ALLOWED_ORIGINS (or fix WEB_APP_URL if it " +
          'points somewhere else on purpose).',
      ),
    );
  }

  return found;
}

/**
 * Cross-checks the web app's build-time vars against this API's own config,
 * when the operator happens to have them in the same env (e.g. a shared
 * local `.env`, or explicitly exported for this check) — see
 * `docs/private-demo-deploy.md` §3.2. Never required; silently skipped when
 * absent, since these vars are normally set in a separate host panel
 * (Vercel), not on the API service.
 */
export function checkWebApiConsistency(env: Env, web: PreflightWebContext): PreflightIssue[] {
  const found: PreflightIssue[] = [];

  if (web.nextPublicApiUrl !== undefined) {
    if (!isHttpsUrl(web.nextPublicApiUrl)) {
      found.push(
        issue(
          'next_public_api_url_not_https',
          'NEXT_PUBLIC_API_URL must be an https:// URL for a public deployment.',
        ),
      );
    }
    if (!web.nextPublicApiUrl.replace(/\/+$/, '').endsWith('/api')) {
      found.push(
        issue(
          'next_public_api_url_missing_prefix',
          'NEXT_PUBLIC_API_URL must include the "/api" suffix — this API always mounts its ' +
            'routes under the global "api" prefix (app.setGlobalPrefix(\'api\') in main.ts), so ' +
            'a base URL without it 404s every request.',
        ),
      );
    }
  }

  if (web.nextPublicAuthMode !== undefined && web.nextPublicAuthMode !== env.AUTH_MODE) {
    found.push(
      issue(
        'auth_mode_mismatch',
        'NEXT_PUBLIC_AUTH_MODE (web) does not match AUTH_MODE (this API). A mismatch makes the ' +
          'web app send an identity the API does not accept for that mode — every request 401s. ' +
          'Set both to the same value ("jwt" for any public deployment).',
      ),
    );
  }

  return found;
}

/**
 * A production deployment of either process must not use the local
 * filesystem for PDFs/generated images — every recommended host here has an
 * ephemeral and/or non-shared-between-services filesystem. Stricter than
 * the existing runtime guard (`assertPdfStorageSupportsWorker`, which only
 * fires for the dedicated worker entrypoint) because this tool exists
 * specifically to catch the config mistake *before* anything boots.
 */
export function checkStorageTopology(env: Env): PreflightIssue[] {
  const found: PreflightIssue[] = [];

  if (env.PDF_STORAGE_DRIVER === 'local') {
    found.push(
      issue(
        'pdf_storage_local_in_production',
        'PDF_STORAGE_DRIVER=local (the default) is not safe for a public production/staging ' +
          'deployment — the container filesystem is ephemeral and, in the recommended ' +
          'api+worker topology, not shared between the two processes at all. Set ' +
          'PDF_STORAGE_DRIVER to "s3" or "r2" plus the matching PDF_STORAGE_* credentials.',
      ),
    );
  }

  if (env.IMAGE_STORAGE_DRIVER === 'local') {
    found.push(
      issue(
        'image_storage_local_in_production',
        'IMAGE_STORAGE_DRIVER=local (the default) is not safe for a public production/staging ' +
          'deployment, for the same ephemeral/non-shared-filesystem reason as PDF storage. Set ' +
          'IMAGE_STORAGE_DRIVER to "s3" or "r2" (it reuses the same PDF_STORAGE_* credentials).',
      ),
    );
  }

  return found;
}

/** Delegates to the same readCloudConfig() the real drivers use at boot — never a second, divergent notion of "complete". */
export function checkCloudStorageCompleteness(env: Env): PreflightIssue[] {
  const found: PreflightIssue[] = [];

  if (env.PDF_STORAGE_DRIVER === 's3' || env.PDF_STORAGE_DRIVER === 'r2') {
    try {
      readCloudConfig(env.PDF_STORAGE_DRIVER, env as unknown as NodeJS.ProcessEnv);
    } catch (err) {
      found.push(issue('pdf_storage_incomplete', errorMessage(err)));
    }
  }

  if (env.IMAGE_STORAGE_DRIVER === 's3' || env.IMAGE_STORAGE_DRIVER === 'r2') {
    try {
      readCloudConfig(
        env.IMAGE_STORAGE_DRIVER,
        env as unknown as NodeJS.ProcessEnv,
        'IMAGE_STORAGE_DRIVER',
      );
    } catch (err) {
      found.push(issue('image_storage_incomplete', errorMessage(err)));
    }
  }

  return found;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Mirrors the runtime warning already logged by createEmailService
 * (email-provider.factory.ts) when NODE_ENV=production resolves to the
 * console provider, but as a preflight *failure* instead of a boot-time log
 * line an operator could easily miss.
 */
export function checkEmailProductionCapable(env: Env): PreflightIssue[] {
  const provider = env.EMAIL_PROVIDER?.trim().toLowerCase();
  const isConsole = !provider || provider === 'console';
  const debugLogLinks = env.EMAIL_DEBUG_LOG_LINKS === 'true';

  if (isConsole && !debugLogLinks) {
    return [
      issue(
        'email_provider_not_production_capable',
        'EMAIL_PROVIDER is unset/"console" — verification and password-reset emails will NOT be ' +
          'delivered to real users, only logged server-side. Set EMAIL_PROVIDER=resend plus ' +
          'RESEND_API_KEY and EMAIL_FROM, or set EMAIL_DEBUG_LOG_LINKS=true only as a temporary, ' +
          'explicitly-acknowledged fallback.',
      ),
    ];
  }

  return [];
}

/**
 * ENABLE_GENERATION_WORKER=true is a same-container dev convenience
 * (main.ts self-registers the queue processor); every deployed environment
 * runs the worker as its own process (worker.ts, which always registers the
 * processor regardless of this var). Leaving it true on a deployed **api**
 * service double-consumes jobs alongside the dedicated worker service.
 */
export function checkWorkerApiTopology(env: Env, role: PreflightRole): PreflightIssue[] {
  if (role === 'api' && env.ENABLE_GENERATION_WORKER === 'true') {
    return [
      issue(
        'enable_generation_worker_set_on_api',
        'ENABLE_GENERATION_WORKER=true must not be set on a deployed "api" service — it is a ' +
          'single-process local dev convenience only. In every deployed environment the ' +
          'generation worker runs as its own process (apps/api/src/worker.ts, which always ' +
          'registers the queue processor regardless of this var); leaving it true here as well ' +
          'means two processes both claim jobs from the same queue. Unset it or set it to false.',
      ),
    ];
  }
  return [];
}

/**
 * Runs every cross-setting invariant check against an already-parsed Env,
 * scoped by role per the environment ownership matrix
 * (`docs/private-demo-deploy.md` §3.2): checks tied to the HTTP surface
 * (auth mode, CORS, email link building, web build-time consistency) only
 * apply to the "api" role — the worker never reads those vars, so flagging
 * them there would be checking something that role doesn't own, not a real
 * worker misconfiguration. Storage and topology checks apply to both, since
 * both processes read the PDF_STORAGE_ and IMAGE_STORAGE_ var groups. Pure —
 * no I/O, no network.
 */
export function runPreflightChecks(
  env: Env,
  role: PreflightRole,
  web: PreflightWebContext = {},
): PreflightIssue[] {
  const universal = [
    ...checkNodeEnv(env),
    ...checkStorageTopology(env),
    ...checkCloudStorageCompleteness(env),
    ...checkWorkerApiTopology(env, role),
  ];

  if (role !== 'api') {
    return universal;
  }

  return [
    ...universal,
    ...checkAuthMode(env),
    ...checkWebAppUrlHttps(env),
    ...checkAllowedOrigins(env),
    ...checkWebApiConsistency(env, web),
    ...checkEmailProductionCapable(env),
  ];
}

/**
 * Top-level entry point: validates the raw env against the real envSchema
 * first (the single source of truth for scalar shape — Database/Redis
 * presence, JWT secret length, Stripe-enabled completeness, resend
 * completeness, etc. are all already enforced there via superRefine, so
 * this file never re-implements them), then layers the cross-setting
 * deployment invariants ordinary scalar parsing can't express. Still a pure
 * function of its inputs — no I/O, no network, safe to call from a unit
 * test as freely as from the CLI.
 */
export function runPreflight(
  raw: NodeJS.ProcessEnv,
  role: PreflightRole,
  web: PreflightWebContext = {},
): PreflightResult {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.errors.map((e) =>
      issue(
        `env_schema:${e.path.join('.') || '(root)'}`,
        `${e.path.join('.') || '(root)'}: ${e.message}`,
      ),
    );
    return { ok: false, issues };
  }

  const issues = runPreflightChecks(parsed.data, role, web);
  return { ok: issues.length === 0, issues };
}
