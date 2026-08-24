export async function register() {
  // Only run on the server (not during build or in edge runtime)
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    try {
      const { getBuildInfo } = await import('@/server/lib/build-info');
      const { version, commitSha } = getBuildInfo();

      const { logger } = await import('@/server/lib/logger');
      logger.info('app.startup', { version, commitSha });

      const { getEnabledProviders, getOidcModes } = await import('@/server/lib/auth-providers');
      const providers = getEnabledProviders();
      if (providers.length > 0) {
        logger.info('app.startup.auth_providers', {
          providers: providers.map((p) => p.id),
          ...(providers.some((p) => p.id === 'oidc') ? { oidcModes: getOidcModes() } : {}),
        });
      }

      const { startPoller } = await import('@/server/lib/auth-health-poller');
      startPoller();
    } catch (error) {
      // Isolate startup failures so the app can still boot (Finding #23).
      // Use console.error as logger may not be available if the import itself failed.
      console.error('app.startup.failed', error instanceof Error ? (error.stack ?? error.message) : String(error));
    }
  }
}
