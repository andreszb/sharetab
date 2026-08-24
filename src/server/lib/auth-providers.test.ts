import { describe, test, expect } from 'vitest';
import { buildOidcProvider, getEnabledProviders, getGoogleConfig, getOidcConfig } from './auth-providers';

const oidcEnv = {
  OIDC_ISSUER: 'https://auth.example.com',
  OIDC_CLIENT_ID: 'client',
  OIDC_CLIENT_SECRET: 'secret',
};

const googleEnv = {
  GOOGLE_CLIENT_ID: 'g-client',
  GOOGLE_CLIENT_SECRET: 'g-secret',
};

describe('getGoogleConfig', () => {
  test('returns null when nothing is set', () => {
    expect(getGoogleConfig({})).toBeNull();
  });

  test('returns null when only one half of the pair is set', () => {
    expect(getGoogleConfig({ GOOGLE_CLIENT_ID: 'g-client' })).toBeNull();
    expect(getGoogleConfig({ GOOGLE_CLIENT_SECRET: 'g-secret' })).toBeNull();
  });

  test('returns the credentials when both are set', () => {
    expect(getGoogleConfig(googleEnv)).toEqual({ clientId: 'g-client', clientSecret: 'g-secret' });
  });
});

describe('getOidcConfig', () => {
  test('returns null unless issuer, id and secret are all present', () => {
    expect(getOidcConfig({})).toBeNull();
    expect(getOidcConfig({ OIDC_ISSUER: 'https://auth.example.com' })).toBeNull();
    expect(getOidcConfig({ ...oidcEnv, OIDC_CLIENT_SECRET: undefined })).toBeNull();
  });

  test('treats empty and whitespace-only values as unset', () => {
    expect(getOidcConfig({ ...oidcEnv, OIDC_ISSUER: '' })).toBeNull();
    expect(getOidcConfig({ ...oidcEnv, OIDC_CLIENT_SECRET: '   ' })).toBeNull();
  });

  test('trims surrounding whitespace off values that are set', () => {
    expect(getOidcConfig({ ...oidcEnv, OIDC_ISSUER: '  https://auth.example.com  ' })?.issuer).toBe(
      'https://auth.example.com',
    );
  });

  test('name is null when OIDC_NAME is unset', () => {
    expect(getOidcConfig(oidcEnv)?.name).toBeNull();
  });

  test('name is carried through when OIDC_NAME is set', () => {
    expect(getOidcConfig({ ...oidcEnv, OIDC_NAME: 'Pocket ID' })?.name).toBe('Pocket ID');
  });
});

describe('getEnabledProviders', () => {
  test('is empty when nothing is configured', () => {
    expect(getEnabledProviders({})).toEqual([]);
  });

  test('lists only what is configured', () => {
    expect(getEnabledProviders(googleEnv)).toEqual([{ id: 'google', name: 'Google' }]);
    expect(getEnabledProviders(oidcEnv)).toEqual([{ id: 'oidc', name: null }]);
  });

  test('lists both, google first, when both are configured', () => {
    expect(getEnabledProviders({ ...googleEnv, ...oidcEnv, OIDC_NAME: 'Pocket ID' })).toEqual([
      { id: 'google', name: 'Google' },
      { id: 'oidc', name: 'Pocket ID' },
    ]);
  });

  test('a half-configured provider gets no button', () => {
    expect(getEnabledProviders({ OIDC_ISSUER: 'https://auth.example.com', OIDC_CLIENT_ID: 'client' })).toEqual([]);
  });
});

describe('buildOidcProvider', () => {
  const config = { issuer: 'https://auth.example.com', clientId: 'c', clientSecret: 's', name: null };

  // Regression: Auth.js defaults `checks` to ['pkce'] alone, and Ory Fosite
  // based providers (Pocket ID) reject an authorize request with no `state`
  // before ever showing their login screen.
  test('requests the state check, not just pkce', () => {
    expect(buildOidcProvider(config).checks).toEqual(['pkce', 'state']);
  });

  test('asks for the email scope, which ShareTab cannot create a user without', () => {
    const authorization = buildOidcProvider(config).authorization;
    expect(typeof authorization === 'object' && authorization?.params?.scope).toBe('openid profile email');
  });

  test('falls back to a generic button name when OIDC_NAME is unset', () => {
    expect(buildOidcProvider(config).name).toBe('SSO');
    expect(buildOidcProvider({ ...config, name: 'Pocket ID' }).name).toBe('Pocket ID');
  });

  test('registers under the id the callback URL is documented as', () => {
    expect(buildOidcProvider(config).id).toBe('oidc');
  });
});
