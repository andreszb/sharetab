import { describe, test, expect } from 'vitest';
import { computeOidcLogout, type OidcLogoutFlags, type OidcLogoutInput } from './oidc-logout';

const defaultFlags: OidcLogoutFlags = {
  rpLogoutEnabled: true,
  autoRedirect: false,
};

function input(overrides: Partial<OidcLogoutInput> = {}): OidcLogoutInput {
  return {
    hasOidcAccount: true,
    idToken: 'id-token-abc',
    endSessionEndpoint: 'https://auth.example.com/api/oidc/end-session',
    clientId: 'sharetab',
    baseUrl: 'https://sharetab.example.com',
    flags: defaultFlags,
    ...overrides,
  };
}

describe('computeOidcLogout', () => {
  test('builds the RP-initiated logout URL when everything is available', () => {
    const result = computeOidcLogout(input());
    expect(result.url).not.toBeNull();
    const url = new URL(result.url!);
    expect(url.origin + url.pathname).toBe('https://auth.example.com/api/oidc/end-session');
    expect(url.searchParams.get('id_token_hint')).toBe('id-token-abc');
    expect(url.searchParams.get('client_id')).toBe('sharetab');
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe('https://sharetab.example.com/login');
  });

  test('post_logout_redirect_uri carries the password=1 break-glass when auto-redirect is on', () => {
    const result = computeOidcLogout(input({ flags: { ...defaultFlags, autoRedirect: true } }));
    const url = new URL(result.url!);
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe('https://sharetab.example.com/login?password=1');
    expect(result.fallbackCallbackUrl).toBe('/login?password=1');
  });

  test('fallbackCallbackUrl is plain /login when auto-redirect is off', () => {
    expect(computeOidcLogout(input()).fallbackCallbackUrl).toBe('/login');
  });

  test('falls back to local-only sign-out when OIDC_RP_LOGOUT is off', () => {
    const result = computeOidcLogout(input({ flags: { ...defaultFlags, rpLogoutEnabled: false } }));
    expect(result).toEqual({ url: null, fallbackCallbackUrl: '/login' });
  });

  test('falls back to local-only sign-out when the user has no OIDC account', () => {
    const result = computeOidcLogout(input({ hasOidcAccount: false, idToken: null }));
    expect(result.url).toBeNull();
  });

  test('falls back to local-only sign-out when the account has no stored id_token', () => {
    const result = computeOidcLogout(input({ idToken: null }));
    expect(result.url).toBeNull();
  });

  test('falls back to local-only sign-out when the issuer advertises no end_session_endpoint', () => {
    const result = computeOidcLogout(input({ endSessionEndpoint: null }));
    expect(result.url).toBeNull();
  });

  test('the fallback still respects auto-redirect even when falling back', () => {
    const result = computeOidcLogout(
      input({ endSessionEndpoint: null, flags: { ...defaultFlags, autoRedirect: true } }),
    );
    expect(result).toEqual({ url: null, fallbackCallbackUrl: '/login?password=1' });
  });
});
