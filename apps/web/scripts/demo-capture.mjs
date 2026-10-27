#!/usr/bin/env node
// Captures reproducible synthetic showcase materials (EN/RU/PL books, their
// downloaded PDFs, product screenshots, an interactive playthrough) from an
// already running `pnpm demo:local`. It is only a browser client: it never
// migrates, seeds, restarts, or tears down anything. See docs/demo-showcase.md.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { DEMO } from '../../../scripts/demo-local.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const SHOWCASE_ROOT = join(repoRoot, 'artifacts', 'demo-showcase');

export const VIEWPORTS = Object.freeze({
  desktop: { width: 1280, height: 900 },
  mobile: { width: 390, height: 844 },
  narrow: { width: 320, height: 740 },
});

const WIZARD_WIDTHS = [VIEWPORTS.narrow.width, VIEWPORTS.mobile.width];
const PAGE_COUNT = 4;

/** Synthetic inputs only: invented names, no photos, no personal data. */
export const SHOWCASE_BOOKS = Object.freeze([
  {
    language: 'en',
    languageLabel: 'English',
    childName: 'Ada',
    childAge: 5,
    theme: 'lighthouse friendship',
    educationalMessage: 'Asking for help is a brave thing to do',
    script: /[A-Za-z]/,
  },
  {
    language: 'ru',
    languageLabel: 'Russian',
    childName: 'Мила',
    childAge: 6,
    theme: 'Ёжик и зимний лес',
    educationalMessage: 'Делиться с друзьями — это радость',
    script: /[А-Яа-яЁё]/,
  },
  {
    language: 'pl',
    languageLabel: 'Polish',
    childName: 'Zosia',
    childAge: 5,
    theme: 'Łódka na Wiśle i źródło gwiazd',
    educationalMessage: 'Cierpliwość się opłaca',
    script: /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/,
  },
]);

/** The published scenario and the exact route the interactive E2E suite already plays. */
export const INTERACTIVE_ROUTE = Object.freeze({
  scenarioId: 'warsaw-last-delivery',
  catalogueTitle: 'The Last Delivery',
  openingScene: 'Praga courtyard',
  beforeReload: [{ choice: 'Ask the caretaker where Tomasz is', scene: "The caretaker's broom" }],
  afterReload: [
    { choice: 'Climb to the fourth floor', scene: 'Flat 4' },
    { choice: 'Use the single-use entry card on the lock', scene: 'Inside flat 4' },
    { choice: 'Take the service stairs down to the cellar', scene: 'The cellar workshop' },
    { choice: 'Carry the original ledger up and confront Ines', scene: 'The ledger exposed' },
  ],
  ending: 'The Ledger Exposed',
});

export class CaptureFailure extends Error {
  constructor(message, status = 1) {
    super(message);
    this.status = status;
  }
}

/**
 * The server-owned estimate is the only accepted proof of provider mode. A
 * missing, malformed, or "real" answer refuses before generation is dispatched;
 * cost fields are deliberately never consulted.
 */
export function assertMockEstimate(estimate) {
  const mode = estimate && typeof estimate === 'object' ? estimate.providerMode : undefined;
  if (mode !== 'mock') {
    throw new CaptureFailure(
      `Refusing to generate: the server reports providerMode=${JSON.stringify(mode)}, not "mock". ` +
        'Showcase capture runs only against the mock-provider local demo.',
      3,
    );
  }
  if (estimate.kind !== 'initial') {
    throw new CaptureFailure(`Unexpected estimate kind ${JSON.stringify(estimate.kind)}.`);
  }
}

