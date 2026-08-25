import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { Prisma } from '@/generated/prisma/client';
import type { PrismaClient } from '@/generated/prisma/client';
import { createTRPCRouter, protectedProcedure, ledgerScopeProcedure, scopeGroupId } from '../init';
import { assertDirectConnections, assertDirectParticipants } from '../../lib/friend-connections';
import { assertReceiptUsableInScope } from '../../lib/receipt-scope';
import { processReceiptImage } from '../../lib/receipt-processor';
import { logger } from '../../lib/logger';
import { parseExtractedData } from '../../lib/json-schemas';
import { getAIProvidersWithFallback, getConfiguredProviderPriority } from '@/server/ai/registry';
import { getExchangeRate, convertCents } from '../../lib/exchange-rates';
import { stripUndefined } from '../../lib/strip-undefined';

/**
 * Verify that a receipt exists and the user has access to it (via group membership).
 * When additional `include` fields are passed, the return type is widened since
 * Prisma cannot statically infer dynamic includes -- callers should cast as needed.
 */
async function verifyReceiptAccess(
  db: PrismaClient,
  receiptId: string,
  userId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  include?: Record<string, any>,
) {
  const receipt = await db.receipt.findUnique({
    where: { id: receiptId },
    include: { group: { include: { members: true } }, ...include },
  });
  if (!receipt) throw new TRPCError({ code: 'NOT_FOUND' });
  if (receipt.group) {
    const isMember = receipt.group.members.some((m: { userId: string }) => m.userId === userId);
    if (!isMember) throw new TRPCError({ code: 'FORBIDDEN' });
  } else {
    // Ungrouped receipt: only the uploader can access it
    if (receipt.uploadedById !== userId) {
      throw new TRPCError({ code: 'FORBIDDEN' });
    }
  }
  return receipt;
}

