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

/**
 * The in-memory form of `participatesInExpense`, for a row already loaded.
 *
 * Deliberately adjacent to its Prisma twin: the two answer the same question in
 * two places, and the whole point of this file is that such a predicate is
 * written once where both spellings can be seen together.
 */
export function participates(expense: { paidById: string; shares?: { userId: string }[] }, userId: string): boolean {
  return expense.paidById === userId || (expense.shares?.some((share) => share.userId === userId) ?? false);
}

/** A direct (non-group) expense that both people take part in. */
export function sharedNonGroupExpense(viewerId: string, otherId: string) {
  return {
    groupId: null,
    AND: [participatesInExpense(viewerId), participatesInExpense(otherId)],
  };
}

/**
 * A group membership held by `otherId` in a live group the viewer is also in.
 *
 * Archived groups are excluded because the friends list and the ledger both
 * exclude them. Counting one here would authorize a friend who then appears
 * nowhere and always reads zero.
 */
export function sharedGroupMembership(viewerId: string, otherId: string) {
  return {
    userId: otherId,
    group: { members: { some: { userId: viewerId } }, archivedAt: null },
  };
}

/** Everyone other than the viewer in the viewer's live groups. */
export function groupCoMembers(viewerId: string) {
  return {
    group: { members: { some: { userId: viewerId } }, archivedAt: null },
    NOT: { userId: viewerId },
  };
}

/**
 * A direct expense the viewer shares with **any** of `otherIds`.
 *
 * The set version of `sharedNonGroupExpense`. Validating a participant list one
 * counterparty at a time would be N queries, but reading every direct expense
 * the viewer has ever been in is an unbounded scan on a write path — this asks
 * only for the rows that could possibly connect somebody in the list.
 *
 * Written as two `in` lists rather than an `OR` of per-id `participatesInExpense`
 * fragments: both say "somebody in `otherIds` took part", but the `OR` spelling
 * compiles to one correlated subquery *per id*, so a caller with a long
 * participant list turns a write into an N-subquery scan. The shape here is
 * constant no matter how long the list is.
 */
export function sharedNonGroupExpenseWithAny(viewerId: string, otherIds: string[]) {
  return {
    groupId: null,
    AND: [
      participatesInExpense(viewerId),
      { OR: [{ paidById: { in: otherIds } }, { shares: { some: { userId: { in: otherIds } } } }] },
    ],
  };
}
