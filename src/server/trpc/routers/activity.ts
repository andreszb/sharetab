import { z } from 'zod';
import { createTRPCRouter, groupMemberProcedure, protectedProcedure } from '../init';
import { participatesInExpense } from '../../lib/friend-queries';

export const activityRouter = createTRPCRouter({
  getGroupActivity: groupMemberProcedure
    .input(
      z.object({
        groupId: z.string(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(20),
      }),
    )
    .query(async ({ ctx, input }) => {
      const items = await ctx.db.activityLog.findMany({
        where: { groupId: input.groupId },
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor } } : {}),
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { id: true, name: true, image: true } },
        },
      });

      let nextCursor: string | undefined;
      if (items.length > input.limit) {
        const next = items.pop();
        nextCursor = next?.id;
      }

      return {
        items: items.map((item) => ({
          ...item,
          user: item.user ?? { id: item.userId ?? 'deleted', name: 'Deleted user', image: null },
        })),
        nextCursor,
      };
    }),

  /**
   * The unified feed: everything from the viewer's groups, plus the direct
   * expenses and settlements they take part in.
   *
   * Direct entries carry no `groupId`, so membership cannot select them.
   * They are found instead by matching `ActivityLog.entityId` against the ids
   * of the direct rows the viewer participates in — which also means a
   * `EXPENSE_DELETED` entry for a direct expense only reaches the person who
   * deleted it, since the row its `entityId` points at is gone by then. The
   * `userId` arm is what keeps their own deletions visible to them.
   */
  getRecentActivity: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(50).default(10) }))
    .query(async ({ ctx, input }) => {
      const [userGroups, directExpenses, directSettlements] = await Promise.all([
        ctx.db.groupMember.findMany({
          where: { userId: ctx.user.id },
          select: { groupId: true },
        }),
        ctx.db.expense.findMany({
          where: { groupId: null, ...participatesInExpense(ctx.user.id) },
          select: { id: true },
        }),
        ctx.db.settlement.findMany({
          where: { groupId: null, OR: [{ fromId: ctx.user.id }, { toId: ctx.user.id }] },
          select: { id: true },
        }),
      ]);

      const groupIds = userGroups.map((g) => g.groupId);
      const directEntityIds = [...directExpenses, ...directSettlements].map((row) => row.id);

      const items = await ctx.db.activityLog.findMany({
        where: {
          OR: [
            { groupId: { in: groupIds } },
            { groupId: null, OR: [{ userId: ctx.user.id }, { entityId: { in: directEntityIds } }] },
          ],
        },
        take: input.limit,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { id: true, name: true, image: true } },
          group: { select: { id: true, name: true } },
        },
      });

      return items.map((item) => ({
        ...item,
        user: item.user ?? { id: item.userId ?? 'deleted', name: 'Deleted user', image: null },
      }));
    }),
});
