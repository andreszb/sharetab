/**
 * Pure policy for the friendship invite lifecycle: who may answer an invite,
 * who may resend one, and — the part that actually matters — who is allowed to
 * see amounts.
 *
 * The governing rule from the spec is that a friendship is **one-sided until
 * accepted**. The requester may start logging expenses against the other person
 * the moment they send the invite, and keeps that ability even if the invite is
 * rejected; the addressee sees only that an invite exists, with no amounts,
 * until they accept. On acceptance the whole retroactive history becomes
 * visible to both sides at once — nothing here filters by date, so that falls
 * out for free.
 *
 * Deliberately knows nothing about Prisma or tRPC; the caller resolves rows and
 * turns a denial into the right error code. Follows the `oidc-signin-policy.ts`
 * precedent.
 */

export type FriendshipStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED';

export type FriendshipRow = {
  requesterId: string;
  addresseeId: string;
  status: FriendshipStatus;
};

export type FriendshipRole = 'requester' | 'addressee';

/** Which side of the row the viewer is on, or null if they are not party to it. */
export function friendshipRole(viewerId: string, row: FriendshipRow): FriendshipRole | null {
  if (row.requesterId === viewerId) return 'requester';
  if (row.addresseeId === viewerId) return 'addressee';
  return null;
}

/**
 * May the viewer see the amounts on this friendship?
 *
 * The requester always may — they created the record and are the one logging
 * into it. The addressee only once they have accepted.
 */
export function canViewFriendAmounts(viewerId: string, row: FriendshipRow): boolean {
  const role = friendshipRole(viewerId, row);
  if (role === 'requester') return true;
  if (role === 'addressee') return row.status === 'ACCEPTED';
  return false;
}

export type FriendshipAction = 'accept' | 'reject' | 'resend';

/** What the viewer can do about this row right now, in display order. */
export function availableFriendshipActions(viewerId: string, row: FriendshipRow): FriendshipAction[] {
  const role = friendshipRole(viewerId, row);
  if (row.status === 'ACCEPTED') return [];

  if (role === 'addressee') {
    // A rejection is not final: the addressee can still change their mind
    // without needing the requester to resend.
    return row.status === 'PENDING' ? ['accept', 'reject'] : ['accept'];
  }
  if (role === 'requester') {
    return row.status === 'REJECTED' ? ['resend'] : [];
  }
  return [];
}

export type FriendshipDenyReason = 'not_a_party' | 'not_the_addressee' | 'not_the_requester' | 'already_accepted';

export type FriendshipDecision = { ok: true; status: FriendshipStatus } | { ok: false; reason: FriendshipDenyReason };

/** Accept or reject an invite. Only the addressee may, and only before acceptance. */
export function evaluateInviteResponse(
  viewerId: string,
  row: FriendshipRow,
  response: 'accept' | 'reject',
): FriendshipDecision {
  const role = friendshipRole(viewerId, row);
  if (role === null) return { ok: false, reason: 'not_a_party' };
  if (role === 'requester') return { ok: false, reason: 'not_the_addressee' };
  if (row.status === 'ACCEPTED') return { ok: false, reason: 'already_accepted' };

  return { ok: true, status: response === 'accept' ? 'ACCEPTED' : 'REJECTED' };
}

/**
 * Put a rejected invite back in front of the addressee. Only the requester may.
 * Resending a still-pending invite is allowed and idempotent, so a client that
 * cannot tell the two states apart cannot get stuck.
 */
export function evaluateInviteResend(viewerId: string, row: FriendshipRow): FriendshipDecision {
  const role = friendshipRole(viewerId, row);
  if (role === null) return { ok: false, reason: 'not_a_party' };
  if (role === 'addressee') return { ok: false, reason: 'not_the_requester' };
  if (row.status === 'ACCEPTED') return { ok: false, reason: 'already_accepted' };

  return { ok: true, status: 'PENDING' };
}

export type AddFriendDenyReason =
  | 'self'
  | 'placeholder_target'
  | 'suspended_target'
  | 'already_requested'
  | 'rejected_use_resend'
  | 'already_friends'
  | 'incoming_invite_pending';

