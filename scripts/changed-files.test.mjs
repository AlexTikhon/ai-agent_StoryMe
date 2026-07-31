import assert from 'node:assert/strict';
import test from 'node:test';
import { parseNulList, selectChangedFiles } from './changed-files-lib.mjs';

test('parses NUL-delimited names without breaking spaces', () => {
  assert.deepEqual(parseNulList('apps/web/a file.ts\0docs/note.md\0'), [
    'apps/web/a file.ts',
    'docs/note.md',
  ]);
});

test('includes modified, renamed destinations, and untracked files once', () => {
  assert.deepEqual(
    selectChangedFiles(
      'apps/api/modified.ts\0apps/web/renamed destination.tsx\0',
      'apps/api/new.ts\0apps/api/modified.ts\0',
      'lint',
    ),
    ['apps/api/modified.ts', 'apps/api/new.ts', 'apps/web/renamed destination.tsx'],
  );
});

test('uses mode extensions and excludes generated outputs', () => {
  const input = 'docs/release.md\0apps/api/value.ts\0apps/web/.next/generated.js\0coverage/a.js\0';
  assert.deepEqual(selectChangedFiles(input, '', 'format'), [
    'apps/api/value.ts',
    'docs/release.md',
  ]);
  assert.deepEqual(selectChangedFiles(input, '', 'lint'), ['apps/api/value.ts']);
});
