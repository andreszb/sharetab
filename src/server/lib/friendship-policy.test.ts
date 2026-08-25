import { describe, test, expect } from 'vitest';
import {
  friendshipRole,
  canViewFriendAmounts,
  availableFriendshipActions,
  evaluateInviteResponse,
  evaluateInviteResend,
  evaluateAddByEmail,
  primaryFriendship,
  incomingFriendship,
  outgoingFriendship,
  canViewAmountsFor,
  type FriendshipRow,
} from './friendship-policy';

const row = (status: FriendshipRow['status']): FriendshipRow => ({
  requesterId: 'alice',
  addresseeId: 'bob',
  status,
});

// ── role ──────────────────────────────────────────────────────────────────

describe('friendshipRole', () => {
  test('identifies each side', () => {
    expect(friendshipRole('alice', row('PENDING'))).toBe('requester');
    expect(friendshipRole('bob', row('PENDING'))).toBe('addressee');
  });

  test('returns null for a bystander', () => {
    expect(friendshipRole('carol', row('ACCEPTED'))).toBeNull();
  });
});

// ── visibility ────────────────────────────────────────────────────────────

describe('canViewFriendAmounts', () => {
  test('the requester sees amounts immediately, before any response', () => {
    expect(canViewFriendAmounts('alice', row('PENDING'))).toBe(true);
  });

  test('the requester keeps seeing amounts after a rejection', () => {
    // Rejection does not stop the requester logging or tracking.
    expect(canViewFriendAmounts('alice', row('REJECTED'))).toBe(true);
  });

  test('the addressee sees no amounts while the invite is pending', () => {
    expect(canViewFriendAmounts('bob', row('PENDING'))).toBe(false);
  });

  test('the addressee sees amounts once accepted', () => {
    expect(canViewFriendAmounts('bob', row('ACCEPTED'))).toBe(true);
  });

  test('a bystander never sees amounts', () => {
    expect(canViewFriendAmounts('carol', row('ACCEPTED'))).toBe(false);
  });
});

// ── available actions ─────────────────────────────────────────────────────

describe('availableFriendshipActions', () => {
  test('the addressee of a pending invite may accept or reject', () => {
    expect(availableFriendshipActions('bob', row('PENDING'))).toEqual(['accept', 'reject']);
  });

  test('the addressee may still accept after rejecting', () => {
    expect(availableFriendshipActions('bob', row('REJECTED'))).toEqual(['accept']);
  });

  test('the requester may resend a rejected invite', () => {
    expect(availableFriendshipActions('alice', row('REJECTED'))).toEqual(['resend']);
  });

  test('nothing is offered on an accepted friendship', () => {
    expect(availableFriendshipActions('alice', row('ACCEPTED'))).toEqual([]);
    expect(availableFriendshipActions('bob', row('ACCEPTED'))).toEqual([]);
  });

  test('the requester waits on a pending invite', () => {
    expect(availableFriendshipActions('alice', row('PENDING'))).toEqual([]);
  });

  test('a bystander is offered nothing', () => {
    expect(availableFriendshipActions('carol', row('PENDING'))).toEqual([]);
  });
});

// ── responding ────────────────────────────────────────────────────────────

describe('evaluateInviteResponse', () => {
  test('the addressee accepts a pending invite', () => {
    expect(evaluateInviteResponse('bob', row('PENDING'), 'accept')).toEqual({ ok: true, status: 'ACCEPTED' });
  });

  test('the addressee rejects a pending invite', () => {
    expect(evaluateInviteResponse('bob', row('PENDING'), 'reject')).toEqual({ ok: true, status: 'REJECTED' });
  });

  test('the addressee may accept one they previously rejected', () => {
    expect(evaluateInviteResponse('bob', row('REJECTED'), 'accept')).toEqual({ ok: true, status: 'ACCEPTED' });
  });

  test('rejecting twice is idempotent rather than an error', () => {
    expect(evaluateInviteResponse('bob', row('REJECTED'), 'reject')).toEqual({ ok: true, status: 'REJECTED' });
  });

  test('the requester cannot answer their own invite', () => {
    expect(evaluateInviteResponse('alice', row('PENDING'), 'accept')).toEqual({
      ok: false,
      reason: 'not_the_addressee',
    });
  });

  test('a bystander cannot answer', () => {
    expect(evaluateInviteResponse('carol', row('PENDING'), 'accept')).toEqual({ ok: false, reason: 'not_a_party' });
  });

  test('an accepted friendship cannot be re-answered', () => {
    // Undoing an acceptance is a different operation (unfriending), not a response.
    expect(evaluateInviteResponse('bob', row('ACCEPTED'), 'reject')).toEqual({
      ok: false,
      reason: 'already_accepted',
    });
  });
});

