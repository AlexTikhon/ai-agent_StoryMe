import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertSafeArchiveEntries, exclusionReason } from './archive-clean.mjs';

test('includes source, migrations, tests, docs, and env examples', () => {
  for (const path of [
    'apps/api/src/main.ts',
    'apps/api/prisma/migrations/20260718000000_phase_g1_generation_cancellation/migration.sql',
    'apps/web/src/app/page.test.tsx',
    'docs/CURRENT_PRODUCT.md',
    '.env.example',
    'apps/web/.env.example',
  ]) {
    assert.equal(exclusionReason(path), null, path);
  }
});

test('excludes environment files without inspecting their contents', () => {
  for (const path of ['.env', '.env.local', 'apps/api/.env', 'apps/web/.env.production']) {
    assert.equal(exclusionReason(path), 'environment/secret file', path);
  }
});

test('excludes dependency, build, cache, temporary, and editor paths', () => {
  for (const path of [
    'node_modules/pkg/index.js',
    'apps/web/.next/server.js',
    'apps/api/dist/main.js',
    'coverage/index.html',
    '.turbo/cache.json',
    '.pnpm-store/v3/file',
    'apps/api/tmp/images/book/photo.jpg',
    'node_modules/example/.env.example',
    '.vscode/settings.json',
    'packages/types/tsconfig.tsbuildinfo',
  ]) {
    assert.ok(exclusionReason(path), path);
  }
});

test('excludes personal artifacts and database/archive files anywhere', () => {
  for (const path of [
    'review/child-photo.jpg',
    'output/book.pdf',
    'data/storyme.sqlite',
    'backup/database.dump',
    'uploads/photo.bin',
    'artifacts/generated.svg',
    'storyme-clean-old.tar.gz',
    'private/private-child-data.txt',
  ]) {
    assert.ok(exclusionReason(path), path);
  }
});

test('fails closed if an unsafe entry reaches the archive list', () => {
  assert.throws(
    () => assertSafeArchiveEntries(['apps/api/src/main.ts', 'apps/api/.env']),
    /Refusing to include unsafe archive entry/,
  );
});
