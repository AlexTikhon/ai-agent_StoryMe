# Cloud PDF storage smoke test

Manual runbook for verifying `CloudPdfStorage` (the S3/R2 driver) against a
**real** AWS S3 or Cloudflare R2 bucket. This is not run in CI and never runs
as part of `pnpm --filter @book/api test` — it requires live credentials and
makes real network calls.

`local` remains the default `PDF_STORAGE_DRIVER` for the app. This smoke test
only exercises the cloud driver in isolation via a standalone script.

## What it does

1. Saves a small sample PDF under a fixed smoke-test book id.
2. Confirms `previewPdfExists` / `getPreviewPdf` return correct data.
3. Confirms a missing book id returns `false` / `null`.
4. Confirms path-traversal book ids are rejected without hitting the network.
5. Deletes the object it created, regardless of whether the checks above
   passed or failed, and reports cleanup failures separately from test
   failures.

The script exits non-zero if any check fails, if cleanup fails, or both.

## Required environment variables

### AWS S3

```
PDF_STORAGE_DRIVER=s3
PDF_STORAGE_BUCKET=storyme-previews
PDF_STORAGE_REGION=us-east-1
PDF_STORAGE_ACCESS_KEY_ID=<your-access-key-id>
PDF_STORAGE_SECRET_ACCESS_KEY=<your-secret-access-key>
```

`PDF_STORAGE_ENDPOINT` is optional for S3 (the AWS SDK infers the regional
endpoint). Leave it unset unless you're pointing at a non-standard endpoint
(e.g. a VPC endpoint or S3-compatible test server).

### Cloudflare R2

```
PDF_STORAGE_DRIVER=r2
PDF_STORAGE_BUCKET=storyme-previews
PDF_STORAGE_REGION=auto
PDF_STORAGE_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
PDF_STORAGE_ACCESS_KEY_ID=<your-r2-access-key-id>
PDF_STORAGE_SECRET_ACCESS_KEY=<your-r2-secret-access-key>
PDF_STORAGE_FORCE_PATH_STYLE=true
```

`PDF_STORAGE_ENDPOINT` is **required** for `r2` — the script fails fast with
a clear error if it's missing. `PDF_STORAGE_FORCE_PATH_STYLE` defaults to
`true` whenever an endpoint is set (which is what R2 needs), so it's only
necessary to set it explicitly if you want to override that default.

## Running it (PowerShell on Windows)

Set the env vars for the current session only, then run the script. Do not
add real credentials to `.env` or any committed file.

```powershell
$env:PDF_STORAGE_DRIVER = "r2"
$env:PDF_STORAGE_BUCKET = "storyme-previews"
$env:PDF_STORAGE_REGION = "auto"
$env:PDF_STORAGE_ENDPOINT = "https://<account-id>.r2.cloudflarestorage.com"
$env:PDF_STORAGE_ACCESS_KEY_ID = "<your-r2-access-key-id>"
$env:PDF_STORAGE_SECRET_ACCESS_KEY = "<your-r2-secret-access-key>"
$env:PDF_STORAGE_FORCE_PATH_STYLE = "true"

pnpm --filter @book/api smoke:pdf-storage
```

For AWS S3, swap the vars above for the S3 block. Close the terminal (or run
`Remove-Item Env:PDF_STORAGE_*`) afterward so credentials don't linger in the
session.

## Expected success output

```
Running cloud PDF storage smoke test against Cloudflare R2...
Config (secrets redacted):
  mode:            Cloudflare R2 (PDF_STORAGE_DRIVER=r2)
  bucket:          storyme-previews
  region:          auto
  endpoint:        https://<account-id>.r2.cloudflarestorage.com
  forcePathStyle:  true
  accessKeyId:     AKIA****************
  secretAccessKey: (set, 40 chars)

[1/5] savePreviewPdf("smoke-test-book")
[2/5] previewPdfExists returns true for the saved book
[3/5] getPreviewPdf reads back matching metadata and content
[4/5] missing bookId returns false / null
[5/5] invalid/path-traversal bookId is rejected

[cleanup] removing smoke-test object...
[cleanup] done.

✔ Cloud PDF storage smoke test passed — all checks succeeded.
```

The process exits `0`.

## Common failures and fixes

| Symptom                                                                | Likely cause                                                             | Fix                                                                                                                            |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `PDF_STORAGE_DRIVER must be "s3" or "r2"`                              | `PDF_STORAGE_DRIVER` unset or set to `local`/something else              | Set it to `s3` or `r2` before running the script                                                                               |
| `requires the following environment variable(s): ...`                  | One or more required vars missing                                        | Set all vars listed in the error; re-check for typos in the var name                                                           |
| `requires the following environment variable(s): PDF_STORAGE_ENDPOINT` | Using `r2` without an endpoint                                           | R2 always needs `PDF_STORAGE_ENDPOINT` — the SDK cannot infer it                                                               |
| `InvalidAccessKeyId` / `SignatureDoesNotMatch`                         | Wrong or revoked access key/secret                                       | Regenerate credentials in the AWS/R2 console and re-set both vars together (a mismatched pair is a common cause)               |
| `NoSuchBucket`                                                         | `PDF_STORAGE_BUCKET` doesn't exist or is in a different account          | Confirm the bucket name and that it exists in the account tied to the credentials                                              |
| `getaddrinfo ENOTFOUND` / connection errors                            | Wrong `PDF_STORAGE_ENDPOINT`, or wrong region for S3                     | Double-check the endpoint URL (R2) or region (S3); typos in the account id are the most common cause for R2                    |
| `PermanentRedirect` / region mismatch errors (S3)                      | `PDF_STORAGE_REGION` doesn't match the bucket's actual region            | Set the region to match the bucket, not your default AWS region                                                                |
| Path-style / 404s that shouldn't happen on R2                          | `PDF_STORAGE_FORCE_PATH_STYLE` explicitly set to `false`                 | Leave it unset (it defaults to `true` when an endpoint is set) or set it to `true`                                             |
| `AccessDenied` on put/get/delete                                       | IAM policy or R2 API token doesn't grant the needed action on the bucket | Grant `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`, and `s3:HeadObject`/`ListBucket` as needed for the bucket/prefix used |
| Network timeout with no other error                                    | Local network, VPN, or firewall blocking egress to the endpoint          | Verify connectivity to the endpoint host from your machine (e.g. `curl` the endpoint)                                          |
| `[cleanup] FAILED` after checks passed                                 | Delete permission missing, or object already removed by another process  | The script logs the exact key and bucket to delete manually; grant `s3:DeleteObject` for next time                             |

## Notes

- Never commit real credentials. `.env.example` only contains placeholders.
- The script only ever touches a single fixed key
  (`previews/smoke-test-book/storyme-preview-smoke-test-book.pdf`) and always
  attempts to delete it, so re-running it repeatedly is safe.
- If cleanup fails after the checks otherwise passed, the script still exits
  non-zero and prints the exact object to remove by hand.
