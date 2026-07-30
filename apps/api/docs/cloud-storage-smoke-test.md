# Cloud artifact storage smoke test

Manual runbook for verifying `CloudPdfStorage` and `CloudImageAssetStorage`
together against a **real** AWS S3 or Cloudflare R2 bucket. This command is
never run by CI or the normal test suite: it requires live credentials,
writes temporary objects, and makes real network calls.

Local storage remains the development default. Use this command only for an
explicitly authorized staging/production storage check.

## Safety and behavior

Each invocation:

1. Mints a fresh `smoke-<uuid>` book namespace so it cannot overwrite an
   earlier smoke object or a real book artifact.
2. Saves and reads back exact PDF bytes.
3. Saves, reads, and server-side copies an image, then reads back exact bytes.
4. Verifies missing objects and path-traversal identifiers behave safely.
5. Deletes only that UUID-scoped book's PDF and image prefixes through the
   same storage deletion boundaries used by hard deletion.
6. Freshly verifies every smoke artifact is absent before returning success.

The command exits non-zero if a check or cleanup verification fails. Provider
exceptions are deliberately summarized rather than dumped so credentials are
never printed.

## Required environment variables

### AWS S3

```text
PDF_STORAGE_DRIVER=s3
IMAGE_STORAGE_DRIVER=s3
PDF_STORAGE_BUCKET=storyme-previews
PDF_STORAGE_REGION=us-east-1
PDF_STORAGE_ACCESS_KEY_ID=<your-access-key-id>
PDF_STORAGE_SECRET_ACCESS_KEY=<your-secret-access-key>
```

`PDF_STORAGE_ENDPOINT` is optional for AWS S3.

### Cloudflare R2

```text
PDF_STORAGE_DRIVER=r2
IMAGE_STORAGE_DRIVER=r2
PDF_STORAGE_BUCKET=storyme-previews
PDF_STORAGE_REGION=auto
PDF_STORAGE_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
PDF_STORAGE_ACCESS_KEY_ID=<your-r2-access-key-id>
PDF_STORAGE_SECRET_ACCESS_KEY=<your-r2-secret-access-key>
PDF_STORAGE_FORCE_PATH_STYLE=true
```

The PDF and image drivers must select the same provider and intentionally
reuse the same bucket and credentials.

## Running it on PowerShell

Set the variables only for the current shell:

```powershell
$env:PDF_STORAGE_DRIVER = "r2"
$env:IMAGE_STORAGE_DRIVER = "r2"
$env:PDF_STORAGE_BUCKET = "storyme-previews"
$env:PDF_STORAGE_REGION = "auto"
$env:PDF_STORAGE_ENDPOINT = "https://<account-id>.r2.cloudflarestorage.com"
$env:PDF_STORAGE_ACCESS_KEY_ID = "<your-r2-access-key-id>"
$env:PDF_STORAGE_SECRET_ACCESS_KEY = "<your-r2-secret-access-key>"
$env:PDF_STORAGE_FORCE_PATH_STYLE = "true"

pnpm --filter @book/api smoke:cloud-storage
```

Close the terminal or remove the environment variables afterward so
credentials do not linger in the session.

## Expected result

Successful output identifies only the provider mode, masked configuration,
and the generated UUID namespace. It ends with:

```text
[cleanup] complete and freshly verified absent.

✔ Cloud PDF and image storage smoke test passed.
```

## Common failures

| Symptom                                  | Likely cause                                       | Required action                                              |
| ---------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------ |
| A storage driver must be `s3` or `r2`    | Driver is unset or still `local`                   | Set both drivers to the selected cloud provider              |
| Drivers must select the same provider    | PDF/image driver mismatch                          | Set both to `s3` or both to `r2`                             |
| Missing required environment variables   | Incomplete bucket configuration                    | Supply every variable named by the validation error          |
| `InvalidAccessKeyId` / signature failure | Wrong or mismatched credential pair                | Rotate or re-enter the provider credentials                  |
| `NoSuchBucket` / endpoint failure        | Wrong bucket, region, account, or endpoint         | Verify settings in the provider dashboard                    |
| Cleanup verification fails               | Missing delete/list permission or provider failure | Inspect and remove only the printed `smoke-<uuid>` namespace |

Never commit real credentials. If cleanup fails, the UUID namespace is the
only scope an operator should inspect or remove manually.
