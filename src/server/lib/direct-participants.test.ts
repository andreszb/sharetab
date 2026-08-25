import { describe, test, expect } from 'vitest';
import { evaluateDirectParticipants, type Connection } from './direct-participants';
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

const connection = (rows: FriendshipRow[], sharesHistory = false): Connection => ({ rows, sharesHistory });

const evaluate = (participantIds: string[], connections: Record<string, Connection> = {}) =>
  evaluateDirectParticipants({
    viewerId: 'me',
    participantIds,
    connections: new Map(Object.entries(connections)),
  });

// ── the viewer must be in their own expense ───────────────────────────────

describe('viewer participation', () => {
  test('the viewer alone is allowed', () => {
    expect(evaluate(['me'])).toEqual({ ok: true });
  });

  test('an expense the viewer is not part of is refused', () => {
    const result = evaluate(['bob', 'carol'], {
      bob: connection([outgoing('bob', 'ACCEPTED')]),
      carol: connection([outgoing('carol', 'ACCEPTED')]),
    });
    expect(result).toEqual({ ok: false, reason: 'viewer_absent', userIds: [] });
  });

  test('viewer_absent wins over an unconnected participant', () => {
    // Reporting "not connected to bob" would be misleading when the real
    // problem is that this expense has nothing to do with the viewer.
    expect(evaluate(['bob'])).toEqual({ ok: false, reason: 'viewer_absent', userIds: [] });
  });

  test('an empty participant list is refused', () => {
    expect(evaluate([])).toEqual({ ok: false, reason: 'viewer_absent', userIds: [] });
  });
});

// ── connection is the amount-visibility rule ──────────────────────────────

describe('connection', () => {
  test('an accepted friend is allowed', () => {
    expect(evaluate(['me', 'bob'], { bob: connection([outgoing('bob', 'ACCEPTED')]) })).toEqual({ ok: true });
  });

  test('someone the viewer invited is allowed before they answer', () => {
    // The invite is one-sided on purpose: the requester may log expenses from
    // the moment they send it.
    expect(evaluate(['me', 'bob'], { bob: connection([outgoing('bob', 'PENDING')]) })).toEqual({ ok: true });
  });

  test('someone who rejected the viewer is still allowed', () => {
    expect(evaluate(['me', 'bob'], { bob: connection([outgoing('bob', 'REJECTED')]) })).toEqual({ ok: true });
  });

  test('someone who invited the viewer is refused until the viewer accepts', () => {
    const result = evaluate(['me', 'bob'], { bob: connection([incoming('bob', 'PENDING')]) });
    expect(result).toEqual({ ok: false, reason: 'not_connected', userIds: ['bob'] });
  });

  test('an invite the viewer accepted makes them allowed', () => {
    expect(evaluate(['me', 'bob'], { bob: connection([incoming('bob', 'ACCEPTED')]) })).toEqual({ ok: true });
  });

  test('shared history overrides an unanswered incoming invite', () => {
    expect(evaluate(['me', 'bob'], { bob: connection([incoming('bob', 'PENDING')], true) })).toEqual({ ok: true });
  });

  test('a group co-member with no friendship row is allowed', () => {
    expect(evaluate(['me', 'bob'], { bob: connection([], true) })).toEqual({ ok: true });
  });

  test('a stranger is refused', () => {
    expect(evaluate(['me', 'bob'], { bob: connection([]) })).toEqual({
      ok: false,
      reason: 'not_connected',
      userIds: ['bob'],
    });
  });

  test('a participant missing from the connection map is refused', () => {
    // A user id that loaded no connection rows at all must fail closed.
    expect(evaluate(['me', 'bob'])).toEqual({ ok: false, reason: 'not_connected', userIds: ['bob'] });
  });
});

// ── several participants at once ──────────────────────────────────────────

describe('multiple participants', () => {
  test('every connected participant is allowed', () => {
    expect(
      evaluate(['me', 'bob', 'carol'], {
        bob: connection([outgoing('bob', 'ACCEPTED')]),
        carol: connection([], true),
      }),
    ).toEqual({ ok: true });
  });

  test('one bad participant names exactly that participant', () => {
    expect(
      evaluate(['me', 'bob', 'carol'], {
        bob: connection([outgoing('bob', 'ACCEPTED')]),
        carol: connection([]),
      }),
    ).toEqual({ ok: false, reason: 'not_connected', userIds: ['carol'] });
  });

  test('every unconnected participant is reported, not just the first', () => {
    const result = evaluate(['me', 'bob', 'carol'], {});
    expect(result).toEqual({ ok: false, reason: 'not_connected', userIds: ['bob', 'carol'] });
  });

  test('a repeated participant is reported once', () => {
    expect(evaluate(['me', 'bob', 'bob'], {})).toEqual({
      ok: false,
      reason: 'not_connected',
      userIds: ['bob'],
    });
  });

  test('the viewer is never checked for a connection to themselves', () => {
    expect(evaluate(['me', 'me'], {})).toEqual({ ok: true });
  });
});
