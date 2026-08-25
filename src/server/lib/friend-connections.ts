/**
 * Loads the ties between the viewer and a specific set of people, in the shape
 * `evaluateDirectParticipants` consumes.
 *
 * This lives apart from `friend-queries.ts` because that file deliberately
 * holds nothing but plain `where` literals and stays free of a Prisma import.
 * It reads the same three sources `friends.list` unions — explicit friendship
 * rows, live group co-membership, and shared direct expenses — so a person the
 * friends list shows can always be put on an expense, and a person it does not
 * show never can.
 */

import { TRPCError } from '@trpc/server';
import type { PrismaClient } from '@/generated/prisma/client';
import { evaluateDirectParticipants, type Connection } from './direct-participants';
import { groupCoMembers, sharedNonGroupExpenseWithAny } from './friend-queries';

export async function loadConnections(
  db: PrismaClient,
  viewerId: string,
  otherIds: string[],
): Promise<Map<string, Connection>> {
  const ids = [...new Set(otherIds)].filter((id) => id !== viewerId);
  if (ids.length === 0) return new Map();

  const [friendships, coMembers, directExpenses] = await Promise.all([
    // Both directions, and both rows of a pair: `canViewAmountsFor` needs the
    // whole set to answer, not whichever one a `findFirst` happened to pick.
    db.friendship.findMany({
      where: {
        OR: [
          { requesterId: viewerId, addresseeId: { in: ids } },
          { requesterId: { in: ids }, addresseeId: viewerId },
        ],
      },
      select: { requesterId: true, addresseeId: true, status: true },
    }),
    db.groupMember.findMany({
      where: { ...groupCoMembers(viewerId), userId: { in: ids } },
      select: { userId: true },
      distinct: ['userId'],
    }),
    db.expense.findMany({
      where: sharedNonGroupExpenseWithAny(viewerId, ids),
      select: { paidById: true, shares: { select: { userId: true } } },
    }),
  ]);

  const sharesHistory = new Set(coMembers.map((member) => member.userId));
  for (const expense of directExpenses) {
    for (const userId of [expense.paidById, ...expense.shares.map((share) => share.userId)]) {
      if (userId !== viewerId) sharesHistory.add(userId);
    }
  }

  const connections = new Map<string, Connection>();
  for (const id of ids) {
    connections.set(id, { rows: [], sharesHistory: sharesHistory.has(id) });
  }
  for (const row of friendships) {
    const otherId = row.requesterId === viewerId ? row.addresseeId : row.requesterId;
    connections.get(otherId)?.rows.push(row);
  }

  return connections;
}

/**
 * Load, evaluate and throw in one call — the form all three write paths need.
 *
 * The transport error is mapped here rather than in each router because
 * expenses, settlements and receipt-derived expenses must refuse an
 * unconnected participant identically; three copies of the mapping is three
 * chances for them to drift.
 */
export async function assertDirectParticipants(
  db: PrismaClient,
  viewerId: string,
  participantIds: string[],
): Promise<void> {
  const connections = await loadConnections(db, viewerId, participantIds);
  const decision = evaluateDirectParticipants({ viewerId, participantIds, connections });
  if (decision.ok) return;

  throw new TRPCError({
    code: 'BAD_REQUEST',
    message:
      decision.reason === 'viewer_absent'
        ? 'You must be part of an expense you record outside a group'
        : 'You are not connected to everyone on this expense',
  });
}

/**
 * The connection half of the rule, without requiring the viewer to be one of
 * the named people.
 *
 * A half-finished receipt is the case for this: while assigning items you may
 * have named only your friends so far and not yet yourself, and that is a
 * legitimate intermediate state. The full rule still applies at the moment the
 * expense is actually created. Implemented by handing the viewer to the pure
 * evaluator as a participant, so the `viewer_absent` arm cannot fire.
 */
export async function assertDirectConnections(db: PrismaClient, viewerId: string, userIds: string[]): Promise<void> {
  await assertDirectParticipants(db, viewerId, [viewerId, ...userIds]);
}
