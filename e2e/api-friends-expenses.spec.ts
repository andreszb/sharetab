import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect, request } from '@playwright/test';
import {
  users,
  authedContext,
  trpcMutation,
  trpcQuery,
  trpcResult,
  trpcError,
  uniqueEmail,
  deleteTestUser,
} from './helpers';

const BASE = process.env.BASE_URL || 'http://localhost:3001';
const PASSWORD = 'password123';
const AI_TIMEOUT = 120_000;

// These tests build on one another — a later one reads the balance or feed
// entry an earlier one wrote. The config's `fullyParallel` would otherwise
// spread them across workers, and since `emails` is randomised per module
// load, each worker would register a *different* Ana and Ben and then assert
// against the wrong one.
test.describe.configure({ mode: 'serial' });

/**
 * Register a throwaway account through the API and sign in as it.
 *
 * These specs deliberately use fresh users rather than the seeded ones: a
 * direct settlement cannot be deleted through any procedure, so running them
 * against Alice and Bob would permanently move the balances that
 * `api-balances.spec.ts` asserts. Everything created here is removed by
 * deleting the users in `afterAll`.
 */
async function registerUser(name: string, email: string) {
  const anon = await request.newContext({ baseURL: BASE });
  await trpcMutation(anon, 'auth.register', { name, email, password: PASSWORD });
  await anon.dispose();
  return authedContext(email, PASSWORD);
}

