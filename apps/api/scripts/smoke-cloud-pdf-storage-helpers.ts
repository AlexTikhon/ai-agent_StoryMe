import { randomUUID } from 'node:crypto';
import type { CloudPdfStorageConfig } from '../src/pdf/pdf-storage';

/** Fresh per-run namespace: cannot overwrite a prior smoke or real book object. */
export function createSmokeBookId(): string {
  return `smoke-${randomUUID()}`;
}

export function sameBytes(actual: Buffer, expected: Buffer): boolean {
  return actual.length === expected.length && actual.equals(expected);
}

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
export function formatConfigSummary(
  config: CloudPdfStorageConfig,
  imageDriver: 's3' | 'r2' = config.driver,
): string[] {
  return [
    `mode:            ${config.driver === 'r2' ? 'Cloudflare R2' : 'AWS S3'}`,
    `drivers:         PDF_STORAGE_DRIVER=${config.driver}, IMAGE_STORAGE_DRIVER=${imageDriver}`,
    `bucket:          ${config.bucket}`,
    `region:          ${config.region}`,
    `endpoint:        ${config.endpoint ?? '(default AWS endpoint)'}`,
    `forcePathStyle:  ${config.forcePathStyle ?? false}`,
    `accessKeyId:     ${maskCredential(config.accessKeyId)}`,
    `secretAccessKey: ${maskSecret(config.secretAccessKey)}`,
  ];
}
