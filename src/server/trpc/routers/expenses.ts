import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { createTRPCRouter, groupMemberProcedure, ledgerScopeProcedure, scopeGroupId, type LedgerScope } from '../init';
import { SplitMode } from '@/generated/prisma/client';
import { getExchangeRate, convertCents } from '../../lib/exchange-rates';
import { MAX_MONEY_CENTS } from '@/lib/money';
import { stripUndefined } from '../../lib/strip-undefined';
import { assertDirectParticipants } from '../../lib/friend-connections';
import { participates } from '../../lib/friend-queries';
import { assertReceiptUsableInScope } from '../../lib/receipt-scope';

const expenseShareSchema = z.object({
  userId: z.string(),
  amount: z.number().int().nonnegative().max(MAX_MONEY_CENTS),
  shares: z.number().int().optional(),
  percentage: z.number().int().optional(),
});

// The upper bound is not a product limit so much as a query bound: on the
// direct path this array reaches Prisma (via `assertDirectParticipants`)
// before the shares-sum check runs, so an unbounded array is an unbounded
// query. 200 is far above any real split and matches the receipt caps.
const expenseSharesArraySchema = z
  .array(expenseShareSchema)
  .min(1)
  .max(200)
  .refine((shares) => new Set(shares.map((s) => s.userId)).size === shares.length, {
    message: 'Duplicate user in shares',
  });

const exchangeRateSchema = z.number().positive().finite().max(1_000_000);

/**
 * Who may change an existing expense, as a message.
 *
 * Outside a group nobody holds a role, so the owner/admin half of the sentence
 * would be a lie there.
 */
function editDeniedMessage(scope: LedgerScope, verb: 'modify' | 'delete'): string {
  return scope.kind === 'group'
    ? `Only the expense creator, payer, or group owner/admin can ${verb} this expense`
    : `Only the expense creator or payer can ${verb} this expense`;
}

