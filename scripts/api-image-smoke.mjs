#!/usr/bin/env node
/**
 * Bounded, credential-free runtime smoke for an already-built API image.
 *
 *   node scripts/api-image-smoke.mjs [image]   (default image: storyme-api:local)
 *
 * Runs one short-lived container with networking disabled, a read-only root
 * filesystem and no environment beyond what the image itself sets. It checks
 * only properties of the image:
 *   - the Node.js major version matches .nvmrc;
 *   - the process runs as a non-root user;
 *   - the API and worker entrypoints exist;
 *   - Prisma Client can be constructed and its musl/OpenSSL 3 query-engine
 *     library loads (no database connection is attempted);
 *   - Sharp performs a real resize + PNG encode;
 *   - the embedded Noto Sans fonts resolve exactly where the compiled PDF
 *     renderer looks for them and PDFKit can render text with both.
 *
 * It does not establish database/Redis connectivity, provider access, or that
 * a deployed application works.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const image = process.argv[2] ?? 'storyme-api:local';
const expectedMajor = readFileSync(join(repoRoot, '.nvmrc'), 'utf8').trim().replace(/^v/, '');

if (!/^\d+$/.test(expectedMajor)) {
  console.error(
    `[api-image-smoke] .nvmrc must contain a bare major version, got "${expectedMajor}"`,
  );
  process.exit(2);
}

// Executed inside the container by `node -` from /app/apps/api, so require()
// resolves against the image's own pnpm workspace layout.
const inContainer = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const results = [];
const check = async (name, fn) => {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
  } catch (error) {
    results.push({ name, ok: false, detail: error && error.message ? error.message : String(error) });
  }
};
const assert = (condition, message) => { if (!condition) throw new Error(message); };

(async () => {
  await check('node version', () => {
    const major = process.versions.node.split('.')[0];
    assert(major === process.env.SMOKE_EXPECTED_NODE_MAJOR, 'expected Node ' + process.env.SMOKE_EXPECTED_NODE_MAJOR + ', got ' + process.version);
    return process.version;
  });

  await check('non-root user', () => {
    const uid = process.getuid();
    assert(uid !== 0, 'running as root');
    return 'uid=' + uid + ' gid=' + process.getgid();
  });

  await check('entrypoints', () => {
    for (const file of ['dist/main.js', 'dist/worker.js']) {
      assert(fs.existsSync(file), 'missing ' + file);
    }
    return 'dist/main.js, dist/worker.js';
  });

  await check('prisma client', () => {
    const { PrismaClient, Prisma } = require('@prisma/client');
    const client = new PrismaClient();
    assert(typeof client.$connect === 'function', 'PrismaClient instance lacks $connect');
    const generated = path.dirname(require.resolve('.prisma/client/index.js', { paths: [path.dirname(require.resolve('@prisma/client'))] }));
    const engine = path.join(generated, 'libquery_engine-linux-musl-openssl-3.0.x.so.node');
    assert(fs.existsSync(engine), 'missing ' + engine);
    const lib = { exports: {} };
    process.dlopen(lib, engine);
    assert(typeof lib.exports.version === 'function', 'query engine library did not expose version()');
    return 'constructed (no connection); Prisma ' + Prisma.prismaVersion.client + '; engine ' + lib.exports.version().commit.slice(0, 12) + ' loaded';
  });

  await check('sharp transform', async () => {
    const sharp = require('sharp');
    const input = await sharp({ create: { width: 8, height: 6, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer();
    const output = await sharp(input).resize(4, 3).flip().png().toBuffer();
    const meta = await sharp(output).metadata();
    assert(meta.format === 'png' && meta.width === 4 && meta.height === 3, 'unexpected output ' + JSON.stringify(meta));
    return 'sharp ' + sharp.versions.sharp + ' (libvips ' + sharp.versions.vips + '): 8x6 -> ' + meta.width + 'x' + meta.height + ' png';
  });

  await check('pdf fonts', async () => {
    const rendererDir = path.resolve('dist/pdf');
    assert(fs.existsSync(path.join(rendererDir, 'pdf-renderer.js')), 'missing dist/pdf/pdf-renderer.js');
    const fontsDir = path.join(rendererDir, '..', '..', 'assets', 'fonts');
    const files = ['NotoSans-Regular.ttf', 'NotoSans-Bold.ttf'];
    for (const file of files) {
      const stat = fs.statSync(path.join(fontsDir, file));
      assert(stat.isFile() && stat.size > 0, file + ' is empty');
    }
    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ autoFirstPage: true });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    const done = new Promise((resolve, reject) => { doc.on('end', resolve); doc.on('error', reject); });
    doc.registerFont('Body', path.join(fontsDir, files[0]));
    doc.registerFont('BodyBold', path.join(fontsDir, files[1]));
    doc.font('Body').text('Smoke Привет Γειά');
    doc.font('BodyBold').text('Smoke');
    doc.end();
    await done;
    const pdf = Buffer.concat(chunks);
    assert(pdf.subarray(0, 5).toString() === '%PDF-', 'output is not a PDF');
    return files.join(', ') + ' at ' + fontsDir + '; rendered ' + pdf.length + '-byte PDF';
  });

  for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + ': ' + r.detail);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
})();
`;

const args = [
  'run',
  '--rm',
  '-i',
  '--network',
  'none',
  '--read-only',
  '--tmpfs',
  '/tmp',
  '--env',
  `SMOKE_EXPECTED_NODE_MAJOR=${expectedMajor}`,
  '--entrypoint',
  'node',
  image,
  '-',
];

console.log(`[api-image-smoke] image: ${image}; expected Node major: ${expectedMajor}`);
const result = spawnSync('docker', args, {
  input: inContainer,
  stdio: ['pipe', 'inherit', 'inherit'],
  timeout: 120_000,
});

if (result.error) {
  console.error(`[api-image-smoke] could not run docker: ${result.error.message}`);
  process.exit(2);
}
console.log(`[api-image-smoke] ${result.status === 0 ? 'PASS' : 'FAIL'} (exit ${result.status})`);
process.exit(result.status ?? 1);
