import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';
import { z } from 'zod';
import { cookies } from 'next/headers';
import { auth } from '../auth';
import type { GroupMember } from '@/generated/prisma/client';
import { db } from '../db';
import { logger } from '../lib/logger';
import { verifyAndParse } from '../lib/signed-cookie';
import { canViewAmountsFor, primaryFriendship } from '../lib/friendship-policy';
import { sharedGroupMembership, sharedNonGroupExpense } from '../lib/friend-queries';

const IMPERSONATE_COOKIE = 'sharetab-impersonate';

export const createTRPCContext = async (opts?: { req?: Request }) => {
  const session = await auth();
  const headers = opts?.req?.headers ?? new Headers();

  // Check for impersonation cookie
  interface ImpersonationData {
    adminId: string;
    adminEmail: string;
    targetId: string;
    targetName: string | null;
    targetEmail: string;
    startedAt?: string;
  }
  let impersonating: ImpersonationData | null = null;

  try {
    const cookieStore = await cookies();
    const impCookie = cookieStore.get(IMPERSONATE_COOKIE);
    if (impCookie?.value && session?.user) {
      const data = verifyAndParse<ImpersonationData>(impCookie.value);
      // Enforce expiry server-side: a replayed cookie value must not outlive
      // the 1h browser maxAge. Cookies without startedAt are rejected.
      const startedAtMs = data?.startedAt ? Date.parse(data.startedAt) : NaN;
      const expired = !Number.isFinite(startedAtMs) || Date.now() - startedAtMs > 60 * 60 * 1000;
      if (data && !expired && data.adminId === session.user.id) {
        impersonating = data;
        // Swap session user to the impersonated user
        if (session.user) {
          session.user.id = data.targetId;
          session.user.name = data.targetName;
          session.user.email = data.targetEmail;
        }
      }
    }
  } catch {
    // Ignore malformed cookie
  }

  return { session, db, headers, impersonating };
};

export type TRPCContext = Awaited<ReturnType<typeof createTRPCContext>>;

const t = initTRPC.context<TRPCContext>().create({
  transformer: superjson,
});

// Procedures that poll frequently and would spam the log buffer
const QUIET_PATHS = new Set(['admin.getLogs', 'admin.getImpersonationStatus']);

const loggingMiddleware = t.middleware(async ({ path, type, next, ctx }) => {
  const start = Date.now();
  const userId = ctx.session?.user?.id;
  // Attribute impersonated requests to the real admin, not just the target
  const impersonatedBy = ctx.impersonating?.adminId;

  const result = await next();

  if (QUIET_PATHS.has(path)) return result;

  const durationMs = Date.now() - start;
  const ok = result.ok;

  if (ok) {
    logger.info('trpc.ok', { path, type, userId, durationMs, ...(impersonatedBy ? { impersonatedBy } : {}) });
  } else {
    logger.warn('trpc.error', { path, type, userId, durationMs, ...(impersonatedBy ? { impersonatedBy } : {}) });
  }

  return result;
});

export const createTRPCRouter = t.router;
export const publicProcedure = t.procedure.use(loggingMiddleware);

export const protectedProcedure = t.procedure.use(loggingMiddleware).use(async ({ ctx, next }) => {
  if (!ctx.session?.user?.id) {
    throw new TRPCError({ code: 'UNAUTHORIZED' });
  }

  const user = await ctx.db.user.findUnique({
    where: { id: ctx.session.user.id },
    select: { suspendedAt: true },
  });

  if (!user) {
    throw new TRPCError({ code: 'UNAUTHORIZED' });
  }

  if (user.suspendedAt) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Your account has been suspended. Please contact an administrator.',
    });
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.session.user,
    },
  });
});

export const groupMemberProcedure = protectedProcedure
  .input(z.object({ groupId: z.string() }))
  .use(async ({ ctx, input, next }) => {
    const membership = await ctx.db.groupMember.findUnique({
      where: {
        userId_groupId: {
          userId: ctx.user.id,
          groupId: input.groupId,
        },
      },
    });
    if (!membership) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Not a member of this group' });
    }
    return next({ ctx: { ...ctx, membership } });
  });

