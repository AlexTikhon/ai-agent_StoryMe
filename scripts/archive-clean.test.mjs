import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import {
  assertSafeArchiveEntries,
  collectArchiveEntries,
  exclusionReason,
} from './archive-clean.mjs';

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
    'nested/.docker-data/postgres/base/1',
    'nested/postgres-data/base/1',
    'nested/redis-data/dump.rdb',
    'apps/web/build/server.js',
    'apps/web/playwright-report/index.html',
    'apps/web/test-results/journey/trace.zip',
    'apps/web/blob-report/report.json',
    'var/logs/worker-output.txt',
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
    'review/child-photo.heic',
    'review/child-photo.tiff',
    'review/child-photo.bmp',
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

test('nested unsafe files never enter a collected archive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'storyme-archive-test-'));
  const safeFiles = ['apps/api/src/main.ts', 'apps/api/.env.example', 'docs/CURRENT_PRODUCT.md'];
  const unsafeFiles = [
    '.env',
    'nested/apps/web/.env.production',
    'nested/apps/api/tmp/images/private-child.png',
    'nested/apps/api/tmp/books/book.pdf',
    'nested/.docker-data/postgres/base/1',
    'nested/postgres-data/base/2',
    'nested/redis-data/dump.rdb',
    'nested/minio-data/books/generated.webp',
    'nested/logs/worker-output.txt',
    'nested/apps/api/dist/main.js',
    'nested/apps/web/.next/server.js',
    'nested/.turbo/cache.json',
    'nested/coverage/index.html',
    'nested/playwright-report/index.html',
    'nested/test-results/journey/trace.zip',
    'nested/blob-report/report.json',
    'nested/storyme-clean-previous.tar.gz',
  ];

  try {
    for (const path of [...safeFiles, ...unsafeFiles]) {
      const absolutePath = join(root, ...path.split('/'));
      await mkdir(join(absolutePath, '..'), { recursive: true });
      await writeFile(absolutePath, 'fixture');
    }

    const { included } = await collectArchiveEntries(root);
    assert.deepEqual(included, safeFiles.sort());
    for (const unsafe of unsafeFiles) {
      assert.equal(included.includes(unsafe), false, unsafe);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
