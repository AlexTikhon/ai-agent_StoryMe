/**
 * Phase F1 — Production/staging deployment preflight.
 *
 * Validates the process's OWN environment (read from `process.env`, exactly
 * as the real app would see it — export/source a target `.env` into the
 * shell before running this, the same way you would before `pnpm --filter
 * @book/api dev`) against the real `envSchema` plus a set of cross-setting
 * deployment invariants ordinary scalar env parsing can't express (CORS
 * origin agreement, storage topology, email/Stripe production-readiness,
 * worker/API topology contradictions — see
 * `apps/api/src/config/preflight-deploy-checks.ts`).
 *
 * Validation only. Makes no network connection, mutates nothing, and never
 * prints a secret value — only env var names and static corrective
 * guidance. Safe to run against real production secrets.
 *
 * Usage:
 *   pnpm --filter @book/api preflight:deploy --role=api
 *   pnpm --filter @book/api preflight:deploy --role=worker
 *
 * See "Pre-deploy preflight check" in docs/private-demo-deploy.md.
 */
import {
  isPreflightRole,
  runPreflight,
  type PreflightRole,
  type PreflightWebContext,
} from '../src/config/preflight-deploy-checks';

function parseRole(argv: string[]): PreflightRole {
  const flag = argv.find((a) => a.startsWith('--role='))?.slice('--role='.length);
  const raw = flag ?? process.env['PREFLIGHT_ROLE'];

  if (!raw) {
    throw new Error(
      'Missing required role. Pass --role=api or --role=worker ' +
        '(or set PREFLIGHT_ROLE=api|worker) — the two entrypoints have different env requirements.',
    );
  }
  if (!isPreflightRole(raw)) {
    throw new Error(`Unknown role "${raw}" (expected "api" or "worker").`);
  }
  return raw;
}

function readWebContext(env: NodeJS.ProcessEnv): PreflightWebContext {
  const web: PreflightWebContext = {};
  if (env['NEXT_PUBLIC_API_URL'] !== undefined) {
    web.nextPublicApiUrl = env['NEXT_PUBLIC_API_URL'];
  }
  if (env['NEXT_PUBLIC_AUTH_MODE'] !== undefined) {
    web.nextPublicAuthMode = env['NEXT_PUBLIC_AUTH_MODE'];
  }
  return web;
}

function main(): void {
  const role = parseRole(process.argv.slice(2));
  const result = runPreflight(process.env, role, readWebContext(process.env));

  console.log(`Preflight check — role: ${role}`);
  console.log('');

  if (result.ok) {
    console.log('✔ No cross-setting deployment issues found.');
    console.log(
      'This does not replace the smoke test checklist (docs/private-demo-deploy.md §6) — ' +
        'it only catches config mistakes before a container starts, not runtime/network issues.',
    );
    return;
  }

  console.error(`✘ ${result.issues.length} issue(s) found:\n`);
  for (const i of result.issues) {
    console.error(`  [${i.code}] ${i.message}\n`);
  }
  process.exitCode = 1;
}

try {
  main();
} catch (err) {
  console.error(`Preflight failed to run: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
