import { describe, test, expect, vi, afterEach } from 'vitest';
import { fetchOidcEndSessionEndpoint } from './oidc-discovery';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchOidcEndSessionEndpoint', () => {
  test('returns the endpoint from a well-formed discovery document', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ end_session_endpoint: 'https://auth.example.com/api/oidc/end-session' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const endpoint = await fetchOidcEndSessionEndpoint('https://auth.example.com');
    expect(endpoint).toBe('https://auth.example.com/api/oidc/end-session');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://auth.example.com/.well-known/openid-configuration',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  test('strips a trailing slash off the issuer before appending the well-known path', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ end_session_endpoint: 'https://auth.example.com/end-session' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await fetchOidcEndSessionEndpoint('https://auth.example.com/');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://auth.example.com/.well-known/openid-configuration',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  test('returns null when the provider omits end_session_endpoint', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });
    vi.stubGlobal('fetch', mockFetch);

    expect(await fetchOidcEndSessionEndpoint('https://auth.example.com')).toBeNull();
  });

  test('returns null on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, json: () => Promise.resolve({}) }));
    expect(await fetchOidcEndSessionEndpoint('https://auth.example.com')).toBeNull();
  });

  test('returns null rather than throwing on a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('ECONNREFUSED')));
    expect(await fetchOidcEndSessionEndpoint('https://auth.example.com')).toBeNull();
  });

  test('returns null rather than throwing on malformed JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce({ ok: true, json: () => Promise.reject(new Error('bad json')) }),
    );
    expect(await fetchOidcEndSessionEndpoint('https://auth.example.com')).toBeNull();
  });

  test('passes an abort signal so a stalled issuer cannot hang sign-out', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ end_session_endpoint: 'https://auth.example.com/end-session' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await fetchOidcEndSessionEndpoint('https://auth.example.com');

    const signal = (mockFetch.mock.calls[0]?.[1] as { signal?: AbortSignal } | undefined)?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  test('returns null rather than throwing when the request times out', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValueOnce(new DOMException('The operation was aborted', 'TimeoutError')),
    );
    expect(await fetchOidcEndSessionEndpoint('https://auth.example.com')).toBeNull();
  });
});
