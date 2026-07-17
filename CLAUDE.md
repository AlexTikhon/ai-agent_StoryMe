# StoryMe Claude Code Instructions

## Usage discipline

- Do not use subagents unless explicitly requested.
- Do not run Explore unless explicitly requested.
- Do not perform broad repository exploration.
- Keep changes small, scoped, and deterministic.
- Only inspect files directly related to the requested task.
- Do not rewrite architecture unless explicitly requested.

## Package manager

- Use pnpm.
- Do not use npm or yarn.

## Project structure

- API package: apps/api
- Web package: apps/web
- API package name: @book/api
- Web package name: @book/web

## Quality gates

For API changes:
pnpm --filter @book/api test
pnpm --filter @book/api typecheck

For PDF-related API changes:
pnpm --filter @book/api render:pdf

For Web changes:
pnpm --filter @book/web test
pnpm --filter @book/web typecheck
pnpm --filter @book/web build

## PDF rules

- LocalPdfStorage remains the default driver.
- Normal tests must not hit real S3/R2 network.
- Cloud storage tests must mock the S3 client.
- Manual S3/R2 smoke tests must be explicitly invoked.
- PDF preview endpoint must remain:
  GET /api/books/:id/pdf/preview
- Frontend PDF links must continue using the API preview endpoint.
