# Inactive workflow examples

These files are **not** GitHub Actions workflows. GitHub only discovers
workflows under `.github/workflows/`; nothing in this directory runs on push,
pull request, schedule or manual dispatch.

Each file is a fully commented-out YAML draft kept as reference material:

| File                                                         | Former workflow name        | Purpose of the draft                                                          |
| ------------------------------------------------------------ | --------------------------- | ----------------------------------------------------------------------------- |
| [`migrate.example.yml`](migrate.example.yml)                 | Database Migration (Manual) | Approval-gated `prisma migrate deploy` against a selected staging/production. |
| [`staging-backup.example.yml`](staging-backup.example.yml)   | Staging Database Backup     | Daily logical dump, upload to the artifact bucket and disposable restore.     |
| [`staging-monitor.example.yml`](staging-monitor.example.yml) | Staging Health Monitor      | Ten-minute `/api/health` probe that opens/closes a `staging-alert` issue.     |

The only active workflow is [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml).

## Before reactivating any draft

Reactivation is a deliberate operator decision, not part of the current
release. It would require at least:

1. uncommenting the YAML and validating it (for example with `actionlint`);
2. aligning its Node version with [`.nvmrc`](../../.nvmrc) and its pnpm
   version with `packageManager` in the root `package.json`;
3. configuring the GitHub Environment, secrets, variables and required
   reviewers described in [staging-operations.md](../staging-operations.md)
   and [private-demo-deploy.md §5a](../private-demo-deploy.md#phase-f3-migration-workflow);
4. moving the file back under `.github/workflows/`.

None of those steps has been performed for the current release.
