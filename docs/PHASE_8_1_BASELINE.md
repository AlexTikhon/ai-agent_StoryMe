# Phase 8.1 baseline

Captured on 2026-07-31 before Phase 8.1 edits. The Git base and `HEAD` were both
`bc0d49d693ac79e2fb2bc5f2658399328f77fd87`; Phase 8 was an uncommitted
worktree diff and was preserved.

## Modified and untracked files

Modified: `.env.example`, `apps/api/scripts/e2e-fixtures.ts`, the mock provider
factories/providers and generation-estimate files, `apps/api/src/config/env.schema.ts`,
`apps/api/test/integration/page-image-revisions.integration.spec.ts`,
`apps/web/e2e/storyme.smoke.spec.ts`, `apps/web/playwright.config.ts`, and
`package.json`.

Untracked: migration `20260731120500_allow_home_page_image_quotes`, mock-failure
configuration/tests, Phase 8 documentation (`E2E_TESTING`, lifecycle matrix,
local Home Edition, baseline audit, defects, troubleshooting), and
`scripts/test-home-e2e.mjs`.

`git diff --check` passed. The Phase 8 diff contained 15 tracked files, 138
insertions, and 11 deletions; untracked files are not included in that Git stat.

## Test and risk baseline

Phase 8's recorded current results were 93 passing API integration tests and 11
passing Home Playwright journeys. The release-closure run re-executes every
required gate before a verdict.

The current migration changes `page_image_revisions.cost_credits` from a
strictly-positive check to a non-negative check for Home Edition's server-owned
zero-credit quote.

Known intermittent risk: one recovery/lease assertion failed during an
intermediate full integration run, then passed narrowly and passed in later
93-test runs. The exact historical runner output was not retained, so Phase 8.1
must identify the affected code/assertions from the suite and improve evidence
and isolation without guessing at a longer timeout.

Missing browser scenarios were successful atomic whole-book replacement,
hard-deletion with denial of book/PDF/image endpoints, and a complete
multilingual PDF release check.

The clean Phase 7 commit's global baseline was already red: `pnpm format:check`
reported 133 files and `pnpm lint` stopped on 312 inherited `Delete CR`
Prettier errors in `packages/types/src/agent.types.ts`. Repository-wide
formatting is therefore audit-only for this release; changed-file gates must be
green without modifying unrelated legacy files.
