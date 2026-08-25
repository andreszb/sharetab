import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { createTRPCRouter, groupMemberProcedure, ledgerScopeProcedure, scopeGroupId } from '../init';
import { getExchangeRate, convertCents } from '../../lib/exchange-rates';
import { MAX_MONEY_CENTS } from '@/lib/money';
import { assertDirectParticipants } from '../../lib/friend-connections';
import { mayRecordDirectPaymentFrom } from '../../lib/direct-participants';

// Two rules, so two messages: inside a group only an owner or admin may record
// someone else's payment, while outside one the only stand-in for that authority
// is a placeholder, who has no account to record their own with. A single shared
// string would tell one of the two callers something untrue.
const SELF_PAYMENTS_ONLY = 'You can only record payments from yourself';
const DIRECT_PAYMENTS_ONLY = 'You can only record payments from yourself, or from someone who is not on ShareTab';

export const settlementsRouter = createTRPCRouter({
  list: groupMemberProcedure
    .input(
      z.object({
        groupId: z.string(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(100),
      }),
    )
    .query(async ({ ctx, input }) => {
      const items = await ctx.db.settlement.findMany({
        where: { groupId: input.groupId },
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor } } : {}),
        include: {
          from: { select: { id: true, name: true, image: true } },
          to: { select: { id: true, name: true, image: true } },
        },
        orderBy: [{ settledAt: 'desc' }, { id: 'desc' }],
      });

      let nextCursor: string | undefined;
      if (items.length > input.limit) {
        const next = items.pop();
        nextCursor = next?.id;
      }

      return { items, nextCursor };
    }),

  /**
   * Record a payment.
   *
   * With no `groupId` this settles the **direct** balance with that person and
   * nothing else: a group's own balances come from `balance-calculator.ts`
   * filtered to that group, so a `groupId: null` row can never clear a debt
   * that arose inside a group. It does move the cross-group figure the Friends
   * view shows, which is what that number is for.
   */
  create: ledgerScopeProcedure
    .input(
      z.object({
        fromId: z.string().optional(),
        toId: z.string(),
        amount: z.number().int().positive().max(MAX_MONEY_CENTS),
        currency: z
          .string()
          .length(3)
          .regex(/^[a-zA-Z]{3}$/)
          .transform((c) => c.toUpperCase())
          .default('USD'),
        exchangeRate: z.number().positive().finite().max(1_000_000).optional(), // manual override
        note: z.string().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const scope = ctx.scope;
      const effectiveFromId = input.fromId ?? ctx.user.id;

      if (scope.kind === 'group' && scope.group.archivedAt) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Cannot create settlements in an archived group',
        });
      }

      // Cannot settle with yourself
      if (effectiveFromId === input.toId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Cannot settle a debt with yourself',
        });
      }

      if (scope.kind === 'group') {
        // Security: non-admin members can only create settlements from themselves
        if (scope.membership.role === 'MEMBER' && input.fromId && input.fromId !== ctx.user.id) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: SELF_PAYMENTS_ONLY,
          });
        }

        // Validate both fromId and toId are members of the group
        const memberCount = await ctx.db.groupMember.count({
          where: {
            groupId: scope.groupId,
            userId: { in: [effectiveFromId, input.toId] },
          },
        });
        if (memberCount < 2) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Both the payer and recipient must be members of this group',
          });
        }
      } else {
        // The group version lets an owner or admin record a payment on someone
        // else's behalf. Outside a group the only stand-in for that authority
        // is a placeholder, which cannot log in to record its own payments —
        // see `mayRecordDirectPaymentFrom`.
        if (effectiveFromId !== ctx.user.id) {
          const payer = await ctx.db.user.findUnique({
            where: { id: effectiveFromId },
            select: { id: true, isPlaceholder: true },
          });
          if (!payer || !mayRecordDirectPaymentFrom(ctx.user.id, payer)) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: DIRECT_PAYMENTS_ONLY,
            });
          }
        }
        await assertDirectParticipants(ctx.db, ctx.user.id, [effectiveFromId, input.toId]);
      }

      // Currency conversion: compute base currency amount if currencies differ.
      // A direct settlement has no group currency to anchor to, so like a direct
      // expense it stays denominated in the currency it was entered in.
      let exchangeRate: number | null = null;
      let baseCurrencyAmount: number | null = null;

      if (scope.kind === 'group') {
        const groupCurrency = scope.group.currency;
        if (input.currency.toUpperCase() !== groupCurrency.toUpperCase()) {
          if (input.exchangeRate) {
            exchangeRate = input.exchangeRate;
          } else {
            exchangeRate = await getExchangeRate(input.currency, groupCurrency);
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

      const settlement = await ctx.db.$transaction(async (tx) => {
        const created = await tx.settlement.create({
          data: {
            groupId: scopeGroupId(scope),
            fromId: effectiveFromId,
            toId: input.toId,
            amount: input.amount,
            currency: input.currency,
            exchangeRate: exchangeRate ?? 1.0,
            baseCurrencyAmount,
            ...(input.note !== undefined ? { note: input.note } : {}),
          },
        });

        await tx.activityLog.create({
          data: {
            groupId: scopeGroupId(scope),
            userId: ctx.user.id,
            type: 'SETTLEMENT_CREATED',
            entityId: created.id,
            metadata: { toId: input.toId, amount: input.amount },
          },
        });

        return created;
      });

      return settlement;
    }),
});
