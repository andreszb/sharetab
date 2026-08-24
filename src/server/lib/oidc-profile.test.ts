import { describe, test, expect } from 'vitest';
import { mapOidcProfile, normalizeOidcLocale } from './oidc-profile';

describe('normalizeOidcLocale', () => {
  test('accepts a locale ShareTab ships verbatim', () => {
    expect(normalizeOidcLocale('en')).toBe('en');
    expect(normalizeOidcLocale('pt-BR')).toBe('pt-BR');
  });

  test('is case-insensitive and accepts POSIX separators', () => {
    expect(normalizeOidcLocale('PT-br')).toBe('pt-BR');
    expect(normalizeOidcLocale('pt_BR')).toBe('pt-BR');
    expect(normalizeOidcLocale('ZH_cn')).toBe('zh-CN');
  });

  test('falls back to the base language when the region differs', () => {
    expect(normalizeOidcLocale('en-US')).toBe('en');
    expect(normalizeOidcLocale('de-AT')).toBe('de');
    expect(normalizeOidcLocale('ko-KR')).toBe('ko');
  });

  test('maps a bare base language onto the only regional variant we ship', () => {
    expect(normalizeOidcLocale('pt')).toBe('pt-BR');
    expect(normalizeOidcLocale('zh')).toBe('zh-CN');
    expect(normalizeOidcLocale('zh-Hans')).toBe('zh-CN');
  });

  test('refuses to cross a script boundary to reach a base-language match', () => {
    // `zh-CN` is Simplified; writing it into `User.locale` for a Traditional
    // reader is a worse outcome than leaving the `en` default in place.
    expect(normalizeOidcLocale('zh-TW')).toBeNull();
    expect(normalizeOidcLocale('zh-Hant')).toBeNull();
    expect(normalizeOidcLocale('zh-Hant-HK')).toBeNull();
    expect(normalizeOidcLocale('zh_TW')).toBeNull();
    // Region-only differences still fall back, since the script agrees.
    expect(normalizeOidcLocale('pt-PT')).toBe('pt-BR');
  });

  test('returns null rather than guessing for anything unshipped or malformed', () => {
    expect(normalizeOidcLocale('nl')).toBeNull();
    expect(normalizeOidcLocale('')).toBeNull();
    expect(normalizeOidcLocale('   ')).toBeNull();
    expect(normalizeOidcLocale(undefined)).toBeNull();
    expect(normalizeOidcLocale(42)).toBeNull();
  });
});

describe('mapOidcProfile', () => {
  test('maps the claims Pocket ID sends', () => {
    expect(
      mapOidcProfile({
        sub: 'abc123',
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        picture: 'https://auth.example.com/avatar.png',
        locale: 'en-GB',
      }),
    ).toEqual({
      id: 'abc123',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      image: 'https://auth.example.com/avatar.png',
      locale: 'en',
    });
  });

  test('omits locale entirely when the claim is missing or unshipped', () => {
    expect(mapOidcProfile({ sub: 'abc123', email: 'ada@example.com' })).not.toHaveProperty('locale');
    expect(mapOidcProfile({ sub: 'abc123', email: 'ada@example.com', locale: 'nl-NL' })).not.toHaveProperty('locale');
  });

  test('builds a name from given_name/family_name when name is absent', () => {
    expect(mapOidcProfile({ sub: 'x', given_name: 'Ada', family_name: 'Lovelace' }).name).toBe('Ada Lovelace');
    expect(mapOidcProfile({ sub: 'x', given_name: 'Ada' }).name).toBe('Ada');
  });

  test('falls back to preferred_username as a last resort', () => {
    expect(mapOidcProfile({ sub: 'x', preferred_username: 'ada' }).name).toBe('ada');
  });

  test('null rather than empty strings when a provider sends blanks', () => {
    const mapped = mapOidcProfile({ sub: 'x', name: '   ', email: '', picture: '' });
    expect(mapped.name).toBeNull();
    expect(mapped.email).toBeNull();
    expect(mapped.image).toBeNull();
  });

  test('a provider that omits email maps to a null email rather than throwing', () => {
    expect(mapOidcProfile({ sub: 'x' }).email).toBeNull();
  });
});
