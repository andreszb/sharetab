import NextAuth, { AuthError } from 'next-auth';
import { PrismaAdapter } from '@auth/prisma-adapter';
import Credentials from 'next-auth/providers/credentials';
import Google from 'next-auth/providers/google';
import Nodemailer from 'next-auth/providers/nodemailer';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { db } from './db';
import { logger } from './lib/logger';
import { checkRateLimit, parsePositiveInt } from './lib/rate-limit';
import { getClientIp, FALLBACK_IP } from './lib/client-ip';
import { buildOidcProvider, getGoogleConfig, getOidcConfig, getOidcPolicyFlags } from './lib/auth-providers';
import { evaluateOidcSignIn, type RegistrationMode } from './lib/oidc-signin-policy';
import { readEmailVerified } from './lib/oidc-profile';

// Resolved once at module load. The `auth.getEnabledProviders` tRPC query the
// login page reads its buttons from calls the same `auth-providers.ts` helpers
// rather than reusing these values, so the two agree only because both derive
// from the same env — which is fixed for the lifetime of the process. Anything
// that mutated `process.env` after this point would render a button for a
// provider NextAuth never registered.
const googleConfig = getGoogleConfig();
const oidcConfig = getOidcConfig();

const oidcProvider = oidcConfig ? buildOidcProvider(oidcConfig) : null;

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

// Auth.js's own `OAuthAccountNotLinked` error class lives inside next-auth's
// privately-nested `@auth/core` copy, which has no resolvable import path
// from application code — and `@auth/prisma-adapter` bundles a *different*
// nested `@auth/core` version, so importing the class from there would risk
// an `instanceof` mismatch against the copy next-auth itself checks against
// internally. Subclassing the `AuthError` that `next-auth` re-exports at its
// public entrypoint sidesteps that: the `signIn` callback below runs inside
// next-auth's own instance, so `error instanceof AuthError` matches, and
// Auth.js reads the `type` static off our class exactly like it does its own
// built-ins — producing the same `?error=OAuthAccountNotLinked` /
// `?error=Configuration` the login page already renders a banner for.
class OidcAccountNotLinked extends AuthError {
  static type = 'OAuthAccountNotLinked';
}

