/**
 * The HTTP book journey and artifact validators used by `pnpm smoke:release`
 * (scripts/release-smoke.mjs). Dependency-free so it runs on a CI runner that
 * has only Node.js and Docker.
 *
 * The journey talks to the containerized API through its public HTTP routes.
 * Its only out-of-band operations go through the `infra` object supplied by
 * the orchestrator: marking the two synthetic accounts verified in the
 * disposable database, reading the outbox/queue state, starting the worker and
 * restarting the application containers.
 */
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';

export class SmokeFailure extends Error {}

const fail = (message) => {
  throw new SmokeFailure(message);
};

export const BOOK_PAGES = 4;
/** Cover, one illustration per story page, back cover. */
export const PUBLISHED_IMAGE_IDS = Object.freeze([
  'cover',
  ...Array.from({ length: BOOK_PAGES }, (_, index) => `page-${index + 1}`),
  'back-cover',
]);
/** Cover + story pages + back cover. */
export const EXPECTED_PDF_PAGES = BOOK_PAGES + 2;

export const SYNTHETIC_BOOK = Object.freeze({
  title: 'The Lantern Garden',
  childName: 'Mira',
  childAge: 6,
  language: 'en',
  theme: 'Kindness in a moonlit garden',
  educationalMessage: 'Sharing your light helps everyone find their way home.',
  pageCount: BOOK_PAGES,
});

// ─── PNG ────────────────────────────────────────────────────────────────────

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Fully decodes the container structure of a PNG: signature, every chunk CRC,
 * IHDR, the zlib stream (which carries its own Adler-32 check) and the exact
 * scanline layout including per-row filter types. Throws on any defect.
 */
export function decodePng(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    fail('not a PNG (bad signature)');
  }
  let offset = 8;
  let header = null;
  const data = [];
  let ended = false;
  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) fail('truncated PNG chunk');
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > buffer.length) fail(`truncated PNG ${type} chunk`);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (crc32(buffer.subarray(offset + 4, offset + 8 + length)) !== buffer.readUInt32BE(end - 4)) {
      fail(`PNG ${type} chunk CRC mismatch`);
    }
    if (header === null && type !== 'IHDR') fail('PNG does not start with IHDR');
    if (type === 'IHDR') {
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        bitDepth: body[8],
        colorType: body[9],
        interlace: body[12],
      };
    } else if (type === 'IDAT') {
      data.push(body);
    } else if (type === 'IEND') {
      ended = true;
      break;
    }
    offset = end;
  }
  if (!header || !ended || data.length === 0) fail('PNG is missing IHDR, IDAT or IEND');
  const channels = PNG_CHANNELS[header.colorType];
  if (!channels || header.width === 0 || header.height === 0) fail('unsupported PNG header');

  let raw;
  try {
    raw = inflateSync(Buffer.concat(data));
  } catch (error) {
    fail(`PNG image data does not inflate: ${error.message}`);
  }
  const passes = header.interlace === 1 ? ADAM7 : [[0, 0, 1, 1]];
  let position = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const width = Math.ceil((header.width - x0) / dx);
    const height = Math.ceil((header.height - y0) / dy);
    if (width <= 0 || height <= 0) continue;
    const rowBytes = Math.ceil((width * channels * header.bitDepth) / 8);
    for (let row = 0; row < height; row++) {
      if (position >= raw.length) fail('PNG image data is shorter than its header declares');
      if (raw[position] > 4) fail(`PNG scanline has invalid filter type ${raw[position]}`);
      position += 1 + rowBytes;
    }
  }
  if (position !== raw.length) fail('PNG image data length does not match its header');
  return { format: 'png', width: header.width, height: header.height };
}

// ─── PDF ────────────────────────────────────────────────────────────────────

/**
 * Structural inspection of an uncompressed-xref PDF (what PDFKit writes):
 * header/trailer, page objects and the page-tree count, embedded font files,
 * and image XObjects whose Flate streams must actually inflate.
 */
