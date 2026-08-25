import { describe, test, expect, vi, beforeEach } from 'vitest';

const getExchangeRate = vi.fn();
vi.mock('./exchange-rates', () => ({ getExchangeRate: (from: string, to: string) => getExchangeRate(from, to) }));

const { loadViewerLedger, loadUserSummaries } = await import('./friend-ledger');

type FakeDb = Parameters<typeof loadViewerLedger>[0];

const expense = (over: Record<string, unknown> = {}) => ({
  id: 'e1',
  title: 'Dinner',
  currency: 'USD',
  expenseDate: new Date('2026-01-01'),
  paidById: 'alice',
  amount: 2000,
  baseCurrencyAmount: null,
  shares: [
    { userId: 'alice', amount: 1000 },
    { userId: 'bob', amount: 1000 },
  ],
  ...over,
});

const settlement = (over: Record<string, unknown> = {}) => ({
  id: 's1',
  currency: 'USD',
  note: null,
  settledAt: new Date('2026-01-02'),
  fromId: 'bob',
  toId: 'alice',
  amount: 500,
  baseCurrencyAmount: null,
  ...over,
});

const fakeDb = (opts: {
  defaultCurrency?: string | null;
  groups?: unknown[];
  directExpenses?: unknown[];
  directSettlements?: unknown[];
  users?: unknown[];
}) =>
  ({
    user: {
      findUnique: vi
        .fn()
        .mockResolvedValue(opts.defaultCurrency === null ? null : { defaultCurrency: opts.defaultCurrency ?? 'USD' }),
      findMany: vi.fn().mockResolvedValue(opts.users ?? []),
    },
    group: { findMany: vi.fn().mockResolvedValue(opts.groups ?? []) },
    expense: { findMany: vi.fn().mockResolvedValue(opts.directExpenses ?? []) },
    settlement: { findMany: vi.fn().mockResolvedValue(opts.directSettlements ?? []) },
  }) as unknown as FakeDb;

beforeEach(() => {
  getExchangeRate.mockReset();
  getExchangeRate.mockResolvedValue(1);
});

// ── currency folding ──────────────────────────────────────────────────────

describe('display currency', () => {
  test("uses the viewer's default currency", async () => {
    const ledger = await loadViewerLedger(fakeDb({ defaultCurrency: 'SEK' }), 'alice');
    expect(ledger.displayCurrency).toBe('SEK');
  });

  test('falls back to USD when the viewer row is missing', async () => {
    const ledger = await loadViewerLedger(fakeDb({ defaultCurrency: null }), 'alice');
    expect(ledger.displayCurrency).toBe('USD');
  });

  test('skips the lookup entirely when a group is already in the display currency', async () => {
    const db = fakeDb({
      groups: [{ id: 'g1', name: 'Flat', currency: 'USD', expenses: [expense()], settlements: [] }],
    });
    const ledger = await loadViewerLedger(db, 'alice');

    expect(getExchangeRate).not.toHaveBeenCalled();
    expect(ledger.expenses[0]?.displayRate).toBe(1);
  });

  test('stamps each group row with its own currency rate', async () => {
    getExchangeRate.mockResolvedValue(0.1);
    const db = fakeDb({
      groups: [{ id: 'g1', name: 'Trip', currency: 'SEK', expenses: [expense()], settlements: [settlement()] }],
    });
    const ledger = await loadViewerLedger(db, 'alice');

    expect(getExchangeRate).toHaveBeenCalledWith('SEK', 'USD');
    expect(ledger.expenses[0]?.displayRate).toBe(0.1);
    expect(ledger.settlements[0]?.displayRate).toBe(0.1);
  });

  test('looks each distinct currency up once, however many rows repeat it', async () => {
    getExchangeRate.mockResolvedValue(0.1);
    const db = fakeDb({
      groups: [
        { id: 'g1', name: 'A', currency: 'SEK', expenses: [expense()], settlements: [] },
        { id: 'g2', name: 'B', currency: 'SEK', expenses: [expense({ id: 'e2' })], settlements: [] },
        { id: 'g3', name: 'C', currency: 'SEK', expenses: [], settlements: [] },
      ],
    });
    await loadViewerLedger(db, 'alice');

    expect(getExchangeRate).toHaveBeenCalledTimes(1);
  });
});

// ── the unreachable-rate fallback ─────────────────────────────────────────

