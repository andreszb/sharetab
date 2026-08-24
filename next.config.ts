import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig: NextConfig = {
  ...(process.env.DOCKER_BUILD === '1' ? { output: 'standalone' as const } : {}),
  serverExternalPackages: ['@rynfar/meridian', '@anthropic-ai/claude-agent-sdk'],
  turbopack: {
    // Turbopack infers the workspace root by walking up looking for
    // next/package.json. Under Nix the dependency tree is a symlink into the
    // store, so inference lands outside the project and the build aborts with
    // "couldn't find the Next.js package". `next build` always runs from the
    // project root, so pin it rather than letting it be inferred.
    root: process.cwd(),
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-DNS-Prefetch-Control', value: 'on' },
          { key: 'Permissions-Policy', value: 'camera=(self), microphone=()' },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
