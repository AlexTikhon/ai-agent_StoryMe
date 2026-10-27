import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  assertMockEstimate,
  CaptureFailure,
  createRecorder,
  createRunDirectory,
  describeArtifacts,
  inspectPdf,
  pdfProblems,
  runId,
  sha256,
  SHOWCASE_BOOKS,
  writeManifest,
} from './demo-capture.mjs';

const mockEstimate = { kind: 'initial', providerMode: 'mock', maximumProviderCalls: 9 };

test('accepts only an initial estimate that the server reports as mock', () => {
  assert.doesNotThrow(() => assertMockEstimate(mockEstimate));
  for (const estimate of [
    { ...mockEstimate, providerMode: 'real' },
    { ...mockEstimate, providerMode: undefined },
    null,
    'mock',
  ]) {
    assert.throws(
      () => assertMockEstimate(estimate),
      (error) => error instanceof CaptureFailure && error.status === 3,
    );
  }
  assert.throws(() => assertMockEstimate({ ...mockEstimate, kind: 'retry' }), CaptureFailure);
});

test('never infers mock mode from a zero cost', () => {
  const zeroCostReal = {
    kind: 'initial',
    providerMode: 'real',
    estimatedCostUsd: { minimum: 0, maximum: 0, label: 'estimate' },
  };
  assert.throws(() => assertMockEstimate(zeroCostReal), /providerMode="real"/);
});

function fakePdf(pages, { fonts = 1, images = 1, padding = 12_000, eof = true } = {}) {
  const objects = [
    '<< /Type /Pages /Count 0 >>',
    ...Array.from({ length: pages }, () => '<< /Type /Page /Parent 1 0 R >>'),
    ...Array.from({ length: fonts }, () => '<< /FontFile2 9 0 R >>'),
    ...Array.from({ length: images }, () => '<< /Type /XObject /Subtype /Image >>'),
  ];
  return Buffer.from(
    `%PDF-1.3\n${objects.join('\n')}\n${'x'.repeat(padding)}\n${eof ? '%%EOF\n' : ''}`,
    'latin1',
  );
}

test('reports PDF framing, page objects, embedded fonts, and images', () => {
  const report = inspectPdf(fakePdf(6));
  assert.equal(report.header, true);
  assert.equal(report.eof, true);
  assert.equal(report.pageCount, 6); // /Type /Pages is not counted
  assert.deepEqual(pdfProblems(report, 6), []);

  const broken = inspectPdf(fakePdf(5, { fonts: 0, images: 0, padding: 10, eof: false }));
  assert.deepEqual(pdfProblems(broken, 6), [
    'missing %%EOF trailer',
    '5 pages, expected 6',
    'no embedded TrueType font',
    'no embedded images',
    `only ${broken.bytes} bytes`,
  ]);
  assert.equal(inspectPdf(Buffer.from('<html>not a pdf</html>')).header, false);
});

test('creates a fresh run directory and refuses to reuse one', () => {
  const root = mkdtempSync(join(tmpdir(), 'storyme-showcase-'));
  try {
    const id = runId(new Date('2026-10-27T12:34:56.789Z'), 'abc123');
    assert.equal(id, '20261027T123456Z-abc123');
    const dir = createRunDirectory(root, id);
    assert.throws(() => createRunDirectory(root, id), /EEXIST/);
    writeFileSync(join(dir, 'pdf', 'storyme-en.pdf'), 'pdf');
    writeFileSync(join(dir, 'screenshots', 'a.png'), 'png');

    const record = createRecorder({ runId: id });
    assert.throws(
      () => record.validate({ name: 'x', passed: false, detail: 'why' }),
      /Validation failed: x/,
    );
    record.manifest.status = 'incomplete';
    writeManifest(dir, record.manifest);
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.status, 'incomplete');
    assert.deepEqual(manifest.artifacts, [
      { path: 'pdf/storyme-en.pdf', bytes: 3, sha256: sha256(Buffer.from('pdf')) },
      { path: 'screenshots/a.png', bytes: 3, sha256: sha256(Buffer.from('png')) },
    ]);
    assert.deepEqual(describeArtifacts(dir), manifest.artifacts); // manifest excludes itself
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('uses one synthetic, photo-free input in its own script per supported language', () => {
  assert.deepEqual(
    SHOWCASE_BOOKS.map((book) => book.language),
    ['en', 'ru', 'pl'],
  );
  for (const book of SHOWCASE_BOOKS) {
    assert.equal('photo' in book, false);
    assert.match(`${book.theme} ${book.educationalMessage}`, book.script);
  }
});
