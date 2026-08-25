import { test, expect, request } from '@playwright/test';
import { authedContext, login, register, trpcMutation, trpcQuery, trpcResult, uniqueEmail } from './helpers';

const BASE = process.env.BASE_URL || 'http://localhost:3001';
const PASSWORD = 'password123';

// Each test builds on the page state the previous one left behind — an invite
// sent in one is answered in the next. Under the config's `fullyParallel` the
// tests would land on different workers, each registering its own randomly
// named pair and asserting against people who did nothing.
test.describe.configure({ mode: 'serial' });

test.describe('Friends UI', () => {
  const emails = {
    ida: uniqueEmail('friends-ui-ida'),
    jon: uniqueEmail('friends-ui-jon'),
  };

  let ida: Awaited<ReturnType<typeof authedContext>>;
  let jon: Awaited<ReturnType<typeof authedContext>>;

  test.beforeAll(async () => {
    const anon = await request.newContext({ baseURL: BASE });
    await trpcMutation(anon, 'auth.register', { name: 'Ida Friend', email: emails.ida, password: PASSWORD });
    await trpcMutation(anon, 'auth.register', { name: 'Jon Friend', email: emails.jon, password: PASSWORD });
    await anon.dispose();

    ida = await authedContext(emails.ida, PASSWORD);
    jon = await authedContext(emails.jon, PASSWORD);
  });

  test.afterAll(async () => {
    await ida?.dispose();
    await jon?.dispose();
  });

  test('Friends appears in the sidebar and opens an empty list', async ({ page }) => {
    await login(page, emails.ida, PASSWORD);

    await page.getByRole('link', { name: 'Friends' }).first().click();
    await page.waitForURL(/\/en\/friends$/);

    await expect(page.getByRole('heading', { name: 'Friends' })).toBeVisible();
    await expect(page.getByText('No friends yet.')).toBeVisible();
  });

  test('a placeholder friend can be added by name and shows as settled', async ({ page }) => {
    await login(page, emails.ida, PASSWORD);
    await page.goto('/en/friends');

    await page.getByRole('button', { name: 'Add friend' }).first().click();
    await page.getByRole('button', { name: 'By name' }).click();
    await page.getByLabel('Name').fill('Ghost Pal');
    await page.getByRole('button', { name: 'Add friend', exact: true }).last().click();

    const row = page.getByTestId('friends-list').getByText('Ghost Pal');
    await expect(row).toBeVisible();
    // A placeholder is ACCEPTED from the start — there is nobody to accept —
    // so its balance is a real 0, not the withheld null.
    await expect(page.getByTestId('friends-list').getByText('Settled up')).toBeVisible();
    await expect(page.getByTestId('friends-list').getByText('Not on ShareTab')).toBeVisible();
  });

  test('an expense with the placeholder moves the balance and lists in the ledger', async ({ page }) => {
    await login(page, emails.ida, PASSWORD);
    await page.goto('/en/friends');

    await page.getByRole('link', { name: 'Ghost Pal' }).click();
    await page.waitForURL(/\/en\/friends\/[^/]+$/);
    // Rendered by `Button render={<Link>} nativeButton={false}`, which is a Base
    // UI button: it stamps role="button" onto the anchor, replacing the link role.
    await page.getByRole('button', { name: 'Add expense' }).click();
    await page.waitForURL(/\/expenses\/new$/);

    await page.getByLabel('Description').fill('Split dinner');
    await page.getByLabel('Amount', { exact: true }).fill('40.00');
    await page.getByLabel('Paid by').selectOption({ label: 'Ida Friend' });
    // The form reuses the group expense namespace, so the submit reads "Add
    // Expense" — capital E, unlike the "Add expense" link that led here.
    await page.getByRole('button', { name: 'Add Expense', exact: true }).click();

    await page.waitForURL(/\/en\/friends\/[^/]+$/);
    // Ida paid 40 and owes half, so the placeholder owes her 20.
    await expect(page.getByTestId('friend-net')).toHaveText(/20\.00/);
    await expect(page.getByText('Split dinner')).toBeVisible();
    await expect(page.getByText('Direct')).toBeVisible();
  });

  test('the placeholder can be settled against, which clears the balance', async ({ page }) => {
    await login(page, emails.ida, PASSWORD);
    await page.goto('/en/friends');
    await page.getByRole('link', { name: 'Ghost Pal' }).click();
    await page.waitForURL(/\/en\/friends\/[^/]+$/);

    await page.getByRole('button', { name: 'Settle up' }).click();
    // The placeholder owes Ida, so the dialog must default to *them* paying —
    // a direction the group settle dialog never offers.
    await expect(page.getByRole('button', { name: /Ghost Pal paid you/ })).toBeVisible();
    await page.getByRole('button', { name: 'Record payment' }).click();

    await expect(page.getByText('You are settled up with Ghost Pal')).toBeVisible();
  });

  test('an invite by email is withheld from the addressee until accepted', async ({ page }) => {
    await login(page, emails.ida, PASSWORD);
    await page.goto('/en/friends');

    await page.getByRole('button', { name: 'Add friend' }).first().click();
    await page.getByLabel('Email').fill(emails.jon);
    await page.getByRole('button', { name: 'Send invite' }).click();
    await expect(page.getByText('Invite sent')).toBeVisible();

    // Jon sees an invite he can answer, and no figure behind it.
    await login(page, emails.jon, PASSWORD);
    await page.goto('/en/friends');
    await expect(page.getByTestId('friend-invites').getByText('Invited you')).toBeVisible();
    await expect(page.getByTestId('friend-invites').getByText('Hidden')).toBeVisible();

    await page.getByRole('button', { name: 'Accept' }).click();
    await expect(page.getByTestId('friend-invites')).toBeHidden();
    await expect(page.getByTestId('friends-list').getByText('Ida Friend')).toBeVisible();
  });

  test('both sides of the invite reach the unified activity feed', async () => {
    // The addressee arm is the whole reason this is not just the sender's own
    // entry: a friendship id matches neither the direct expense nor the
    // settlement id list `getRecentActivity` otherwise filters on.
    for (const ctx of [ida, jon]) {
      const feed = await trpcResult(await trpcQuery(ctx, 'activity.getRecentActivity', { limit: 50 }));
      const types = feed.map((item: { type: string }) => item.type);
      expect(types).toContain('FRIEND_INVITE_SENT');
      expect(types).toContain('FRIEND_INVITE_ACCEPTED');
    }
  });

  test('a new account reaches Friends from the mobile menu', async ({ page }) => {
    const email = uniqueEmail('friends-ui-mob');
    await page.setViewportSize({ width: 390, height: 844 });
    await register(page, 'Mobile Friend', email, PASSWORD);

    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.getByRole('link', { name: 'Friends' }).click();
    await page.waitForURL(/\/en\/friends$/);
    await expect(page.getByRole('heading', { name: 'Friends' })).toBeVisible();
  });
});
