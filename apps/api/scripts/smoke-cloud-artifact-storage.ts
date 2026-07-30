/**
 * Manual S3/R2 artifact-storage smoke test.
 *
 * Verifies the real cloud PDF and image drivers together. Never run in CI:
 * this command requires live credentials, writes beneath a fresh UUID-scoped
 * book namespace, and makes real network calls.
 */
import { createPdfStorage, readCloudConfig, type PdfStorage } from '../src/pdf/pdf-storage';
import {
  createImageAssetStorage,
  imageAssetKey,
  type ImageAssetStorage,
} from '../src/images/image-asset-storage';
import {
  createSmokeBookId,
  formatConfigSummary,
  sameBytes,
} from './smoke-cloud-pdf-storage-helpers';

const SAMPLE_PDF = Buffer.from('%PDF-1.4\n% StoryMe cloud storage smoke test\n%%EOF\n');
const SAMPLE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const INVALID_ID = '../evil';

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function assertRejects(promise: Promise<unknown>, message: string): Promise<void> {
  let rejected = false;
  try {
    await promise;
  } catch {
    rejected = true;
  }
  assert(rejected, message);
}

async function runPdfChecks(storage: PdfStorage, bookId: string): Promise<void> {
  const missingBookId = `${bookId}-missing`;

  console.log(`[1/9] savePreviewPdf("${bookId}")`);
  await storage.savePreviewPdf(bookId, SAMPLE_PDF);

  console.log('[2/9] PDF existence/read returns the exact saved bytes');
  assert(await storage.previewPdfExists(bookId), 'expected the saved PDF to exist');
  const result = await storage.getPreviewPdf(bookId);
  assert(result !== null, 'expected getPreviewPdf to return the saved PDF');
  assert(result.contentType === 'application/pdf', 'expected PDF content type metadata');
  assert(sameBytes(result.buffer, SAMPLE_PDF), 'expected exact PDF byte round-trip');

  console.log('[3/9] missing PDF returns false/null');
  assert(!(await storage.previewPdfExists(missingBookId)), 'expected missing PDF not to exist');
  assert((await storage.getPreviewPdf(missingBookId)) === null, 'expected missing PDF to be null');

  console.log('[4/9] invalid PDF book ids are rejected before storage access');
  await assertRejects(
    storage.savePreviewPdf(INVALID_ID, SAMPLE_PDF),
    'expected invalid PDF book id to be rejected',
  );
}

async function runImageChecks(storage: ImageAssetStorage, bookId: string): Promise<void> {
  const sourceKey = imageAssetKey(bookId, 'cover');
  const copyKey = imageAssetKey(bookId, 'page', 1);
  const missingKey = imageAssetKey(`${bookId}-missing`, 'cover');

  console.log(`[5/9] saveImageAsset("${sourceKey}")`);
  await storage.saveImageAsset(sourceKey, SAMPLE_PNG, 'image/png');

  console.log('[6/9] image read returns the exact saved bytes');
  const saved = await storage.getImageAsset(sourceKey);
  assert(saved !== undefined, 'expected the saved image to exist');
  assert(sameBytes(saved, SAMPLE_PNG), 'expected exact image byte round-trip');

  console.log('[7/9] server-side image copy is readable with matching bytes');
  const copiedRef = await storage.copyImageAsset(sourceKey, copyKey);
  assert(copiedRef !== undefined, 'expected the cloud image copy to succeed');
  const copied = await storage.getImageAsset(copyKey);
  assert(copied !== undefined, 'expected the copied image to exist');
  assert(sameBytes(copied, SAMPLE_PNG), 'expected exact copied-image byte round-trip');

  console.log('[8/9] missing image returns undefined');
  assert((await storage.getImageAsset(missingKey)) === undefined, 'expected missing image');

  console.log('[9/9] invalid image keys are rejected before storage access');
  await assertRejects(
    storage.saveImageAsset(INVALID_ID, SAMPLE_PNG, 'image/png'),
    'expected invalid image key to be rejected',
  );
}

async function cleanup(
  pdfStorage: PdfStorage,
  imageStorage: ImageAssetStorage,
  bookId: string,
): Promise<unknown[]> {
  const failures: unknown[] = [];

  for (const [label, operation] of [
    ['PDF', () => pdfStorage.deleteBookArtifacts(bookId)],
    ['image', () => imageStorage.deleteBookArtifacts(bookId)],
  ] as const) {
    try {
      const result = await operation();
      if (!result.complete) {
        failures.push(new Error(`${label} cleanup reported incomplete`));
      }
    } catch (err) {
      failures.push(err);
    }
  }

  try {
    if (await pdfStorage.previewPdfExists(bookId)) {
      failures.push(new Error('PDF remained after cleanup'));
    }
    if (await imageStorage.getImageAsset(imageAssetKey(bookId, 'cover'))) {
      failures.push(new Error('source image remained after cleanup'));
    }
    if (await imageStorage.getImageAsset(imageAssetKey(bookId, 'page', 1))) {
      failures.push(new Error('copied image remained after cleanup'));
    }
  } catch (err) {
    failures.push(err);
  }

  return failures;
}

async function main(): Promise<void> {
  const pdfDriver = process.env['PDF_STORAGE_DRIVER'];
  const imageDriver = process.env['IMAGE_STORAGE_DRIVER'];
  if (pdfDriver !== 's3' && pdfDriver !== 'r2') {
    throw new Error('PDF_STORAGE_DRIVER must be "s3" or "r2" for this smoke test.');
  }
  if (imageDriver !== 's3' && imageDriver !== 'r2') {
    throw new Error('IMAGE_STORAGE_DRIVER must be "s3" or "r2" for this smoke test.');
  }
  if (pdfDriver !== imageDriver) {
    throw new Error(
      'PDF_STORAGE_DRIVER and IMAGE_STORAGE_DRIVER must select the same cloud driver.',
    );
  }

  const config = readCloudConfig(pdfDriver, process.env);
  readCloudConfig(imageDriver, process.env, 'IMAGE_STORAGE_DRIVER');
  const bookId = createSmokeBookId();
  const pdfStorage = createPdfStorage(pdfDriver, process.env);
  const imageStorage = createImageAssetStorage(imageDriver, process.env);

  console.log('Running StoryMe cloud artifact storage smoke test...');
  console.log('Config (secrets redacted):');
  for (const line of formatConfigSummary(config, imageDriver)) console.log(`  ${line}`);
  console.log(`  namespace:       ${bookId}`);

  let testError: unknown;
  try {
    await runPdfChecks(pdfStorage, bookId);
    await runImageChecks(imageStorage, bookId);
  } catch (err) {
    testError = err;
  }

  console.log('\n[cleanup] deleting only the UUID-scoped smoke artifacts...');
  const cleanupFailures = await cleanup(pdfStorage, imageStorage, bookId);
  if (cleanupFailures.length > 0) {
    console.error(
      `[cleanup] FAILED (${cleanupFailures.length} operation(s)); inspect namespace "${bookId}" manually.`,
    );
  } else {
    console.log('[cleanup] complete and freshly verified absent.');
  }

  if (testError) {
    throw new Error(
      'Smoke checks failed; provider details were intentionally omitted from output.',
    );
  }
  if (cleanupFailures.length > 0) {
    throw new Error('Smoke checks passed, but scoped cleanup verification failed.');
  }

  console.log('\n✔ Cloud PDF and image storage smoke test passed.');
}

main().catch((err: unknown) => {
  console.error(`\n✘ Cloud artifact storage smoke test FAILED: ${String(err)}`);
  process.exit(1);
});
