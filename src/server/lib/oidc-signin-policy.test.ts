import { describe, test, expect } from 'vitest';
import { evaluateOidcSignIn, type OidcSignInFlags, type OidcSignInInput } from './oidc-signin-policy';

const defaultFlags: OidcSignInFlags = {
  allowLinking: true,
  trustEmail: false,
  autoProvision: false,
};

function input(overrides: Partial<OidcSignInInput> = {}): OidcSignInInput {
  return {
    email: 'ada@example.com',
    emailVerified: true,
    alreadyLinked: false,
    existingUserByEmail: false,
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
          existingUserByEmail: true,
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

  describe('linking (existingUserByEmail: true)', () => {
    test('links when email_verified is true', () => {
      expect(evaluateOidcSignIn(input({ existingUserByEmail: true, emailVerified: true }))).toEqual({
        allow: true,
      });
    });

    test('refuses when email_verified is false', () => {
      expect(evaluateOidcSignIn(input({ existingUserByEmail: true, emailVerified: false }))).toEqual({
        allow: false,
        reason: 'email_not_verified',
      });
    });

    test('refuses when email_verified is absent and OIDC_TRUST_EMAIL is off', () => {
      expect(evaluateOidcSignIn(input({ existingUserByEmail: true, emailVerified: null }))).toEqual({
        allow: false,
        reason: 'email_not_verified',
      });
    });

    test('links when email_verified is absent and OIDC_TRUST_EMAIL is on', () => {
      expect(
        evaluateOidcSignIn(
          input({
            existingUserByEmail: true,
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
            existingUserByEmail: true,
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
            existingUserByEmail: true,
            emailVerified: true,
            flags: { ...defaultFlags, allowLinking: false },
          }),
        ),
      ).toEqual({ allow: false, reason: 'linking_disabled' });
    });
  });

  describe('provisioning (existingUserByEmail: false)', () => {
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
  });
});