class OidcConfigurationError extends AuthError {
  static type = 'Configuration';
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(db),
  session: { strategy: 'jwt' },
  pages: {
    signIn: '/login',
    // Sending OIDC's denial/protocol errors to the login page (rather than
    // Auth.js's built-in error page) lets it render a translated banner from
    // the `?error=` code instead of a bare code on an unstyled page.
    error: '/login',
    verifyRequest: '/verify-request',
  },
  providers: [
    Credentials({
      name: 'credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials, request) {
        const parsed = loginSchema.safeParse(credentials);
        if (!parsed.success) return null;

        // Rate limit login attempts per IP — bounds password spraying across
        // many emails while staying generous for shared NATs/households.
        // Checked BEFORE the per-email bucket so attempts denied by the IP
        // cap don't also charge the email bucket: a user behind a rate-
        // limited shared IP who keeps retrying must not end up locked out
        // by their email bucket after the IP window clears.
        // Skipped when no proxy header identifies the client (direct
        // deployments without a reverse proxy): a single shared bucket
        // would let one client lock every user out of login, and the
        // per-email bucket below still bounds attempts in that case.
        const ip = getClientIp(request.headers);
        if (ip !== FALLBACK_IP) {
          const maxIpAttempts = parsePositiveInt(process.env.AUTH_IP_RATE_LIMIT_MAX, 30);
          const { allowed: ipAllowed } = checkRateLimit(`login-ip:${ip}`, maxIpAttempts, 15 * 60 * 1000);
          if (!ipAllowed) {
            logger.warn('auth.rate_limited_ip', { ip });
            return null;
          }
        }

        // Rate limit login attempts per email (configurable for CI/testing)
        const maxLoginAttempts = parsePositiveInt(process.env.AUTH_RATE_LIMIT_MAX, 5);
        const { allowed } = checkRateLimit(`login:${parsed.data.email}`, maxLoginAttempts, 15 * 60 * 1000);
        if (!allowed) {
          logger.warn('auth.rate_limited', { email: parsed.data.email });
          return null;
        }

        const user = await db.user.findUnique({
          where: { email: parsed.data.email },
        });
        if (!user?.passwordHash) return null;

        const valid = await bcrypt.compare(parsed.data.password, user.passwordHash);
        if (!valid) {
          logger.warn('auth.login_failed', { email: parsed.data.email, reason: 'invalid_password' });
          return null;
        }

        logger.info('auth.login', { userId: user.id, email: user.email });
        return { id: user.id, name: user.name, email: user.email, image: user.image, locale: user.locale };
      },
    }),
    // @ts-expect-error -- upstream next-auth type bug (not fixable from the call
    // site): NodemailerConfig["server"] is declared `server?: AllTransportOptions`,
    // but the base EmailConfig re-derives it via an indexed-access type
    // (`server?: NodemailerConfig["server"]`), which flattens the optional-property
    // bit into an explicit `AllTransportOptions | undefined` value type. Under
    // exactOptionalPropertyTypes that reads as "may be present-as-undefined", which
    // NodemailerConfig's own (correctly) optional `server?:` field does not accept.
    // TS attributes the diagnostic to this first spread element in the providers
    // array literal; see also the (related but not identical) upstream discussion
    // in nextauthjs/next-auth#9883 / #9890.
    ...(googleConfig
      ? [
          Google({
            clientId: googleConfig.clientId,
            clientSecret: googleConfig.clientSecret,
          }),
        ]
      : []),
    // @ts-expect-error -- same upstream NodemailerConfig["server"] typing issue as above.
    ...(process.env.EMAIL_SERVER_HOST
      ? [
          Nodemailer({
            server: {
              host: process.env.EMAIL_SERVER_HOST,
              port: parseInt(process.env.EMAIL_SERVER_PORT ?? '587'),
              secure: parseInt(process.env.EMAIL_SERVER_PORT ?? '587') === 465,
              auth: {
                ...(process.env.EMAIL_SERVER_USER !== undefined ? { user: process.env.EMAIL_SERVER_USER } : {}),
                ...(process.env.EMAIL_SERVER_PASSWORD !== undefined ? { pass: process.env.EMAIL_SERVER_PASSWORD } : {}),
              },
            },
            from: process.env.EMAIL_FROM ?? 'ShareTab <noreply@sharetab.local>',
          }),
        ]
      : []),
    // Generic OIDC provider. Everything vendor-specific comes from the
    // issuer's discovery document, so one code path covers Pocket ID,
    // Authentik, Keycloak, Authelia and Zitadel without per-vendor branches.
    //
    // `allowDangerousEmailAccountLinking` skips Auth.js's own email-match
    // check so an `OAuthAccountNotLinked` denial always reaches the `signIn`
    // callback below, which is the one place that decision is actually made
    // (`evaluateOidcSignIn`) rather than a bare email-string comparison.
    // @ts-expect-error -- the same upstream NodemailerConfig["server"] typing
    // issue described above. TS raises it against the providers array union and
    // pins it to one spread element at a time, so adding a third spread moved
    // it here; the suppression has to travel with it. The provider object
    // itself is typed as OIDCConfig above, outside this suppression.
    ...(oidcProvider ? [oidcProvider] : []),
  ],
  callbacks: {
    // Runs before the adapter links or creates anything, so this is the one
    // place account-linking and provisioning policy can veto a sign-in.
    // Only the OIDC provider is gated here — Credentials, Google and
    // Nodemailer keep NextAuth's defaults.
    async signIn({ account, profile }) {
      if (!account || account.provider !== 'oidc') return true;

      try {
        // A previous sign-in already linked this exact OIDC identity to a
        // User row: a normal re-login, always allowed regardless of the
        // current linking/provisioning flags (those only govern the first
        // sign-in for a given identity).
        const alreadyLinked = await db.account.findUnique({
          where: {
            provider_providerAccountId: {
              provider: 'oidc',
              providerAccountId: account.providerAccountId,
            },
          },
          select: { id: true },
        });
        if (alreadyLinked) return true;

        // Lowercased to match what the adapter will do: `@auth/core`'s OAuth
        // callback lowercases the mapped email before its own
        // `getUserByEmail`, so reasoning about the raw claim here would let
        // this callback and the adapter disagree about which user is meant.
        const email = profile?.email?.trim().toLowerCase() || null;

        // Case-insensitive because ShareTab stores emails verbatim — a row
        // registered as `Ada@Example.com` is invisible to an exact lookup for
        // `ada@example.com`, and the adapter's own lookup would miss it too
        // and quietly create a *second* account for the same person.
        const matches = email
          ? await db.user.findMany({
              where: { email: { equals: email, mode: 'insensitive' } },
              select: { id: true, email: true },
            })
          : [];

        // Two rows already differ only in case. Normalising either would
        // violate the unique index, and picking one arbitrarily would attach
        // the identity to a coin flip — an operator has to merge them first.
        if (matches.length > 1) {
          logger.error('auth.oidc_signin_ambiguous_email', { count: matches.length });
          throw new OidcConfigurationError();
        }
        const existingUser = matches[0] ?? null;

        // Auth.js links a new account onto whoever this browser is already
        // signed in as, consulting email only when there is no session
        // (`handle-login.js`). `/login` is a public route, so that path is
        // reachable by a signed-in user clicking the SSO button, and a policy
        // that ignored it would simply not run.
        const session = await auth();
        const sessionUserId = session?.user?.id ?? null;

        // Only consulted on the provisioning path, so skip the query whenever
        // this is a link onto an account that already exists.
        const registrationSetting =
          existingUser || sessionUserId
            ? null
            : await db.systemSetting.findUnique({ where: { key: 'registrationMode' } });

        const decision = evaluateOidcSignIn({
          email,
          emailVerified: readEmailVerified(profile?.email_verified),
          alreadyLinked: false,
          sessionUserId,
          existingUserIdByEmail: existingUser?.id ?? null,
          registrationMode: (registrationSetting?.value ?? 'open') as RegistrationMode,
          flags: getOidcPolicyFlags(),
        });

        if (decision.allow) {
          // The adapter is about to look this user up by the lowercased
          // email. If the stored row differs only in case that lookup misses
          // and a duplicate account is created instead of the link the policy
          // just approved, so bring the row into agreement first.
          if (email && existingUser && existingUser.email !== email) {
            await db.user.update({ where: { id: existingUser.id }, data: { email } });
            logger.info('auth.oidc_email_normalized', { userId: existingUser.id });
          }
          return true;
        }

        logger.warn('auth.oidc_signin_denied', { reason: decision.reason });

        // `provisioning_blocked` maps to Auth.js's own `AccessDenied` via a
        // plain `false` return. The other reasons need a specific thrown
        // error, since `false` always produces `AccessDenied` regardless of
        // cause.
        if (decision.reason === 'provisioning_blocked') return false;
        if (decision.reason === 'no_email') throw new OidcConfigurationError();
        throw new OidcAccountNotLinked();
      } catch (error) {
        // Auth.js turns *any* uncaught throw in this callback into
        // `AccessDenied`, whose banner tells the user to ask for an invite —
        // wrong and unactionable when the real cause is the database being
        // briefly unreachable. Deliberate denials are already `AuthError`s.
        if (error instanceof AuthError) throw error;
        logger.error('auth.oidc_signin_error', {
          error: error instanceof Error ? error.message : String(error),
        });
        throw new OidcConfigurationError();
      }
    },
    async jwt({ token, user }) {
      if (user?.id) {
        token.id = user.id;
        if (user.name !== undefined) token.name = user.name;
        if (user.locale !== undefined) token.locale = user.locale;
      }
      // Always refresh profile fields from DB to pick up profile changes.
      if (token.id) {
        const fresh = await db.user.findUnique({
          where: { id: token.id as string },
          select: { name: true, locale: true },
        });
        if (fresh?.name) token.name = fresh.name;
        if (fresh?.locale) token.locale = fresh.locale;
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        session.user.name = (token.name as string | null | undefined) ?? session.user.name ?? null;
        if (typeof token.locale === 'string') {
          session.user.locale = token.locale;
        }
      }
      return session;
    },
  },
});