/** Structural PDF checks that need no extra tooling. Text streams are subset-encoded, so no text search. */
export function inspectPdf(bytes) {
  const head = bytes.subarray(0, 8).toString('latin1');
  const tail = bytes.subarray(Math.max(0, bytes.length - 1024)).toString('latin1');
  const body = bytes.toString('latin1');
  return {
    bytes: bytes.length,
    header: head.startsWith('%PDF-'),
    eof: tail.trimEnd().endsWith('%%EOF'),
    pageCount: (body.match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length,
    embeddedFonts: (body.match(/\/FontFile2\b/g) ?? []).length,
    images: (body.match(/\/Subtype\s*\/Image\b/g) ?? []).length,
  };
}

export function pdfProblems(report, expectedPages) {
  const problems = [];
  if (!report.header) problems.push('missing %PDF- header');
  if (!report.eof) problems.push('missing %%EOF trailer');
  if (report.pageCount !== expectedPages)
    problems.push(`${report.pageCount} pages, expected ${expectedPages}`);
  if (report.embeddedFonts < 1) problems.push('no embedded TrueType font');
  if (report.images < 1) problems.push('no embedded images');
  if (report.bytes < 10_000) problems.push(`only ${report.bytes} bytes`);
  return problems;
}

export function runId(now = new Date(), suffix = randomBytes(3).toString('hex')) {
  return `${now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')}-${suffix}`;
}

/** Always a new directory: mkdir without `recursive` on the leaf fails if it exists. */
export function createRunDirectory(root, id) {
  mkdirSync(root, { recursive: true });
  const dir = join(root, id);
  mkdirSync(dir);
  for (const sub of ['pdf', 'screenshots']) mkdirSync(join(dir, sub));
  return dir;
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Every file except the manifest, with artifact-relative POSIX paths. */
export function describeArtifacts(dir) {
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (full !== join(dir, 'manifest.json')) {
        const bytes = readFileSync(full);
        files.push({
          path: relative(dir, full).split(sep).join('/'),
          bytes: statSync(full).size,
          sha256: sha256(bytes),
        });
      }
    }
  };
  walk(dir);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export function gitState(cwd = repoRoot) {
  const run = (args) => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  const head = run(['rev-parse', 'HEAD']);
  const status = run(['status', '--porcelain', '--untracked-files=no']);
  return {
    head: head.status === 0 ? head.stdout.trim() : null,
    trackedChanges: status.status === 0 ? status.stdout.trim().length > 0 : null,
  };
}

// ─── Browser journey ────────────────────────────────────────────────────────

const apiPath = (path) => `${DEMO.apiUrl}${path}`;

async function reachable(url) {
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5_000) });
    return response.status >= 200 && response.status < 400;
  } catch {
    return false;
  }
}

/**
 * Resolves once the image is decoded with real pixels and shown. A lazy image
 * has no height until it loads, so it is scrolled to rather than waited on as
 * visible, and the locator is re-resolved on every poll because the reader can
 * re-render (replacing the element) while a publication settles.
 */
async function waitForDecoded(locator, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let state = 'not attached';
  for (;;) {
    const probe = await locator
      .evaluate(
        (img) => {
          img.scrollIntoView({ block: 'center' });
          return {
            ready: img.complete && img.naturalWidth > 0 && getComputedStyle(img).opacity === '1',
            detail: `complete=${img.complete} naturalWidth=${img.naturalWidth} src=${img.src.slice(0, 5)}`,
          };
        },
        null,
        { timeout: 2_000 },
      )
      .catch(() => ({ ready: false, detail: 'not attached' }));
    state = probe.detail;
    if (probe.ready) break;
    if (Date.now() >= deadline) {
      throw new CaptureFailure(`${locator} never finished decoding (${state}).`);
    }
    await locator.page().waitForTimeout(250);
  }
  await locator.evaluate((img) => img.decode());
  await locator.waitFor({ state: 'visible', timeout });
}

async function failOnAlert(scope, where) {
  const alerts = scope.getByRole('alert');
  if ((await alerts.count()) > 0) {
    const text = (await alerts.allInnerTexts()).join(' | ').slice(0, 300);
    throw new CaptureFailure(`${where} shows an error: ${text}`);
  }
  // The demo web app runs `next dev`; its badge (open shadow DOM) flags runtime/build errors.
  if ((await scope.page().locator('[data-next-badge][data-error="true"]').count()) > 0) {
    throw new CaptureFailure(`${where}: the Next.js dev overlay reports an error.`);
  }
}

/** Puts the reader at the top of the viewport, the way a person reads it. */
async function frameReader(reader) {
  await reader.evaluate((el) => el.scrollIntoView({ block: 'start' }));
}

