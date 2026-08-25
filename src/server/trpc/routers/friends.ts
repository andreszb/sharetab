import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import type { PrismaClient } from '@/generated/prisma/client';
import { createTRPCRouter, friendProcedure, protectedProcedure } from '../init';
import { checkRateLimit, parsePositiveInt } from '../../lib/rate-limit';
import { buildFriendsList } from '../../lib/friends-list';
import { createPlaceholderUser } from '../../lib/placeholder-user';
import { loadUserSummaries, loadViewerLedger } from '../../lib/friend-ledger';
import { attributeExpense, attributeSettlement, computePairwiseBalances } from '../../lib/pairwise-balance-calculator';
import {
  evaluateAddByEmail,
  evaluateInviteResend,
  evaluateInviteResponse,
  incomingFriendship,
  outgoingFriendship,
  type AddFriendDenyReason,
  type FriendshipDenyReason,
} from '../../lib/friendship-policy';
import { groupCoMembers, participatesInExpense } from '../../lib/friend-queries';

const INVITE_WINDOW_MS = 60 * 60 * 1000;

const ADD_FRIEND_ERRORS: Record<
  AddFriendDenyReason,
  { code: 'BAD_REQUEST' | 'FORBIDDEN' | 'CONFLICT'; message: string }
> = {
  self: { code: 'BAD_REQUEST', message: 'You cannot add yourself as a friend' },
  placeholder_target: { code: 'BAD_REQUEST', message: 'That account cannot be added by email' },
  suspended_target: { code: 'FORBIDDEN', message: 'That account is suspended' },
  already_requested: { code: 'CONFLICT', message: 'You have already invited this person' },
  rejected_use_resend: { code: 'CONFLICT', message: 'This invite was declined — resend it instead' },
  already_friends: { code: 'CONFLICT', message: 'You are already friends' },
  incoming_invite_pending: { code: 'CONFLICT', message: 'This person already invited you — accept their invite' },
};

const FRIENDSHIP_ERRORS: Record<FriendshipDenyReason, { code: 'FORBIDDEN' | 'CONFLICT'; message: string }> = {
  not_a_party: { code: 'FORBIDDEN', message: 'Not your invite' },
  not_the_addressee: { code: 'FORBIDDEN', message: 'Only the person invited can answer this' },
  not_the_requester: { code: 'FORBIDDEN', message: 'Only the person who sent this can resend it' },
  already_accepted: { code: 'CONFLICT', message: 'This friendship is already accepted' },
};

/**
 * Friend invites in the unified feed.
 *
 * `entityId` is the **friendship** id, which is how the addressee reaches the
 * entry at all: `activity.getRecentActivity` selects non-group entries either
 * by actor or by entityId, and only the actor arm would otherwise match. The
 * row carries no `groupId` — a friendship belongs to no group by definition.
 */
async function writeInviteActivity(
  db: Pick<PrismaClient, 'activityLog'>,
  input: { type: 'FRIEND_INVITE_SENT' | 'FRIEND_INVITE_ACCEPTED'; friendshipId: string; actorId: string },
) {
  await db.activityLog.create({
    data: { groupId: null, userId: input.actorId, type: input.type, entityId: input.friendshipId },
  });
}

