/**
 * Which third-party sign-in providers this instance has configured.
 *
 * Single source of truth for two things that must never disagree: the
 * providers registered with NextAuth in `src/server/auth.ts`, and the buttons
 * the login page renders (via the `auth.getEnabledProviders` tRPC query). A
 * button for an unregistered provider dead-ends on NextAuth's error page.
 *
 * Env is passed in rather than read directly so the rules are testable without
 * mutating `process.env`.
 */

import type { OIDCConfig } from 'next-auth/providers';
import { mapOidcProfile, type OidcClaims } from './oidc-profile';
import type { OidcSignInFlags } from './oidc-signin-policy';

export type ThirdPartyProviderId = 'google' | 'oidc';

export interface ThirdPartyProvider {
  id: ThirdPartyProviderId;
  /**
   * Admin-supplied display name for the sign-in button. `null` for OIDC when
   * `OIDC_NAME` is unset, which the UI renders as a generic "sign in with SSO"
   * label rather than inventing a name for someone else's identity provider.
   */
  name: string | null;
}

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
}

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  name: string | null;
}

type Env = Record<string, string | undefined>;

/**
 * Treat whitespace-only and empty values as unset: `OIDC_ISSUER=` in a compose
 * file or an EnvironmentFile arrives as `''`, not `undefined`.
 */
function read(env: Env, key: string): string | undefined {
  const trimmed = env[key]?.trim();
  return trimmed ? trimmed : undefined;
}

export function getGoogleConfig(env: Env = process.env): GoogleConfig | null {
  const clientId = read(env, 'GOOGLE_CLIENT_ID');
  const clientSecret = read(env, 'GOOGLE_CLIENT_SECRET');
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function getOidcConfig(env: Env = process.env): OidcConfig | null {
  const issuer = read(env, 'OIDC_ISSUER');
  const clientId = read(env, 'OIDC_CLIENT_ID');
  const clientSecret = read(env, 'OIDC_CLIENT_SECRET');
  if (!issuer || !clientId || !clientSecret) return null;
  return { issuer, clientId, clientSecret, name: read(env, 'OIDC_NAME') ?? null };
}

/**
 * The three flags `evaluateOidcSignIn` consults. Read through `read()` like
 * every other `OIDC_*` var rather than off `process.env` directly: Unraid's
 * container-variable fields do not trim, and a trailing space on
 * `OIDC_ALLOW_LINKING=false ` would otherwise leave linking *enabled* — a
 * security toggle that fails open.
 */
export function getOidcPolicyFlags(env: Env = process.env): OidcSignInFlags {
  return {
    allowLinking: read(env, 'OIDC_ALLOW_LINKING') !== 'false',
    trustEmail: read(env, 'OIDC_TRUST_EMAIL') === 'true',
    autoProvision: read(env, 'OIDC_AUTO_PROVISION') === 'true',
  };
}

export function getEnabledProviders(env: Env = process.env): ThirdPartyProvider[] {
  const providers: ThirdPartyProvider[] = [];
  if (getGoogleConfig(env)) providers.push({ id: 'google', name: 'Google' });
  const oidc = getOidcConfig(env);
  if (oidc) providers.push({ id: 'oidc', name: oidc.name });
  return providers;
}

/**
 * The NextAuth provider built from an `OidcConfig`. Everything vendor-specific
 * is resolved at runtime from the issuer's discovery document, so one provider
 * covers Pocket ID, Authentik, Keycloak, Authelia and Zitadel.
 */
export function buildOidcProvider(config: OidcConfig): OIDCConfig<OidcClaims> {
  return {
    id: 'oidc',
    name: config.name ?? 'SSO',
    type: 'oidc',
    issuer: config.issuer,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    // `email` is not in the default scope set, and ShareTab cannot create a
    // user without it.
    authorization: { params: { scope: 'openid profile email' } },
    // Auth.js defaults to `['pkce']` alone. Providers built on Ory Fosite —
    // Pocket ID among them — reject an authorize request carrying no `state`
    // outright (`invalid_state`, "must be at least 8 characters"), so sign-in
    // never reaches the identity provider's login screen at all. State is CSRF
    // protection worth sending to every provider regardless. `nonce` binds the
    // ID token to this session and is core OIDC — every conformant provider
    // supports it.
    checks: ['pkce', 'state', 'nonce'],
    profile: mapOidcProfile,
    // Safe only because the `signIn` callback in `auth.ts` vetoes the link
    // itself via `evaluateOidcSignIn` — it never fires on Auth.js's own
    // (weaker) email-match check. See the comment there.
    allowDangerousEmailAccountLinking: true,
  };
}