describe('when a rate cannot be fetched', () => {
  test('assumes 1:1 and flags the whole ledger as approximate', async () => {
    getExchangeRate.mockResolvedValue(null);
    const db = fakeDb({
      groups: [{ id: 'g1', name: 'Trip', currency: 'SEK', expenses: [expense()], settlements: [] }],
    });
    const ledger = await loadViewerLedger(db, 'alice');

    expect(ledger.ratesUnavailable).toBe(true);
    expect(ledger.expenses[0]?.displayRate).toBe(1);
  });

  test('one bad rate does not discard the rows that converted fine', async () => {
    getExchangeRate.mockImplementation(async (from: string) => (from === 'SEK' ? null : 0.5));
    const db = fakeDb({
      groups: [
        { id: 'g1', name: 'Trip', currency: 'SEK', expenses: [expense()], settlements: [] },
        { id: 'g2', name: 'Flat', currency: 'EUR', expenses: [expense({ id: 'e2' })], settlements: [] },
      ],
    });
    const ledger = await loadViewerLedger(db, 'alice');

    expect(ledger.ratesUnavailable).toBe(true);
    expect(ledger.expenses.find((e) => e.id === 'e2')?.displayRate).toBe(0.5);
  });

  test('a fully convertible ledger is not flagged', async () => {
    getExchangeRate.mockResolvedValue(0.5);
    const db = fakeDb({
      groups: [{ id: 'g1', name: 'Trip', currency: 'EUR', expenses: [expense()], settlements: [] }],
    });
    expect((await loadViewerLedger(db, 'alice')).ratesUnavailable).toBe(false);
  });
});

// ── direct (non-group) rows ───────────────────────────────────────────────

describe('direct rows', () => {
  test('are included and marked as belonging to no group', async () => {
    const db = fakeDb({ directExpenses: [expense({ id: 'd1' })], directSettlements: [settlement({ id: 'd2' })] });
    const ledger = await loadViewerLedger(db, 'alice');

    expect(ledger.expenses).toHaveLength(1);
    expect(ledger.expenses[0]).toMatchObject({ id: 'd1', groupId: null, groupName: null });
    expect(ledger.settlements[0]).toMatchObject({ id: 'd2', groupId: null, groupName: null });
  });

  test('anchor in their own currency, since they have no group currency to use', async () => {
    getExchangeRate.mockResolvedValue(0.1);
    const db = fakeDb({ directExpenses: [expense({ currency: 'SEK' })] });
    const ledger = await loadViewerLedger(db, 'alice');

    expect(getExchangeRate).toHaveBeenCalledWith('SEK', 'USD');
    expect(ledger.expenses[0]?.displayRate).toBe(0.1);
  });

  test('sit alongside group rows in one ledger', async () => {
    const db = fakeDb({
      groups: [{ id: 'g1', name: 'Flat', currency: 'USD', expenses: [expense()], settlements: [] }],
      directExpenses: [expense({ id: 'd1' })],
    });
    const ledger = await loadViewerLedger(db, 'alice');

    expect(ledger.expenses.map((e) => e.groupName)).toEqual(['Flat', null]);
  });
});

// ── user summaries ────────────────────────────────────────────────────────

describe('loadUserSummaries', () => {
  test('queries nothing for an empty id list', async () => {
    const db = fakeDb({});
    expect((await loadUserSummaries(db, [])).size).toBe(0);
    expect(db.user.findMany).not.toHaveBeenCalled();
  });

  test('prefers a placeholder name, then the real name', async () => {
    const db = fakeDb({
      users: [
        { id: 'p1', name: null, placeholderName: 'Ghost', image: null, isPlaceholder: true, venmoUsername: null },
        { id: 'u1', name: 'Bob', placeholderName: null, image: null, isPlaceholder: false, venmoUsername: 'bob' },
      ],
    });
    const users = await loadUserSummaries(db, ['p1', 'u1']);

    expect(users.get('p1')?.name).toBe('Ghost');
    expect(users.get('u1')?.name).toBe('Bob');
  });

  test('falls back to Unknown rather than rendering a blank name', async () => {
    const db = fakeDb({
      users: [{ id: 'u1', name: null, placeholderName: null, image: null, isPlaceholder: false, venmoUsername: null }],
    });
    expect((await loadUserSummaries(db, ['u1'])).get('u1')?.name).toBe('Unknown');
  });

  test('deduplicates ids before querying', async () => {
    const db = fakeDb({ users: [] });
    await loadUserSummaries(db, ['a', 'a', 'b']);

    expect(db.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ['a', 'b'] } } }));
  });
});
