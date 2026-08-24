import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { TRPCError } from '@trpc/server';
import { createTRPCRouter, publicProcedure, protectedProcedure } from '../init';
import { checkRateLimit, parsePositiveInt } from '../../lib/rate-limit';
import { getClientIp } from '../../lib/client-ip';
import { locales } from '@/i18n/routing';
import { stripUndefined } from '../../lib/strip-undefined';
import { getEnabledProviders, getOidcConfig, getOidcModes } from '../../lib/auth-providers';
import { fetchOidcEndSessionEndpoint } from '../../lib/oidc-discovery';
import { computeOidcLogout } from '../../lib/oidc-logout';

export const authRouter = createTRPCRouter({
  getSession: publicProcedure.query(({ ctx }) => {
    return ctx.session;
  }),

  // Which third-party sign-in buttons the login page should render, and
  // which OIDC modes are in effect. Public because it is read before the
  // user has a session, and safe to expose: providers/modes are admin-chosen
  // configuration, never secrets.
  getEnabledProviders: publicProcedure.query(() => {
    const modes = getOidcModes();
    return { providers: getEnabledProviders(), oidcOnly: modes.only, oidcAutoRedirect: modes.autoRedirect };
  }),

  // Where sign-out should send the browser. Resolved server-side because it
  // needs the stored Account.id_token and a live fetch of the issuer's
  // discovery document — see computeOidcLogout for why local-only sign-out
  // isn't enough once RP-initiated logout applies.
  getLogoutUrl: protectedProcedure.query(async ({ ctx }) => {
    const modes = getOidcModes();
    const oidcConfig = getOidcConfig();

    const account = oidcConfig
      ? await ctx.db.account.findFirst({
          where: { userId: ctx.user.id, provider: 'oidc' },
          select: { id_token: true },
        })
      : null;

    const endSessionEndpoint = oidcConfig && account ? await fetchOidcEndSessionEndpoint(oidcConfig.issuer) : null;

    return computeOidcLogout({
      hasOidcAccount: account !== null,
      idToken: account?.id_token ?? null,
      endSessionEndpoint,
      clientId: oidcConfig?.clientId ?? '',
      baseUrl: (process.env.NEXTAUTH_URL ?? '').replace(/\/$/, ''),
      flags: { rpLogoutEnabled: modes.rpLogout, autoRedirect: modes.autoRedirect },
    });
  }),

  getRegistrationMode: publicProcedure.query(async ({ ctx }) => {
    const setting = await ctx.db.systemSetting.findUnique({
      where: { key: 'registrationMode' },
    });
    return { mode: (setting?.value ?? 'open') as 'open' | 'invite-only' | 'closed' };
  }),

  register: publicProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100),
        email: z.string().email(),
        password: z.string().min(8).max(100),
        inviteCode: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Rate limit: 10 registrations per hour per IP (fall back to global key)
      const ip = getClientIp(ctx.headers);
      const maxRegAttempts = parsePositiveInt(process.env.REGISTER_RATE_LIMIT_MAX, 10);
      const { allowed } = checkRateLimit(`register:${ip}`, maxRegAttempts, 60 * 60 * 1000);
      if (!allowed) {
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: 'Too many registration attempts. Please try again later.',
        });
      }

      // Check registration mode
      const modeSetting = await ctx.db.systemSetting.findUnique({
        where: { key: 'registrationMode' },
      });
      const mode = modeSetting?.value ?? 'open';

      if (mode === 'closed') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Registration is currently closed.',
        });
      }

      if (mode === 'invite-only') {
        if (!input.inviteCode) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'An invite code is required to register.',
          });
        }

        const invite = await ctx.db.systemInvite.findUnique({
          where: { code: input.inviteCode },
        });
        if (!invite || invite.revokedAt || invite.usedAt || (invite.expiresAt && invite.expiresAt < new Date())) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Invalid or expired invite code.',
          });
        }
      }

      const existing = await ctx.db.user.findUnique({
        where: { email: input.email },
      });
      if (existing) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Unable to create account. Please try a different email or sign in.',
        });
      }

      const passwordHash = await bcrypt.hash(input.password, 12);
      const user = await ctx.db.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            name: input.name,
            email: input.email,
            passwordHash,
          },
        });

        if (input.inviteCode && mode === 'invite-only') {
          const claimed = await tx.systemInvite.updateMany({
            where: {
              code: input.inviteCode,
              usedAt: null,
              revokedAt: null,
              OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
            },
            data: { usedById: created.id, usedAt: new Date() },
          });
          if (claimed.count === 0) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'Invalid or expired invite code.',
            });
          }
        }

        return created;
      });

      return { id: user.id, name: user.name, email: user.email };
    }),

  changePassword: protectedProcedure
    .input(
      z.object({
        currentPassword: z.string().min(1),
        newPassword: z.string().min(8).max(100),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = await ctx.db.user.findUnique({
        where: { id: ctx.user.id },
      });
      if (!user?.passwordHash) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Account uses OAuth or magic link — no password to change',
        });
      }

      const valid = await bcrypt.compare(input.currentPassword, user.passwordHash);
      if (!valid) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Current password is incorrect',
        });
      }

      const passwordHash = await bcrypt.hash(input.newPassword, 12);
      await ctx.db.user.update({
        where: { id: ctx.user.id },
        data: { passwordHash },
      });

      return { success: true };
    }),

  getProfile: protectedProcedure.query(async ({ ctx }) => {
    const user = await ctx.db.user.findUnique({
      where: { id: ctx.user.id },
      select: { name: true, email: true, venmoUsername: true, locale: true, defaultCurrency: true },
    });
    if (!user) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
    }
    return user;
  }),

  updateProfile: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100).optional(),
        defaultCurrency: z.string().length(3).optional(),
        locale: z.enum(locales).optional(),
        venmoUsername: z.string().max(50).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const data = {
        ...stripUndefined(input),
        ...(input.venmoUsername !== undefined ? { venmoUsername: input.venmoUsername?.trim() || null } : {}),
      };
      const user = await ctx.db.user.update({
        where: { id: ctx.user.id },
        data,
      });
      return {
        id: user.id,
        name: user.name,
        email: user.email,
        locale: user.locale,
        venmoUsername: user.venmoUsername,
      };
    }),
});
