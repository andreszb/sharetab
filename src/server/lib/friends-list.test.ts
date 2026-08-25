import { describe, test, expect } from 'vitest';
import { buildFriendsList } from './friends-list';
import type { FriendshipRow } from './friendship-policy';

const outgoing = (to: string, status: FriendshipRow['status'] = 'PENDING'): FriendshipRow => ({
  requesterId: 'me',
  addresseeId: to,
  status,
});
const incoming = (from: string, status: FriendshipRow['status'] = 'PENDING'): FriendshipRow => ({
  requesterId: from,
  addresseeId: 'me',
  status,
});

const build = (input: Partial<Parameters<typeof buildFriendsList>[0]>) =>
  buildFriendsList({
    viewerId: 'me',
    friendships: [],
    groupCoMemberIds: [],
    expenseCoParticipantIds: [],
    ...input,
  });

// ── the union of three sources ────────────────────────────────────────────

describe('sources', () => {
  test('an explicit friendship is listed', () => {
    expect(build({ friendships: [outgoing('bob', 'ACCEPTED')] })).toEqual([
      {
        userId: 'bob',
        status: 'ACCEPTED',
        direction: 'outgoing',
        canViewAmounts: true,
        actions: [],
        sources: ['friendship'],
      },
    ]);
  });

  test('a group co-member with no row is listed as implicit', () => {
    expect(build({ groupCoMemberIds: ['bob'] })).toEqual([
      {
        userId: 'bob',
        status: 'IMPLICIT',
        direction: null,
        canViewAmounts: true,
        actions: [],
        sources: ['group'],
      },
    ]);
  });

  test('a non-group expense co-participant with no row is listed as implicit', () => {
    expect(build({ expenseCoParticipantIds: ['bob'] })).toEqual([
      {
        userId: 'bob',
        status: 'IMPLICIT',
        direction: null,
        canViewAmounts: true,
        actions: [],
        sources: ['expense'],
      },
    ]);
  });

  test('one person reached by all three sources appears once', () => {
    const [bob, ...rest] = build({
      friendships: [outgoing('bob', 'ACCEPTED')],
      groupCoMemberIds: ['bob'],
      expenseCoParticipantIds: ['bob'],
    });
    expect(rest).toEqual([]);
    expect(bob?.sources).toEqual(['friendship', 'group', 'expense']);
  });

  test('duplicate ids within one source collapse', () => {
    // Co-membership of three shared groups is still one friend.
    expect(build({ groupCoMemberIds: ['bob', 'bob', 'bob'] })).toHaveLength(1);
  });

  test('the viewer is never their own friend', () => {
    expect(
      build({
        friendships: [{ requesterId: 'me', addresseeId: 'me', status: 'ACCEPTED' }],
        groupCoMemberIds: ['me'],
        expenseCoParticipantIds: ['me'],
      }),
    ).toEqual([]);
  });

  test('rows between two other people are ignored', () => {
    expect(build({ friendships: [{ requesterId: 'bob', addresseeId: 'carol', status: 'ACCEPTED' }] })).toEqual([]);
  });

  test('empty input yields an empty list', () => {
    expect(build({})).toEqual([]);
  });
});

// ── direction and status ──────────────────────────────────────────────────

describe('direction and status', () => {
  test('an invite the viewer sent is outgoing', () => {
    expect(build({ friendships: [outgoing('bob')] })[0]).toMatchObject({ direction: 'outgoing', status: 'PENDING' });
  });

  test('an invite the viewer received is incoming', () => {
    expect(build({ friendships: [incoming('bob')] })[0]).toMatchObject({ direction: 'incoming', status: 'PENDING' });
  });

  test('a rejected invite stays on the list for the requester', () => {
    // Rejection does not remove the friend — the requester keeps logging.
    expect(build({ friendships: [outgoing('bob', 'REJECTED')] })[0]).toMatchObject({
      status: 'REJECTED',
      canViewAmounts: true,
    });
  });

  test('an explicit row wins over implicit status', () => {
    expect(build({ friendships: [outgoing('bob')], groupCoMemberIds: ['bob'] })[0]).toMatchObject({
      status: 'PENDING',
      direction: 'outgoing',
    });
  });
});

