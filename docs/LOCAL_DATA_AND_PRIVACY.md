# Local Data and Privacy

StoryMe processes children's names, ages, optional photos, generated illustrations, story text,
and PDFs. Treat PostgreSQL, object storage, and local runtime data as private.

## Storage locations

The uploaded original photo is buffered in API-process memory only. Sharp decodes it, applies byte
and pixel limits, auto-orients it, and re-encodes it without EXIF, XMP, ICC, or GPS metadata. The
original is not intentionally persisted.

The processed photo receives an immutable versioned key. Local image storage places it below
`apps/api/tmp/images/`, alongside character sheets, covers, pages, and back covers. S3/R2 uses the
bucket's `images/` prefix. PostgreSQL retains its key, content type, hash, and size. Local PDFs
live below `apps/api/tmp/books/`; cloud PDFs use claim/PDF bucket keys. PostgreSQL also contains
account/book input, generated JSON, artifact pointers, run diagnostics, and credit records.
Docker PostgreSQL, Redis, and optional MinIO volumes are private local data outside the repository.

`pnpm archive:clean` excludes these locations without reading excluded file contents.

## Data leaving the machine

Mocks are the default and make no provider call. Enabling OpenAI story generation sends child
name, age, theme, language, page/lesson input, and a derived character profile. Enabling OpenAI
character-profile generation can send the processed photo and child/book context. Enabling OpenAI
images sends prompts and can send the generated character sheet. Resend receives account email
and verification/reset messages. Stripe receives checkout/account metadata while card data stays
on hosted Checkout. S3/R2 receives processed photos, images, and PDFs.

## Safe cleanup

Local deletion never runs automatically. Stop API/worker processes, then run:

```text
pnpm privacy:cleanup-local
```

This is a dry run: it reports the exact repository-relative scope and file count and deletes
nothing. After backing up anything needed, confirm explicitly:

```text
pnpm privacy:cleanup-local -- --apply
```

The confirmed command removes only `apps/api/tmp/`. It does not touch PostgreSQL, Redis, Docker
volumes, S3/R2, or arbitrary user directories. Database/cloud deletion remains a deliberate
provider-specific operation. Never invoke the apply form from startup, tests, archive, or deploy.

Deleting a Book currently sets `deletedAt`. It hides the Book from normal reads but does not
necessarily erase generated JSON, logs, processed photos, images, PDFs, or cloud objects. It must
not be described as complete erasure.

## Exposed-key response

1. Revoke/rotate the key immediately in the provider dashboard.
2. Replace it only in the deployment secret store or untracked local environment file.
3. Restart affected API/worker services and verify the replacement is active.
4. Review provider audit/usage and billing for unexpected activity.
5. Treat a key in Git history or an archive as compromised even after editing the file; remove
   the unsafe artifact from circulation and follow the host's secret-remediation procedure.

Never paste or print a real credential during repository maintenance.
