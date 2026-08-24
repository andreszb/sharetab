/**
 * next-intl resolves the locale for an unprefixed path from the `NEXT_LOCALE`
 * cookie. Writing it from the client is how the language switcher makes a
 * choice stick, and how sign-out carries the current locale across a round
 * trip through the identity provider — once the session cookie is gone,
 * `User.locale` is no longer reachable to the middleware.
 */
export function setLocaleCookie(locale: string) {
  const secure = window.location.protocol === 'https:' ? ';secure' : '';
  document.cookie = `NEXT_LOCALE=${encodeURIComponent(locale)};path=/;max-age=31536000;samesite=lax${secure}`;
}
