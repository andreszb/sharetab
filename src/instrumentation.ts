export async function register() {
  // Only run on the server (not during build or in edge runtime)
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    try {
      const { getBuildInfo } = await import('@/server/lib/build-info');
      const { version, commitSha } = getBuildInfo();

      const { logger } = await import('@/server/lib/logger');
      logger.info('app.startup', { version, commitSha });

      // Logged unconditionally, including the empty case. The whole point of
      // this line is diagnosing "I set the OIDC vars and no button appeared",
      // and the most common cause — a missing OIDC_CLIENT_SECRET on a public
      // client — resolves to no provider at all. Suppressing the line there
      // would make a misconfigured instance look exactly like a deliberately
      // password-only one.
      const { getEnabledProviders, getOidcModes, getOidcPlaceholderWarnings } =
        await import('@/server/lib/auth-providers');
      const providers = getEnabledProviders();
      const oidcConfigured = providers.some((p) => p.id === 'oidc');
      const oidcPlaceholderVars = getOidcPlaceholderWarnings();
      logger.info('app.startup.auth_providers', {
        providers: providers.map((p) => p.id),
        oidcConfigured,
        ...(oidcConfigured ? { oidcModes: getOidcModes() } : {}),
        // Distinguishes "OIDC never configured" from "configured with an
        // unresolved <...> placeholder" — both otherwise log identically.
        ...(oidcPlaceholderVars.length > 0 ? { oidcPlaceholderVars } : {}),
      });

      const { startPoller } = await import('@/server/lib/auth-health-poller');
      startPoller();
    } catch (error) {
      // Isolate startup failures so the app can still boot (Finding #23).
      // Use console.error as logger may not be available if the import itself failed.
      console.error('app.startup.failed', error instanceof Error ? (error.stack ?? error.message) : String(error));
    }
  }
}
