/**
 * Pure policy for what happens on an OIDC sign-in: whether to link the
 * identity onto an existing account, and whether to allow provisioning a
 * brand new one. Extracted from `auth.ts`'s `signIn` callback for
 * testability, following the `balance-calculator.ts` precedent.
 *
 * Deliberately knows nothing about NextAuth, Prisma, or env vars — the
 * caller resolves those into the primitives below.
 */

export type OidcDenyReason =
  'no_email' | 'linking_disabled' | 'email_not_verified' | 'email_belongs_to_other_user' | 'provisioning_blocked';

export type OidcSignInDecision = { allow: true } | { allow: false; reason: OidcDenyReason };

export type RegistrationMode = 'open' | 'invite-only' | 'closed';

export interface OidcSignInFlags {
  /** OIDC_ALLOW_LINKING, default true. */
  allowLinking: boolean;
  /** OIDC_TRUST_EMAIL, default false — treat a *missing* email_verified claim as verified. */
  trustEmail: boolean;
  /** OIDC_AUTO_PROVISION, default false — bypass registrationMode for new OIDC users. */
  autoProvision: boolean;
}

export interface OidcSignInInput {
  /**
   * Lowercased, since `@auth/core` lowercases the mapped profile email before
   * its own `getUserByEmail` and the caller must match that to agree with
   * what the adapter will actually do.
   */
  email: string | null;
  /** The ID token's `email_verified` claim; null when the provider omits it entirely. */
  emailVerified: boolean | null;
  /** A User+Account row already links this exact OIDC identity — a normal re-login. */
  alreadyLinked: boolean;
  /**
   * The user this browser is already signed in as, if any. Auth.js links a
   * new account straight onto the session user without consulting email at
   * all (`handle-login.js`: `if (user) await linkAccount(...)`), so a policy
   * that only looked at email would be bypassed entirely on this path.
   */
  sessionUserId: string | null;
  /** The User row holding this email, if one exists. */
  existingUserIdByEmail: string | null;
  registrationMode: RegistrationMode;
  flags: OidcSignInFlags;
}

/**
 * `alreadyLinked` short-circuits everything else: the linking and
 * provisioning flags only govern the *first* sign-in for a given OIDC
 * identity, not every subsequent one.
 */
export function evaluateOidcSignIn(input: OidcSignInInput): OidcSignInDecision {
  if (input.alreadyLinked) return { allow: true };

  if (!input.email) return { allow: false, reason: 'no_email' };

  const verified = input.emailVerified === true || (input.emailVerified === null && input.flags.trustEmail);

  // Signed in already: Auth.js will link this identity to the session user
  // whatever the email says, so the only useful questions are whether linking
  // is permitted at all and whether the incoming email is safe to attach.
  if (input.sessionUserId) {
    if (!input.flags.allowLinking) return { allow: false, reason: 'linking_disabled' };
    // The identity's email belongs to somebody else's account. Linking would
    // attach it to whoever happens to be signed in on this browser.
    if (input.existingUserIdByEmail !== null && input.existingUserIdByEmail !== input.sessionUserId) {
      return { allow: false, reason: 'email_belongs_to_other_user' };
    }
    return verified ? { allow: true } : { allow: false, reason: 'email_not_verified' };
  }

  if (input.existingUserIdByEmail !== null) {
    if (!input.flags.allowLinking) return { allow: false, reason: 'linking_disabled' };
    return verified ? { allow: true } : { allow: false, reason: 'email_not_verified' };
  }

  // Provisioning is held to the same verification bar as linking. An IdP that
  // lets anyone self-register an address they do not control would otherwise
  // let an attacker pre-create `victim@example.com`; the victim's later magic
  // link resolves by email onto that same row and hands over the account.
  if (!verified) return { allow: false, reason: 'email_not_verified' };

  if (input.flags.autoProvision || input.registrationMode === 'open') return { allow: true };
  return { allow: false, reason: 'provisioning_blocked' };
}
