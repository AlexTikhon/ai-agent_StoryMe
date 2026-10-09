import { expect, test, type Browser, type Page } from '@playwright/test';

// Interactive story reader. Runs through the guarded Playwright config: real
// API, disposable PostgreSQL/Redis, deterministic mock narrator, no providers.

const apiBaseUrl = 'http://127.0.0.1:4100/api';
const loginEmail = 'verified-login@e2e.storyme.test';
const password = 'StoryMeE2E1!';
const SESSION_URL = /\/dashboard\/interactive\/[0-9a-f-]{36}$/;

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

async function registerFreshUser(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
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
    await expect(page.getByRole('button', { name: 'Start another story' })).toBeEnabled();
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

    // "Start another story" is the only thing that creates a second session.
    await page.getByRole('button', { name: 'Start another story' }).click();
    await expect(page).not.toHaveURL(new RegExp(`${sessionId}$`));
    await expect(page).toHaveURL(SESSION_URL);
    await expect(page.getByRole('heading', { name: 'Praga courtyard', exact: true })).toBeVisible();
    expect(createRequests).toHaveLength(2);
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
    await page.getByRole('link', { name: 'Interactive story' }).click();

    await page.getByRole('button', { name: 'Start story' }).click();
    await expect(page.getByRole('alert').filter({ hasText: /couldn.t confirm/i })).toBeVisible();
    expect(bodies).toHaveLength(1); // nothing was retried automatically

    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page).toHaveURL(SESSION_URL);
    await expect(page.getByRole('heading', { name: 'Praga courtyard', exact: true })).toBeVisible();
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]); // same body, same idempotency key
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