test.describe('Friends direct expenses API', () => {
  const emails = {
    ana: uniqueEmail('friend-ana'),
    ben: uniqueEmail('friend-ben'),
    cleo: uniqueEmail('friend-cleo'),
    dana: uniqueEmail('friend-dana'),
  };

  let ana: Awaited<ReturnType<typeof authedContext>>;
  let ben: Awaited<ReturnType<typeof authedContext>>;
  let cleo: Awaited<ReturnType<typeof authedContext>>;
  let dana: Awaited<ReturnType<typeof authedContext>>;
  let anaId: string;
  let benId: string;
  let cleoId: string;
  let danaId: string;

  test.beforeAll(async () => {
    ana = await registerUser('Ana Direct', emails.ana);
    ben = await registerUser('Ben Direct', emails.ben);
    cleo = await registerUser('Cleo Direct', emails.cleo);
    dana = await registerUser('Dana Direct', emails.dana);

    // getProfile omits the id; the session carries it.
    anaId = (await trpcResult(await trpcQuery(ana, 'auth.getSession'))).user.id;
    benId = (await trpcResult(await trpcQuery(ben, 'auth.getSession'))).user.id;
    cleoId = (await trpcResult(await trpcQuery(cleo, 'auth.getSession'))).user.id;
    danaId = (await trpcResult(await trpcQuery(dana, 'auth.getSession'))).user.id;

    // Ana invites Ben and Dana. She may log expenses against either straight
    // away — the friendship is one-sided until they answer. Dana is never put
    // on an expense, so she stays a stranger to everyone for the negatives.
    await trpcMutation(ana, 'friends.addByEmail', { email: emails.ben });
    await trpcMutation(ana, 'friends.addByEmail', { email: emails.dana });
  });

  test.afterAll(async () => {
    for (const ctx of [ana, ben, cleo, dana]) await ctx.dispose();
    const admin = await authedContext(users.alice.email, users.alice.password);
    for (const email of Object.values(emails)) await deleteTestUser(admin, email);
    await admin.dispose();
  });

  test('creates a direct expense and reflects it in the friend balance', async () => {
    const res = await trpcMutation(ana, 'expenses.create', {
      title: 'Dinner, no group',
      amount: 4000,
      currency: 'USD',
      paidById: anaId,
      splitMode: 'EQUAL',
      shares: [
        { userId: anaId, amount: 2000 },
        { userId: benId, amount: 2000 },
      ],
    });
    const expense = await trpcResult(res);
    expect(expense?.id).toBeTruthy();
    expect(expense.groupId).toBeNull();
    // The anchor-currency contract: a direct row carries no base amount.
    expect(expense.baseCurrencyAmount).toBeNull();

    const balance = await trpcResult(await trpcQuery(ana, 'friends.getBalance', { friendId: benId }));
    expect(balance.net).toBe(2000);

    const ledger = await trpcResult(await trpcQuery(ana, 'friends.getLedger', { friendId: benId }));
    expect(ledger.net).toBe(2000);
    expect(ledger.entries.reduce((sum: number, e: { delta: number }) => sum + e.delta, 0)).toBe(2000);
    expect(ledger.entries[0].groupId).toBeNull();
  });

  test('settling the direct balance brings it back to zero', async () => {
    const res = await trpcMutation(ben, 'settlements.create', {
      toId: anaId,
      amount: 2000,
      currency: 'USD',
      note: 'Paying Ana back',
    });
    const settlement = await trpcResult(res);
    expect(settlement?.id).toBeTruthy();
    expect(settlement.groupId).toBeNull();
    expect(settlement.baseCurrencyAmount).toBeNull();

    const balance = await trpcResult(await trpcQuery(ana, 'friends.getBalance', { friendId: benId }));
    expect(balance.net).toBe(0);
  });

  test('a direct expense reaches the other participant activity feed', async () => {
    const items = await trpcResult(await trpcQuery(ben, 'activity.getRecentActivity', { limit: 20 }));
    const titles = items.map((item: { metadata?: { title?: string } }) => item.metadata?.title);
    expect(titles).toContain('Dinner, no group');
  });

  test('a three-way direct expense is allowed once everyone is connected', async () => {
    await trpcMutation(ana, 'friends.addByEmail', { email: emails.cleo });

    const res = await trpcMutation(ana, 'expenses.create', {
      title: 'Three-way taxi',
      amount: 3000,
      currency: 'USD',
      paidById: anaId,
      splitMode: 'EQUAL',
      shares: [
        { userId: anaId, amount: 1000 },
        { userId: benId, amount: 1000 },
        { userId: cleoId, amount: 1000 },
      ],
    });
    expect((await trpcResult(res))?.id).toBeTruthy();

    const balance = await trpcResult(await trpcQuery(ana, 'friends.getBalance', { friendId: cleoId }));
    expect(balance.net).toBe(1000);
  });

  test('sharing a direct expense connects two people who never invited each other', async () => {
    // Ben and Cleo were only ever both on Ana's three-way taxi. That shared row
    // is itself a connection, so either can now start an expense with the other
    // — the same rule that makes group co-members friends without a row.
    const res = await trpcMutation(ben, 'expenses.create', {
      title: 'Ben and Cleo, introduced by a taxi',
      amount: 2000,
      paidById: benId,
      splitMode: 'EQUAL',
      shares: [
        { userId: benId, amount: 1000 },
        { userId: cleoId, amount: 1000 },
      ],
    });
    expect((await trpcResult(res))?.id).toBeTruthy();
  });

  test('an unconnected participant is refused', async () => {
    // Dana shares no group, no expense, and no friendship with Ben.
    const res = await trpcMutation(ben, 'expenses.create', {
      title: 'Stranger split',
      amount: 2000,
      paidById: benId,
      splitMode: 'EQUAL',
      shares: [
        { userId: benId, amount: 1000 },
        { userId: danaId, amount: 1000 },
      ],
    });
    const error = await trpcError(res);
    expect(error?.data?.code).toBe('BAD_REQUEST');
    expect(error?.message).toContain('not connected');
  });

  test('an expense the creator is not part of is refused', async () => {
    const res = await trpcMutation(ana, 'expenses.create', {
      title: 'Not my expense',
      amount: 2000,
      paidById: benId,
      splitMode: 'EQUAL',
      shares: [{ userId: benId, amount: 2000 }],
    });
    const error = await trpcError(res);
    expect(error?.data?.code).toBe('BAD_REQUEST');
    expect(error?.message).toContain('must be part of');
  });

  test('someone who only received an invite cannot log against the sender', async () => {
    // Dana has an unanswered invite from Ana and no shared history, so the
    // one-sided rule is the only thing deciding — and it says no.
    const res = await trpcMutation(dana, 'expenses.create', {
      title: 'Presumptuous',
      amount: 2000,
      paidById: danaId,
      splitMode: 'EQUAL',
      shares: [
        { userId: danaId, amount: 1000 },
        { userId: anaId, amount: 1000 },
      ],
    });
    const error = await trpcError(res);
    expect(error?.data?.code).toBe('BAD_REQUEST');
    expect(error?.message).toContain('not connected');
  });

  test('accepting the invite makes it work', async () => {
    await trpcMutation(dana, 'friends.respondToInvite', { friendId: anaId, response: 'accept' });

    const res = await trpcMutation(dana, 'expenses.create', {
      title: 'Now allowed',
      amount: 2000,
      paidById: danaId,
      splitMode: 'EQUAL',
      shares: [
        { userId: danaId, amount: 1000 },
        { userId: anaId, amount: 1000 },
      ],
    });
    expect((await trpcResult(res))?.id).toBeTruthy();
  });

  test('a non-participant cannot read a direct expense', async () => {
    const created = await trpcResult(
      await trpcMutation(ana, 'expenses.create', {
        title: 'Private to Ana and Ben',
        amount: 1000,
        paidById: anaId,
        splitMode: 'EQUAL',
        shares: [
          { userId: anaId, amount: 500 },
          { userId: benId, amount: 500 },
        ],
      }),
    );

    const mine = await trpcResult(await trpcQuery(ana, 'expenses.get', { expenseId: created.id }));
    expect(mine.id).toBe(created.id);

    const res = await trpcQuery(dana, 'expenses.get', { expenseId: created.id });
    expect((await trpcError(res))?.data?.code).toBe('NOT_FOUND');
  });

  test('scans a receipt into a direct expense', async () => {
    // Gated like every other receipt spec: it needs an AI provider configured
    // (AI_PROVIDER_PRIORITY=mock is enough — no real API call).
    test.skip(!process.env.RUN_AI_TESTS, 'Set RUN_AI_TESTS=1 to enable');

    const upload = await ana.post(`${BASE}/api/upload`, {
      multipart: {
        file: {
          name: 'test-receipt.png',
          mimeType: 'image/png',
          buffer: readFileSync(resolve('e2e/test-receipt.png')),
        },
      },
    });
    expect(upload.status()).toBe(200);
    const { receiptId } = await upload.json();

    const processed = await trpcResult(await trpcMutation(ana, 'receipts.processReceipt', { receiptId }, AI_TIMEOUT));
    expect(processed.status).toBe('COMPLETED');

    // An ungrouped receipt is pending for whoever uploaded it.
    const pending = await trpcResult(await trpcQuery(ana, 'receipts.listPending', {}));
    expect(pending.map((r: { id: string }) => r.id)).toContain(receiptId);

    const { items } = await trpcResult(await trpcQuery(ana, 'receipts.getReceiptItems', { receiptId }));
    const assignments = items.slice(0, 4).map((item: { id: string }, i: number) => ({
      receiptItemId: item.id,
      userIds: i % 2 === 0 ? [anaId, benId] : [benId],
    }));

    const expense = await trpcResult(
      await trpcMutation(ana, 'receipts.assignItemsAndCreateExpense', {
        receiptId,
        title: 'Direct receipt split',
        paidById: anaId,
        assignments,
      }),
    );
    expect(expense.groupId).toBeNull();
    expect(expense.splitMode).toBe('ITEM');
    // The receipt path must honour the anchor contract too — the currency comes
    // from the receipt (or the viewer's default), never converted into a group's.
    expect(expense.baseCurrencyAmount).toBeNull();
    expect(expense.amount).toBeGreaterThan(0);

    // Consuming the receipt clears it from the pending list.
    const after = await trpcResult(await trpcQuery(ana, 'receipts.listPending', {}));
    expect(after.map((r: { id: string }) => r.id)).not.toContain(receiptId);
  });

  test('only the creator or payer can delete a direct expense', async () => {
    const created = await trpcResult(
      await trpcMutation(ana, 'expenses.create', {
        title: 'Ana deletes this',
        amount: 1000,
        paidById: anaId,
        splitMode: 'EQUAL',
        shares: [
          { userId: anaId, amount: 500 },
          { userId: benId, amount: 500 },
        ],
      }),
    );

    // Ben holds a share but neither paid nor created it.
    const refused = await trpcMutation(ben, 'expenses.delete', { expenseId: created.id });
    expect((await trpcError(refused))?.data?.code).toBe('FORBIDDEN');

    const deleted = await trpcMutation(ana, 'expenses.delete', { expenseId: created.id });
    expect((await trpcResult(deleted))?.success).toBe(true);
  });
});
