import { describe, test, expect } from 'vitest';
import {
  friendshipRole,
  canViewFriendAmounts,
  availableFriendshipActions,
  evaluateInviteResponse,
  evaluateInviteResend,
  evaluateAddByEmail,
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