async function horizontalFit(page, width, label) {
  await page.setViewportSize({ width, height: VIEWPORTS.narrow.height });
  const metrics = await page.evaluate(() => {
    const nav = document.querySelector('nav[aria-label="Wizard steps"]');
    // The nav's own box always fits; overflowing steps only show in its content.
    const edges = nav
      ? [...nav.querySelectorAll('*')].map((el) => el.getBoundingClientRect().right)
      : [];
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      stepsRight: edges.length > 0 ? Math.max(...edges) : null,
    };
  });
  const passed =
    metrics.scrollWidth <= metrics.clientWidth &&
    metrics.stepsRight !== null &&
    metrics.stepsRight <= width;
  return {
    name: `wizard-fits-${width}px:${label}`,
    passed,
    detail: `scrollWidth ${metrics.scrollWidth}, clientWidth ${metrics.clientWidth}, steps right edge ${metrics.stepsRight === null ? 'missing' : Math.ceil(metrics.stepsRight)}`,
  };
}

export async function captureShowcase({ dir, record, log = console.log }) {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      baseURL: DEMO.webUrl,
      viewport: VIEWPORTS.desktop,
      acceptDownloads: true,
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    const shoot = async (name, options = {}) => {
      const path = join(dir, 'screenshots', `${name}.png`);
      if (options.locator) await options.locator.screenshot({ path });
      else await page.screenshot({ path, fullPage: options.fullPage ?? false });
    };

    record.step('sign-in');
    await page.goto('/login');
    await page.getByLabel('Email').fill(DEMO.loginEmail);
    await page.getByLabel('Password').fill(DEMO.loginPassword);
    const loginResponse = page.waitForResponse(
      (r) => r.url() === apiPath('/auth/login') && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Sign in' }).click();
    const login = await loginResponse;
    if (login.status() !== 200 && login.status() !== 201) {
      throw new CaptureFailure(`Sign-in failed with HTTP ${login.status()}.`);
    }
    // Held in memory for read-only API checks; never written anywhere.
    const { accessToken } = await login.json();
    const authorized = { headers: { Authorization: `Bearer ${accessToken}` } };
    await page.waitForURL(/\/dashboard$/);

    for (const input of SHOWCASE_BOOKS) {
      const lang = input.language;
      const screenshotWizard = lang === 'en';
      record.step(`book-${lang}:wizard`);
      log(`Creating the ${input.languageLabel} book through the wizard...`);
      await page.setViewportSize(VIEWPORTS.narrow);
      await page.goto('/dashboard/books/new');
      await page.getByRole('heading', { name: 'New Book' }).waitFor();

      const stage = async (label) => {
        await failOnAlert(page.locator('main'), `${lang} wizard ${label}`);
        for (const width of WIZARD_WIDTHS) {
          record.validate(await horizontalFit(page, width, `${lang}:${label}`));
          if (screenshotWizard) await shoot(`wizard-${width}-${label}`, { fullPage: true });
        }
        await page.setViewportSize(VIEWPORTS.narrow);
      };

      await page.getByLabel(/Child's name/).fill(input.childName);
      await page.getByRole('spinbutton').fill(String(input.childAge));
      await stage('step-1-child');
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      await page.getByLabel('Language').selectOption(lang);
      await page.getByLabel('Theme').fill(input.theme);
      await page.getByLabel('Number of pages').selectOption(String(PAGE_COUNT));
      await page.getByLabel(/Educational message/).fill(input.educationalMessage);
      await stage('step-2-story');
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      await page.getByRole('heading', { name: /Review/ }).waitFor();
      await stage('step-3-review');
      await page.getByRole('button', { name: 'Create Book' }).click();
      await page.waitForURL(/\/dashboard\/books\/[0-9a-f-]{36}$/);
      const bookId = new URL(page.url()).pathname.split('/').at(-1);
      const book = record.book({ ...input, script: undefined, bookId });

      record.step(`book-${lang}:estimate`);
      await page.setViewportSize(VIEWPORTS.desktop);
      const estimateResponse = page.waitForResponse(
        (r) => r.url() === apiPath(`/books/${bookId}/generation-estimate?kind=initial`),
      );
      await page.getByRole('button', { name: /view provider-work estimate/i }).click();
      const estimateHttp = await estimateResponse;
      if (estimateHttp.status() !== 200) {
        throw new CaptureFailure(`Generation estimate failed with HTTP ${estimateHttp.status()}.`);
      }
      const estimate = await estimateHttp.json();
      assertMockEstimate(estimate);
      book.estimate = { kind: estimate.kind, providerMode: estimate.providerMode };
      record.validate({ name: `provider-mode-mock:${lang}`, passed: true, detail: 'estimate' });

      record.step(`book-${lang}:generate`);
      log(`Generating the ${input.languageLabel} book with the mock providers...`);
      const generateResponse = page.waitForResponse(
        (r) => r.url() === apiPath(`/books/${bookId}/generate`) && r.request().method() === 'POST',
      );
      await page.getByRole('button', { name: 'Generate Story' }).click();
      const generateHttp = await generateResponse;
      if (!generateHttp.ok()) {
        throw new CaptureFailure(
          `Generate Story was refused with HTTP ${generateHttp.status()}` +
            (generateHttp.status() === 429
              ? ' (per-account generation rate limit; see docs/demo-showcase.md).'
              : '.'),
        );
      }
      await page
        .getByRole('heading', { name: 'Your PDF is ready' })
        .or(page.getByText(/generation failed/i))
        .first()
        .waitFor({ timeout: 120_000 });
      const api = await (await page.request.get(apiPath(`/books/${bookId}`), authorized)).json();
      if (api.status !== 'complete' || !api.bookPreview) {
        throw new CaptureFailure(`Book ${lang} ended as ${api.status}, not complete.`);
      }
      const pages = api.bookPreview.pages.slice().sort((a, b) => a.pageNumber - b.pageNumber);
      Object.assign(book, {
        title: api.bookPreview.title,
        status: api.status,
        publishedEdition: api.publishedEdition ?? null,
        pages: pages.length,
      });
      record.validate({
        name: `book-complete:${lang}`,
        passed: pages.length === PAGE_COUNT && api.language === lang && !!api.publishedEdition,
        detail: `${pages.length} pages, language ${api.language}, edition ${api.publishedEdition}`,
      });
      const text = [api.bookPreview.title, ...pages.map((p) => p.text)].join(' ');
      record.validate({
        name: `localized-text:${lang}`,
        passed: input.script.test(text) && !text.includes('�'),
        detail: `title "${api.bookPreview.title}"`,
      });

      record.step(`book-${lang}:reader`);
      const reader = page.getByRole('region', { name: 'Published book reader' });
      await waitForDecoded(reader.getByRole('img', { name: 'Illustration for cover' }));
      await failOnAlert(reader, `${lang} reader cover`);
      if (lang === 'en') {
        await frameReader(reader);
        await shoot(`reader-desktop-${lang}`);
        book.screenshots.push(`screenshots/reader-desktop-${lang}.png`);
      }
      await reader.getByRole('button', { name: 'Next page' }).click();
      await reader.getByText(`Page 1 · 2 of ${PAGE_COUNT + 2}`).waitFor();
      await waitForDecoded(reader.getByRole('img', { name: 'Illustration for page 1' }));
      await reader.getByText(pages[0].text.trim().slice(0, 40), { exact: false }).waitFor();
      await failOnAlert(reader, `${lang} reader page 1`);
      await shoot(`reader-page-1-${lang}`, { locator: reader });
      book.screenshots.push(`screenshots/reader-page-1-${lang}.png`);

      record.step(`book-${lang}:download`);
      const pdfPath = `pdf/storyme-${lang}.pdf`;
      const downloadPromise = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download PDF' }).click();
      const download = await downloadPromise;
      await download.saveAs(join(dir, pdfPath));
      const downloaded = readFileSync(join(dir, pdfPath));
      const served = await page.request.get(apiPath(`/books/${bookId}/pdf/preview`), authorized);
      const servedBytes = await served.body();
      const report = inspectPdf(downloaded);
      const problems = pdfProblems(report, PAGE_COUNT + 2);
      Object.assign(book, { pdf: pdfPath, suggestedFilename: download.suggestedFilename() });
      record.validate({
        name: `pdf-structure:${lang}`,
        passed: problems.length === 0,
        detail: problems.length
          ? problems.join('; ')
          : `${report.pageCount} pages, ${report.embeddedFonts} embedded font(s), ${report.images} image(s), ${report.bytes} bytes`,
      });
      record.validate({
        name: `pdf-matches-preview-endpoint:${lang}`,
        passed: served.status() === 200 && sha256(servedBytes) === sha256(downloaded),
        detail: `GET /api/books/:id/pdf/preview -> ${served.status()}`,
      });

      if (lang === 'en') {
        record.step('book-en:mobile-reader');
        await page.setViewportSize(VIEWPORTS.mobile);
        await page.reload();
        const mobileReader = page.getByRole('region', { name: 'Published book reader' });
        await waitForDecoded(mobileReader.getByRole('img', { name: 'Illustration for cover' }));
        await failOnAlert(mobileReader, 'mobile reader');
        await frameReader(mobileReader);
        await shoot('reader-mobile-en');
        book.screenshots.push('screenshots/reader-mobile-en.png');
        await page.setViewportSize(VIEWPORTS.desktop);
      }
    }

    record.step('interactive:start');
    log('Playing the published interactive story...');
    const creations = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url() === apiPath('/interactive/sessions')) {
        creations.push(request.url());
      }
    });
    const catalogueResponse = page.waitForResponse(
      (r) => r.url() === apiPath('/interactive/scenarios'),
    );
    await page.goto('/dashboard/interactive');
    const catalogue = await (await catalogueResponse).json();
    const entry = catalogue.scenarios.find((s) => s.scenarioId === INTERACTIVE_ROUTE.scenarioId);
    if (!entry) throw new CaptureFailure('The published scenario is not in the catalogue.');
    const created = page.waitForResponse(
      (r) => r.url() === apiPath('/interactive/sessions') && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: `Start story: ${entry.title}` }).click();
    const session = await (await created).json();
    await page.waitForURL(new RegExp(`/dashboard/interactive/${session.sessionId}$`));
    const interactive = record.interactive({
      sessionId: session.sessionId,
      scenarioId: session.scenarioId,
      scenarioVersion: session.scenarioVersion,
      title: entry.title,
      route: [...INTERACTIVE_ROUTE.beforeReload, ...INTERACTIVE_ROUTE.afterReload].map(
        (s) => s.choice,
      ),
    });
    const scene = (title) => page.getByRole('heading', { name: title, exact: true });
    const sceneArt = () => page.locator('article figure img').first();
    await scene(INTERACTIVE_ROUTE.openingScene).waitFor();

    for (const { choice, scene: next } of INTERACTIVE_ROUTE.beforeReload) {
      await page.getByRole('button', { name: choice, exact: true }).click();
      await scene(next).waitFor();
    }
    await waitForDecoded(sceneArt());
    await failOnAlert(page.locator('article'), 'interactive scene');
    await page.evaluate(() => window.scrollTo(0, 0));
    await shoot('interactive-play-desktop', { fullPage: true });
    interactive.screenshots.push('screenshots/interactive-play-desktop.png');

    record.step('interactive:reload');
    const sceneBeforeReload = INTERACTIVE_ROUTE.beforeReload.at(-1).scene;
    await page.reload();
    await scene(sceneBeforeReload).waitFor();
    const resumed =
      new URL(page.url()).pathname.endsWith(`/${session.sessionId}`) && creations.length === 1;
    record.validate({
      name: 'interactive-reload-resumes-session',
      passed: resumed,
      detail: `scene "${sceneBeforeReload}" after reload, ${creations.length} creation request(s)`,
    });
    if (!resumed) throw new CaptureFailure('Reload did not resume the same interactive session.');

    record.step('interactive:ending');
    for (const { choice, scene: next } of INTERACTIVE_ROUTE.afterReload) {
      await page.getByRole('button', { name: choice, exact: true }).click();
      await scene(next).waitFor();
    }
    const ending = page.getByRole('heading', { name: INTERACTIVE_ROUTE.ending, exact: true });
    await ending.waitFor();
    await waitForDecoded(sceneArt());
    await failOnAlert(page.locator('article'), 'interactive ending');
    interactive.ending = INTERACTIVE_ROUTE.ending;
    await page.evaluate(() => window.scrollTo(0, 0));
    await shoot('interactive-ending-desktop', { fullPage: true });
    interactive.screenshots.push('screenshots/interactive-ending-desktop.png');
    record.validate({
      name: 'interactive-ending-reached',
      passed: creations.length === 1,
      detail: `ending "${INTERACTIVE_ROUTE.ending}" in session ${session.sessionId}`,
    });

    await context.close();
  } finally {
    await browser.close();
  }
}

