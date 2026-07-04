#!/usr/bin/env node
// Fails the build fast with one clear message instead of letting
// `next build` throw the same "NEXT_PUBLIC_API_URL is not set" error once
// per static page while prerendering (getApiBase() is called at module
// scope in src/lib/api/client.ts, so every page that imports it hits this).
if (!process.env.NEXT_PUBLIC_API_URL) {
  console.error(
    [
      '',
      '✖ NEXT_PUBLIC_API_URL is not set — cannot build @book/web.',
      '',
      '`next build` always runs with NODE_ENV=production, and this app',
      'refuses to silently fall back to localhost in production (see',
      'src/lib/api/config.ts).',
      '',
      'Fix:',
      '  - Local build check: NEXT_PUBLIC_API_URL="http://localhost:4000/api" pnpm --filter @book/web build',
      '  - Vercel/Railway/CI: set NEXT_PUBLIC_API_URL in the platform’s',
      '    build-time environment variables before triggering a build.',
      '',
      'See apps/web/.env.example and README.md#environment for details.',
      '',
    ].join('\n'),
  );
  process.exit(1);
}
