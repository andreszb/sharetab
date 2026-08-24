import { describe, test, expect } from 'vitest';
import { evaluateOidcSignIn, type OidcSignInFlags, type OidcSignInInput } from './oidc-signin-policy';

const defaultFlags: OidcSignInFlags = {
  allowLinking: true,
  trustEmail: false,
  autoProvision: false,
};

const ADA = 'user_ada';
const BOB = 'user_bob';

function input(overrides: Partial<OidcSignInInput> = {}): OidcSignInInput {
  return {
    email: 'ada@example.com',
    emailVerified: true,
    alreadyLinked: false,
    sessionUserId: null,
    existingUserIdByEmail: null,
    registrationMode: 'open',
    flags: defaultFlags,
    ...overrides,
  };
}

describe('evaluateOidcSignIn', () => {
  test('always allows a re-login through an identity already linked', () => {
    expect(
      evaluateOidcSignIn(
        input({
          alreadyLinked: true,
          // Even flags that would otherwise deny every other branch don't matter here.
          existingUserIdByEmail: ADA,
          emailVerified: false,
          registrationMode: 'closed',
          flags: { allowLinking: false, trustEmail: false, autoProvision: false },
        }),
      ),
    ).toEqual({ allow: true });
  });

  test('denies a profile with no email, regardless of other state', () => {
    expect(evaluateOidcSignIn(input({ email: null }))).toEqual({ allow: false, reason: 'no_email' });
  });

  describe('linking (a User already holds this email)', () => {
    test('links when email_verified is true', () => {
      expect(evaluateOidcSignIn(input({ existingUserIdByEmail: ADA, emailVerified: true }))).toEqual({
        allow: true,
      });
    });

    test('refuses when email_verified is false', () => {
      expect(evaluateOidcSignIn(input({ existingUserIdByEmail: ADA, emailVerified: false }))).toEqual({
        allow: false,
        reason: 'email_not_verified',
      });
    });

    test('refuses when email_verified is absent and OIDC_TRUST_EMAIL is off', () => {
      expect(evaluateOidcSignIn(input({ existingUserIdByEmail: ADA, emailVerified: null }))).toEqual({
        allow: false,
        reason: 'email_not_verified',
      });
    });

    test('links when email_verified is absent and OIDC_TRUST_EMAIL is on', () => {
      expect(
        evaluateOidcSignIn(
          input({
            existingUserIdByEmail: ADA,
            emailVerified: null,
            flags: { ...defaultFlags, trustEmail: true },
          }),
        ),
      ).toEqual({ allow: true });
    });

    test('OIDC_TRUST_EMAIL does not override an explicit false claim', () => {
      expect(
        evaluateOidcSignIn(
          input({
            existingUserIdByEmail: ADA,
            emailVerified: false,
            flags: { ...defaultFlags, trustEmail: true },
          }),
        ),
      ).toEqual({ allow: false, reason: 'email_not_verified' });
    });

    test('refuses regardless of verification when OIDC_ALLOW_LINKING is off', () => {
      expect(
        evaluateOidcSignIn(
          input({
            existingUserIdByEmail: ADA,
            emailVerified: true,
            flags: { ...defaultFlags, allowLinking: false },
          }),
        ),
      ).toEqual({ allow: false, reason: 'linking_disabled' });
    });
  });

  // Auth.js links a new account straight onto the session user without
  // consulting email, so these cases have to be decided here or not at all.
  describe('linking onto an existing session', () => {
    test('links a first-time identity onto the signed-in user', () => {
      expect(evaluateOidcSignIn(input({ sessionUserId: ADA, existingUserIdByEmail: ADA }))).toEqual({ allow: true });
    });

    test('links even when no User holds the OIDC email yet', () => {
      expect(evaluateOidcSignIn(input({ sessionUserId: ADA, existingUserIdByEmail: null }))).toEqual({ allow: true });
    });

    test('refuses when the OIDC email belongs to a different account', () => {
      expect(evaluateOidcSignIn(input({ sessionUserId: ADA, existingUserIdByEmail: BOB }))).toEqual({
        allow: false,
        reason: 'email_belongs_to_other_user',
      });
    });

    test('honours OIDC_ALLOW_LINKING=false, which the email-only path could not see', () => {
      expect(
        evaluateOidcSignIn(
          input({
            sessionUserId: ADA,
            existingUserIdByEmail: null,
            flags: { ...defaultFlags, allowLinking: false },
          }),
        ),
      ).toEqual({ allow: false, reason: 'linking_disabled' });
    });

    test('still requires a verified email', () => {
      expect(evaluateOidcSignIn(input({ sessionUserId: ADA, emailVerified: false }))).toEqual({
        allow: false,
        reason: 'email_not_verified',
      });
    });

    test('does not consult registrationMode — nothing is being provisioned', () => {
      expect(evaluateOidcSignIn(input({ sessionUserId: ADA, registrationMode: 'closed' }))).toEqual({ allow: true });
    });
  });

  describe('provisioning (no User holds this email)', () => {
    test('allows a new user when registrationMode is open', () => {
      expect(evaluateOidcSignIn(input({ registrationMode: 'open' }))).toEqual({ allow: true });
    });

    test('blocks a new user when registrationMode is invite-only', () => {
      expect(evaluateOidcSignIn(input({ registrationMode: 'invite-only' }))).toEqual({
        allow: false,
        reason: 'provisioning_blocked',
      });
    });

    test('blocks a new user when registrationMode is closed', () => {
      expect(evaluateOidcSignIn(input({ registrationMode: 'closed' }))).toEqual({
        allow: false,
        reason: 'provisioning_blocked',
      });
    });

    test('OIDC_AUTO_PROVISION overrides invite-only', () => {
      expect(
        evaluateOidcSignIn(input({ registrationMode: 'invite-only', flags: { ...defaultFlags, autoProvision: true } })),
      ).toEqual({ allow: true });
    });

    test('OIDC_AUTO_PROVISION overrides closed', () => {
      expect(
        evaluateOidcSignIn(input({ registrationMode: 'closed', flags: { ...defaultFlags, autoProvision: true } })),
      ).toEqual({ allow: true });
    });

    test('refuses an unverified email even when registration is open', () => {
      // Otherwise an IdP with open self-registration lets an attacker
      // pre-create a row for an address they do not control.
      expect(evaluateOidcSignIn(input({ emailVerified: false }))).toEqual({
        allow: false,
        reason: 'email_not_verified',
      });
    });

    test('refuses a missing email_verified claim unless OIDC_TRUST_EMAIL is on', () => {
      expect(evaluateOidcSignIn(input({ emailVerified: null }))).toEqual({
        allow: false,
        reason: 'email_not_verified',
      });
      expect(evaluateOidcSignIn(input({ emailVerified: null, flags: { ...defaultFlags, trustEmail: true } }))).toEqual({
        allow: true,
      });
    });

    test('OIDC_AUTO_PROVISION does not waive the verification requirement', () => {
      expect(
        evaluateOidcSignIn(input({ emailVerified: false, flags: { ...defaultFlags, autoProvision: true } })),
      ).toEqual({ allow: false, reason: 'email_not_verified' });
    });
  });
});
