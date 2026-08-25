/**
 * Prisma `where` fragments describing what it means for two people to be
 * connected outside a group.
 *
 * These live here rather than being written out at each call site because the
 * same predicate has to agree in three places — `friendProcedure`'s
 * authorization, the friends list, and the per-friend ledger. A connection the
 * ledger recognises but the procedure does not is a 403 on a friend the user
 * can plainly see.
 *
 * Returned as plain object literals so this file stays free of a Prisma import
 * and can be reasoned about (and reused) without a client.
 */

/** Someone takes part in an expense if they paid for it or hold a share of it. */
export function participatesInExpense(userId: string) {
  return { OR: [{ paidById: userId }, { shares: { some: { userId } } }] };
}

/** A direct (non-group) expense that both people take part in. */
export function sharedNonGroupExpense(viewerId: string, otherId: string) {
  return {
    groupId: null,
    AND: [participatesInExpense(viewerId), participatesInExpense(otherId)],
  };
}

/** A group membership held by `otherId` in a group the viewer is also in. */
export function sharedGroupMembership(viewerId: string, otherId: string) {
  return {
    userId: otherId,
    group: { members: { some: { userId: viewerId } } },
  };
}
