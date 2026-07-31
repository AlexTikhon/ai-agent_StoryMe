# Phase 8 proven defects

## Mock estimate reported zero work

- Reproduction: the browser estimate for a four-page all-mock run reported zero provider calls even though execution invokes story once, character profile once, and image generation seven times.
- Cause: `buildGenerationEstimate` counted only OpenAI boundary calls.
- Resolution: count logical work for both provider modes while retaining `$0.00` external mock cost. Unit and Playwright assertions now expect 9 calls for four pages.

## E2E did not pin the character provider

- Reproduction: Playwright forced story/image mocks but inherited `CHARACTER_PROFILE_PROVIDER`, allowing a developer environment to select the real provider and change cost behavior.
- Resolution: Playwright explicitly sets all three providers to `mock`. No paid provider was run during Phase 8.

## Windows runner could not launch pnpm

- Reproduction: Node 24 returned `spawnSync pnpm.cmd EINVAL`; the `finally` cleanup still succeeded.
- Resolution: the runner invokes the current pnpm CLI through `process.execPath`/`npm_execpath`, avoiding shell-specific command parsing.

## Home page-image quotes violated the database constraint

- Reproduction: after a successful page-text correction, `POST /pages/1/image-regeneration-quote` returned 500; PostgreSQL rejected `cost_credits=0` although home mode intentionally charges no credit.
- Cause: the Phase 4 constraint required `cost_credits > 0`, while Phase 7 home policy writes zero.
- Resolution: non-destructive migration `20260731120500_allow_home_page_image_quotes` replaces the check with `cost_credits >= 0`. Integration coverage permits zero and rejects negative values; the browser correction/quote/confirm/republication journey passes.
