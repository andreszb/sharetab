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

import { canViewFriendAmounts, friendshipRole, type FriendshipRow, type FriendshipStatus } from './friendship-policy';

export type FriendSource = 'friendship' | 'group' | 'expense';

/** `IMPLICIT` = derived from shared history, with no friendship row. */
export type FriendListStatus = FriendshipStatus | 'IMPLICIT';

export type FriendListEntry = {
  userId: string;
  status: FriendListStatus;
  /** Who sent the invite. null for a friend derived from shared history. */
  direction: 'outgoing' | 'incoming' | null;
  canViewAmounts: boolean;
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

  const rows = new Map<string, FriendshipRow>();
  for (const row of friendships) {
    const role = friendshipRole(viewerId, row);
    if (role === null) continue;
    const otherId = role === 'requester' ? row.addresseeId : row.requesterId;
    // A self-row is not a friendship, and would otherwise list the viewer.
    if (otherId === viewerId) continue;
    rows.set(otherId, row);
  }

  const inGroup = new Set(groupCoMemberIds.filter((id) => id !== viewerId));
  const inExpense = new Set(expenseCoParticipantIds.filter((id) => id !== viewerId));

  const entries: FriendListEntry[] = [];
  for (const userId of new Set([...rows.keys(), ...inGroup, ...inExpense])) {
    const row = rows.get(userId);
    const sharesHistory = inGroup.has(userId) || inExpense.has(userId);

    const sources: FriendSource[] = [];
    if (row) sources.push('friendship');
    if (inGroup.has(userId)) sources.push('group');
    if (inExpense.has(userId)) sources.push('expense');

    entries.push({
      userId,
      status: row ? row.status : 'IMPLICIT',
      direction: row ? (friendshipRole(viewerId, row) === 'requester' ? 'outgoing' : 'incoming') : null,
      // Shared history overrides a pending invite's blackout: these figures are
      // already visible to both of them in the group or expense they share.
      canViewAmounts: sharesHistory || (row ? canViewFriendAmounts(viewerId, row) : false),
      sources,
    });
  }

  return entries.sort((a, b) => a.userId.localeCompare(b.userId));
}