export function inspectPdf(buffer) {
  if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') fail('not a PDF (bad header)');
  const text = buffer.toString('latin1');
  const tail = text.slice(-1024);
  if (!/startxref\s+\d+\s+%%EOF\s*$/.test(tail)) fail('PDF trailer (startxref/%%EOF) missing');

  const pageObjects = text.match(/\/Type\s*\/Page(?![A-Za-z])/g)?.length ?? 0;
  const treeCounts = [];
  for (const match of text.matchAll(/\/Type\s*\/Pages(?![A-Za-z])/g)) {
    const start = text.lastIndexOf('<<', match.index);
    const end = text.indexOf('>>', match.index);
    const count = /\/Count\s+(\d+)/.exec(text.slice(start, end));
    if (count) treeCounts.push(Number(count[1]));
  }
  const pageTreeCount = treeCounts.length > 0 ? Math.max(...treeCounts) : 0;

  const embeddedFonts = text.match(/\/FontFile[23]?(?![A-Za-z])/g)?.length ?? 0;
  const fontNames = [
    ...new Set([...text.matchAll(/\/BaseFont\s*\/([^\s/<>[\]()]+)/g)].map((m) => m[1])),
  ];

  let images = 0;
  let decodedImages = 0;
  for (const match of text.matchAll(/\/Subtype\s*\/Image(?![A-Za-z])/g)) {
    images++;
    const start = text.lastIndexOf('<<', match.index);
    const streamAt = text.indexOf('stream', match.index);
    if (start < 0 || streamAt < 0) fail('PDF image XObject has no stream');
    const dictionary = text.slice(start, streamAt);
    const length = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dictionary);
    if (!length || !/\/FlateDecode/.test(dictionary)) continue;
    const dataStart = streamAt + 'stream'.length + (text[streamAt + 6] === '\r' ? 2 : 1);
    const stream = buffer.subarray(dataStart, dataStart + Number(length[1]));
    try {
      if (inflateSync(stream).length === 0) fail('PDF image stream is empty');
    } catch (error) {
      if (error instanceof SmokeFailure) throw error;
      fail(`PDF image stream does not inflate: ${error.message}`);
    }
    decodedImages++;
  }
  return { pageObjects, pageTreeCount, embeddedFonts, fontNames, images, decodedImages };
}

// ─── HTTP ───────────────────────────────────────────────────────────────────

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function bounded(value, max = 600) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function createHttpClient(baseUrl, options = {}) {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.requestTimeoutMs ?? 15_000;
  return async function request(method, path, { token, json } = {}) {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (json !== undefined) headers['content-type'] = 'application/json';
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers,
        body: json === undefined ? undefined : JSON.stringify(json),
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      fail(`${method} ${path} failed: ${error.message}`);
    }
    const body = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') ?? '';
    let parsed = null;
    if (contentType.includes('application/json')) {
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        parsed = null;
      }
    }
    return { status: response.status, contentType, body, json: parsed };
  };
}

function expectStatus(response, expected, label) {
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!allowed.includes(response.status)) {
    fail(
      `${label}: expected HTTP ${allowed.join(' or ')}, got ${response.status} ` +
        bounded(response.json ?? response.body.toString('utf8')),
    );
  }
  return response;
}

// ─── Journey ────────────────────────────────────────────────────────────────

async function waitFor(label, deadlineMs, intervalMs, probe, shouldStop) {
  const deadline = Date.now() + deadlineMs;
  let last;
  for (;;) {
    if (shouldStop()) fail(`${label}: interrupted`);
    last = await probe();
    if (last.done) return last.value;
    if (Date.now() >= deadline) {
      fail(`${label} not reached within ${Math.round(deadlineMs / 1000)}s (last: ${last.detail})`);
    }
    await sleep(intervalMs);
  }
}

/**
 * Runs the complete journey. Resolves with a summary on success and throws
 * SmokeFailure (or an infrastructure error) on the first unmet expectation.
 */