export const expensesRouter = createTRPCRouter({
  // Listing stays group-only: a friend's rows are read through
  // `friends.getLedger`, which shares one loader with the balance so the two
  // cannot disagree. A second listing path here would be that drift.
  list: groupMemberProcedure
    .input(
      z.object({
        groupId: z.string(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(20),
      }),
    )
    .query(async ({ ctx, input }) => {
      const expenses = await ctx.db.expense.findMany({
        where: { groupId: input.groupId },
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor } } : {}),
        orderBy: { expenseDate: 'desc' },
        include: {
          paidBy: { select: { id: true, name: true, email: true, image: true } },
          shares: {
            include: { user: { select: { id: true, name: true, email: true, image: true } } },
          },
        },
      });

      let nextCursor: string | undefined;
      if (expenses.length > input.limit) {
        const next = expenses.pop();
        nextCursor = next?.id;
      }

      return { expenses, nextCursor };
    }),

  get: ledgerScopeProcedure.input(z.object({ expenseId: z.string() })).query(async ({ ctx, input }) => {
    const expense = await ctx.db.expense.findUnique({
      where: { id: input.expenseId },
      include: {
        paidBy: { select: { id: true, name: true, email: true, image: true } },
        addedBy: { select: { id: true, name: true, email: true, image: true } },
        shares: {
          include: { user: { select: { id: true, name: true, email: true, image: true } } },
        },
        receipt: true,
      },
    });
    if (!expense || expense.groupId !== scopeGroupId(ctx.scope)) {
      throw new TRPCError({ code: 'NOT_FOUND' });
    }
    // A group scope was already authorized by membership. A direct scope
    // authorizes nothing on its own, so participation is the gate — and a
    // non-participant gets NOT_FOUND rather than FORBIDDEN, which would
    // confirm the expense exists.
    if (ctx.scope.kind === 'direct' && !participates(expense, ctx.user.id)) {
      throw new TRPCError({ code: 'NOT_FOUND' });
    }
    return expense;
  }),

  create: ledgerScopeProcedure
    .input(
      z.object({
        title: z.string().min(1).max(200),
        description: z.string().max(1000).optional(),
        amount: z.number().int().positive().max(MAX_MONEY_CENTS),
        currency: z
          .string()
          .length(3)
          .regex(/^[a-zA-Z]{3}$/)
          .transform((c) => c.toUpperCase())
          .default('USD'),
        exchangeRate: exchangeRateSchema.optional(), // manual override
        category: z.string().max(50).optional(),
        expenseDate: z.string().datetime().optional(),
        paidById: z.string(),
        splitMode: z.nativeEnum(SplitMode),
        shares: expenseSharesArraySchema,
        receiptId: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const scope = ctx.scope;
      const shareUserIds = input.shares.map((s) => s.userId);

      if (scope.kind === 'group') {
        if (scope.group.archivedAt) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Cannot add expenses to an archived group',
          });
        }

        // Validate paidById is a member of the group
        const paidByMember = await ctx.db.groupMember.findFirst({
          where: { groupId: scope.groupId, userId: input.paidById },
        });
        if (!paidByMember) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Paid-by user is not a member of this group' });
        }

        // Validate all share userIds are group members
        const memberCount = await ctx.db.groupMember.count({
          where: { groupId: scope.groupId, userId: { in: shareUserIds } },
        });
        if (memberCount !== new Set(shareUserIds).size) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'One or more share users are not members of this group',
          });
        }
      } else {
        // Outside a group there is no membership to check against, so the
        // participant set is validated against who the viewer is connected to.
        await assertDirectParticipants(ctx.db, ctx.user.id, [input.paidById, ...shareUserIds]);
      }

      // A receipt may only be attached from the scope it already belongs to.
      // `Expense.receiptId` is unique, so an unchecked id here is both a read
      // leak (`get` includes the receipt) and a permanent denial for the group
      // that owns it. The direct scope removed the last incidental barrier:
      // a self-only expense needs no connection to anyone.
      if (input.receiptId !== undefined) {
        const receipt = await ctx.db.receipt.findUnique({
          where: { id: input.receiptId },
          select: { groupId: true, uploadedById: true },
        });
        if (!receipt) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Receipt not found' });
        }
        assertReceiptUsableInScope(receipt, scopeGroupId(scope), ctx.user.id);
      }

      // Validate shares sum equals total (in expense's original currency)
      const sharesSum = input.shares.reduce((sum, s) => sum + s.amount, 0);
      if (sharesSum !== input.amount) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Shares sum (${sharesSum}) does not equal expense amount (${input.amount})`,
        });
      }

      // Currency conversion: compute base currency amount if currencies differ.
      // Only a group has a base currency to convert into — a direct expense is
      // anchored in the currency it was entered in, and `baseCurrencyAmount`
      // must stay null for `loadViewerLedger` to read it correctly.
      let exchangeRate: number | null = null;
      let baseCurrencyAmount: number | null = null;

      if (scope.kind === 'group') {
        const groupCurrency = scope.group.currency;
        if (input.currency.toUpperCase() !== groupCurrency.toUpperCase()) {
          if (input.exchangeRate) {
            // Manual override
            exchangeRate = input.exchangeRate;
          } else {
            // Auto-fetch from frankfurter.app
            const dateStr = input.expenseDate
              ? input.expenseDate.slice(0, 10) // YYYY-MM-DD from ISO string
              : undefined;
            exchangeRate = await getExchangeRate(input.currency, groupCurrency, dateStr);
          }

          if (exchangeRate === null) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Could not fetch exchange rate. Please provide a manual rate or try again.',
            });
          }

          baseCurrencyAmount = convertCents(input.amount, exchangeRate);
        }
      }

      const expense = await ctx.db.$transaction(async (tx) => {
        const created = await tx.expense.create({
          data: {
            groupId: scopeGroupId(scope),
            title: input.title,
            ...(input.description !== undefined ? { description: input.description } : {}),
            amount: input.amount,
            currency: input.currency,
            exchangeRate: exchangeRate ?? 1.0,
            baseCurrencyAmount,
            ...(input.category !== undefined ? { category: input.category } : {}),
            expenseDate: input.expenseDate ? new Date(input.expenseDate) : new Date(),
            paidById: input.paidById,
            addedById: ctx.user.id,
            splitMode: input.splitMode,
            ...(input.receiptId !== undefined ? { receiptId: input.receiptId } : {}),
            shares: {
              create: input.shares.map((s) => ({
                userId: s.userId,
                amount: s.amount,
                shares: s.shares ?? 1,
                ...(s.percentage !== undefined ? { percentage: s.percentage } : {}),
              })),
            },
          },
          include: {
            shares: true,
          },
        });

        await tx.activityLog.create({
          data: {
            groupId: scopeGroupId(scope),
            userId: ctx.user.id,
            type: 'EXPENSE_CREATED',
            entityId: created.id,
            metadata: { title: input.title, amount: input.amount },
          },
        });

        return created;
      });

      return expense;
    }),

  update: ledgerScopeProcedure
    .input(
      z
        .object({
          expenseId: z.string(),
          title: z.string().min(1).max(200).optional(),
          description: z.string().max(1000).optional(),
          amount: z.number().int().positive().max(MAX_MONEY_CENTS).optional(),
          currency: z
            .string()
            .length(3)
            .regex(/^[a-zA-Z]{3}$/)
            .transform((c) => c.toUpperCase())
            .optional(),
          exchangeRate: exchangeRateSchema.optional(), // manual override
          category: z.string().max(50).optional(),
          expenseDate: z.string().datetime().optional(),
          paidById: z.string().optional(),
          splitMode: z.nativeEnum(SplitMode).optional(),
          shares: expenseSharesArraySchema.optional(),
        })
        .refine((data) => !data.amount || data.shares, {
          message: 'Shares are required when updating the amount',
          path: ['shares'],
        }),
    )
    .mutation(async ({ ctx, input }) => {
      const scope = ctx.scope;

      if (scope.kind === 'group' && scope.group.archivedAt) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Cannot modify expenses in an archived group',
        });
      }

      const existing = await ctx.db.expense.findUnique({
        where: { id: input.expenseId },
        include: { shares: { select: { userId: true } } },
      });
      if (!existing || existing.groupId !== scopeGroupId(scope)) {
        throw new TRPCError({ code: 'NOT_FOUND' });
      }
      if (scope.kind === 'direct' && !participates(existing, ctx.user.id)) {
        throw new TRPCError({ code: 'NOT_FOUND' });
      }

      // Outside a group nobody holds a role, so the owner/admin override has
      // no equivalent: only the creator or the payer can edit.
      const isOwnerOrAdmin =
        scope.kind === 'group' && (scope.membership.role === 'OWNER' || scope.membership.role === 'ADMIN');
      const isCreatorOrPayer = existing.paidById === ctx.user.id || existing.addedById === ctx.user.id;
      if (!isOwnerOrAdmin && !isCreatorOrPayer) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: editDeniedMessage(scope, 'modify'),
        });
      }

      const { expenseId, shares, currency: inputCurrency, exchangeRate: inputExchangeRate, ...rest } = input;
      // `groupId` belongs to the scope procedure's input, not to the row being
      // written; `stripUndefined` drops it before it can reach the payload.
      const data = { ...rest, groupId: undefined };

      if (scope.kind === 'group') {
        // Validate paidById is a member of the group (if provided)
        if (input.paidById) {
          const paidByMember = await ctx.db.groupMember.findFirst({
            where: { groupId: scope.groupId, userId: input.paidById },
          });
          if (!paidByMember) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: 'Paid-by user is not a member of this group' });
          }
        }

        if (shares) {
          // Validate all share userIds are group members
          const shareUserIds = shares.map((s) => s.userId);
          const memberCount = await ctx.db.groupMember.count({
            where: { groupId: scope.groupId, userId: { in: shareUserIds } },
          });
          if (memberCount !== new Set(shareUserIds).size) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'One or more share users are not members of this group',
            });
          }
        }
      } else if (input.paidById || shares) {
        // Re-check the whole participant set, not just what changed: an edit
        // that swaps in an unconnected payer is the same problem as creating
        // one.
        const nextShareIds = shares ? shares.map((s) => s.userId) : existing.shares.map((s) => s.userId);
        await assertDirectParticipants(ctx.db, ctx.user.id, [input.paidById ?? existing.paidById, ...nextShareIds]);
      }

      if (shares) {
        const expectedAmount = data.amount ?? existing.amount;
        const sharesSum = shares.reduce((sum, s) => sum + s.amount, 0);
        if (sharesSum !== expectedAmount) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Shares sum (${sharesSum}) does not equal expense amount (${expectedAmount})`,
          });
        }
      }

      // Recompute currency conversion if currency or amount changed
      const effectiveCurrency = inputCurrency ?? existing.currency;
      const effectiveAmount = data.amount ?? existing.amount;
      let newExchangeRate: number | null = existing.exchangeRate;
      let newBaseCurrencyAmount: number | null = existing.baseCurrencyAmount;

      if (scope.kind === 'direct') {
        // Self-anchored: changing the currency of a direct expense re-denominates
        // it rather than converting it, so there is nothing to recompute.
        newExchangeRate = 1.0;
        newBaseCurrencyAmount = null;
      } else if (effectiveCurrency.toUpperCase() !== scope.group.currency.toUpperCase()) {
        const groupCurrency = scope.group.currency;
        if (inputExchangeRate) {
          newExchangeRate = inputExchangeRate;
        } else if (inputCurrency || data.amount || data.expenseDate) {
          // Currency, amount, or date changed -- re-fetch rate
          const dateStr = (data.expenseDate ?? existing.expenseDate.toISOString()).slice(0, 10);
          const fetched = await getExchangeRate(effectiveCurrency, groupCurrency, dateStr);
          if (fetched === null) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Could not fetch exchange rate. Please provide a manual rate or try again.',
            });
          }
          newExchangeRate = fetched;
        }
        newBaseCurrencyAmount = newExchangeRate ? convertCents(effectiveAmount, newExchangeRate) : null;
      } else {
        // Same currency as group -- clear conversion fields
        newExchangeRate = 1.0;
        newBaseCurrencyAmount = null;
      }

      const expense = await ctx.db.$transaction(async (tx) => {
        if (shares) {
          await tx.expenseShare.deleteMany({ where: { expenseId } });
          await tx.expenseShare.createMany({
            data: shares.map((s) => ({
              expenseId,
              userId: s.userId,
              amount: s.amount,
              shares: s.shares ?? 1,
              ...(s.percentage !== undefined ? { percentage: s.percentage } : {}),
            })),
          });
        }

        const updated = await tx.expense.update({
          where: { id: expenseId },
          data: {
            ...stripUndefined(data),
            ...(inputCurrency ? { currency: inputCurrency } : {}),
            exchangeRate: newExchangeRate ?? 1.0,
            baseCurrencyAmount: newBaseCurrencyAmount,
            ...(data.expenseDate ? { expenseDate: new Date(data.expenseDate) } : {}),
          },
          include: { shares: true },
        });

        await tx.activityLog.create({
          data: {
            groupId: scopeGroupId(scope),
            userId: ctx.user.id,
            type: 'EXPENSE_UPDATED',
            entityId: expenseId,
          },
        });

        return updated;
      });

      return expense;
    }),

  delete: ledgerScopeProcedure.input(z.object({ expenseId: z.string() })).mutation(async ({ ctx, input }) => {
    const scope = ctx.scope;

    if (scope.kind === 'group' && scope.group.archivedAt) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Cannot delete expenses from an archived group',
      });
    }

    const expense = await ctx.db.expense.findUnique({
      where: { id: input.expenseId },
      include: { shares: { select: { userId: true } } },
    });
    if (!expense || expense.groupId !== scopeGroupId(scope)) {
      throw new TRPCError({ code: 'NOT_FOUND' });
    }
    if (scope.kind === 'direct' && !participates(expense, ctx.user.id)) {
      throw new TRPCError({ code: 'NOT_FOUND' });
    }

    const isOwnerOrAdmin =
      scope.kind === 'group' && (scope.membership.role === 'OWNER' || scope.membership.role === 'ADMIN');
    const isCreatorOrPayer = expense.paidById === ctx.user.id || expense.addedById === ctx.user.id;
    if (!isOwnerOrAdmin && !isCreatorOrPayer) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: editDeniedMessage(scope, 'delete'),
      });
    }

    await ctx.db.$transaction(async (tx) => {
      await tx.expense.delete({ where: { id: input.expenseId } });

      await tx.activityLog.create({
        data: {
          groupId: scopeGroupId(scope),
          userId: ctx.user.id,
          type: 'EXPENSE_DELETED',
          entityId: input.expenseId,
          metadata: { title: expense.title, amount: expense.amount },
        },
      });
    });

    return { success: true };
  }),
});
