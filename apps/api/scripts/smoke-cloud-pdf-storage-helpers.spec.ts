import { describe, it, expect } from 'vitest';
import { maskCredential, maskSecret, formatConfigSummary } from './smoke-cloud-pdf-storage-helpers';

describe('maskCredential', () => {
  it('returns "(not set)" for an empty value', () => {
    expect(maskCredential('')).toBe('(not set)');
  });

  it('masks all characters when the value is 4 chars or shorter', () => {
    expect(maskCredential('ABCD')).toBe('****');
    expect(maskCredential('AB')).toBe('**');
  });

  it('keeps the first 4 characters and masks the rest', () => {
    expect(maskCredential('AKIAABCDEFGHIJKLMNOP')).toBe('AKIA****************');
  });
});

describe('maskSecret', () => {
  it('returns "(not set)" for an empty value', () => {
    expect(maskSecret('')).toBe('(not set)');
  });

  it('reveals only that a value is set and its length, never its characters', () => {
    const summary = maskSecret('super-secret-value');
    expect(summary).toBe('(set, 18 chars)');
    expect(summary).not.toContain('super-secret-value');
  });
});

describe('formatConfigSummary', () => {
  const baseConfig = {
    driver: 's3' as const,
    bucket: 'storyme-previews',
    region: 'us-east-1',
    accessKeyId: 'AKIAABCDEFGH',
    secretAccessKey: 'topsecretvalue',
  };

  it('labels s3 driver as AWS S3', () => {
    const lines = formatConfigSummary(baseConfig);
    expect(lines.some((line) => line.includes('AWS S3'))).toBe(true);
    expect(lines.some((line) => line.includes('PDF_STORAGE_DRIVER=s3'))).toBe(true);
  });

  it('labels r2 driver as Cloudflare R2', () => {
    const lines = formatConfigSummary({
      ...baseConfig,
      driver: 'r2',
      endpoint: 'https://abc.r2.cloudflarestorage.com',
    });
    expect(lines.some((line) => line.includes('Cloudflare R2'))).toBe(true);
  });

  it('shows "(default AWS endpoint)" when no endpoint is configured', () => {
    const lines = formatConfigSummary(baseConfig);
    expect(lines.some((line) => line.includes('(default AWS endpoint)'))).toBe(true);
  });

  it('never includes the raw secret access key value', () => {
    const lines = formatConfigSummary(baseConfig).join('\n');
    expect(lines).not.toContain('topsecretvalue');
  });

  it('never includes the full raw access key id value', () => {
    const lines = formatConfigSummary(baseConfig).join('\n');
    expect(lines).not.toContain('AKIAABCDEFGH');
  });

  it('includes bucket and region unredacted', () => {
    const lines = formatConfigSummary(baseConfig);
    expect(lines.some((line) => line.includes('storyme-previews'))).toBe(true);
    expect(lines.some((line) => line.includes('us-east-1'))).toBe(true);
  });
});
