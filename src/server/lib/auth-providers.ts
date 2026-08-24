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

export function getEnabledProviders(env: Env = process.env): ThirdPartyProvider[] {
  const providers: ThirdPartyProvider[] = [];
  if (getGoogleConfig(env)) providers.push({ id: 'google', name: 'Google' });
  const oidc = getOidcConfig(env);
  if (oidc) providers.push({ id: 'oidc', name: oidc.name });
  return providers;
}
