import type { CloudPdfStorageConfig } from '../src/pdf/pdf-storage';

/** Reveals only the first 4 characters; safe for identifiers like access key IDs, never for secrets. */
export function maskCredential(value: string): string {
  if (!value) return '(not set)';
  if (value.length <= 4) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}${'*'.repeat(value.length - 4)}`;
}

/** Never reveals any characters of a secret — only whether it is set and how long it is. */
export function maskSecret(value: string): string {
  return value ? `(set, ${value.length} chars)` : '(not set)';
}

/** Human-readable, secret-redacted summary lines for operator console output. */
export function formatConfigSummary(config: CloudPdfStorageConfig): string[] {
  return [
    `mode:            ${config.driver === 'r2' ? 'Cloudflare R2' : 'AWS S3'} (PDF_STORAGE_DRIVER=${config.driver})`,
    `bucket:          ${config.bucket}`,
    `region:          ${config.region}`,
    `endpoint:        ${config.endpoint ?? '(default AWS endpoint)'}`,
    `forcePathStyle:  ${config.forcePathStyle ?? false}`,
    `accessKeyId:     ${maskCredential(config.accessKeyId)}`,
    `secretAccessKey: ${maskSecret(config.secretAccessKey)}`,
  ];
}
