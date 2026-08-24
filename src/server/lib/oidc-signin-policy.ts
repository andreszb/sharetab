/**
 * Pure policy for what happens on an OIDC sign-in: whether to link the
 * identity onto an existing account, and whether to allow provisioning a
 * brand new one. Extracted from `auth.ts`'s `signIn` callback for
 * testability, following the `balance-calculator.ts` precedent.
 *
 * Deliberately knows nothing about NextAuth, Prisma, or env vars — the
 * caller resolves those into the primitives below.
 */

export type OidcDenyReason = 'no_email' | 'linking_disabled' | 'email_not_verified' | 'provisioning_blocked';

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
  email: string | null;
  /** The ID token's `email_verified` claim; null when the provider omits it entirely. */
  emailVerified: boolean | null;
  /** A User+Account row already links this exact OIDC identity — a normal re-login. */
  alreadyLinked: boolean;
  /** A User row with this email exists, but is not the one `alreadyLinked` refers to. */
  existingUserByEmail: boolean;
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

  if (input.existingUserByEmail) {
    if (!input.flags.allowLinking) return { allow: false, reason: 'linking_disabled' };

    const verified = input.emailVerified === true || (input.emailVerified === null && input.flags.trustEmail);
    return verified ? { allow: true } : { allow: false, reason: 'email_not_verified' };
  }

  if (input.flags.autoProvision || input.registrationMode === 'open') return { allow: true };
  return { allow: false, reason: 'provisioning_blocked' };
}
