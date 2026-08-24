'use client';

import { Suspense, useEffect, useState } from 'react';
import { signIn } from 'next-auth/react';
import { useLocale, useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { Link, useRouter } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Receipt, Mail } from 'lucide-react';
import { normalizeCallbackPath, stripLocalePrefix } from '@/lib/locale-paths';
import { ProviderButtons } from '@/components/auth/provider-buttons';
import { trpc } from '@/lib/trpc';

// The codes `pages.error: '/login'` (auth.ts) can send back over `?error=`.
// Auth.js sends others (e.g. `Verification`) that don't apply to this login
// form's flows; `errors.default` covers those and anything unrecognized
// rather than surfacing a raw code.
const OIDC_ERROR_CODES = new Set(['OAuthAccountNotLinked', 'AccessDenied', 'OAuthCallbackError', 'Configuration']);

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const t = useTranslations('auth.login');
  const locale = useLocale() as Locale;
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // Seeded once from `?error=` on the redirect Auth.js sends back after a
  // denied or failed OIDC sign-in — a lazy initializer since this is a full
  // page load, not a client-side query change to react to.
  const [error, setError] = useState(() => {
    const code = searchParams.get('error');
    if (!code) return '';
    return t(OIDC_ERROR_CODES.has(code) ? `errors.${code}` : 'errors.default');
  });
  const [loading, setLoading] = useState(false);
  const [magicLinkEmail, setMagicLinkEmail] = useState('');
  const [magicLinkSending, setMagicLinkSending] = useState(false);
  const [showMagicLink, setShowMagicLink] = useState(false);
  const callbackPath = normalizeCallbackPath(searchParams.get('callbackUrl'), locale);
  const callbackHref = stripLocalePrefix(callbackPath);
  const registerHref = `/register?callbackUrl=${encodeURIComponent(callbackPath)}`;

  // `?password=1` is a permanent break-glass: it makes this page behave as if
  // OIDC_ONLY were off, regardless of the actual flag, so a misconfigured IdP
  // can never lock the owner out of their own login form.
  const breakGlass = searchParams.get('password') === '1';
  const errorParam = searchParams.get('error');
  const { data: providerData } = trpc.auth.getEnabledProviders.useQuery();
  const oidcOnly = (providerData?.oidcOnly ?? false) && !breakGlass;
  // Never auto-redirect when we just bounced back with an error, or the
  // failure (or a denied linking/provisioning decision) would loop forever
  // between here and the IdP.
  const autoRedirect = (providerData?.oidcAutoRedirect ?? false) && !breakGlass && !errorParam;

  useEffect(() => {
    if (autoRedirect) void signIn('oidc', { callbackUrl: callbackPath });
  }, [autoRedirect, callbackPath]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    const result = await signIn('credentials', {
      email,
      password,
      redirect: false,
      callbackUrl: callbackPath,
    });

    setLoading(false);

    if (result?.error) {
      setError(t('error'));
    } else {
      router.push(callbackHref);
      router.refresh();
    }
  }

  async function handleMagicLink(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setMagicLinkSending(true);

    const result = await signIn('nodemailer', {
      email: magicLinkEmail,
      redirect: false,
      callbackUrl: callbackPath,
    });

    setMagicLinkSending(false);

    if (result?.error) {
      setError(t('magicLinkError'));
    } else {
      router.push('/verify-request');
    }
  }

  if (autoRedirect) {
    return (
      <Card className="border-primary/10 shadow-lg shadow-primary/5">
        <CardContent className="py-10 text-center text-sm text-muted-foreground">{t('redirecting')}</CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-primary/10 shadow-lg shadow-primary/5">
      <CardHeader className="text-center pb-2">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 ring-1 ring-primary/20">
          <Receipt className="h-7 w-7 text-primary" />
        </div>
        <CardTitle className="text-2xl font-semibold tracking-tight">{t('title')}</CardTitle>
        <CardDescription className="mt-1">{t('subtitle')}</CardDescription>
      </CardHeader>
      <CardContent className="pt-4">
        {oidcOnly ? (
          <div className="space-y-3">
            {error && <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
            <ProviderButtons callbackUrl={callbackPath} />
          </div>
        ) : !showMagicLink ? (
          <>
            <form onSubmit={handleSubmit} className="space-y-4">
              {error && <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
              <div className="space-y-2">
                <Label htmlFor="email">{t('email')}</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder={t('emailPlaceholder')}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="password">{t('password')}</Label>
                  <button
                    type="button"
                    onClick={() => setShowMagicLink(true)}
                    className="text-xs text-primary hover:text-primary/80 transition-colors"
                  >
                    {t('forgotPassword')}
                  </button>
                </div>
                <Input
                  id="password"
                  type="password"
                  placeholder={t('passwordPlaceholder')}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                />
              </div>
              <Button type="submit" className="w-full rounded-full h-10 text-sm font-medium mt-2" disabled={loading}>
                {loading ? t('submitting') : t('submit')}
              </Button>
            </form>

            <div className="relative my-8">
              <Separator />
              <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-card px-3 text-xs text-muted-foreground uppercase tracking-wider">
                {t('or')}
              </span>
            </div>

            <div className="space-y-3">
              <ProviderButtons callbackUrl={callbackPath} />

              <Button
                variant="outline"
                className="w-full rounded-full h-10 text-sm border-primary/20 text-muted-foreground hover:text-foreground hover:border-primary/40"
                onClick={() => setShowMagicLink(true)}
              >
                <Mail className="mr-2 h-4 w-4" />
                {t('magicLink')}
              </Button>
            </div>
          </>
        ) : (
          <>
            <form onSubmit={handleMagicLink} className="space-y-4">
              {error && <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
              <p className="text-sm text-muted-foreground">{t('magicLinkDescription')}</p>
              <div className="space-y-2">
                <Label htmlFor="magic-email">{t('magicLinkEmail')}</Label>
                <Input
                  id="magic-email"
                  type="email"
                  placeholder={t('emailPlaceholder')}
                  value={magicLinkEmail}
                  onChange={(e) => setMagicLinkEmail(e.target.value)}
                  required
                />
              </div>
              <Button
                type="submit"
                className="w-full rounded-full h-10 text-sm font-medium mt-2"
                disabled={magicLinkSending}
              >
                <Mail className="mr-2 h-4 w-4" />
                {magicLinkSending ? t('magicLinkSending') : t('magicLinkSubmit')}
              </Button>
            </form>

            <div className="relative my-8">
              <Separator />
              <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-card px-3 text-xs text-muted-foreground uppercase tracking-wider">
                {t('or')}
              </span>
            </div>

            <Button
              variant="outline"
              className="w-full rounded-full h-10 text-sm border-primary/20 text-muted-foreground hover:text-foreground hover:border-primary/40"
              onClick={() => setShowMagicLink(false)}
            >
              {t('passwordLink')}
            </Button>
          </>
        )}

        <div className="relative my-8">
          <Separator />
        </div>

        <div className="text-center space-y-3">
          <p className="text-sm text-muted-foreground">
            {t('noAccount')}{' '}
            <Link href={registerHref} className="font-medium text-primary hover:underline">
              {t('createAccount')}
            </Link>
          </p>
          <p className="text-xs text-muted-foreground/80">
            {t('quickSplit')}{' '}
            <Link href="/split" className="font-medium text-primary hover:underline">
              {t('quickSplitLink')}
            </Link>
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