export const friendsRouter = createTRPCRouter({
  /**
   * The friends list: explicit friendships unioned with everyone the viewer
   * shares a group or a direct expense with. Only the first of those has rows
   * in the database — see `friends-list.ts` for why the rest are derived.
   */
  list: protectedProcedure.query(async ({ ctx }) => {
    const viewerId = ctx.user.id;

    const [friendships, coMembers, directExpenses] = await Promise.all([
      ctx.db.friendship.findMany({
        where: { OR: [{ requesterId: viewerId }, { addresseeId: viewerId }] },
        select: { requesterId: true, addresseeId: true, status: true },
      }),
      ctx.db.groupMember.findMany({
        where: groupCoMembers(viewerId),
        select: { userId: true },
      }),
      ctx.db.expense.findMany({
        where: { groupId: null, ...participatesInExpense(viewerId) },
        select: { paidById: true, shares: { select: { userId: true } } },
      }),
    ]);

    const entries = buildFriendsList({
      viewerId,
      friendships,
      groupCoMemberIds: coMembers.map((member) => member.userId),
      expenseCoParticipantIds: directExpenses.flatMap((expense) => [
        expense.paidById,
        ...expense.shares.map((share) => share.userId),
      ]),
    });

    const ledger = await loadViewerLedger(ctx.db, viewerId);
    const balances = new Map(
      computePairwiseBalances(viewerId, ledger.expenses, ledger.settlements).map((balance) => [
        balance.userId,
        balance.net,
      ]),
    );
    const users = await loadUserSummaries(
      ctx.db,
      entries.map((entry) => entry.userId),
    );

    return {
      displayCurrency: ledger.displayCurrency,
      ratesUnavailable: ledger.ratesUnavailable,
      friends: entries.map((entry) => ({
        ...entry,
        user: users.get(entry.userId) ?? null,
        // Null, not zero: an invitee who has not accepted must not be able to
        // tell an empty balance apart from a withheld one.
        net: entry.canViewAmounts ? (balances.get(entry.userId) ?? 0) : null,
      })),
    };
  }),

  addByEmail: protectedProcedure.input(z.object({ email: z.string().email() })).mutation(async ({ ctx, input }) => {
    // Rate limited because addByEmail is an email-existence oracle: it can only
    // match a registered address, so an unbounded caller could walk a list and
    // learn who holds an account here.
    const limit = checkRateLimit(
      `friend-invite:${ctx.user.id}`,
      parsePositiveInt(process.env.FRIEND_INVITE_RATE_LIMIT_MAX, 20),
      INVITE_WINDOW_MS,
    );
    if (!limit.allowed) {
      throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'Too many invites — try again later' });
    }

    // Exact match, because that is what sign-in does — auth.ts looks the address
    // up verbatim. Matching case-insensitively here would let someone befriend
    // an account that cannot log in with the address they typed, and would be
    // ambiguous whenever two such accounts exist.
    const target = await ctx.db.user.findUnique({
      where: { email: input.email.trim() },
      select: { id: true, isPlaceholder: true, suspendedAt: true },
    });
    if (!target) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'No account found for that email' });
    }

    const existing = await ctx.db.friendship.findMany({
      where: {
        OR: [
          { requesterId: ctx.user.id, addresseeId: target.id },
          { requesterId: target.id, addresseeId: ctx.user.id },
        ],
      },
      select: { requesterId: true, addresseeId: true, status: true },
    });

    const decision = evaluateAddByEmail({
      viewerId: ctx.user.id,
      target: { id: target.id, isPlaceholder: target.isPlaceholder, suspended: target.suspendedAt !== null },
      existing,
    });
    if (!decision.ok) throw new TRPCError(ADD_FRIEND_ERRORS[decision.reason]);

    // One transaction, because a committed row with a failed feed entry leaves
    // the requester holding an invite they were told had failed — the retry
    // then answers `already_requested`, which is unrecoverable from the UI.
    const friendship = await ctx.db.$transaction(async (tx) => {
      const row = await tx.friendship.create({
        data: { requesterId: ctx.user.id, addresseeId: target.id, status: 'PENDING' },
      });
      await writeInviteActivity(tx, { type: 'FRIEND_INVITE_SENT', friendshipId: row.id, actorId: ctx.user.id });
      return row;
    });

    return { friendshipId: friendship.id, friendId: target.id, status: friendship.status };
  }),

  /**
   * A friend who does not use ShareTab. Starts ACCEPTED because there is nobody
   * on the other side to accept, and unlike a group placeholder this one has no
   * group membership to live in — the friendship row is what makes it findable.
   */
  addPlaceholder: protectedProcedure
    .input(z.object({ name: z.string().min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      const placeholder = await createPlaceholderUser(ctx.db, {
        name: input.name,
        createdByUserId: ctx.user.id,
      });

      await ctx.db.friendship.create({
        data: {
          requesterId: ctx.user.id,
          addresseeId: placeholder.id,
          status: 'ACCEPTED',
          respondedAt: new Date(),
        },
      });

      return { friendId: placeholder.id, name: placeholder.name, isPlaceholder: true };
    }),

  respondToInvite: friendProcedure
    .input(z.object({ response: z.enum(['accept', 'reject']) }))
    .mutation(async ({ ctx, input }) => {
      // Specifically the row addressed to the viewer. If they also sent an
      // invite of their own, that one is not theirs to answer.
      const invite = incomingFriendship(ctx.user.id, ctx.friendships);
      if (!invite) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'No invite from this person' });
      }

      const decision = evaluateInviteResponse(ctx.user.id, invite, input.response);
      if (!decision.ok) throw new TRPCError(FRIENDSHIP_ERRORS[decision.reason]);

      await ctx.db.$transaction(async (tx) => {
        await tx.friendship.update({
          where: { id: invite.id },
          data: { status: decision.status, respondedAt: new Date() },
        });

        // Only acceptance is logged. A rejection would reach the requester
        // through the same entityId arm the acceptance does, and telling someone
        // they were turned down is not what this feed is for.
        if (decision.status === 'ACCEPTED') {
          await writeInviteActivity(tx, {
            type: 'FRIEND_INVITE_ACCEPTED',
            friendshipId: invite.id,
            actorId: ctx.user.id,
          });
        }
      });

      return { status: decision.status };
    }),

  resendInvite: friendProcedure.mutation(async ({ ctx }) => {
    const invite = outgoingFriendship(ctx.user.id, ctx.friendships);
    if (!invite) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'No invite to this person' });
    }

    const decision = evaluateInviteResend(ctx.user.id, invite);
    if (!decision.ok) throw new TRPCError(FRIENDSHIP_ERRORS[decision.reason]);

    await ctx.db.$transaction(async (tx) => {
      await tx.friendship.update({
        where: { id: invite.id },
        data: { status: decision.status, respondedAt: null },
      });

      // A resend puts a live invite in front of the addressee again, so it is
      // the same event as the original send as far as the feed is concerned.
      await writeInviteActivity(tx, { type: 'FRIEND_INVITE_SENT', friendshipId: invite.id, actorId: ctx.user.id });
    });

    return { status: decision.status };
  }),

  getBalance: friendProcedure.query(async ({ ctx, input }) => {
    const ledger = await loadViewerLedger(ctx.db, ctx.user.id);
    if (!ctx.canViewAmounts) {
      return { net: null, displayCurrency: ledger.displayCurrency, ratesUnavailable: false };
    }

    const balances = computePairwiseBalances(ctx.user.id, ledger.expenses, ledger.settlements);
    return {
      net: balances.find((balance) => balance.userId === input.friendId)?.net ?? 0,
      displayCurrency: ledger.displayCurrency,
      ratesUnavailable: ledger.ratesUnavailable,
    };
  }),

  /**
   * Every row that moved the balance with this one friend, newest first.
   *
   * Each row's `delta` comes from the same attribution the balance is folded
   * from, so the rows add up to `net` — but only when the list is complete.
   * Past `limit` the response says `truncated`, and a caller that sums the
   * rows it received will not reach `net`.
   */
  getLedger: friendProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }))
    .query(async ({ ctx, input }) => {
      const ledger = await loadViewerLedger(ctx.db, ctx.user.id);
      if (!ctx.canViewAmounts) {
        return {
          entries: [],
          truncated: false,
          net: null,
          displayCurrency: ledger.displayCurrency,
          ratesUnavailable: false,
        };
      }

      const friendId = input.friendId;

      const expenseEntries = ledger.expenses.flatMap((expense) => {
        const delta = attributeExpense(ctx.user.id, expense).get(friendId);
        if (delta === undefined) return [];
        return [
          {
            kind: 'expense' as const,
            id: expense.id,
            title: expense.title,
            date: expense.expenseDate,
            currency: expense.currency,
            groupId: expense.groupId,
            groupName: expense.groupName,
            paidByYou: expense.paidById === ctx.user.id,
            delta,
          },
        ];
      });

      const settlementEntries = ledger.settlements.flatMap((settlement) => {
        const delta = attributeSettlement(ctx.user.id, settlement).get(friendId);
        if (delta === undefined) return [];
        return [
          {
            kind: 'settlement' as const,
            id: settlement.id,
            title: settlement.note,
            date: settlement.settledAt,
            currency: settlement.currency,
            groupId: settlement.groupId,
            groupName: settlement.groupName,
            paidByYou: settlement.fromId === ctx.user.id,
            delta,
          },
        ];
      });

      const entries = [...expenseEntries, ...settlementEntries].sort((a, b) => b.date.getTime() - a.date.getTime());

      return {
        entries: entries.slice(0, input.limit),
        truncated: entries.length > input.limit,
        net: entries.reduce((total, entry) => total + entry.delta, 0),
        displayCurrency: ledger.displayCurrency,
        ratesUnavailable: ledger.ratesUnavailable,
      };
    }),
});
