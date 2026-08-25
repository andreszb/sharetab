/**
 * Builds the viewer's friends list out of three sources that overlap freely:
 *
 *   1. explicit `Friendship` rows — the only source with a table behind it;
 *   2. co-members of the viewer's groups;
 *   3. co-participants on the viewer's non-group expenses.
 *
 * Only (1) is stored. The settled design is deliberately not to write a row for
 * everyone the viewer has ever shared an expense with: that would need a
 * backfill and would amplify every expense write into a fan-out of friendship
 * upserts, with the rows drifting out of sync the moment anything is deleted.
 * Deriving (2) and (3) at read time costs one query each and cannot drift.
 *
 * Pure: the caller runs the three queries and passes the ids in.
 */

import {
  availableFriendshipActions,
  canViewAmountsFor,
  friendshipRole,
  primaryFriendship,
  type FriendshipAction,
  type FriendshipRow,
  type FriendshipStatus,
} from './friendship-policy';

export type FriendSource = 'friendship' | 'group' | 'expense';

/** `IMPLICIT` = derived from shared history, with no friendship row. */
export type FriendListStatus = FriendshipStatus | 'IMPLICIT';

export type FriendListEntry = {
  userId: string;
  status: FriendListStatus;
  /** Who sent the invite. null for a friend derived from shared history. */
  direction: 'outgoing' | 'incoming' | null;
  canViewAmounts: boolean;
  /** What the viewer can do about this friendship right now. */
  actions: FriendshipAction[];
  /** Every source this person was reached by, in the order listed above. */
  sources: FriendSource[];
};

export function buildFriendsList(input: {
  viewerId: string;
  friendships: FriendshipRow[];
  groupCoMemberIds: string[];
  expenseCoParticipantIds: string[];
}): FriendListEntry[] {
  const { viewerId, friendships, groupCoMemberIds, expenseCoParticipantIds } = input;

  // Group by counterparty first: both directions can hold a row, and taking
  // whichever the query happened to return last would make the listed status
  // depend on row order.
  const byCounterparty = new Map<string, FriendshipRow[]>();
  for (const row of friendships) {
    const role = friendshipRole(viewerId, row);
    if (role === null) continue;
    const otherId = role === 'requester' ? row.addresseeId : row.requesterId;
    // A self-row is not a friendship, and would otherwise list the viewer.
    if (otherId === viewerId) continue;
    byCounterparty.set(otherId, [...(byCounterparty.get(otherId) ?? []), row]);
  }

  const inGroup = new Set(groupCoMemberIds.filter((id) => id !== viewerId));
  const inExpense = new Set(expenseCoParticipantIds.filter((id) => id !== viewerId));

  const entries: FriendListEntry[] = [];
  for (const userId of new Set([...byCounterparty.keys(), ...inGroup, ...inExpense])) {
    const rows = byCounterparty.get(userId) ?? [];
    const row = primaryFriendship(viewerId, rows);
    const sharesHistory = inGroup.has(userId) || inExpense.has(userId);

    const sources: FriendSource[] = [];
    if (row) sources.push('friendship');
    if (inGroup.has(userId)) sources.push('group');
    if (inExpense.has(userId)) sources.push('expense');

    entries.push({
      userId,
      status: row ? row.status : 'IMPLICIT',
      direction: row ? (friendshipRole(viewerId, row) === 'requester' ? 'outgoing' : 'incoming') : null,
      canViewAmounts: canViewAmountsFor(viewerId, rows, sharesHistory),
      actions: row ? availableFriendshipActions(viewerId, row) : [],
      sources,
    });
  }

  return entries.sort((a, b) => a.userId.localeCompare(b.userId));
}