// ── amount visibility ─────────────────────────────────────────────────────

describe('canViewAmounts', () => {
  test('a pending addressee sees no amounts', () => {
    expect(build({ friendships: [incoming('bob')] })[0]?.canViewAmounts).toBe(false);
  });

  test('accepting reveals amounts to the addressee', () => {
    expect(build({ friendships: [incoming('bob', 'ACCEPTED')] })[0]?.canViewAmounts).toBe(true);
  });

  test('a pending addressee who shares a group still sees amounts', () => {
    // Nothing can be hidden from someone who is already in the group and can
    // read the same figures there. Withholding them would only be theatre.
    expect(build({ friendships: [incoming('bob')], groupCoMemberIds: ['bob'] })[0]?.canViewAmounts).toBe(true);
  });

  test('a pending addressee who shares a non-group expense still sees amounts', () => {
    expect(build({ friendships: [incoming('bob')], expenseCoParticipantIds: ['bob'] })[0]?.canViewAmounts).toBe(true);
  });

  test('a rejected addressee with no shared history sees no amounts', () => {
    expect(build({ friendships: [incoming('bob', 'REJECTED')] })[0]?.canViewAmounts).toBe(false);
  });
});

// ── ordering ──────────────────────────────────────────────────────────────

describe('ordering', () => {
  test('sorted by userId, so the output is stable', () => {
    const list = build({ friendships: [outgoing('carol'), outgoing('alice')], groupCoMemberIds: ['bob'] });
    expect(list.map((f) => f.userId)).toEqual(['alice', 'bob', 'carol']);
  });
});

// ── both directions ───────────────────────────────────────────────────────
//
// Two rows for one pair are legal: the unique constraint is on the ordered
// pair, and someone may invite a person whose earlier invite they rejected.
// The listed status must not depend on which row the query returned first.

describe('a pair with a row in each direction', () => {
  const stale = incoming('bob', 'REJECTED');
  const live = outgoing('bob', 'PENDING');

  test('collapses to a single entry', () => {
    expect(build({ friendships: [stale, live] })).toHaveLength(1);
  });

  test('reports the same entry whichever order the rows arrive in', () => {
    expect(build({ friendships: [stale, live] })).toEqual(build({ friendships: [live, stale] }));
  });

  test('the live invite wins over the dead one', () => {
    expect(build({ friendships: [stale, live] })[0]).toMatchObject({
      status: 'PENDING',
      direction: 'outgoing',
    });
  });

  test('an accepted row wins over anything else', () => {
    const accepted = incoming('bob', 'ACCEPTED');
    expect(build({ friendships: [live, accepted] })[0]).toMatchObject({ status: 'ACCEPTED' });
  });

  test('an invite the viewer can answer beats one they are only waiting on', () => {
    const answerable = incoming('bob', 'PENDING');
    expect(build({ friendships: [live, answerable] })[0]).toMatchObject({
      direction: 'incoming',
      actions: ['accept', 'reject'],
    });
  });
});

// ── actions ───────────────────────────────────────────────────────────────

describe('actions', () => {
  test('an incoming pending invite offers accept and reject', () => {
    expect(build({ friendships: [incoming('bob')] })[0]?.actions).toEqual(['accept', 'reject']);
  });

  test("the viewer's own rejected invite offers resend", () => {
    expect(build({ friendships: [outgoing('bob', 'REJECTED')] })[0]?.actions).toEqual(['resend']);
  });

  test('an implicit friend has nothing to act on', () => {
    expect(build({ groupCoMemberIds: ['bob'] })[0]?.actions).toEqual([]);
  });
});