// ── resending ─────────────────────────────────────────────────────────────

describe('evaluateInviteResend', () => {
  test('the requester puts a rejected invite back to pending', () => {
    expect(evaluateInviteResend('alice', row('REJECTED'))).toEqual({ ok: true, status: 'PENDING' });
  });

  test('resending a still-pending invite is a harmless nudge', () => {
    expect(evaluateInviteResend('alice', row('PENDING'))).toEqual({ ok: true, status: 'PENDING' });
  });

  test('the addressee cannot resend', () => {
    expect(evaluateInviteResend('bob', row('REJECTED'))).toEqual({ ok: false, reason: 'not_the_requester' });
  });

  test('an accepted friendship has nothing to resend', () => {
    expect(evaluateInviteResend('alice', row('ACCEPTED'))).toEqual({ ok: false, reason: 'already_accepted' });
  });

  test('a bystander cannot resend', () => {
    expect(evaluateInviteResend('carol', row('REJECTED'))).toEqual({ ok: false, reason: 'not_a_party' });
  });
});

// ── adding by email ───────────────────────────────────────────────────────

describe('evaluateAddByEmail', () => {
  const target = { id: 'bob', isPlaceholder: false, suspended: false };

  test('accepts a fresh, registered, active target', () => {
    expect(evaluateAddByEmail({ viewerId: 'alice', target, existing: [] })).toEqual({ ok: true });
  });

  test('refuses to befriend yourself', () => {
    expect(evaluateAddByEmail({ viewerId: 'alice', target: { ...target, id: 'alice' }, existing: [] })).toEqual({
      ok: false,
      reason: 'self',
    });
  });

  test('refuses a placeholder target', () => {
    // Placeholders are added through addPlaceholder, which owns their creation.
    expect(evaluateAddByEmail({ viewerId: 'alice', target: { ...target, isPlaceholder: true }, existing: [] })).toEqual(
      { ok: false, reason: 'placeholder_target' },
    );
  });

  test('refuses a suspended target', () => {
    expect(evaluateAddByEmail({ viewerId: 'alice', target: { ...target, suspended: true }, existing: [] })).toEqual({
      ok: false,
      reason: 'suspended_target',
    });
  });

  test('refuses when the viewer already sent this invite', () => {
    expect(evaluateAddByEmail({ viewerId: 'alice', target, existing: [row('PENDING')] })).toEqual({
      ok: false,
      reason: 'already_requested',
    });
  });

  test('points the viewer at resend when their invite was rejected', () => {
    expect(evaluateAddByEmail({ viewerId: 'alice', target, existing: [row('REJECTED')] })).toEqual({
      ok: false,
      reason: 'rejected_use_resend',
    });
  });

  test('refuses when the two are already friends', () => {
    expect(evaluateAddByEmail({ viewerId: 'alice', target, existing: [row('ACCEPTED')] })).toEqual({
      ok: false,
      reason: 'already_friends',
    });
  });

  test('points the viewer at accept when the other side invited them first', () => {
    const incoming: FriendshipRow = { requesterId: 'bob', addresseeId: 'alice', status: 'PENDING' };
    expect(evaluateAddByEmail({ viewerId: 'alice', target, existing: [incoming] })).toEqual({
      ok: false,
      reason: 'incoming_invite_pending',
    });
  });

  test('lets the viewer invite someone whose invite they rejected', () => {
    // Alice rejected Bob, then changed her mind and added him herself. The
    // caller creates a new row in her direction; the stale one is untouched.
    const incoming: FriendshipRow = { requesterId: 'bob', addresseeId: 'alice', status: 'REJECTED' };
    expect(evaluateAddByEmail({ viewerId: 'alice', target, existing: [incoming] })).toEqual({ ok: true });
  });
});

