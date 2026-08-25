import { createTRPCRouter, groupMemberProcedure, protectedProcedure } from '../init';
import { z } from 'zod';
import { simplifyDebts, computeBalances } from '../../lib/balance-calculator';
import {
  computePairwiseBalances,
  type PairwiseExpense,
  type PairwiseSettlement,
} from '../../lib/pairwise-balance-calculator';
import { getExchangeRate } from '../../lib/exchange-rates';

export const balancesRouter = createTRPCRouter({
  getGroupBalances: groupMemberProcedure.input(z.object({ groupId: z.string() })).query(async ({ ctx, input }) => {
    const [expenses, settlements] = await Promise.all([
      ctx.db.expense.findMany({
        where: { groupId: input.groupId },
        select: {
          paidById: true,
          amount: true,
          baseCurrencyAmount: true,
          shares: { select: { userId: true, amount: true } },
        },
      }),
      ctx.db.settlement.findMany({
        where: { groupId: input.groupId },
        select: { fromId: true, toId: true, amount: true, baseCurrencyAmount: true },
      }),
    ]);

    const balances = computeBalances(expenses, settlements);
    return { balances };
  }),

  getSimplifiedDebts: groupMemberProcedure.input(z.object({ groupId: z.string() })).query(async ({ ctx, input }) => {
    const [expenses, settlements] = await Promise.all([
      ctx.db.expense.findMany({
        where: { groupId: input.groupId },
        select: {
          paidById: true,
          amount: true,
          baseCurrencyAmount: true,
          shares: { select: { userId: true, amount: true } },
        },
      }),
      ctx.db.settlement.findMany({
        where: { groupId: input.groupId },
        select: { fromId: true, toId: true, amount: true, baseCurrencyAmount: true },
      }),
    ]);

    const balances = computeBalances(expenses, settlements);
    const debts = simplifyDebts(balances);
    return { debts };
  }),

  // Per-person debts across every active group, denominated in the viewer's
  // own currency.
  //
  // This deliberately does NOT reuse simplifyDebts. That heuristic minimises
  // transfers within a group by matching the largest creditor to the largest
  // debtor, which routinely pairs two people who were never on the same
  // expense; aggregating those synthetic edges per person reported debts that
  // did not exist. computePairwiseBalances attributes every share literally
  // instead. See src/server/lib/pairwise-balance-calculator.ts.
  getOverallDebts: protectedProcedure.query(async ({ ctx }) => {
    const [viewer, groups] = await Promise.all([
      ctx.db.user.findUnique({
        where: { id: ctx.user.id },
        select: { defaultCurrency: true },
      }),
      ctx.db.group.findMany({
        where: { members: { some: { userId: ctx.user.id } }, archivedAt: null },
        select: {
          currency: true,
          expenses: {
            select: {
              paidById: true,
              amount: true,
              baseCurrencyAmount: true,
              shares: { select: { userId: true, amount: true } },
            },
          },
          settlements: {
            select: { fromId: true, toId: true, amount: true, baseCurrencyAmount: true },
          },
          members: {
            select: { user: { select: { id: true, name: true, venmoUsername: true } } },
          },
        },
      }),
    ]);

    const displayCurrency = viewer?.defaultCurrency ?? 'USD';

    // One lookup per distinct group currency, not per expense (getExchangeRate
    // caches, but the groups list can repeat a currency many times).
    const rates = new Map<string, number>();
    let ratesUnavailable = false;
    for (const currency of new Set(groups.map((g) => g.currency))) {
      if (currency === displayCurrency) {
        rates.set(currency, 1);
        continue;
      }
      const rate = await getExchangeRate(currency, displayCurrency);
      if (rate == null) {
        // One unreachable rate must not blank the whole dashboard. Fall back to
        // 1:1 and let the client mark the figures as approximate.
        ratesUnavailable = true;
        rates.set(currency, 1);
      } else {
        rates.set(currency, rate);
      }
    }

    // Flatten every group into a single ledger, stamping each entry with its
    // group's rate. Aggregation across groups is then a property of the
    // algorithm rather than a second pass over per-group results.
    const expenses: PairwiseExpense[] = [];
    const settlements: PairwiseSettlement[] = [];
    const userMap = new Map<string, { name: string; venmoUsername: string | null }>();

    for (const group of groups) {
      const displayRate = rates.get(group.currency) ?? 1;
      for (const expense of group.expenses) expenses.push({ ...expense, displayRate });
      for (const settlement of group.settlements) settlements.push({ ...settlement, displayRate });
      for (const member of group.members) {
        userMap.set(member.user.id, {
          name: member.user.name ?? 'Unknown',
          venmoUsername: member.user.venmoUsername,
        });
      }
    }

    const balances = computePairwiseBalances(ctx.user.id, expenses, settlements);

    const unnamed = balances.map((b) => b.userId).filter((id) => !userMap.has(id));
    if (unnamed.length > 0) {
      const strangers = await ctx.db.user.findMany({
        where: { id: { in: unnamed } },
        select: { id: true, name: true, placeholderName: true, venmoUsername: true },
      });
      for (const stranger of strangers) {
        userMap.set(stranger.id, {
          name: stranger.placeholderName ?? stranger.name ?? 'Unknown',
          venmoUsername: stranger.venmoUsername,
        });
      }
    }

    type DebtRow = { userId: string; userName: string; venmoUsername: string | null; amount: number };
    const owedToYou: DebtRow[] = [];
    const youOwe: DebtRow[] = [];

    for (const balance of balances) {
      const info = userMap.get(balance.userId);
      const row: DebtRow = {
        userId: balance.userId,
        userName: info?.name ?? 'Unknown',
        venmoUsername: info?.venmoUsername ?? null,
        amount: Math.abs(balance.net),
      };
      if (balance.net > 0) owedToYou.push(row);
      else youOwe.push(row);
    }

    owedToYou.sort((a, b) => b.amount - a.amount);
    youOwe.sort((a, b) => b.amount - a.amount);

    return { owedToYou, youOwe, displayCurrency, ratesUnavailable };
  }),

  getDashboard: protectedProcedure.query(async ({ ctx }) => {
    const groups = await ctx.db.group.findMany({
      where: { members: { some: { userId: ctx.user.id } }, archivedAt: null },
      select: {
        id: true,
        name: true,
        currency: true,
        expenses: {
          select: {
            paidById: true,
            amount: true,
            baseCurrencyAmount: true,
            shares: { select: { userId: true, amount: true } },
          },
        },
        settlements: {
          select: { fromId: true, toId: true, amount: true, baseCurrencyAmount: true },
        },
      },
    });

    let totalOwed = 0; // others owe you
    let totalOwing = 0; // you owe others

    const perGroup: {
      groupId: string;
      groupName: string;
      currency: string;
      balance: number;
    }[] = [];

    for (const group of groups) {
      const balances = computeBalances(group.expenses, group.settlements);
      const userBalance = balances.find((b) => b.userId === ctx.user.id);
      const net = userBalance?.net ?? 0;
      if (net > 0) totalOwed += net;
      if (net < 0) totalOwing += -net;

      perGroup.push({
        groupId: group.id,
        groupName: group.name,
        currency: group.currency,
        balance: net,
      });
    }

    return { totalOwed, totalOwing, perGroup };
  }),
});
