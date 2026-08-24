'use client';

import { signIn } from 'next-auth/react';
import { useTranslations } from 'next-intl';
import { ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { trpc } from '@/lib/trpc';
import type { ThirdPartyProvider } from '@/server/lib/auth-providers';

/**
 * Google's brand mark. Lucide ships no brand icons, and the alternative —
 * pulling in a whole icon pack for one glyph — is not worth the bytes.
 */
function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.06 12.25c0-.85-.08-1.67-.22-2.45H12v4.63h6.2a5.3 5.3 0 0 1-2.3 3.48v2.89h3.72c2.18-2 3.44-4.96 3.44-8.55Z"
      />
      <path
        fill="#34A853"
        d="M12 23.5c3.11 0 5.72-1.03 7.62-2.8l-3.72-2.89c-1.03.69-2.35 1.1-3.9 1.1-3 0-5.54-2.03-6.45-4.75H1.71v2.98A11.5 11.5 0 0 0 12 23.5Z"
      />
      <path fill="#FBBC05" d="M5.55 14.16a6.9 6.9 0 0 1 0-4.32V6.86H1.71a11.5 11.5 0 0 0 0 10.28l3.84-2.98Z" />
      <path
        fill="#EA4335"
        d="M12 4.77c1.69 0 3.21.58 4.4 1.72l3.3-3.3C17.72 1.31 15.11.25 12 .25A11.5 11.5 0 0 0 1.71 6.86l3.84 2.98C6.46 7.12 9 4.77 12 4.77Z"
      />
    </svg>
  );
}

const BUTTON_CLASS =
  'w-full rounded-full h-10 text-sm border-primary/20 text-muted-foreground hover:text-foreground hover:border-primary/40';

/**
 * One sign-in button per configured third-party provider, or nothing at all
 * when the instance has none. The list comes from the server rather than from
 * env vars read in the browser, so a button can never point at a provider
 * NextAuth did not register.
 */
export function ProviderButtons({ callbackUrl }: { callbackUrl: string }) {
  const t = useTranslations('auth.login');
  const { data } = trpc.auth.getEnabledProviders.useQuery(undefined, {
    // Provider configuration only changes on restart, so re-fetching it on
    // every window focus is pure noise on a page the user sits on.
    staleTime: Infinity,
  });

  const providers: ThirdPartyProvider[] = data?.providers ?? [];
  if (providers.length === 0) return null;

  return (
    <>
      {providers.map((provider) => (
        <Button
          key={provider.id}
          type="button"
          variant="outline"
          className={BUTTON_CLASS}
          onClick={() => void signIn(provider.id, { callbackUrl })}
        >
          {provider.id === 'google' ? (
            <GoogleIcon className="mr-2 h-4 w-4" />
          ) : (
            <ShieldCheck className="mr-2 h-4 w-4" />
          )}
          {provider.name ? t('ssoButton', { provider: provider.name }) : t('ssoButtonGeneric')}
        </Button>
      ))}
    </>
  );
}
