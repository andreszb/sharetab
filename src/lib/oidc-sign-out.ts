import { signOut } from 'next-auth/react';
import type { trpc } from './trpc';

/**
 * Sign-out that also closes the identity provider's own session when
 * RP-initiated logout applies (see `computeOidcLogout` on the server side for
 * the full reasoning). Shared by the sidebar and the mobile menu so the two
 * don't drift.
 */
export async function signOutWithOidc(utils: ReturnType<(typeof trpc)['useUtils']>) {
  const { url, fallbackCallbackUrl } = await utils.auth.getLogoutUrl.fetch();

  if (url) {
    // Clear the local session first — otherwise the browser comes back from
    // the IdP still holding a valid ShareTab cookie.
    await signOut({ redirect: false });
    window.location.href = url;
    return;
  }

  await signOut({ callbackUrl: fallbackCallbackUrl });
}
