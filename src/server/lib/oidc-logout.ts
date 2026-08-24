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
  /**
   * Absolute origin (e.g. `https://sharetab.example.com`) to build
   * `post_logout_redirect_uri` against, or null when `NEXTAUTH_URL` is unset.
   * It must match what's registered with the IdP, so it can never be a
   * relative path — see below for what happens when it's missing.
   */
  baseUrl: string | null;
  /** The signing-out user's locale, so the local landing page is in their language. */
  locale: string;
  flags: OidcLogoutFlags;
}

export interface OidcLogoutResult {
  /** The IdP's RP-initiated logout URL, or null when a plain local sign-out is all that applies. */
  url: string | null;
  /**
   * Always set, relative and locale-prefixed — where local NextAuth
   * `signOut()` should send the browser, whether or not `url` is used. When
   * auto-redirect is on the path is `/login?password=1` rather than `/login`:
   * landing back on plain `/login` after signing out would immediately
   * auto-redirect into the IdP again, and if its session is still open (RP
   * logout skipped, disabled, or failed) that's a loop with no way to reach
   * the credentials form.
   */
  fallbackCallbackUrl: string;
}

export function computeOidcLogout(input: OidcLogoutInput): OidcLogoutResult {
  const path = input.flags.autoRedirect ? '/login?password=1' : '/login';
  const fallbackCallbackUrl = `/${input.locale}${path}`;

  if (!input.flags.rpLogoutEnabled || !input.hasOidcAccount || !input.idToken || !input.endSessionEndpoint) {
    return { url: null, fallbackCallbackUrl };
  }

  const params = new URLSearchParams({
    id_token_hint: input.idToken,
    client_id: input.clientId,
  });

  // Deliberately locale-free, and omitted entirely without an absolute base.
  // IdPs match this against a pre-registered list literally, so one URL to
  // register beats one per locale — the middleware re-derives the locale from
  // the `NEXT_LOCALE` cookie on the way back in. And a *relative* value is
  // invalid per RP-Initiated Logout: sending one gets the whole request
  // rejected, which is worse than omitting the parameter and letting the IdP
  // show its own signed-out page.
  if (input.baseUrl) {
    params.set('post_logout_redirect_uri', `${input.baseUrl}${path}`);
  }

  return { url: `${input.endSessionEndpoint}?${params}`, fallbackCallbackUrl };
}
