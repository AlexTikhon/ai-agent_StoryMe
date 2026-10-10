import { expect, test, type Browser, type Page } from '@playwright/test';

// Interactive story reader. Runs through the guarded Playwright config: real
// API, disposable PostgreSQL/Redis, deterministic mock narrator, no providers.

const apiBaseUrl = 'http://127.0.0.1:4100/api';
const loginEmail = 'verified-login@e2e.storyme.test';
const password = 'StoryMeE2E1!';
const SESSION_URL = /\/dashboard\/interactive\/[0-9a-f-]{36}$/;
const METADATA_URL = /\/interactive\/sessions\/[0-9a-f-]{36}\/metadata$/;

interface CatalogueEntry {
  scenarioId: string;
  scenarioVersion: number;
  title: string;
}

async function login(page: Page): Promise<string> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(loginEmail);
  await page.getByLabel('Password').fill(password);
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url() === `${apiBaseUrl}/auth/login` && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Sign in' }).click();
  const body = (await (await responsePromise).json()) as { accessToken: string };
  await expect(page).toHaveURL(/\/dashboard$/);
  return body.accessToken;
}

async function startStory(page: Page): Promise<string> {
  await page.getByRole('link', { name: 'Interactive story' }).click();
  await expect(page.getByRole('heading', { name: 'The Last Delivery' })).toBeVisible();
  await page.getByRole('button', { name: 'Start story' }).click();
  await expect(page).toHaveURL(SESSION_URL);
  await expect(page.getByRole('heading', { name: 'Praga courtyard', exact: true })).toBeVisible();
  return new URL(page.url()).pathname.split('/').at(-1)!;
}

async function choose(page: Page, label: string, nextSceneTitle: string): Promise<void> {
  await page.getByRole('button', { name: label, exact: true }).click();
  await expect(page.getByRole('heading', { name: nextSceneTitle, exact: true })).toBeVisible();
}

async function registerFreshUser(
  browser: Browser,
  contextOptions: Parameters<Browser['newContext']>[0] = {},
): Promise<Page> {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  await page.goto('/register');
  await page.getByLabel(/^Name/).fill('Second Reader');
  await page.getByLabel('Email').fill(`reader-${Date.now()}@e2e.storyme.test`);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  return page;
}

