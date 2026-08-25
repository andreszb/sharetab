/**
 * Fetches and parses an issuer's `.well-known/openid-configuration`. Returns
 * `null` on any failure — network error, timeout, non-200, malformed JSON —
 * so callers never need their own try/catch.
 */
async function fetchDiscoveryDocument(issuer: string): Promise<Record<string, unknown> | null> {
  try {
    // Node's fetch has no default timeout, so an issuer that accepts the
    // connection and then stalls would hang the caller indefinitely — the
    // `catch` below only covers rejections, never a socket that never
    // answers. Three seconds is generous for a discovery document.
    const res = await fetch(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;

    const doc: unknown = await res.json();
    return typeof doc === 'object' && doc !== null ? (doc as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Fetches the `end_session_endpoint` from an OIDC issuer's discovery
 * document. Logout is a low-frequency, user-initiated action, so this is
 * fetched fresh each time rather than cached — the added staleness risk of a
 * cache isn't worth it for something this infrequent.
 */
export async function fetchOidcEndSessionEndpoint(issuer: string): Promise<string | null> {
  const doc = await fetchDiscoveryDocument(issuer);
  if (!doc || !('end_session_endpoint' in doc)) return null;
  const endpoint = doc.end_session_endpoint;
  return typeof endpoint === 'string' ? endpoint : null;
}

/**
 * Whether the configured issuer's discovery document is reachable at all —
 * the check behind the System Health OIDC card, so a self-hoster with a
 * typo'd `OIDC_ISSUER` sees that instead of a silently-inert "configured: true".
 */
export async function isOidcDiscoveryReachable(issuer: string): Promise<boolean> {
  return (await fetchDiscoveryDocument(issuer)) !== null;
}
