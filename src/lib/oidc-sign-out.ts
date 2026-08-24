import { signOut } from 'next-auth/react';
import { setLocaleCookie } from './locale-cookie';
import type { trpc } from './trpc';

/**
 * Sign-out that also closes the identity provider's own session when
 * RP-initiated logout applies (see `computeOidcLogout` on the server side for
 * the full reasoning). Shared by the sidebar and the mobile menu so the two
 * don't drift.
 *
 * `locale` is the one currently being viewed, remembered in a cookie before
 * any round trip through the IdP: `post_logout_redirect_uri` is deliberately
 * locale-free so a single URL can be registered with the provider, and once
 * the session cookie is gone the middleware has nothing else to go on.
 */
export async function signOutWithOidc(utils: ReturnType<(typeof trpc)['useUtils']>, locale: string) {
  setLocaleCookie(locale);

  let logout: { url: string | null; fallbackCallbackUrl: string };
  try {
    logout = await utils.auth.getLogoutUrl.fetch();
  } catch {
    // `getLogoutUrl` is a protected procedure, so it throws for a user who was
    // suspended while signed in — and suspension does not invalidate the JWT.
    // Without this the sign-out button would simply do nothing, forever, for
    // exactly the users most likely to be pressing it. A plain local sign-out
    // is always better than none.
    await signOut({ callbackUrl: `/${locale}/login` });
    return;
  }

  if (logout.url) {
    // Clear the local session first — otherwise the browser comes back from
    // the IdP still holding a valid ShareTab cookie.
    await signOut({ redirect: false });
    window.location.href = logout.url;
    return;
  }

  await signOut({ callbackUrl: logout.fallbackCallbackUrl });
}