export async function runReleaseJourney({
  infra,
  accounts,
  log,
  timeouts = {},
  fetch: fetchImpl,
  shouldStop = () => false,
}) {
  const generationMs = timeouts.generationMs ?? 180_000;
  const dispatchMs = timeouts.dispatchMs ?? 30_000;
  const pollMs = timeouts.pollMs ?? 1_000;
  const pass = (message) => {
    log(`[smoke:release] PASS ${message}`);
    if (shouldStop()) fail('interrupted');
  };

  let request = createHttpClient(await infra.apiBaseUrl(), { fetch: fetchImpl });

  const login = async (account, label) => {
    const response = expectStatus(
      await request('POST', '/auth/login', {
        json: { email: account.email, password: account.password },
      }),
      200,
      label,
    );
    if (typeof response.json?.accessToken !== 'string') fail(`${label}: no access token`);
    return response.json.accessToken;
  };

  for (const account of [accounts.owner, accounts.other]) {
    expectStatus(
      await request('POST', '/auth/register', {
        json: { email: account.email, password: account.password, name: account.name },
      }),
      201,
      `register ${account.name}`,
    );
  }
  const unverified = await request('POST', '/auth/login', {
    json: { email: accounts.owner.email, password: accounts.owner.password },
  });
  expectStatus(unverified, 401, 'login before verification');
  if (unverified.json?.code !== 'EMAIL_NOT_VERIFIED') {
    fail(`login before verification: expected EMAIL_NOT_VERIFIED, got ${bounded(unverified.json)}`);
  }
  pass('registered two synthetic accounts; unverified login is still refused');

  const verified = await infra.markAccountsVerified([accounts.owner.email, accounts.other.email]);
  if (verified.length !== 2) fail(`expected 2 accounts marked verified, got ${verified.length}`);
  let ownerToken = await login(accounts.owner, 'owner login');
  const otherToken = await login(accounts.other, 'second-user login');
  pass('both accounts authenticated through POST /api/auth/login');

  const created = expectStatus(
    await request('POST', '/books', { token: ownerToken, json: SYNTHETIC_BOOK }),
    201,
    'create book',
  ).json;
  const bookId = created?.id;
  if (typeof bookId !== 'string') fail('create book: no id in response');

  const estimate = expectStatus(
    await request('GET', `/books/${bookId}/generation-estimate`, { token: ownerToken }),
    200,
    'generation estimate',
  ).json;
  if (estimate?.providerMode !== 'mock') {
    fail(`generation estimate: providerMode is ${bounded(estimate?.providerMode)}, not "mock"`);
  }
  pass(`four-page book ${bookId} created; server estimate reports providerMode="mock"`);

  expectStatus(
    await request('POST', `/books/${bookId}/generate`, { token: ownerToken }),
    200,
    'schedule generation',
  );
  const runId = await waitFor(
    'outbox dispatch to BullMQ',
    dispatchMs,
    pollMs,
    async () => {
      const rows = await infra.generationOutbox();
      const row = rows.find((candidate) => candidate.status === 'dispatched');
      return { done: Boolean(row), value: row?.aggregateId, detail: bounded(rows) };
    },
    shouldStop,
  );
  const waiting = await infra.waitingGenerationJobs();
  if (!waiting.includes(runId)) {
    fail(`generation run ${runId} is not waiting in BullMQ (waiting: ${bounded(waiting)})`);
  }
  for (let check = 0; check < 3; check++) {
    const progress = expectStatus(
      await request('GET', `/books/${bookId}/generation-progress`, { token: ownerToken }),
      200,
      'generation progress',
    ).json;
    if (progress?.status !== 'queued') {
      fail(`without a worker the run must stay queued, got ${bounded(progress)}`);
    }
    if (check < 2) await sleep(pollMs * 2);
  }
  pass(`run ${runId} dispatched from the outbox and stays queued with only the API running`);

  await infra.startWorker();
  pass('separate worker container started');

  const progress = await waitFor(
    'published book',
    generationMs,
    pollMs,
    async () => {
      const response = await request('GET', `/books/${bookId}/generation-progress`, {
        token: ownerToken,
      });
      const status = response.json?.status;
      if (status === 'failed' || status === 'cancelled') {
        const diagnostics = await request('GET', `/books/${bookId}/generation-diagnostics`, {
          token: ownerToken,
        });
        fail(`generation ended ${status}: ${bounded(diagnostics.json, 1500)}`);
      }
      return { done: status === 'complete', value: response.json, detail: bounded(response.json) };
    },
    shouldStop,
  );
  const book = expectStatus(
    await request('GET', `/books/${bookId}`, { token: ownerToken }),
    200,
    'read published book',
  ).json;
  if (book?.status !== 'complete' || !book.publishedEdition) {
    fail(`book is not published: status=${book?.status} edition=${book?.publishedEdition}`);
  }
  if (book.bookPreview?.pages?.length !== BOOK_PAGES) {
    fail(`published book has ${book.bookPreview?.pages?.length} pages, expected ${BOOK_PAGES}`);
  }
  pass(`worker published edition ${book.publishedEdition} (progress: ${progress.status})`);

  const artifactPaths = [
    ...PUBLISHED_IMAGE_IDS.map((id) => ({ id, path: `/books/${bookId}/images/${id}` })),
    { id: 'pdf', path: `/books/${bookId}/pdf/preview` },
  ];

  const fetchArtifacts = async (token) => {
    const results = {};
    for (const { id, path } of artifactPaths) {
      const response = expectStatus(await request('GET', path, { token }), 200, `GET ${id}`);
      if (id === 'pdf') {
        if (!response.contentType.startsWith('application/pdf')) {
          fail(`PDF served as ${response.contentType}`);
        }
        const pdf = inspectPdf(response.body);
        if (pdf.pageObjects !== EXPECTED_PDF_PAGES || pdf.pageTreeCount !== EXPECTED_PDF_PAGES) {
          fail(
            `PDF has ${pdf.pageObjects} page objects / page-tree count ${pdf.pageTreeCount}, ` +
              `expected ${EXPECTED_PDF_PAGES}`,
          );
        }
        if (pdf.embeddedFonts < 1) fail(`PDF embeds no font files (${pdf.fontNames.join(', ')})`);
        if (pdf.images < PUBLISHED_IMAGE_IDS.length || pdf.decodedImages < pdf.images) {
          fail(
            `PDF embeds ${pdf.images} image(s) (${pdf.decodedImages} decoded), expected at least ` +
              `${PUBLISHED_IMAGE_IDS.length} decodable illustrations`,
          );
        }
        results[id] = { bytes: response.body.length, sha256: sha256(response.body), ...pdf };
      } else {
        if (response.contentType !== 'image/png') {
          fail(`${id} served as ${response.contentType}; the mock provider publishes PNG`);
        }
        const image = decodePng(response.body);
        results[id] = { bytes: response.body.length, sha256: sha256(response.body), ...image };
      }
    }
    return results;
  };

  const artifacts = await fetchArtifacts(ownerToken);
  const pdf = artifacts.pdf;
  pass(
    `retrieved ${PUBLISHED_IMAGE_IDS.length} decodable PNG illustrations and a ` +
      `${pdf.pageObjects}-page PDF (${pdf.images} embedded images, ${pdf.embeddedFonts} embedded fonts)`,
  );

  for (const { id, path } of artifactPaths) {
    expectStatus(await request('GET', path), 401, `unauthenticated GET ${id}`);
    const foreign = await request('GET', path, { token: otherToken });
    expectStatus(foreign, [403, 404], `second-user GET ${id}`);
    if (foreign.body.length > 0 && sha256(foreign.body) === artifacts[id].sha256) {
      fail(`second-user GET ${id} returned the artifact bytes`);
    }
  }
  expectStatus(
    await request('GET', `/books/${bookId}`, { token: otherToken }),
    [403, 404],
    'second-user GET book',
  );
  pass('unauthenticated (401) and second-user (403/404) requests cannot read any artifact');

  request = createHttpClient(await infra.restartApplication(), { fetch: fetchImpl });
  ownerToken = await login(accounts.owner, 'owner login after restart');
  const restarted = expectStatus(
    await request('GET', `/books/${bookId}`, { token: ownerToken }),
    200,
    'read book after restart',
  ).json;
  if (restarted?.status !== 'complete' || restarted.publishedEdition !== book.publishedEdition) {
    fail(
      `after restart: status=${restarted?.status} edition=${restarted?.publishedEdition}, ` +
        `expected complete/${book.publishedEdition}`,
    );
  }
  const again = await fetchArtifacts(ownerToken);
  const changed = Object.keys(artifacts).filter((id) => again[id].sha256 !== artifacts[id].sha256);
  if (changed.length > 0) fail(`artifact bytes changed after restart: ${changed.join(', ')}`);
  pass('after restarting API and worker, re-login sees the same edition and identical bytes');

  return { bookId, runId, edition: book.publishedEdition, artifacts };
}
