/**
 * Fetches the `end_session_endpoint` from an OIDC issuer's discovery
 * document. Logout is a low-frequency, user-initiated action, so this is
 * fetched fresh each time rather than cached — the added staleness risk of a
 * cache isn't worth it for something this infrequent.
 */
export async function fetchOidcEndSessionEndpoint(issuer: string): Promise<string | null> {
  try {
    const res = await fetch(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`);
    if (!res.ok) return null;

    const doc: unknown = await res.json();
    if (typeof doc !== 'object' || doc === null || !('end_session_endpoint' in doc)) return null;

    const endpoint = (doc as { end_session_endpoint: unknown }).end_session_endpoint;
    return typeof endpoint === 'string' ? endpoint : null;
  } catch {
    // Network failure, malformed JSON, etc. — never block sign-out on this.
    return null;
  }
}
