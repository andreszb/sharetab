import { createTRPCRouter, groupMemberProcedure, protectedProcedure } from '../init';
import { z } from 'zod';
import { simplifyDebts, computeBalances } from '../../lib/balance-calculator';
import { computePairwiseBalances } from '../../lib/pairwise-balance-calculator';
import { loadUserSummaries, loadViewerLedger } from '../../lib/friend-ledger';

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

  // Per-person debts across every active group and direct expense,
  // denominated in the viewer's own currency.
  //
  // This deliberately does NOT reuse simplifyDebts. That heuristic minimises
  // transfers within a group by matching the largest creditor to the largest
  // debtor, which routinely pairs two people who were never on the same
  // expense; aggregating those synthetic edges per person reported debts that
  // did not exist. computePairwiseBalances attributes every share literally
  // instead. See src/server/lib/pairwise-balance-calculator.ts.
  getOverallDebts: protectedProcedure.query(async ({ ctx }) => {
    const ledger = await loadViewerLedger(ctx.db, ctx.user.id);
    const balances = computePairwiseBalances(ctx.user.id, ledger.expenses, ledger.settlements);
    const users = await loadUserSummaries(
      ctx.db,
      balances.map((balance) => balance.userId),
    );

    type DebtRow = { userId: string; userName: string; venmoUsername: string | null; amount: number };
    const owedToYou: DebtRow[] = [];
    const youOwe: DebtRow[] = [];

    for (const balance of balances) {
      const user = users.get(balance.userId);
      const row: DebtRow = {
        userId: balance.userId,
        userName: user?.name ?? 'Unknown',
        venmoUsername: user?.venmoUsername ?? null,
        amount: Math.abs(balance.net),
      };
      if (balance.net > 0) owedToYou.push(row);
      else youOwe.push(row);
    }

    owedToYou.sort((a, b) => b.amount - a.amount);
    youOwe.sort((a, b) => b.amount - a.amount);

    return {
      owedToYou,
      youOwe,
      displayCurrency: ledger.displayCurrency,
      ratesUnavailable: ledger.ratesUnavailable,
    };
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