export type AddFriendDecision = { ok: true } | { ok: false; reason: AddFriendDenyReason };

/**
 * Whether the viewer may send a fresh invite to `target`.
 *
 * `existing` is every friendship row between the two, in either direction —
 * the unique constraint is on the ordered pair, so there can be at most two.
 * Each rejection routes the caller to the operation that actually applies
 * (resend, or accept) rather than silently creating a duplicate.
 */
export function evaluateAddByEmail(input: {
  viewerId: string;
  target: { id: string; isPlaceholder: boolean; suspended: boolean };
  existing: FriendshipRow[];
}): AddFriendDecision {
  const { viewerId, target, existing } = input;

  if (target.id === viewerId) return { ok: false, reason: 'self' };
  if (target.isPlaceholder) return { ok: false, reason: 'placeholder_target' };
  if (target.suspended) return { ok: false, reason: 'suspended_target' };

  const outgoing = existing.find((r) => r.requesterId === viewerId && r.addresseeId === target.id);
  if (outgoing) {
    if (outgoing.status === 'ACCEPTED') return { ok: false, reason: 'already_friends' };
    if (outgoing.status === 'PENDING') return { ok: false, reason: 'already_requested' };
    return { ok: false, reason: 'rejected_use_resend' };
  }

  const incoming = existing.find((r) => r.requesterId === target.id && r.addresseeId === viewerId);
  if (incoming) {
    if (incoming.status === 'ACCEPTED') return { ok: false, reason: 'already_friends' };
    if (incoming.status === 'PENDING') return { ok: false, reason: 'incoming_invite_pending' };
    // The viewer rejected them earlier and has now changed their mind. Let the
    // new invite go out in their own direction; the stale row stays as history.
  }

  return { ok: true };
}

/**
 * Which row governs a pair when both directions have one.
 *
 * Two rows can legitimately exist: the unique constraint is on the ordered
 * pair, and `evaluateAddByEmail` deliberately lets someone invite a person
 * whose earlier invite they rejected. Picking with `findFirst` would then be a
 * coin toss, so callers must resolve the pair through here instead.
 *
 * An accepted row always wins. Failing that, an invite the viewer can act on
 * beats one they are only waiting on, and a live invite beats a dead one.
 */
export function primaryFriendship<T extends FriendshipRow>(viewerId: string, rows: T[]): T | null {
  const relevant = rows.filter((row) => friendshipRole(viewerId, row) !== null);
  if (relevant.length === 0) return null;

  const rank = (row: T) => {
    if (row.status === 'ACCEPTED') return 3;
    if (row.status === 'PENDING') return friendshipRole(viewerId, row) === 'addressee' ? 2 : 1;
    return 0;
  };

  return relevant.reduce((best, row) => {
    if (rank(row) !== rank(best)) return rank(row) > rank(best) ? row : best;
    // Stable tiebreak so two equally ranked rows never alternate between calls.
    return row.requesterId.localeCompare(best.requesterId) < 0 ? row : best;
  });
}

/** The invite awaiting the viewer's answer, if any. */
export function incomingFriendship<T extends FriendshipRow>(viewerId: string, rows: T[]): T | null {
  return rows.find((row) => row.addresseeId === viewerId) ?? null;
}

/** The invite the viewer sent, if any. */
export function outgoingFriendship<T extends FriendshipRow>(viewerId: string, rows: T[]): T | null {
  return rows.find((row) => row.requesterId === viewerId) ?? null;
}

/**
 * The full amount-visibility rule, and the only place it should be written.
 *
 * Beyond the one-sided invite rule, sharing a group or a direct expense with
 * someone reveals the figures regardless: they can already read them there, so
 * withholding them on the friends surface would be theatre rather than privacy.
 */
export function canViewAmountsFor(viewerId: string, rows: FriendshipRow[], sharesHistory: boolean): boolean {
  return sharesHistory || rows.some((row) => canViewFriendAmounts(viewerId, row));
}
