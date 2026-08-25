/**
 * Who may appear on a direct (non-group) expense or settlement.
 *
 * A group answers this with `GroupMember`: everyone in the group can be on
 * everyone else's expenses. Outside a group there is no such container, so the
 * rule is drawn from amount visibility instead — **you may log an expense with
 * anyone whose amounts you are already allowed to see**.
 *
 * That reuse is deliberate rather than convenient. It gives the one-sided
 * invite semantics for free: a requester can log against someone who has not
 * answered yet (which is the whole point of a one-sided friendship), while an
 * addressee who has not accepted cannot log back, because they cannot yet see
 * any figures to log against.
 */

import { canViewAmountsFor, type FriendshipRow } from './friendship-policy';

/** Everything known about one counterparty's tie to the viewer. */
export type Connection = {
  /** Friendship rows for the pair — both directions, so possibly two. */
  rows: FriendshipRow[];
  /** True when the pair already shares a live group or a direct expense. */
  sharesHistory: boolean;
};

export type ParticipantDecision =
  { ok: true } | { ok: false; reason: 'viewer_absent' | 'not_connected'; userIds: string[] };

/**
 * Decide whether the viewer may write a direct row with this participant set.
 *
 * `participantIds` is the payer plus every share holder; duplicates are fine.
 * `connections` is keyed by counterparty id — a participant with no entry is
 * treated as unconnected, so a failed or partial load fails closed.
 */
export function evaluateDirectParticipants(input: {
  viewerId: string;
  participantIds: string[];
  connections: Map<string, Connection>;
}): ParticipantDecision {
  const { viewerId, participantIds, connections } = input;

  // Checked before connections so the error names the real problem: an expense
  // between two other people is refused for not involving the viewer, not for
  // some incidental gap in how they know those people.
  if (!participantIds.includes(viewerId)) {
    return { ok: false, reason: 'viewer_absent', userIds: [] };
  }

  const others = [...new Set(participantIds)].filter((userId) => userId !== viewerId);
  const unconnected = others.filter((userId) => {
    const connection = connections.get(userId);
    if (!connection) return true;
    return !canViewAmountsFor(viewerId, connection.rows, connection.sharesHistory);
  });

  if (unconnected.length > 0) {
    return { ok: false, reason: 'not_connected', userIds: unconnected };
  }

  return { ok: true };
}