/**
 * The non-group sibling of `groupMemberProcedure`.
 *
 * `groupMemberProcedure` bakes a required `groupId` into its input schema and
 * authorizes against `GroupMember`, so nothing outside a group can reuse it.
 * This one bakes `friendId` instead and authorizes on connection: an explicit
 * friendship row in either direction, shared membership of any group, or shared
 * participation in a direct expense.
 *
 * Authorization and visibility are separate questions here. Someone who has
 * only been *sent* an invite is authorized to open the friend — they must be
 * able to see and answer it — but must not see any amounts until they accept.
 * The procedure therefore hands `canViewAmounts` down in the context rather
 * than conflating the two into one yes/no.
 */
export const friendProcedure = protectedProcedure
  .input(z.object({ friendId: z.string() }))
  .use(async ({ ctx, input, next }) => {
    if (input.friendId === ctx.user.id) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Cannot act on yourself as a friend' });
    }

    const [friendships, groupTie, expenseTie] = await Promise.all([
      // Both directions can hold a row, so this must be findMany: findFirst
      // would pick one of the two arbitrarily and, say, hide a live invite
      // behind a stale rejected one.
      ctx.db.friendship.findMany({
        where: {
          OR: [
            { requesterId: ctx.user.id, addresseeId: input.friendId },
            { requesterId: input.friendId, addresseeId: ctx.user.id },
          ],
        },
      }),
      ctx.db.groupMember.findFirst({
        where: sharedGroupMembership(ctx.user.id, input.friendId),
        select: { id: true },
      }),
      ctx.db.expense.findFirst({
        where: sharedNonGroupExpense(ctx.user.id, input.friendId),
        select: { id: true },
      }),
    ]);

    if (friendships.length === 0 && !groupTie && !expenseTie) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Not connected to this user' });
    }

    const sharesHistory = groupTie !== null || expenseTie !== null;

    return next({
      ctx: {
        ...ctx,
        friendships,
        friendship: primaryFriendship(ctx.user.id, friendships),
        canViewAmounts: canViewAmountsFor(ctx.user.id, friendships, sharesHistory),
      },
    });
  });

/**
 * The scope a ledger row is written into.
 *
 * Expenses, settlements and receipt-derived expenses all land either inside a
 * group or in the direct space between friends, and the two differ in more
 * than a nullable column: a group brings membership, roles, an archived flag
 * and a base currency, while the direct space brings none of them.
 */
export type LedgerScope =
  | { kind: 'direct' }
  | {
      kind: 'group';
      groupId: string;
      membership: GroupMember;
      group: { archivedAt: Date | null; currency: string };
    };

/**
 * `groupMemberProcedure` for procedures that can also run outside a group.
 *
 * `groupId` becomes optional, and the resolved `ctx.scope` is a discriminated
 * union rather than a bare membership, so a call site cannot read
 * `membership.role` without first establishing that there is a group to have a
 * role in. Passing a `groupId` you are not a member of is still a 403.
 *
 * The group's `archivedAt` and `currency` are fetched alongside the membership
 * because every call site needed them and each was issuing its own
 * `group.findUnique` to get them. The archived *throw* stays at the call sites:
 * "cannot add to" and "cannot delete from" are different messages, and on a
 * direct scope there is no `archivedAt` for the check to read at all.
 */
export const ledgerScopeProcedure = protectedProcedure
  .input(z.object({ groupId: z.string().nullish() }))
  .use(async ({ ctx, input, next }) => {
    let scope: LedgerScope;

    if (input.groupId) {
      const membership = await ctx.db.groupMember.findUnique({
        where: { userId_groupId: { userId: ctx.user.id, groupId: input.groupId } },
        include: { group: { select: { archivedAt: true, currency: true } } },
      });
      if (!membership) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Not a member of this group' });
      }
      const { group, ...rest } = membership;
      scope = { kind: 'group', groupId: input.groupId, membership: rest, group };
    } else {
      scope = { kind: 'direct' };
    }

    return next({ ctx: { ...ctx, scope } });
  });
