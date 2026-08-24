/**
 * Claim -> ShareTab user mapping for the generic OIDC provider.
 *
 * Applied by NextAuth's `profile()` callback, which runs on every sign-in but
 * whose result only reaches the database on the *first* one (the adapter's
 * `createUser`). That is deliberate: ShareTab has its own profile editor, and
 * an identity provider that silently reverts a display name on every login is
 * indistinguishable from a bug.
 */

import { locales, type Locale } from '@/i18n/routing';

/** The subset of standard OIDC claims this mapping reads. */
export interface OidcClaims {
  sub: string;
  name?: unknown;
  given_name?: unknown;
  family_name?: unknown;
  preferred_username?: unknown;
  email?: unknown;
  picture?: unknown;
  locale?: unknown;
}

export interface MappedOidcProfile {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
  locale?: Locale;
}

function str(claim: unknown): string | null {
  if (typeof claim !== 'string') return null;
  const trimmed = claim.trim();
  return trimmed ? trimmed : null;
}

/**
 * Subtags that rule out a base-language fallback for a given base, because
 * they name a script ShareTab's locale for that language is not written in.
 * `tw`/`hk`/`mo` are region subtags rather than script subtags, but they imply
 * Traditional Chinese in every deployment that sends them.
 */
const SCRIPT_MISMATCH: Record<string, string[]> = {
  zh: ['hant', 'tw', 'hk', 'mo'],
};

/**
 * Best-effort map of an OIDC `locale` claim onto a locale ShareTab actually
 * ships. Providers send BCP-47 tags that mostly do not match our list
 * verbatim: `en-US` and `en_US` both mean `en`, `pt` means `pt-BR` here
 * because that is the only Portuguese we have, and `zh-Hans` means `zh-CN`.
 * Anything with no plausible match returns null so the User default (`en`)
 * stands rather than a guess being written to the row.
 */
export function normalizeOidcLocale(claim: unknown): Locale | null {
  const raw = str(claim);
  if (!raw) return null;

  // Providers vary between BCP-47 (`pt-BR`) and POSIX (`pt_BR`) separators.
  const tag = raw.replace(/_/g, '-').toLowerCase();

  const exact = locales.find((locale) => locale.toLowerCase() === tag);
  if (exact) return exact;

  const subtags = tag.split('-');
  const base = subtags[0];
  if (!base) return null;

  // Crossing a *region* on the way to a base-language match is fine — `pt-PT`
  // reading `pt-BR` is imperfect but legible. Crossing a *script* is not:
  // `zh-TW`/`zh-Hant` would land on `zh-CN` and write Simplified Chinese into
  // `User.locale` for a Traditional-Chinese reader. That is the "guess" this
  // function exists to avoid, so those return null and leave the default.
  if (SCRIPT_MISMATCH[base]?.some((subtag) => subtags.includes(subtag))) return null;

  return locales.find((locale) => locale.toLowerCase().split('-')[0] === base) ?? null;
}

/**
 * `name` falls back through the claims most providers actually populate:
 * Pocket ID always sends `name`, but a bare Keycloak realm may only have
 * `given_name`/`family_name`, and some deployments only have a username.
 */
function pickName(profile: OidcClaims): string | null {
  const full = str(profile.name);
  if (full) return full;

  const parts = [str(profile.given_name), str(profile.family_name)].filter((part): part is string => part !== null);
  if (parts.length > 0) return parts.join(' ');

  return str(profile.preferred_username);
}

export function mapOidcProfile(profile: OidcClaims): MappedOidcProfile {
  const locale = normalizeOidcLocale(profile.locale);

  return {
    id: profile.sub,
    name: pickName(profile),
    // A provider that omits `email` cannot be mapped onto a ShareTab user at
    // all (User.email is required and unique). Sign-in policy rejects that
    // case; mapping it to null here keeps this function total.
    email: str(profile.email),
    image: str(profile.picture),
    ...(locale ? { locale } : {}),
  };
}
