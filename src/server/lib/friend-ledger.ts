/**
 * Loads the viewer's entire cross-group ledger, folded into a single currency.
 *
 * Four surfaces need exactly this — the dashboard's overall debts, the friends
 * list, a single friend's balance, and a single friend's ledger — and they must
 * agree to the cent. Assembling it once here is what keeps them agreeing;
 * the alternative is four slightly different `findMany` shapes drifting apart.
 *
 * Everything is denominated in the viewer's `defaultCurrency`. Group rows are
 * anchored in their group's currency (that is what `baseCurrencyAmount` means);
 * direct expenses have no group to anchor to, so they are anchored in the
 * currency they were entered in. Both then take one rate into the display
 * currency, applied by the engine as a single rescale.
 */

import type { PrismaClient } from '@/generated/prisma/client';
import { getExchangeRate } from './exchange-rates';
import { participatesInExpense } from './friend-queries';
import type { PairwiseExpense, PairwiseSettlement } from './pairwise-balance-calculator';

/** Where a ledger row came from, for display. Null group = a direct expense. */
export type LedgerOrigin = { groupId: string | null; groupName: string | null };

export type LedgerExpense = PairwiseExpense &
  LedgerOrigin & {
    id: string;
    title: string;
    currency: string;
    expenseDate: Date;
  };

export type LedgerSettlement = PairwiseSettlement &
  LedgerOrigin & {
    id: string;
    currency: string;
    note: string | null;
    settledAt: Date;
  };

export type ViewerLedger = {
  displayCurrency: string;
  /** True when at least one rate could not be fetched and 1:1 was assumed. */
  ratesUnavailable: boolean;
  expenses: LedgerExpense[];
  settlements: LedgerSettlement[];
};

export type UserSummary = {
  id: string;
  name: string;
  image: string | null;
  isPlaceholder: boolean;
  venmoUsername: string | null;
};

/**
 * Look up display details for a set of user ids in one query.
 *
 * Placeholders carry their name in `placeholderName`, and a real user can have
 * a null `name`, so the fallback chain matters: without it the dashboard shows
 * "Unknown" for people it knows perfectly well.
 */
export async function loadUserSummaries(db: PrismaClient, userIds: string[]): Promise<Map<string, UserSummary>> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Map();

  const users = await db.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, image: true, isPlaceholder: true, placeholderName: true, venmoUsername: true },
  });

  return new Map(
    users.map((user) => [
      user.id,
      {
        id: user.id,
        name: user.placeholderName ?? user.name ?? 'Unknown',
        image: user.image,
        isPlaceholder: user.isPlaceholder,
        venmoUsername: user.venmoUsername,
      },
    ]),
  );
}

export async function loadViewerLedger(db: PrismaClient, viewerId: string): Promise<ViewerLedger> {
  const [viewer, groups, directExpenses, directSettlements] = await Promise.all([
    db.user.findUnique({ where: { id: viewerId }, select: { defaultCurrency: true } }),
    db.group.findMany({
      where: { members: { some: { userId: viewerId } }, archivedAt: null },
      select: {
        id: true,
        name: true,
        currency: true,
        expenses: {
          select: {
            id: true,
            title: true,
            currency: true,
            expenseDate: true,
            paidById: true,
            amount: true,
            baseCurrencyAmount: true,
            shares: { select: { userId: true, amount: true } },
          },
        },
        settlements: {
          select: {
            id: true,
            currency: true,
            note: true,
            settledAt: true,
            fromId: true,
            toId: true,
            amount: true,
            baseCurrencyAmount: true,
          },
        },
      },
    }),
    db.expense.findMany({
      where: { groupId: null, ...participatesInExpense(viewerId) },
      select: {
        id: true,
        title: true,
        currency: true,
        expenseDate: true,
        paidById: true,
        amount: true,
        baseCurrencyAmount: true,
        shares: { select: { userId: true, amount: true } },
      },
    }),
    db.settlement.findMany({
      where: { groupId: null, OR: [{ fromId: viewerId }, { toId: viewerId }] },
      select: {
        id: true,
        currency: true,
        note: true,
        settledAt: true,
        fromId: true,
        toId: true,
        amount: true,
        baseCurrencyAmount: true,
      },
    }),
  ]);

  const displayCurrency = viewer?.defaultCurrency ?? 'USD';

  // One lookup per distinct anchor currency, not per row: getExchangeRate
  // caches, but a long ledger repeats the same currency hundreds of times.
  const anchors = new Set<string>([
    ...groups.map((group) => group.currency),
    ...directExpenses.map((expense) => expense.currency),
    ...directSettlements.map((settlement) => settlement.currency),
  ]);

  const rates = new Map<string, number>();
  let ratesUnavailable = false;
  for (const currency of anchors) {
    if (currency === displayCurrency) {
      rates.set(currency, 1);
      continue;
    }
    const rate = await getExchangeRate(currency, displayCurrency);
    if (rate == null) {
      // One unreachable rate must not blank the whole view. Fall back to 1:1
      // and let the client mark the figures as approximate.
      ratesUnavailable = true;
      rates.set(currency, 1);
    } else {
      rates.set(currency, rate);
    }
  }

  const expenses: LedgerExpense[] = [];
  const settlements: LedgerSettlement[] = [];

  for (const group of groups) {
    const displayRate = rates.get(group.currency) ?? 1;
    const origin = { groupId: group.id, groupName: group.name };
    for (const expense of group.expenses) expenses.push({ ...expense, ...origin, displayRate });
    for (const settlement of group.settlements) settlements.push({ ...settlement, ...origin, displayRate });
  }

  const direct = { groupId: null, groupName: null };
  for (const expense of directExpenses) {
    expenses.push({ ...expense, ...direct, displayRate: rates.get(expense.currency) ?? 1 });
  }
  for (const settlement of directSettlements) {
    settlements.push({ ...settlement, ...direct, displayRate: rates.get(settlement.currency) ?? 1 });
  }

  return { displayCurrency, ratesUnavailable, expenses, settlements };
}