// ─── Manifest + CLI ─────────────────────────────────────────────────────────

export function createRecorder(base) {
  const manifest = {
    schemaVersion: 1,
    ...base,
    status: 'incomplete',
    lastStep: null,
    books: [],
    interactive: null,
    validations: [],
    artifacts: [],
  };
  return {
    manifest,
    step(name) {
      manifest.lastStep = name;
    },
    validate(result) {
      manifest.validations.push(result);
      if (!result.passed)
        throw new CaptureFailure(`Validation failed: ${result.name} (${result.detail})`);
    },
    book(entry) {
      const book = { ...entry, screenshots: [] };
      manifest.books.push(book);
      return book;
    },
    interactive(entry) {
      manifest.interactive = { ...entry, screenshots: [] };
      return manifest.interactive;
    },
  };
}

export function writeManifest(dir, manifest) {
  manifest.artifacts = describeArtifacts(dir);
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function main() {
  const [apiUp, webUp] = await Promise.all([reachable(DEMO.apiHealthUrl), reachable(DEMO.webUrl)]);
  if (!apiUp || !webUp) {
    console.error(
      `The local demo is not answering (${apiUp ? '' : `API ${DEMO.apiHealthUrl} `}${webUp ? '' : `web ${DEMO.webUrl}`}).\n` +
        'Start it first in another terminal with `pnpm demo:local`, wait for the ready banner, then retry.',
    );
    process.exit(2);
  }

  const id = runId();
  const dir = createRunDirectory(SHOWCASE_ROOT, id);
  const record = createRecorder({
    kind: 'storyme-demo-showcase',
    runId: id,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    git: gitState(),
    providers: {
      designation: 'mock',
      evidence: 'server-owned generation estimate providerMode, checked before every generation',
      note: 'Deterministic mock story, character, and image providers. These materials demonstrate the product and pipeline, not real-model generation quality.',
    },
    application: { webUrl: DEMO.webUrl, apiUrl: DEMO.apiUrl, account: DEMO.loginEmail },
    viewports: VIEWPORTS,
    inputs: {
      books: SHOWCASE_BOOKS.map(({ script: _script, ...book }) => ({
        ...book,
        pageCount: PAGE_COUNT,
      })),
      photos: 'none',
      interactiveScenario: INTERACTIVE_ROUTE.scenarioId,
    },
  });

  let finished = false;
  const finish = (status, failure) => {
    if (finished) return;
    finished = true;
    const { manifest } = record;
    manifest.status = status;
    manifest.finishedAt = new Date().toISOString();
    if (failure) manifest.failure = { step: manifest.lastStep, message: failure.slice(0, 600) };
    writeManifest(dir, manifest);
  };
  process.once('SIGINT', () => {
    finish('incomplete', 'Interrupted (SIGINT).');
    console.error(`Interrupted; marked incomplete: ${dir}`);
    process.exit(130);
  });

  console.log(`Capturing into ${dir}`);
  try {
    await captureShowcase({ dir, record });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    finish('incomplete', message);
    console.error(`Capture INCOMPLETE at step ${record.manifest.lastStep}: ${message}`);
    console.error(`Partial output (marked incomplete): ${dir}`);
    process.exit(error instanceof CaptureFailure ? error.status : 1);
  }
  finish('complete');
  console.log(`Showcase complete: ${dir}`);
  console.log(
    `${record.manifest.artifacts.length} artifacts, ${record.manifest.validations.length} validations passed.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