// ── resolving a pair that has a row in each direction ─────────────────────

describe('primaryFriendship', () => {
  const sentByAlice = (status: FriendshipRow['status']): FriendshipRow => ({
    requesterId: 'alice',
    addresseeId: 'bob',
    status,
  });
  const sentByBob = (status: FriendshipRow['status']): FriendshipRow => ({
    requesterId: 'bob',
    addresseeId: 'alice',
    status,
  });

  test('returns null when the viewer is party to nothing', () => {
    expect(primaryFriendship('carol', [sentByAlice('PENDING')])).toBeNull();
    expect(primaryFriendship('alice', [])).toBeNull();
  });

  test('an accepted row outranks a pending one', () => {
    expect(primaryFriendship('alice', [sentByAlice('PENDING'), sentByBob('ACCEPTED')])).toEqual(sentByBob('ACCEPTED'));
  });

  test('an answerable invite outranks one the viewer is waiting on', () => {
    // Alice can do something about Bob's invite; her own she can only wait on.
    expect(primaryFriendship('alice', [sentByAlice('PENDING'), sentByBob('PENDING')])).toEqual(sentByBob('PENDING'));
  });

  test('a live invite outranks a rejected one', () => {
    expect(primaryFriendship('alice', [sentByBob('REJECTED'), sentByAlice('PENDING')])).toEqual(sentByAlice('PENDING'));
  });

  test('the answer does not depend on row order', () => {
    const rows = [sentByAlice('PENDING'), sentByBob('REJECTED')];
    expect(primaryFriendship('alice', rows)).toEqual(primaryFriendship('alice', [...rows].reverse()));
  });

  test('two equally ranked rows resolve to the same one either way round', () => {
    const rows = [sentByAlice('REJECTED'), sentByBob('REJECTED')];
    expect(primaryFriendship('alice', rows)).toEqual(primaryFriendship('alice', [...rows].reverse()));
  });

  test('preserves extra fields on the row it picks', () => {
    // The router needs the row's id to update it.
    const rows = [{ ...sentByBob('PENDING'), id: 'row-1' }];
    expect(primaryFriendship('alice', rows)?.id).toBe('row-1');
  });
});

describe('incomingFriendship / outgoingFriendship', () => {
  const rows: FriendshipRow[] = [
    { requesterId: 'alice', addresseeId: 'bob', status: 'REJECTED' },
    { requesterId: 'bob', addresseeId: 'alice', status: 'PENDING' },
  ];

  test('each side picks its own row, not whichever came first', () => {
    expect(incomingFriendship('alice', rows)).toEqual(rows[1]);
    expect(outgoingFriendship('alice', rows)).toEqual(rows[0]);
  });

  test('null when there is no row in that direction', () => {
    expect(incomingFriendship('alice', [rows[0]!])).toBeNull();
    expect(outgoingFriendship('alice', [rows[1]!])).toBeNull();
  });
});

// ── the combined visibility rule ──────────────────────────────────────────

describe('canViewAmountsFor', () => {
  const pendingIncoming: FriendshipRow = { requesterId: 'bob', addresseeId: 'alice', status: 'PENDING' };

  test('a pending addressee is blacked out', () => {
    expect(canViewAmountsFor('alice', [pendingIncoming], false)).toBe(false);
  });

  test('shared history overrides the blackout', () => {
    expect(canViewAmountsFor('alice', [pendingIncoming], true)).toBe(true);
  });

  test('shared history alone is enough, with no row at all', () => {
    expect(canViewAmountsFor('alice', [], true)).toBe(true);
  });

  test('no row and no history reveals nothing', () => {
    expect(canViewAmountsFor('alice', [], false)).toBe(false);
  });

  test('any qualifying row grants visibility', () => {
    // Alice's own outgoing invite lets her see, even while Bob's to her pends.
    const outgoing: FriendshipRow = { requesterId: 'alice', addresseeId: 'bob', status: 'PENDING' };
    expect(canViewAmountsFor('alice', [pendingIncoming, outgoing], false)).toBe(true);
  });
});
