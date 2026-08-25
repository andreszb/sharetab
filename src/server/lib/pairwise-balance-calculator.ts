/**
 * Exact pairwise ledger between the viewer and each other person.
 *
 * This is deliberately NOT the group balance model in `balance-calculator.ts`.
 * That one nets each member to a single number and then uses `simplifyDebts` to
 * heuristically match debtors to creditors, which is the right thing inside a
 * group (it minimises the number of transfers) but produces edges between people
 * who never actually shared an expense. Rolling those synthetic edges up per
 * person — as `balances.getOverallDebts` used to — reports debts that do not
 * exist.
 *
 * Here every expense and settlement is instead attributed literally: the payer
 * is credited and each other participant is debited their own share *against
 * that payer*. Two people only ever appear in each other's ledger if they were
 * both on the same expense or settlement.
 */

import { scaleShares } from './balance-calculator';

export type PairwiseExpense = {
  paidById: string;
  amount: number;
  /** Amount in the ledger's anchor currency (the group's currency, for group expenses). */
  baseCurrencyAmount?: number | null;
  /** Rate from the anchor currency into the viewer's display currency. 1 = none. */
  displayRate?: number;
  shares: { userId: string; amount: number }[];
};

export type PairwiseSettlement = {
  fromId: string;
  toId: string;
  amount: number;
  /** Amount in the ledger's anchor currency. */
  baseCurrencyAmount?: number | null;
  /** Rate from the anchor currency into the viewer's display currency. 1 = none. */
  displayRate?: number;
};

/** net > 0: this person owes the viewer. net < 0: the viewer owes them. */
export type PairwiseBalance = { userId: string; net: number };

/** Convert an anchor amount into the viewer's display currency. */
function toDisplay(amount: number, baseCurrencyAmount: number | null | undefined, displayRate: number | undefined) {
  return Math.round((baseCurrencyAmount ?? amount) * (displayRate ?? 1));
}

/**
 * Build the viewer's pairwise balance against every counterparty they share
 * history with.
 *
 * Expenses and settlements may span groups with different currencies: pass a
 * `displayRate` per entry to fold them all into one currency. Base-currency and
 * display-currency conversion are applied as a single rescale so the shares
 * still sum exactly to the converted total.
 *
 * Entries the viewer took no part in are skipped, which is what stops a debt
 * being invented between two third parties. Counterparties that net to zero are
 * omitted, and the result is sorted by `userId`.
 */
export function computePairwiseBalances(
  viewerId: string,
  expenses: PairwiseExpense[],
  settlements: PairwiseSettlement[],
): PairwiseBalance[] {
  const net = new Map<string, number>();
  const add = (userId: string, delta: number) => net.set(userId, (net.get(userId) ?? 0) + delta);

  for (const expense of expenses) {
    const viewerPaid = expense.paidById === viewerId;
    const viewerParticipated = expense.shares.some((s) => s.userId === viewerId);
    if (!viewerPaid && !viewerParticipated) continue;

    const displayTotal = toDisplay(expense.amount, expense.baseCurrencyAmount, expense.displayRate);
    const shares = scaleShares(expense.shares, expense.amount, displayTotal);

    if (viewerPaid) {
      // Everyone else owes the viewer their share. The viewer's own share is
      // not a debt to themselves.
      for (const share of shares) {
        if (share.userId !== viewerId) add(share.userId, share.amount);
      }
    } else {
      const viewerShare = shares.find((s) => s.userId === viewerId);
      if (viewerShare) add(expense.paidById, -viewerShare.amount);
    }
  }

  for (const settlement of settlements) {
    const amount = toDisplay(settlement.amount, settlement.baseCurrencyAmount, settlement.displayRate);
    if (settlement.fromId === viewerId) {
      // The viewer handed over money, so the counterparty owes that much more.
      add(settlement.toId, amount);
    } else if (settlement.toId === viewerId) {
      add(settlement.fromId, -amount);
    }
  }

  return [...net.entries()]
    .filter(([, amount]) => amount !== 0)
    .map(([userId, amount]) => ({ userId, net: amount }))
    .sort((a, b) => a.userId.localeCompare(b.userId));
}