test.describe('interactive story — real API journeys', () => {
  test('plays the quiet route to its ending and offers another story', async ({ page }) => {
    await login(page);
    await startStory(page);

    await choose(page, 'Check the mailboxes by the stairwell', 'Behind the mailboxes');
    await expect(
      page.getByRole('region', { name: 'Clues' }).getByText(/stamp on the torn ledger page/),
    ).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'Carrying' }).getByText('Torn ledger page'),
    ).toBeVisible();

    // A single-option transition is still an ordinary server-provided choice.
    await choose(page, 'Climb to the fourth floor', 'Flat 4');
    await choose(
      page,
      'Slip a delivery slip under the door and leave the parcel',
      'A quiet delivery',
    );

    await expect(
      page.getByRole('heading', { name: 'A Quiet Delivery', exact: true }),
    ).toBeVisible();
    await expect(page.getByText('What do you do?')).toBeHidden();
    await expect(page.getByRole('link', { name: 'Start another story' })).toBeVisible();
  });

  test('reloads mid-story into the same session, then reaches the exposed ending', async ({
    page,
  }) => {
    await login(page);
    const createRequests: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url() === `${apiBaseUrl}/interactive/sessions`) {
        createRequests.push(request.url());
      }
    });
    const sessionId = await startStory(page);
    expect(createRequests).toHaveLength(1);

    await choose(page, 'Ask the caretaker where Tomasz is', "The caretaker's broom");
    await expect(
      page.getByRole('region', { name: 'Carrying' }).getByText('Single-use entry card'),
    ).toBeVisible();

    await page.reload();
    await expect(page).toHaveURL(new RegExp(`${sessionId}$`));
    await expect(page.getByRole('heading', { name: "The caretaker's broom" })).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'Carrying' }).getByText('Single-use entry card'),
    ).toBeVisible();
    expect(createRequests).toHaveLength(1); // reload resumed; it did not create another session

    await choose(page, 'Climb to the fourth floor', 'Flat 4');
    await choose(page, 'Use the single-use entry card on the lock', 'Inside flat 4');
    // The one-time card is consumed.
    await expect(
      page.getByRole('region', { name: 'Carrying' }).getByText('Single-use entry card'),
    ).toBeHidden();
    await choose(page, 'Take the service stairs down to the cellar', 'The cellar workshop');
    await choose(page, 'Carry the original ledger up and confront Ines', 'The ledger exposed');

    await expect(
      page.getByRole('heading', { name: 'The Ledger Exposed', exact: true }),
    ).toBeVisible();

    // "Start another story" only leads to the catalogue; clicking a story card is what
    // creates the second session.
    await page.getByRole('link', { name: 'Start another story' }).click();
    await expect(page).toHaveURL(/\/dashboard\/interactive$/);
    expect(createRequests).toHaveLength(1);
    await page.getByRole('button', { name: /^Start story/ }).click();
    await expect(page).not.toHaveURL(new RegExp(`${sessionId}$`));
    await expect(page).toHaveURL(SESSION_URL);
    await expect(page.getByRole('heading', { name: 'Praga courtyard', exact: true })).toBeVisible();
    expect(createRequests).toHaveLength(2);
  });

  test('starts the catalogue entry exact id/version and titles the reader from its metadata, across reload', async ({
    page,
  }) => {
    await login(page);
    const created = page.waitForResponse(
      (r) => r.url() === `${apiBaseUrl}/interactive/sessions` && r.request().method() === 'POST',
    );
    const catalogue = page.waitForResponse(
      (r) => r.url() === `${apiBaseUrl}/interactive/scenarios`,
    );
    await page.getByRole('link', { name: 'Interactive story' }).click();
    const entry = (
      (await (await catalogue).json()) as { scenarios: CatalogueEntry[] }
    ).scenarios.find((e) => e.scenarioId === 'warsaw-last-delivery')!;
    expect(entry).toBeTruthy();
    const metadata = page.waitForResponse((r) => METADATA_URL.test(r.url()));
    await page.getByRole('button', { name: 'Start story' }).click();

    // The creation POST names exactly the catalogue entry's id and version.
    const creation = await created;
    const sent = JSON.parse(creation.request().postData() ?? '{}') as Record<string, unknown>;
    expect(sent).toEqual({
      scenarioId: entry.scenarioId,
      scenarioVersion: entry.scenarioVersion,
      idempotencyKey: expect.any(String),
    });
    const session = (await creation.json()) as {
      sessionId: string;
      scenarioId: string;
      scenarioVersion: number;
    };
    expect(session).toMatchObject({
      scenarioId: entry.scenarioId,
      scenarioVersion: entry.scenarioVersion,
    });
    await expect(page).toHaveURL(SESSION_URL);

    // The reader title is exactly what the metadata endpoint said, and it is not the session view's.
    const first = (await (await metadata).json()) as Record<string, unknown>;
    expect(first).toEqual({
      sessionId: session.sessionId,
      scenarioId: entry.scenarioId,
      scenarioVersion: entry.scenarioVersion,
      title: entry.title,
    });
    await expect(page.getByTestId('story-title')).toHaveText(first['title'] as string);

    await choose(page, 'Check the mailboxes by the stairwell', 'Behind the mailboxes');
    await expect(page.getByTestId('story-title')).toHaveText(first['title'] as string);

    // Reload: a fresh metadata answer, the same title, the same session.
    const reloaded = page.waitForResponse((r) => METADATA_URL.test(r.url()));
    await page.reload();
    expect(await (await reloaded).json()).toEqual(first);
    await expect(page.getByRole('heading', { name: 'Behind the mailboxes' })).toBeVisible();
    await expect(page.getByTestId('story-title')).toHaveText(first['title'] as string);
  });

  test('shows the same unavailable screen for missing and foreign sessions', async ({
    page,
    browser,
  }) => {
    await login(page);
    const sessionId = await startStory(page);

    const other = await registerFreshUser(browser);
    await other.goto(`/dashboard/interactive/${sessionId}`);
    const foreign = other.getByRole('heading', { name: /isn.t available/ });
    await expect(foreign).toBeVisible();

    await other.goto('/dashboard/interactive/00000000-0000-4000-8000-0000000000aa');
    await expect(other.getByRole('heading', { name: /isn.t available/ })).toBeVisible();
    await expect(other.getByRole('button', { name: /Ask|Check|Climb/ })).toHaveCount(0);
    await other.context().close();
  });

  test('explains a conflict from another tab and waits for a fresh choice', async ({
    page,
    context,
  }) => {
    await login(page);
    await startStory(page);
    const second = await context.newPage();
    await second.goto(page.url());
    await expect(second.getByRole('heading', { name: 'Praga courtyard' })).toBeVisible();

    // Tab two advances the story; tab one still shows the opening scene.
    await choose(second, 'Check the mailboxes by the stairwell', 'Behind the mailboxes');

    await page.getByRole('button', { name: 'Ask the caretaker where Tomasz is' }).click();
    await expect(page.getByRole('status').filter({ hasText: /moved on/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Behind the mailboxes' })).toBeVisible();
    // Nothing was applied on the player's behalf.
    await expect(page.getByRole('button', { name: 'Climb to the fourth floor' })).toBeEnabled();
    await expect(page.getByText('Single-use entry card')).toBeHidden();
  });
});

test.describe('interactive story — browser-injected transport failures (not a real network fault)', () => {
  test('a lost response is recovered by retrying the identical command exactly once', async ({
    page,
  }) => {
    const token = await login(page);
    const sessionId = await startStory(page);

    const bodies: string[] = [];
    let dropped = false;
    await page.route(`${apiBaseUrl}/interactive/sessions/*/choices`, async (route) => {
      bodies.push(route.request().postData() ?? '');
      if (!dropped) {
        dropped = true;
        // The server really processes it; the browser just never gets the answer.
        await route.fetch();
        await route.abort('failed');
        return;
      }
      await route.continue();
    });

    await page.getByRole('button', { name: 'Ask the caretaker where Tomasz is' }).click();
    await expect(page.getByRole('alert').filter({ hasText: /couldn.t confirm/i })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Check the mailboxes by the stairwell' }),
    ).toBeDisabled();

    await page.getByRole('button', { name: 'Retry choice' }).click();
    await expect(page.getByRole('heading', { name: "The caretaker's broom" })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Climb to the fourth floor', exact: true }),
    ).toBeEnabled();

    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);

    // Exactly one transition was recorded server-side.
    const response = await page.request.get(`${apiBaseUrl}/interactive/sessions/${sessionId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(((await response.json()) as { revision: number }).revision).toBe(1);
  });

  test('a session-metadata outage shows the generic title and play continues', async ({ page }) => {
    await login(page);
    let failures = 0;
    await page.route(METADATA_URL, async (route) => {
      failures += 1;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'SERVICE_UNAVAILABLE', message: 'down' }),
      });
    });
    await startStory(page);
    await expect(page.getByTestId('story-title')).toHaveText('Interactive story');
    await expect.poll(() => failures).toBe(1);

    // Choices, retries and illustrations are unaffected by the title outage.
    await expect(page.getByRole('img', { name: /rain-soaked courtyard/ })).toBeVisible();
    await choose(page, 'Ask the caretaker where Tomasz is', "The caretaker's broom");
    await choose(page, 'Climb to the fourth floor', 'Flat 4');
    await expect(page.getByTestId('story-title')).toHaveText('Interactive story');
    expect(failures).toBe(1); // scene changes did not refetch, and nothing retried on its own
  });
});

// ── Session library (Phase 3) ───────────────────────────────────────────────

const libraryRegion = (page: Page) => page.getByRole('region', { name: 'Your stories' });
const BACK_TO_LIBRARY = '← Interactive story';

test.describe('interactive story library — real API journeys', () => {
  test('starts, returns to the library, resumes mid-story and completes it', async ({
    browser,
  }) => {
    const page = await registerFreshUser(browser);
    const createRequests: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url() === `${apiBaseUrl}/interactive/sessions`) {
        createRequests.push(request.url());
      }
    });
    const sessionId = await startStory(page);
    await choose(page, 'Check the mailboxes by the stairwell', 'Behind the mailboxes');

    await page.getByRole('link', { name: BACK_TO_LIBRARY }).click();
    await expect(page).toHaveURL(/\/dashboard\/interactive$/);
    const stories = libraryRegion(page).getByRole('listitem');
    await expect(stories).toHaveCount(1);
    await expect(stories.getByText('In progress')).toBeVisible();
    await expect(stories.getByText('At: Behind the mailboxes')).toBeVisible();

    // Resume: the reader shows the *current* scene, not the opening one.
    await stories.getByRole('link', { name: /Continue/ }).click();
    await expect(page).toHaveURL(new RegExp(`${sessionId}$`));
    await expect(page.getByRole('heading', { name: 'Behind the mailboxes' })).toBeVisible();
    expect(createRequests).toHaveLength(1); // the library and resume created nothing

    await choose(page, 'Climb to the fourth floor', 'Flat 4');
    await choose(
      page,
      'Slip a delivery slip under the door and leave the parcel',
      'A quiet delivery',
    );

    await page.getByRole('link', { name: BACK_TO_LIBRARY }).click();
    await expect(stories).toHaveCount(1);
    await expect(stories.getByText('Completed')).toBeVisible();
    await expect(stories.getByText('Ending: A Quiet Delivery')).toBeVisible();
    await expect(stories.getByRole('link', { name: /Read again/ })).toBeVisible();
    expect(createRequests).toHaveLength(1);
    await page.context().close();
  });

  test('keeps each account’s stories private', async ({ browser }) => {
    const owner = await registerFreshUser(browser);
    await startStory(owner);

    const other = await registerFreshUser(browser);
    await other.getByRole('link', { name: 'Interactive story' }).click();
    await expect(libraryRegion(other).getByText(/No stories yet/)).toBeVisible();
    await expect(libraryRegion(other).getByRole('listitem')).toHaveCount(0);
    await owner.context().close();
    await other.context().close();
  });
});

test.describe('interactive story library — browser-injected transport failures (not a real network fault)', () => {
  /** The server really creates the session; the browser never receives the answer. */
  async function dropFirstCreationResponse(page: Page): Promise<string[]> {
    const bodies: string[] = [];
    let dropped = false;
    await page.route(`${apiBaseUrl}/interactive/sessions`, async (route) => {
      if (route.request().method() !== 'POST') {
        await route.fallback();
        return;
      }
      bodies.push(route.request().postData() ?? '');
      if (!dropped) {
        dropped = true;
        await route.fetch();
        await route.abort('failed');
        return;
      }
      await route.continue();
    });
    return bodies;
  }

  test('a lost creation response is recovered by retrying the identical command: one session', async ({
    browser,
  }) => {
    const page = await registerFreshUser(browser);
    const bodies = await dropFirstCreationResponse(page);
    const catalogue = page.waitForResponse(
      (r) => r.url() === `${apiBaseUrl}/interactive/scenarios`,
    );
    await page.getByRole('link', { name: 'Interactive story' }).click();
    const entry = (
      (await (await catalogue).json()) as { scenarios: CatalogueEntry[] }
    ).scenarios.find((e) => e.scenarioId === 'warsaw-last-delivery')!;

    await page.getByRole('button', { name: 'Start story' }).click();
    await expect(page.getByRole('alert').filter({ hasText: /couldn.t confirm/i })).toBeVisible();
    expect(bodies).toHaveLength(1); // nothing was retried automatically

    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page).toHaveURL(SESSION_URL);
    await expect(page.getByRole('heading', { name: 'Praga courtyard', exact: true })).toBeVisible();
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]); // same body, same idempotency key
    // ... and that body carries exactly the catalogue entry's id and version plus one key.
    expect(JSON.parse(bodies[1]!)).toEqual({
      scenarioId: entry.scenarioId,
      scenarioVersion: entry.scenarioVersion,
      idempotencyKey: expect.any(String),
    });
    const sessionId = new URL(page.url()).pathname.split('/').at(-1)!;

    // The server holds exactly one session, and it is the one the retry opened.
    await page.getByRole('link', { name: BACK_TO_LIBRARY }).click();
    const stories = libraryRegion(page).getByRole('listitem');
    await expect(stories).toHaveCount(1);
    await expect(stories.getByRole('link', { name: /Continue/ })).toHaveAttribute(
      'href',
      `/dashboard/interactive/${sessionId}`,
    );
    await page.context().close();
  });

  test('a lost creation response leaves a committed session that the library reveals and resumes', async ({
    browser,
  }) => {
    const page = await registerFreshUser(browser);
    const bodies = await dropFirstCreationResponse(page);
    await page.getByRole('link', { name: 'Interactive story' }).click();
    await expect(libraryRegion(page).getByText(/No stories yet/)).toBeVisible();

    await page.getByRole('button', { name: 'Start story' }).click();
    await expect(page.getByRole('alert').filter({ hasText: /couldn.t confirm/i })).toBeVisible();

    await libraryRegion(page).getByRole('button', { name: 'Refresh' }).click();
    const stories = libraryRegion(page).getByRole('listitem');
    await expect(stories).toHaveCount(1);
    await stories.getByRole('link', { name: /Continue/ }).click();

    await expect(page).toHaveURL(SESSION_URL);
    await expect(page.getByRole('heading', { name: 'Praga courtyard', exact: true })).toBeVisible();
    expect(bodies).toHaveLength(1); // resuming from the library sent no second creation
    await page.context().close();
  });
});

// ── Illustrated reader (Phase 4) ────────────────────────────────────────────

/** Alt-text fingerprints of the eight Warsaw noir v1 panels (see presentation/packs.ts). */
const ART = {
  courtyard: /rain-soaked courtyard/,
  caretaker: /caretaker holding a broom/,
  mailboxes: /dented metal mailboxes/,
  door: /silent fourth-floor landing/,
  flat: /dark flat at night/,
  cellar: /brick-vaulted cellar workshop/,
  quiet: /lone cyclist rides away/,
  exposed: /open ledger on it/,
} as const;
type ArtKey = keyof typeof ART;

const artImage = (page: Page, key: ArtKey) => page.getByRole('img', { name: ART[key] });

/** The picture is on screen *and* its file really loaded (not a broken-image box). */
async function expectArt(page: Page, key: ArtKey): Promise<void> {
  const image = artImage(page, key);
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0))
    .toBe(true);
  // Past the fade-in, so screenshots show the finished picture.
  await expect(image).toHaveCSS('opacity', '1');
  for (const other of Object.keys(ART) as ArtKey[]) {
    if (other !== key) await expect(artImage(page, other)).toHaveCount(0);
  }
}

async function expectUsableLayout(page: Page): Promise<void> {
  const viewport = page.viewportSize()!;
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth); // no horizontal scroll
  const figure = page.getByTestId('scene-illustration').locator('figure');
  if ((await figure.count()) > 0) {
    const box = (await figure.first().boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 0.5);
    expect(box.width / box.height).toBeCloseTo(1.5, 1); // the reserved 3:2 shape
  }
  for (const button of await page.getByRole('main').getByRole('button').all()) {
    const box = await button.boundingBox();
    if (box) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 0.5);
    }
  }
}

const SHOTS = 'test-results/interactive-visual';
const PRESENTATION_REV_0 = /\/interactive\/sessions\/[^/]+\/presentation\?expectedRevision=0$/;

test.describe('interactive story — illustrated reader (real API)', () => {
  test('quiet route: every scene has its artwork, and the shared ending is neutral', async ({
    browser,
  }) => {
    const page = await registerFreshUser(browser);
    await startStory(page);
    await expectArt(page, 'courtyard');

    await choose(page, 'Ask the caretaker where Tomasz is', "The caretaker's broom");
    await expectArt(page, 'caretaker');
    await choose(page, 'Climb to the fourth floor', 'Flat 4');
    await expectArt(page, 'door');
    await choose(
      page,
      'Slip a delivery slip under the door and leave the parcel',
      'A quiet delivery',
    );
    await expectArt(page, 'quiet');
    await expect(page.getByRole('link', { name: 'Start another story' })).toBeVisible();
    await page.context().close();
  });

  test('quiet ending reached by handing the parcel over shows the same artwork', async ({
    browser,
  }) => {
    const page = await registerFreshUser(browser);
    await startStory(page);
    await choose(page, 'Check the mailboxes by the stairwell', 'Behind the mailboxes');
    await expectArt(page, 'mailboxes');
    await choose(page, 'Climb to the fourth floor', 'Flat 4');
    await choose(
      page,
      'Follow the ledger stamp down to the cellar workshop',
      'The cellar workshop',
    );
    await expectArt(page, 'cellar');
    await choose(page, 'Hand Tomasz his parcel and ask no more questions', 'A quiet delivery');
    await expectArt(page, 'quiet');
    await page.context().close();
  });

  test('exposed route: reload resumes the matching artwork, then the exposed ending is illustrated', async ({
    browser,
  }) => {
    const page = await registerFreshUser(browser);
    await startStory(page);
    await choose(page, 'Ask the caretaker where Tomasz is', "The caretaker's broom");
    await choose(page, 'Climb to the fourth floor', 'Flat 4');
    await choose(page, 'Use the single-use entry card on the lock', 'Inside flat 4');
    await expectArt(page, 'flat');

    // Reload: the artwork requested for the resumed scene is the one displayed.
    const presentation = page.waitForResponse((r) =>
      /\/interactive\/sessions\/[^/]+\/presentation\?expectedRevision=3$/.test(r.url()),
    );
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Inside flat 4' })).toBeVisible();
    const body = (await (await presentation).json()) as { revision: number; sceneId: string };
    expect(body).toMatchObject({ revision: 3, sceneId: 's-flat' });
    await expectArt(page, 'flat');

    await choose(page, 'Take the service stairs down to the cellar', 'The cellar workshop');
    await expectArt(page, 'cellar');
    await choose(page, 'Carry the original ledger up and confront Ines', 'The ledger exposed');
    await expectArt(page, 'exposed');
    await page.context().close();
  });

  test('a slow artwork answer for the old scene never appears under the new scene', async ({
    browser,
  }) => {
    const page = await registerFreshUser(browser);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held = false;
    let answered = false;
    await page.route(PRESENTATION_REV_0, async (route) => {
      if (held) {
        await route.continue();
        return;
      }
      held = true;
      await gate; // the first scene's answer is withheld until the test releases it
      await route.continue();
      answered = true;
    });
    await startStory(page);
    await expect(page.getByTestId('illustration-placeholder')).toBeVisible();

    // The text and choices are fully usable while the picture is pending.
    await choose(page, 'Ask the caretaker where Tomasz is', "The caretaker's broom");
    await expectArt(page, 'caretaker');

    release(); // the old answer now arrives
    await expect.poll(() => answered).toBe(true);
    await expect(artImage(page, 'courtyard')).toHaveCount(0);
    await expectArt(page, 'caretaker');
    await page.context().close();
  });

  test('an artwork metadata outage leaves the text reader playable; reload recovers it', async ({
    browser,
  }) => {
    const page = await registerFreshUser(browser);
    let failures = 0;
    await page.route(PRESENTATION_REV_0, async (route) => {
      if (failures < 1) {
        failures += 1;
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ code: 'SERVICE_UNAVAILABLE', message: 'down' }),
        });
        return;
      }
      await route.continue();
    });
    await startStory(page);
    await expect(page.getByText(/illustration isn.t available/i)).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Ask the caretaker where Tomasz is' }),
    ).toBeEnabled();

    await page.getByRole('button', { name: 'Reload illustration' }).click();
    await expectArt(page, 'courtyard');
    expect(failures).toBe(1);

    await choose(page, 'Ask the caretaker where Tomasz is', "The caretaker's broom");
    await expectArt(page, 'caretaker');
    await page.context().close();
  });

  test('a broken image file degrades to text and play continues', async ({ browser }) => {
    const page = await registerFreshUser(browser);
    await page.route('**/interactive/warsaw-noir/v1/s-caretaker.svg', (route) =>
      route.abort('failed'),
    );
    await startStory(page);
    await expectArt(page, 'courtyard');

    await choose(page, 'Ask the caretaker where Tomasz is', "The caretaker's broom");
    await expect(page.getByText(/illustration isn.t available/i)).toBeVisible();
    await expect(artImage(page, 'caretaker')).toHaveCount(0);
    await choose(page, 'Climb to the fourth floor', 'Flat 4');
    await expectArt(page, 'door'); // the next scene's art is unaffected
    await page.context().close();
  });

  test('artwork files are public static assets, but the scene metadata needs a login', async ({
    browser,
  }) => {
    const page = await registerFreshUser(browser);
    const sessionId = await startStory(page);
    const asset = await page.request.get('/interactive/warsaw-noir/v1/s-cellar.svg');
    expect(asset.status()).toBe(200);
    expect(asset.headers()['content-type']).toContain('image/svg+xml');

    const anonymous = await (
      await browser.newContext()
    ).request.get(
      `${apiBaseUrl}/interactive/sessions/${sessionId}/presentation?expectedRevision=0`,
    );
    expect([401, 403]).toContain(anonymous.status());
    await page.context().close();
  });

  for (const [name, viewport] of [
    ['desktop', { width: 1280, height: 800 }],
    ['mobile', { width: 390, height: 844 }],
  ] as const) {
    test(`has a usable ${name} layout at the entry scene and the ending (screenshots)`, async ({
      browser,
    }) => {
      const page = await registerFreshUser(browser, {
        viewport,
        deviceScaleFactor: name === 'mobile' ? 2 : 1,
        ...(name === 'mobile' ? { isMobile: true, hasTouch: true } : {}),
      });
      await startStory(page);
      await expectArt(page, 'courtyard');
      await expectUsableLayout(page);
      await page.screenshot({ path: `${SHOTS}/${name}-entry.png`, fullPage: true });

      await choose(page, 'Ask the caretaker where Tomasz is', "The caretaker's broom");
      await expectArt(page, 'caretaker');
      await expectUsableLayout(page);
      await choose(page, 'Climb to the fourth floor', 'Flat 4');
      await choose(page, 'Use the single-use entry card on the lock', 'Inside flat 4');
      await expectArt(page, 'flat');
      await expectUsableLayout(page);
      await page.screenshot({ path: `${SHOTS}/${name}-flat.png`, fullPage: true });
      await choose(page, 'Take the service stairs down to the cellar', 'The cellar workshop');
      await choose(page, 'Hand Tomasz his parcel and ask no more questions', 'A quiet delivery');
      await expectArt(page, 'quiet');
      await expectUsableLayout(page);
      await page.screenshot({ path: `${SHOTS}/${name}-ending.png`, fullPage: true });
      await page.context().close();
    });
  }
});

// ── Rereading a completed story (Phase 9.2) ────────────────────────────────

const TRANSCRIPT_URL = /\/dashboard\/interactive\/[0-9a-f-]{36}\/transcript$/;
const TRANSCRIPT_REQUEST = /\/interactive\/sessions\/[0-9a-f-]{36}\/transcript(\?|$)/;

const chapterHeading = (page: Page, title: string) =>
  page.getByRole('heading', { level: 2, name: title, exact: true });

/** Interactive POSTs seen from now on (creation or choices); rereading must send none. */
function watchInteractivePosts(page: Page): string[] {
  const posts: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().startsWith(`${apiBaseUrl}/interactive/`)) {
      posts.push(request.url());
    }
  });
  return posts;
}

async function playExposedRoute(page: Page): Promise<void> {
  await choose(page, 'Ask the caretaker where Tomasz is', "The caretaker's broom");
  await choose(page, 'Climb to the fourth floor', 'Flat 4');
  await choose(page, 'Use the single-use entry card on the lock', 'Inside flat 4');
  await choose(page, 'Take the service stairs down to the cellar', 'The cellar workshop');
  await choose(page, 'Carry the original ledger up and confront Ines', 'The ledger exposed');
}

test.describe('interactive story — rereading a completed story (real API)', () => {
  test('library “Read again” rereads the exposed route page by page, and reload starts over', async ({
    browser,
  }) => {
    const page = await registerFreshUser(browser);
    const sessionId = await startStory(page);
    await playExposedRoute(page);
    await expect(
      page.getByRole('heading', { name: 'The Ledger Exposed', exact: true }),
    ).toBeVisible();

    await page.getByRole('link', { name: BACK_TO_LIBRARY }).click();
    const stories = libraryRegion(page).getByRole('listitem');
    await expect(stories.getByText('Completed')).toBeVisible();

    // Everything from here on is rereading: no creation and no choice may be sent.
    const posts = watchInteractivePosts(page);
    const transcriptUrls: string[] = [];
    // Finished requests only: dev-mode StrictMode also starts (and immediately aborts) a first one.
    page.on('requestfinished', (request) => {
      if (TRANSCRIPT_REQUEST.test(request.url())) transcriptUrls.push(request.url());
    });

    const readAgain = stories.getByRole('link', { name: /Read again/ });
    await expect(readAgain).toHaveAttribute(
      'href',
      `/dashboard/interactive/${sessionId}/transcript`,
    );
    await readAgain.click();
    await expect(page).toHaveURL(TRANSCRIPT_URL);

    // First page: the first three chapters, nothing else yet.
    await expect(chapterHeading(page, 'Praga courtyard')).toBeVisible();
    await expect(chapterHeading(page, 'Flat 4')).toBeVisible();
    await expect(page.getByTestId('transcript-chapter')).toHaveCount(3);
    await expect(page.getByTestId('transcript-progress')).toHaveText('Showing 3 of 6 chapters.');
    await expect(page.getByTestId('story-title')).toHaveText('The Last Delivery');
    await expect(page.getByText('You chose: Ask the caretaker where Tomasz is')).toBeVisible();
    await expect(chapterHeading(page, 'The ledger exposed')).toHaveCount(0);
    await expect(page.getByText('The end', { exact: true })).toHaveCount(0);
    expect(transcriptUrls).toHaveLength(1); // no automatic loading of the rest
    expect(new URL(transcriptUrls[0]!).searchParams.get('limit')).toBe('3');
    expect(new URL(transcriptUrls[0]!).searchParams.get('cursor')).toBeNull();

    // Explicit "Load more": remaining chapters in order, then the ending.
    await page.getByRole('button', { name: 'Load more' }).click();
    await expect(chapterHeading(page, 'The ledger exposed')).toBeVisible();
    await expect(page.getByTestId('transcript-chapter')).toHaveCount(6);
    await expect(page.getByTestId('transcript-chapter').locator('h2')).toHaveText([
      'Praga courtyard',
      "The caretaker's broom",
      'Flat 4',
      'Inside flat 4',
      'The cellar workshop',
      'The ledger exposed',
    ]);
    await expect(page.getByRole('heading', { level: 3, name: 'The Ledger Exposed' })).toBeVisible();
    await expect(page.getByTestId('transcript-progress')).toHaveText(
      'All 6 chapters, from the beginning to the end.',
    );
    await expect(page.getByRole('button', { name: /Load more|Try again/ })).toHaveCount(0);
    expect(transcriptUrls).toHaveLength(2);
    expect(new URL(transcriptUrls[1]!).searchParams.get('cursor')).toBeTruthy();

    // Reload: a fresh scope that again starts with the first page only.
    await page.reload();
    await expect(chapterHeading(page, 'Praga courtyard')).toBeVisible();
    await expect(page.getByTestId('transcript-chapter')).toHaveCount(3);
    await expect(page.getByTestId('transcript-progress')).toHaveText('Showing 3 of 6 chapters.');
    await page.getByRole('button', { name: 'Load more' }).click();
    await expect(page.getByTestId('transcript-chapter')).toHaveCount(6);
    await expect(page.getByTestId('story-title')).toHaveText('The Last Delivery');

    expect(posts).toEqual([]); // rereading created nothing and chose nothing
    await page.context().close();
  });

  test('the completed reader links to the rereading route; the quiet ending rereads too', async ({
    browser,
  }) => {
    const page = await registerFreshUser(browser);
    await startStory(page);
    await choose(page, 'Check the mailboxes by the stairwell', 'Behind the mailboxes');
    await choose(page, 'Climb to the fourth floor', 'Flat 4');
    await choose(
      page,
      'Slip a delivery slip under the door and leave the parcel',
      'A quiet delivery',
    );

    const posts = watchInteractivePosts(page);
    await page.getByRole('link', { name: 'Read the story from the beginning' }).click();
    await expect(page).toHaveURL(TRANSCRIPT_URL);
    await expect(page.getByTestId('transcript-chapter')).toHaveCount(3);
    await expect(page.getByTestId('transcript-progress')).toHaveText('Showing 3 of 4 chapters.');

    await page.getByRole('button', { name: 'Load more' }).click();
    await expect(page.getByTestId('transcript-chapter')).toHaveCount(4);
    await expect(page.getByRole('heading', { level: 3, name: 'A Quiet Delivery' })).toBeVisible();
    await expect(page.getByTestId('transcript-progress')).toContainText('All 4 chapters');

    await page.getByRole('link', { name: 'Back to the ending' }).click();
    await expect(
      page.getByRole('heading', { name: 'A Quiet Delivery', exact: true }),
    ).toBeVisible();
    expect(posts).toEqual([]);
    await page.context().close();
  });

  test('an unfinished story explains that rereading comes after the ending; a foreign one is unavailable', async ({
    browser,
  }) => {
    const owner = await registerFreshUser(browser);
    const sessionId = await startStory(owner);
    await owner.goto(`/dashboard/interactive/${sessionId}/transcript`);
    await expect(
      owner.getByRole('heading', { name: 'Rereading comes after the ending' }),
    ).toBeVisible();
    await expect(owner.getByTestId('transcript-chapter')).toHaveCount(0);
    await owner.getByRole('link', { name: 'Continue the story' }).click();
    await expect(
      owner.getByRole('heading', { name: 'Praga courtyard', exact: true }),
    ).toBeVisible();

    const other = await registerFreshUser(browser);
    await other.goto(`/dashboard/interactive/${sessionId}/transcript`);
    await expect(other.getByRole('heading', { name: /isn.t available/ })).toBeVisible();
    await other.goto('/dashboard/interactive/00000000-0000-4000-8000-0000000000aa/transcript');
    await expect(other.getByRole('heading', { name: /isn.t available/ })).toBeVisible();
    await owner.context().close();
    await other.context().close();
  });
});

test.describe('interactive story — rereading under browser-injected transport failures (not a real network fault)', () => {
  test('a failed later page keeps the loaded chapters and retries the exact cursor', async ({
    browser,
  }) => {
    const page = await registerFreshUser(browser);
    await startStory(page);
    await playExposedRoute(page);

    const posts = watchInteractivePosts(page);
    const cursors: Array<string | null> = [];
    let failed = false;
    await page.route(TRANSCRIPT_REQUEST, async (route) => {
      const cursor = new URL(route.request().url()).searchParams.get('cursor');
      cursors.push(cursor);
      if (cursor !== null && !failed) {
        failed = true;
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ code: 'SERVICE_UNAVAILABLE', message: 'down' }),
        });
        return;
      }
      await route.continue();
    });

    await page.getByRole('link', { name: 'Read the story from the beginning' }).click();
    await expect(page.getByTestId('transcript-chapter')).toHaveCount(3);

    await page.getByRole('button', { name: 'Load more' }).click();
    const problem = page.getByRole('alert').filter({ hasText: /couldn.t load the next chapters/i });
    await expect(problem).toBeVisible();
    await expect(page.getByTestId('transcript-chapter')).toHaveCount(3); // nothing discarded
    await expect(page.getByTestId('transcript-progress')).toHaveText('Showing 3 of 6 chapters.');

    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByTestId('transcript-chapter')).toHaveCount(6);
    await expect(problem).toHaveCount(0);
    await expect(page.getByTestId('transcript-progress')).toContainText('All 6 chapters');

    // Page-two requests only (the first page has no cursor): the failed one, then the exact retry.
    const pageTwo = cursors.filter((cursor) => cursor !== null);
    expect(pageTwo).toHaveLength(2);
    expect(pageTwo[1]).toBe(pageTwo[0]);
    expect(posts).toEqual([]);
    await page.context().close();
  });

  test('a session-metadata outage leaves the generic title and the chapters readable', async ({
    browser,
  }) => {
    const page = await registerFreshUser(browser);
    await startStory(page);
    await playExposedRoute(page);
    await page.route(METADATA_URL, (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'SERVICE_UNAVAILABLE', message: 'down' }),
      }),
    );

    await page.getByRole('link', { name: 'Read the story from the beginning' }).click();
    await expect(page.getByTestId('transcript-chapter')).toHaveCount(3);
    await expect(page.getByTestId('story-title')).toHaveText('Interactive story');
    await page.getByRole('button', { name: 'Load more' }).click();
    await expect(page.getByTestId('transcript-chapter')).toHaveCount(6);
    await page.context().close();
  });
});

// ── Illustrated rereading (Phase 9.4) ───────────────────────────────────────

const ARTWORK_REQUEST = /\/interactive\/sessions\/[0-9a-f-]{36}\/transcript\/presentation(\?|$)/;

const chapterAt = (page: Page, index: number) => page.getByTestId('transcript-chapter').nth(index);

/** Chapter `index` shows exactly this picture, and its file really loaded (not a broken-image box). */
async function expectChapterArt(page: Page, index: number, key: ArtKey): Promise<void> {
  await expect(chapterAt(page, index).getByRole('img')).toHaveCount(1);
  const image = chapterAt(page, index).getByRole('img', { name: ART[key] });
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0))
    .toBe(true);
}

/** Finished artwork requests (dev-mode StrictMode also starts, and aborts, a first one). */
function watchArtworkRequests(page: Page): URL[] {
  const urls: URL[] = [];
  page.on('requestfinished', (request) => {
    if (ARTWORK_REQUEST.test(request.url())) urls.push(new URL(request.url()));
  });
  return urls;
}

const EXPOSED_ART: ArtKey[] = ['courtyard', 'caretaker', 'door', 'flat', 'cellar', 'exposed'];
const QUIET_ART: ArtKey[] = ['courtyard', 'mailboxes', 'door', 'quiet'];

test.describe('interactive story — illustrated rereading (real API)', () => {
  test('exposed ending: each chapter shows its own picture across pages, and a reload starts over', async ({
    browser,
  }) => {
    const page = await registerFreshUser(browser);
    await startStory(page);
    await playExposedRoute(page);

    const posts = watchInteractivePosts(page);
    const artwork = watchArtworkRequests(page);
    await page.getByRole('link', { name: 'Read the story from the beginning' }).click();
    await expect(page).toHaveURL(TRANSCRIPT_URL);

    await expect(page.getByTestId('transcript-chapter')).toHaveCount(3);
    for (const index of [0, 1, 2]) await expectChapterArt(page, index, EXPOSED_ART[index]!);
    expect(artwork).toHaveLength(1); // one request for the page, not one per chapter
    expect(artwork[0]!.searchParams.get('limit')).toBe('3');
    expect(artwork[0]!.searchParams.get('cursor')).toBeNull();
    await expect(page.getByTestId('transcript-progress')).toHaveText('Showing 3 of 6 chapters.');

    await page.getByRole('button', { name: 'Load more' }).click();
    await expect(page.getByTestId('transcript-chapter')).toHaveCount(6);
    for (const index of [0, 1, 2, 3, 4, 5]) {
      await expectChapterArt(page, index, EXPOSED_ART[index]!);
    }
    expect(artwork).toHaveLength(2);
    expect(artwork[1]!.searchParams.get('limit')).toBe('3');
    expect(artwork[1]!.searchParams.get('cursor')).toBeTruthy();
    // The ending chapter keeps its text and its picture together.
    await expect(
      chapterAt(page, 5).getByRole('heading', { level: 3, name: 'The Ledger Exposed' }),
    ).toBeVisible();
    await expect(page.getByTestId('transcript-progress')).toContainText('All 6 chapters');
    // Images below the first chapter are lazy and every one reserves its size.
    const attributes = await page
      .getByTestId('transcript-chapter')
      .locator('img')
      .evaluateAll((els) =>
        els.map((el) => ({
          loading: el.getAttribute('loading'),
          width: el.getAttribute('width'),
          height: el.getAttribute('height'),
        })),
      );
    expect(attributes.map((a) => a.loading)).toEqual([
      null,
      'lazy',
      'lazy',
      'lazy',
      'lazy',
      'lazy',
    ]);
    expect(attributes.every((a) => a.width === '1200' && a.height === '800')).toBe(true);

    await page.reload();
    await expect(page.getByTestId('transcript-chapter')).toHaveCount(3);
    for (const index of [0, 1, 2]) await expectChapterArt(page, index, EXPOSED_ART[index]!);
    await page.getByRole('button', { name: 'Load more' }).click();
    await expect(page.getByTestId('transcript-chapter')).toHaveCount(6);
    await expectChapterArt(page, 5, 'exposed');

    expect(posts).toEqual([]); // rereading created nothing and chose nothing
    await page.context().close();
  });

  test('quiet ending: its own pictures end the story', async ({ browser }) => {
    const page = await registerFreshUser(browser);
    await startStory(page);
    await choose(page, 'Check the mailboxes by the stairwell', 'Behind the mailboxes');
    await choose(page, 'Climb to the fourth floor', 'Flat 4');
    await choose(
      page,
      'Slip a delivery slip under the door and leave the parcel',
      'A quiet delivery',
    );

    const posts = watchInteractivePosts(page);
    await page.getByRole('link', { name: 'Read the story from the beginning' }).click();
    await expect(page.getByTestId('transcript-chapter')).toHaveCount(3);
    await page.getByRole('button', { name: 'Load more' }).click();
    await expect(page.getByTestId('transcript-chapter')).toHaveCount(4);
    for (const [index, key] of QUIET_ART.entries()) await expectChapterArt(page, index, key);
    await expect(page.getByRole('heading', { level: 3, name: 'A Quiet Delivery' })).toBeVisible();
    expect(posts).toEqual([]);
    await page.context().close();
  });
});

test.describe('interactive story — illustrated rereading under browser-injected failures (not a real network fault)', () => {
  const unavailable = /illustration isn.t available/;

  test('a metadata outage leaves the text and pagination usable; a retry sends the exact query', async ({
    browser,
  }) => {
    const page = await registerFreshUser(browser);
    await startStory(page);
    await playExposedRoute(page);

    const posts = watchInteractivePosts(page);
    const artworkQueries: string[] = [];
    let failures = 0;
    await page.route(ARTWORK_REQUEST, async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('cursor') === null && failures < 1) {
        failures += 1;
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ code: 'SERVICE_UNAVAILABLE', message: 'down' }),
        });
        return;
      }
      artworkQueries.push(url.search);
      await route.continue();
    });

    await page.getByRole('link', { name: 'Read the story from the beginning' }).click();
    await expect(page.getByTestId('transcript-chapter')).toHaveCount(3);
    await expect(page.getByText(unavailable)).toHaveCount(1);
    await expect(page.getByRole('main').getByRole('img')).toHaveCount(0);
    await expect(page.getByTestId('transcript-progress')).toHaveText('Showing 3 of 6 chapters.');

    // Pagination is unaffected, and the next page's pictures still arrive.
    await page.getByRole('button', { name: 'Load more' }).click();
    await expect(page.getByTestId('transcript-chapter')).toHaveCount(6);
    for (const index of [3, 4, 5]) await expectChapterArt(page, index, EXPOSED_ART[index]!);
    await expect(chapterAt(page, 0).getByRole('img')).toHaveCount(0);

    await page.getByRole('button', { name: 'Reload illustration' }).click();
    for (const index of [0, 1, 2]) await expectChapterArt(page, index, EXPOSED_ART[index]!);
    await expect(page.getByText(unavailable)).toHaveCount(0);
    expect(artworkQueries.some((query) => query === '?limit=3')).toBe(true); // exact first-page query
    expect(posts).toEqual([]);
    await page.context().close();
  });

  test('a response for other chapters is rejected whole, and the text stays complete', async ({
    browser,
  }) => {
    const page = await registerFreshUser(browser);
    await startStory(page);
    await playExposedRoute(page);
    await page.route(ARTWORK_REQUEST, async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { steps: { sceneId: string }[] };
      body.steps[1]!.sceneId = 's-somewhere-else';
      await route.fulfill({ response, json: body });
    });

    await page.getByRole('link', { name: 'Read the story from the beginning' }).click();
    await expect(page.getByTestId('transcript-chapter')).toHaveCount(3);
    await expect(page.getByTestId('transcript-progress')).toHaveText('Showing 3 of 6 chapters.');
    await expect(page.getByTestId('illustration-placeholder')).toHaveCount(0);
    await expect(page.getByRole('main').getByRole('img')).toHaveCount(0);
    await page.getByRole('button', { name: 'Load more' }).click();
    await expect(page.getByTestId('transcript-chapter')).toHaveCount(6);
    await expect(page.getByTestId('transcript-progress')).toContainText('All 6 chapters');
    await expect(page.getByTestId('illustration-placeholder')).toHaveCount(0);
    await expect(page.getByRole('main').getByRole('img')).toHaveCount(0);
    await page.context().close();
  });

  test('a broken image file degrades to a note on its chapter only', async ({ browser }) => {
    const page = await registerFreshUser(browser);
    await startStory(page);
    await playExposedRoute(page);
    await page.route('**/interactive/warsaw-noir/v1/s-caretaker.svg', (route) => route.abort());

    const posts = watchInteractivePosts(page);
    await page.getByRole('link', { name: 'Read the story from the beginning' }).click();
    await expect(page.getByTestId('transcript-chapter')).toHaveCount(3);
    await expectChapterArt(page, 0, 'courtyard');
    await expectChapterArt(page, 2, 'door');
    await expect(chapterAt(page, 1).getByText(unavailable)).toBeVisible();
    await expect(chapterAt(page, 1).getByRole('img')).toHaveCount(0);
    await expect(chapterAt(page, 1).getByRole('heading', { level: 2 })).toBeVisible();

    await page.getByRole('button', { name: 'Load more' }).click();
    await expect(page.getByTestId('transcript-chapter')).toHaveCount(6);
    for (const index of [3, 4, 5]) await expectChapterArt(page, index, EXPOSED_ART[index]!);
    expect(posts).toEqual([]);
    await page.context().close();
  });
});