export const receiptsRouter = createTRPCRouter({
  getScanProviderInfo: protectedProcedure.query(async () => {
    try {
      const configured = getConfiguredProviderPriority();
      const [active] = await getAIProvidersWithFallback();
      return {
        configuredProviders: configured,
        activeProvider: active?.name ?? null,
      };
    } catch {
      // Keep response shape stable even if provider checks fail.
      return {
        configuredProviders: [],
        activeProvider: null,
      };
    }
  }),

  processReceipt: protectedProcedure
    .input(
      z.object({
        receiptId: z.string(),
        groupId: z.string().optional(),
        correctionHint: z.string().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const receipt = await verifyReceiptAccess(ctx.db, input.receiptId, ctx.user.id);
      if (!receipt) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Receipt not found' });
      }

      // A groupId here does not merely scope the scan — the claim below writes
      // it onto the receipt. So the caller must belong to the target group, and
      // the receipt must not already belong to a different one: `saveForLater`
      // refuses that move for the same reason, and refusing it in only one of
      // the two places leaves the receipt reachable from the other.
      if (input.groupId) {
        const membership = await ctx.db.groupMember.findUnique({
          where: {
            userId_groupId: {
              userId: ctx.user.id,
              groupId: input.groupId,
            },
          },
        });
        if (!membership) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Not a member of this group' });
        }
        assertReceiptUsableInScope(receipt, input.groupId, ctx.user.id);
      }

      // Note: old items are NOT deleted here — processReceiptImage handles
      // delete + recreate atomically, so if the AI provider fails the old items remain.

      // Conditional update doubles as a mutex: a receipt already PROCESSING
      // is rejected so concurrent calls can't interleave delete/recreate.
      // A PROCESSING receipt untouched for 15+ minutes is considered stale
      // (crashed run) and may be re-claimed. The threshold deliberately
      // exceeds the worst-case provider pipeline (2 passes x per-provider
      // timeouts of 30-120s) so a slow-but-live run is never re-claimed.
      const claimed = await ctx.db.receipt.updateMany({
        where: {
          id: input.receiptId,
          OR: [{ status: { not: 'PROCESSING' } }, { updatedAt: { lt: new Date(Date.now() - 15 * 60 * 1000) } }],
        },
        data: {
          status: 'PROCESSING',
          ...(input.groupId ? { groupId: input.groupId, savedById: ctx.user.id } : {}),
        },
      });
      if (claimed.count === 0) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Receipt is already being processed',
        });
      }

      try {
        return await processReceiptImage({
          db: ctx.db,
          receiptId: input.receiptId,
          receipt,
          ...(input.correctionHint !== undefined ? { correctionHint: input.correctionHint } : {}),
          logPrefix: 'receipt',
        });
      } catch (error) {
        logger.error('receipt.failed', {
          receiptId: input.receiptId,
          error: error instanceof Error ? error.message : 'Unknown',
        });
        await ctx.db.receipt.update({
          where: { id: input.receiptId },
          data: {
            status: 'FAILED',
            rawResponse: {
              error: error instanceof Error ? error.message : 'Unknown error',
            } as unknown as Prisma.InputJsonValue,
          },
        });

        // Details are logged and stored in rawResponse; don't echo raw
        // provider/internal errors to the client.
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Receipt processing failed. Please try again.',
        });
      }
    }),

  getReceiptItems: protectedProcedure.input(z.object({ receiptId: z.string() })).query(async ({ ctx, input }) => {
    const receipt = await verifyReceiptAccess(ctx.db, input.receiptId, ctx.user.id, {
      items: {
        orderBy: { sortOrder: 'asc' },
        include: { assignments: true },
      },
    });

    type ReceiptItem = {
      id: string;
      name: string;
      quantity: number;
      unitPrice: number;
      totalPrice: number;
      sortOrder: number;
      assignments: { id: string; receiptItemId: string; userId: string; shareOfItem: number }[];
    };

    const receiptWithItems = receipt as typeof receipt & { items: ReceiptItem[] };

    return {
      receipt: {
        id: receiptWithItems.id,
        status: receiptWithItems.status,
        imagePath: receiptWithItems.imagePath,
        paidById: receiptWithItems.paidById,
        extractedData: receiptWithItems.extractedData as {
          merchantName?: string;
          date?: string;
          subtotal: number;
          tax: number;
          tip: number;
          total: number;
          currency: string;
        } | null,
      },
      items: receiptWithItems.items as ReceiptItem[],
    };
  }),

  updateItem: protectedProcedure
    .input(
      z.object({
        itemId: z.string(),
        name: z.string().min(1).max(200).optional(),
        quantity: z.number().int().min(1).optional(),
        unitPrice: z.number().int().min(0).optional(),
        totalPrice: z.number().int().min(0).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const item = await ctx.db.receiptItem.findUnique({
        where: { id: input.itemId },
      });
      if (!item) throw new TRPCError({ code: 'NOT_FOUND' });
      await verifyReceiptAccess(ctx.db, item.receiptId, ctx.user.id);

      const { itemId, ...data } = input;
      return ctx.db.receiptItem.update({
        where: { id: itemId },
        data: stripUndefined(data),
      });
    }),

  addItem: protectedProcedure
    .input(
      z.object({
        receiptId: z.string(),
        name: z.string().min(1).max(200),
        quantity: z.number().int().min(1).default(1),
        unitPrice: z.number().int().min(0),
        totalPrice: z.number().int().min(0),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await verifyReceiptAccess(ctx.db, input.receiptId, ctx.user.id);

      const maxSort = await ctx.db.receiptItem.findFirst({
        where: { receiptId: input.receiptId },
        orderBy: { sortOrder: 'desc' },
        select: { sortOrder: true },
      });
      return ctx.db.receiptItem.create({
        data: {
          receiptId: input.receiptId,
          name: input.name,
          quantity: input.quantity,
          unitPrice: input.unitPrice,
          totalPrice: input.totalPrice,
          sortOrder: (maxSort?.sortOrder ?? 0) + 1,
        },
      });
    }),

  deleteItem: protectedProcedure.input(z.object({ itemId: z.string() })).mutation(async ({ ctx, input }) => {
    const item = await ctx.db.receiptItem.findUnique({
      where: { id: input.itemId },
    });
    if (!item) throw new TRPCError({ code: 'NOT_FOUND' });
    await verifyReceiptAccess(ctx.db, item.receiptId, ctx.user.id);

    await ctx.db.receiptItemAssignment.deleteMany({
      where: { receiptItemId: input.itemId },
    });
    await ctx.db.receiptItem.delete({ where: { id: input.itemId } });
    return { success: true };
  }),

  splitItem: protectedProcedure
    .input(
      z.object({
        itemId: z.string(),
        splitQuantity: z.number().int().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const item = await ctx.db.receiptItem.findUnique({
        where: { id: input.itemId },
      });
      if (!item) throw new TRPCError({ code: 'NOT_FOUND' });
      await verifyReceiptAccess(ctx.db, item.receiptId, ctx.user.id);

      if (input.splitQuantity >= item.quantity) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Split quantity must be less than total quantity',
        });
      }

      return ctx.db.$transaction(async (tx) => {
        const current = await tx.receiptItem.findUniqueOrThrow({
          where: { id: input.itemId },
        });

        if (input.splitQuantity >= current.quantity) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Split quantity must be less than total quantity',
          });
        }

        const maxNewTotal = current.totalPrice - 1;
        if (maxNewTotal <= 0) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Item price too low to split',
          });
        }

        const newTotalPrice = Math.min(current.unitPrice * input.splitQuantity, maxNewTotal);
        const remainingQuantity = current.quantity - input.splitQuantity;
        const remainingTotalPrice = current.totalPrice - newTotalPrice;

        if (newTotalPrice <= 0 || remainingTotalPrice <= 0) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Split would result in invalid price distribution',
          });
        }

        await tx.receiptItem.updateMany({
          where: {
            receiptId: current.receiptId,
            sortOrder: { gt: current.sortOrder },
          },
          data: { sortOrder: { increment: 1 } },
        });

        await tx.receiptItem.update({
          where: { id: input.itemId },
          data: {
            quantity: remainingQuantity,
            totalPrice: remainingTotalPrice,
          },
        });

        return tx.receiptItem.create({
          data: {
            receiptId: current.receiptId,
            name: current.name,
            quantity: input.splitQuantity,
            unitPrice: current.unitPrice,
            totalPrice: newTotalPrice,
            sortOrder: current.sortOrder + 1,
          },
        });
      });
    }),

  updateExtractedData: protectedProcedure
    .input(
      z.object({
        receiptId: z.string(),
        tax: z.number().int().min(0).optional(),
        tip: z.number().int().min(0).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const receipt = await verifyReceiptAccess(ctx.db, input.receiptId, ctx.user.id);

      const current = (receipt.extractedData ?? {}) as Record<string, unknown>;
      const updated = {
        ...current,
        ...(input.tax !== undefined ? { tax: input.tax } : {}),
        ...(input.tip !== undefined ? { tip: input.tip } : {}),
      };

      await ctx.db.receipt.update({
        where: { id: input.receiptId },
        data: { extractedData: updated as unknown as Prisma.InputJsonValue },
      });
      return { success: true };
    }),

  retryProcessing: protectedProcedure.input(z.object({ receiptId: z.string() })).mutation(async ({ ctx, input }) => {
    const receipt = await verifyReceiptAccess(ctx.db, input.receiptId, ctx.user.id);

    // Reset status to PROCESSING and re-run extraction; conditional update
    // rejects concurrent reprocessing of the same receipt. A PROCESSING
    // receipt untouched for 15+ minutes is stale and may be re-claimed
    // (threshold exceeds the worst-case provider pipeline duration).
    const claimed = await ctx.db.receipt.updateMany({
      where: {
        id: input.receiptId,
        OR: [{ status: { not: 'PROCESSING' } }, { updatedAt: { lt: new Date(Date.now() - 15 * 60 * 1000) } }],
      },
      data: { status: 'PROCESSING' },
    });
    if (claimed.count === 0) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'Receipt is already being processed',
      });
    }

    try {
      return await processReceiptImage({
        db: ctx.db,
        receiptId: input.receiptId,
        receipt: { imagePath: receipt.imagePath, mimeType: receipt.mimeType },
        logPrefix: 'receipt.retry',
      });
    } catch (error) {
      await ctx.db.receipt.update({
        where: { id: input.receiptId },
        data: {
          status: 'FAILED',
          rawResponse: {
            error: error instanceof Error ? error.message : 'Unknown error',
          } as unknown as Prisma.InputJsonValue,
        },
      });
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Reprocessing failed',
      });
    }
  }),

  assignItemsAndCreateExpense: ledgerScopeProcedure
    .input(
      z.object({
        receiptId: z.string(),
        title: z.string().min(1).max(200),
        paidById: z.string(),
        tipOverride: z.number().int().min(0).optional(),
        assignments: z.array(
          z.object({
            receiptItemId: z.string(),
            userIds: z.array(z.string()).min(1),
          }),
        ),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const scope = ctx.scope;
      const groupId = scopeGroupId(scope);

      if (scope.kind === 'group' && scope.group.archivedAt) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Cannot create expenses in archived groups' });
      }

      const receipt = await ctx.db.receipt.findUnique({
        where: { id: input.receiptId },
        include: { items: true },
      });
      if (!receipt || receipt.status !== 'COMPLETED') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Receipt not ready' });
      }

      // Verify the caller has access to this receipt, in the same terms
      // `expenses.create` uses for a receipt handed to it directly.
      assertReceiptUsableInScope(receipt, groupId, ctx.user.id);

      const extractedData = parseExtractedData(receipt.extractedData);

      const tax = extractedData.tax;
      const tip = input.tipOverride ?? extractedData.tip;

      const assignedUserIds = input.assignments.flatMap((a) => a.userIds);

      if (scope.kind === 'group') {
        // Verify paidBy and all assignees are members of this group
        const groupMembers = await ctx.db.groupMember.findMany({
          where: { groupId: scope.groupId },
          select: { userId: true },
        });
        const memberIds = new Set(groupMembers.map((m) => m.userId));
        if (!memberIds.has(input.paidById)) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Payer is not a member of this group' });
        }
        for (const uid of assignedUserIds) {
          if (!memberIds.has(uid)) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: 'Assignee is not a member of this group' });
          }
        }
      } else {
        await assertDirectParticipants(ctx.db, ctx.user.id, [input.paidById, ...assignedUserIds]);
      }

      // Build item map and verify all referenced items belong to this receipt
      const itemMap = new Map(receipt.items.map((item) => [item.id, item]));
      for (const a of input.assignments) {
        if (!itemMap.has(a.receiptItemId)) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Item does not belong to this receipt' });
        }
      }

      // Calculate per-user item subtotals
      const userSubtotals = new Map<string, number>();

      for (const assignment of input.assignments) {
        const item = itemMap.get(assignment.receiptItemId)!;

        const perPerson = Math.floor(item.totalPrice / assignment.userIds.length);
        const remainder = item.totalPrice - perPerson * assignment.userIds.length;

        for (const [i, userId] of assignment.userIds.entries()) {
          const amount = perPerson + (i < remainder ? 1 : 0);
          userSubtotals.set(userId, (userSubtotals.get(userId) ?? 0) + amount);
        }
      }

      // Proportionally distribute tax and tip using receipt subtotal as denominator.
      // This ensures each assigned item gets its fair share of tax/tip relative to
      // the full receipt subtotal, even when not all items are assigned.
      const actualSubtotal = Array.from(userSubtotals.values()).reduce((a, b) => a + b, 0);
      const receiptSubtotal = extractedData.subtotal > 0 ? extractedData.subtotal : actualSubtotal;
      const totalAmount = actualSubtotal + tax + tip;

      const userTotals = new Map<string, number>();
      let allocatedTotal = 0;
      const userEntries = Array.from(userSubtotals.entries());

      for (const [i, [userId, itemTotal]] of userEntries.entries()) {
        const proportion = receiptSubtotal > 0 ? itemTotal / receiptSubtotal : 0;

        let userTax: number;
        let userTip: number;

        if (i === userEntries.length - 1) {
          // Last user gets remainder to prevent off-by-one
          const alreadyAllocated = allocatedTotal;
          const userTotal = totalAmount - alreadyAllocated;
          userTotals.set(userId, userTotal);
          allocatedTotal += userTotal;
        } else {
          userTax = Math.round(tax * proportion);
          userTip = Math.round(tip * proportion);
          const userTotal = itemTotal + userTax + userTip;
          userTotals.set(userId, userTotal);
          allocatedTotal += userTotal;
        }
      }

      // Save assignments in a single batch (replaces N×M individual upserts)
      const assignmentData = input.assignments.flatMap((a) =>
        a.userIds.map((userId) => ({
          receiptItemId: a.receiptItemId,
          userId,
        })),
      );

      // Currency conversion for receipt expenses. A direct expense has no group
      // currency to anchor to, so it keeps the receipt's own currency (falling
      // back to the viewer's default) and leaves baseCurrencyAmount null.
      const rawCurrency = extractedData.currency;
      const isValidIso = rawCurrency && /^[a-zA-Z]{3}$/.test(rawCurrency);
      let exchangeRate: number | null = null;
      let baseCurrencyAmount: number | null = null;
      let receiptCurrency: string;

      if (scope.kind === 'group') {
        const groupCurrency = scope.group.currency.toUpperCase();
        receiptCurrency = (isValidIso ? rawCurrency : scope.group.currency).toUpperCase();

        if (receiptCurrency !== groupCurrency) {
          const receiptDate = extractedData.date?.slice(0, 10);
          exchangeRate = await getExchangeRate(receiptCurrency, groupCurrency, receiptDate);
          if (exchangeRate === null) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Could not fetch exchange rate for receipt currency. Please try again.',
            });
          }
          baseCurrencyAmount = convertCents(totalAmount, exchangeRate);
        }
      } else {
        const viewer = await ctx.db.user.findUnique({
          where: { id: ctx.user.id },
          select: { defaultCurrency: true },
        });
        receiptCurrency = (isValidIso ? rawCurrency : (viewer?.defaultCurrency ?? 'USD')).toUpperCase();
      }

      // All writes in a single transaction for atomicity
      const expense = await ctx.db.$transaction(async (tx) => {
        const exp = await tx.expense.create({
          data: {
            groupId,
            title: input.title,
            amount: totalAmount,
            currency: receiptCurrency,
            exchangeRate: exchangeRate ?? 1.0,
            baseCurrencyAmount,
            splitMode: 'ITEM',
            paidById: input.paidById,
            addedById: ctx.user.id,
            receiptId: input.receiptId,
            shares: {
              create: Array.from(userTotals.entries()).map(([userId, amount]) => ({
                userId,
                amount,
              })),
            },
          },
        });

        const itemIds = [...new Set(input.assignments.map((a) => a.receiptItemId))];
        await tx.receiptItemAssignment.deleteMany({
          where: { receiptItemId: { in: itemIds } },
        });
        await tx.receiptItemAssignment.createMany({
          data: assignmentData,
          skipDuplicates: true,
        });

        await tx.activityLog.create({
          data: {
            groupId,
            userId: ctx.user.id,
            type: 'EXPENSE_CREATED',
            entityId: exp.id,
            metadata: { title: input.title, amount: totalAmount, fromReceipt: true },
          },
        });

        return exp;
      });

      return expense;
    }),

  saveForLater: ledgerScopeProcedure
    .input(
      z.object({
        receiptId: z.string(),
        paidById: z.string().nullable().optional(),
        assignments: z
          .array(
            z.object({
              receiptItemId: z.string(),
              userIds: z.array(z.string()).max(100),
            }),
          )
          .max(200)
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await verifyReceiptAccess(ctx.db, input.receiptId, ctx.user.id);
      const scope = ctx.scope;

      const userIdsToValidate = new Set<string>();
      if (input.paidById) {
        userIdsToValidate.add(input.paidById);
      }
      for (const assignment of input.assignments ?? []) {
        for (const userId of assignment.userIds) {
          userIdsToValidate.add(userId);
        }
      }

      // Connection only: a half-assigned receipt need not name the viewer
      // yet. assignItemsAndCreateExpense applies the full rule.
      //
      // Deliberately outside the transaction below: `loadConnections` issues
      // its own reads on the base client, and holding an interactive
      // transaction open across them turns pool contention into a P2024
      // rather than the domain error the caller can act on.
      if (scope.kind === 'direct' && userIdsToValidate.size > 0) {
        await assertDirectConnections(ctx.db, ctx.user.id, Array.from(userIdsToValidate));
      }

      await ctx.db.$transaction(async (tx) => {
        const receipt = await tx.receipt.findUnique({
          where: { id: input.receiptId },
        });
        if (!receipt || receipt.status !== 'COMPLETED') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Receipt must be processed first' });
        }
        // Saving into any scope other than the one the receipt already belongs
        // to would take it out of that group for every member — whether that
        // means detaching it entirely (direct scope) or moving it to a second
        // group the caller also happens to be in. An unassigned receipt still
        // adopts the scope it is saved into.
        if (receipt.groupId && receipt.groupId !== scopeGroupId(scope)) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Receipt belongs to a different group' });
        }
        // Check it's not already linked to an expense
        const existing = await tx.expense.findUnique({
          where: { receiptId: input.receiptId },
        });
        if (existing) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Receipt already has an expense' });
        }

        // The direct half of this check ran before the transaction opened.
        if (userIdsToValidate.size > 0 && scope.kind === 'group') {
          const validMembers = await tx.groupMember.findMany({
            where: {
              groupId: scope.groupId,
              userId: { in: Array.from(userIdsToValidate) },
            },
            select: { userId: true },
          });
          const validMemberIds = new Set(validMembers.map((member) => member.userId));
          for (const userId of userIdsToValidate) {
            if (!validMemberIds.has(userId)) {
              throw new TRPCError({
                code: 'BAD_REQUEST',
                message: `User ${userId} is not a member of this group`,
              });
            }
          }
        }

        await tx.receipt.update({
          where: { id: input.receiptId },
          data: {
            groupId: scopeGroupId(scope),
            savedById: ctx.user.id,
            ...(input.paidById !== undefined ? { paidById: input.paidById } : {}),
          },
        });

        // Save partial assignments if provided (empty array clears existing)
        if (input.assignments) {
          // Validate that all receiptItemIds belong to this receipt
          if (input.assignments.length > 0) {
            const itemIds = input.assignments.map((a) => a.receiptItemId);
            const validItems = await tx.receiptItem.findMany({
              where: { id: { in: itemIds }, receiptId: input.receiptId },
              select: { id: true },
            });
            const validIds = new Set(validItems.map((i) => i.id));
            for (const id of itemIds) {
              if (!validIds.has(id)) {
                throw new TRPCError({ code: 'BAD_REQUEST', message: `Item ${id} does not belong to this receipt` });
              }
            }
          }

          // Clear any existing assignments first
          await tx.receiptItemAssignment.deleteMany({
            where: {
              receiptItem: { receiptId: input.receiptId },
            },
          });

          // Create new assignments
          const seenAssignments = new Set<string>();
          const assignmentData: { receiptItemId: string; userId: string }[] = [];
          for (const assignment of input.assignments) {
            for (const userId of assignment.userIds) {
              const key = `${assignment.receiptItemId}\u0000${userId}`;
              if (seenAssignments.has(key)) {
                continue;
              }
              seenAssignments.add(key);
              assignmentData.push({
                receiptItemId: assignment.receiptItemId,
                userId,
              });
            }
          }
          if (assignmentData.length > 0) {
            await tx.receiptItemAssignment.createMany({
              data: assignmentData,
            });
          }
        }
      });

      return { success: true };
    }),

  listPending: ledgerScopeProcedure.query(async ({ ctx }) => {
    const receipts = await ctx.db.receipt.findMany({
      where: {
        // Outside a group a pending receipt belongs to whoever uploaded it —
        // there is no membership to widen access to it.
        ...(ctx.scope.kind === 'group' ? { groupId: ctx.scope.groupId } : { groupId: null, uploadedById: ctx.user.id }),
        status: 'COMPLETED',
        expense: null,
      },
      take: 200,
      orderBy: { createdAt: 'desc' },
    });

    return receipts.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      extractedData: r.extractedData as {
        merchantName?: string;
        date?: string;
        subtotal: number;
        tax: number;
        tip: number;
        total: number;
        currency: string;
      } | null,
    }));
  }),

  deletePending: protectedProcedure.input(z.object({ receiptId: z.string() })).mutation(async ({ ctx, input }) => {
    const receipt = await ctx.db.receipt.findUnique({
      where: { id: input.receiptId },
    });
    if (!receipt) {
      throw new TRPCError({ code: 'NOT_FOUND' });
    }
    // Only the uploader or the person who saved it can delete it
    const isUploader = receipt.uploadedById === ctx.user.id;
    const isSaver = receipt.savedById && receipt.savedById === ctx.user.id;
    if (!isUploader && !isSaver) {
      throw new TRPCError({ code: 'FORBIDDEN' });
    }
    // Can't delete if already linked to expense
    const expense = await ctx.db.expense.findUnique({
      where: { receiptId: input.receiptId },
    });
    if (expense) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Receipt has an expense' });
    }

    await ctx.db.receiptItem.deleteMany({ where: { receiptId: input.receiptId } });
    await ctx.db.receipt.delete({ where: { id: input.receiptId } });

    // Clean up the uploaded image file
    try {
      const { unlink } = await import('fs/promises');
      const { resolveUploadPath } = await import('../../lib/upload-dir');
      const filepath = resolveUploadPath(receipt.imagePath);
      await unlink(filepath);
    } catch {
      // Non-fatal: file may already be missing
      logger.warn('receipt.delete.fileCleanupFailed', {
        receiptId: input.receiptId,
        imagePath: receipt.imagePath,
      });
    }

    return { success: true };
  }),
});
