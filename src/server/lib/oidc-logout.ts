/**
 * Pure policy for what URL signing out should send the browser to. Extracted
 * from the `auth.getLogoutUrl` tRPC procedure for testability, following the
 * `evaluateOidcSignIn` precedent — this function knows nothing about
 * Prisma, fetch, or env vars, only the primitives the caller resolves them
 * into.
 *
 * With RP-initiated logout, signing out locally is not enough: dropping
 * ShareTab's own cookie leaves the identity provider's session intact, so the
 * very next sign-in attempt bounces straight back in without ever showing a
 * login screen. Sending the browser through the IdP's `end_session_endpoint`
 * first closes that session too.
 */

export interface OidcLogoutFlags {
  /** OIDC_RP_LOGOUT, default true. */
  rpLogoutEnabled: boolean;
  /** OIDC_AUTO_REDIRECT — changes the post-logout destination, not just the login page's own behavior. */
  autoRedirect: boolean;
}

export interface OidcLogoutInput {
  /** The signing-out user has a linked OIDC identity to log out of. */
  hasOidcAccount: boolean;
  /** That identity's stored `Account.id_token`, if any. */
  idToken: string | null;
  /** The issuer's advertised `end_session_endpoint`, if discovery succeeded and it exists. */
  endSessionEndpoint: string | null;
  clientId: string;
  /** Absolute origin (e.g. `https://sharetab.example.com`) to build `post_logout_redirect_uri` against — it must match what's registered with the IdP, so it can't be a relative path. */
  baseUrl: string;
  flags: OidcLogoutFlags;
}

export interface OidcLogoutResult {
  /** The IdP's RP-initiated logout URL, or null when a plain local sign-out is all that applies. */
  url: string | null;
  /**
   * Always set, relative — where local NextAuth `signOut()` should send the
   * browser, whether or not `url` is used. When auto-redirect is on this is
   * `/login?password=1` rather than `/login`: landing back on plain `/login`
   * after signing out would immediately auto-redirect into the IdP again,
   * and if its session is still open (RP logout skipped, disabled, or
   * failed) that's a loop with no way to reach the credentials form.
   */
  fallbackCallbackUrl: string;
}

export function computeOidcLogout(input: OidcLogoutInput): OidcLogoutResult {
  const fallbackCallbackUrl = input.flags.autoRedirect ? '/login?password=1' : '/login';

  if (!input.flags.rpLogoutEnabled || !input.hasOidcAccount || !input.idToken || !input.endSessionEndpoint) {
    return { url: null, fallbackCallbackUrl };
  }

  const params = new URLSearchParams({
    id_token_hint: input.idToken,
    post_logout_redirect_uri: `${input.baseUrl}${fallbackCallbackUrl}`,
    client_id: input.clientId,
  });

  return { url: `${input.endSessionEndpoint}?${params}`, fallbackCallbackUrl };
}
