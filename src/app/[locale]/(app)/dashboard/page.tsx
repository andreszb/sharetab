'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { trpc } from '@/lib/trpc';
import { formatCents } from '@/lib/money';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { ArrowUpRight, ArrowDownLeft, Plus, ChevronRight, TrendingUp, TrendingDown } from 'lucide-react';
import Image from 'next/image';
import { Link } from '@/i18n/navigation';
import { getInitials, avatarColor } from '@/lib/avatar';
import { PersonRow, PersonRowSkeleton } from '@/components/people/person-row';

const GROUPS_PER_PAGE = 6;

/* ------------------------------------------------------------------ */
/*  Skeleton / loading helpers                                        */
/* ------------------------------------------------------------------ */

function SummarySkeleton() {
  return (
    <div className="space-y-3">
      <div className="h-4 w-24 animate-pulse rounded bg-muted" />
      <div className="h-9 w-32 animate-pulse rounded bg-muted" />
    </div>
  );
}

function GroupCardSkeleton() {
  return (
    <Card className="h-[110px]">
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <div className="h-5 w-5 animate-pulse rounded bg-muted" />
          <div className="h-5 w-32 animate-pulse rounded bg-muted" />
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between">
          <div className="flex -space-x-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-7 w-7 animate-pulse rounded-full bg-muted ring-2 ring-card" />
            ))}
          </div>
          <div className="h-4 w-16 animate-pulse rounded bg-muted" />
        </div>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  Main page                                                         */
/* ------------------------------------------------------------------ */

export default function DashboardPage() {
  const t = useTranslations('dashboard');
  const locale = useLocale();
  const dashboard = trpc.balances.getDashboard.useQuery();
  const overallDebts = trpc.balances.getOverallDebts.useQuery();
  const groups = trpc.groups.list.useQuery();
  const archivedGroups = trpc.groups.listArchived.useQuery();
  const [showAllGroups, setShowAllGroups] = useState(false);

  const visibleGroups = showAllGroups ? groups.data : groups.data?.slice(0, GROUPS_PER_PAGE);
  const hasMoreGroups = (groups.data?.length ?? 0) > GROUPS_PER_PAGE;

  // The two aggregate cards are the sums of the per-person lists below them,
  // which is what makes the pair consistent: both come from getOverallDebts,
  // which folds every group and every direct row into the viewer's own
  // currency server-side. They used to sum unconverted cents straight out of
  // getDashboard and suppress themselves entirely once two currencies were in
  // play; that suppression is gone because there is nothing left to suppress.
  //
  // getDashboard still drives the per-group cards further down, where each
  // group's own currency is the right unit and no conversion belongs.
  const totalOwed = overallDebts.data?.owedToYou.reduce((sum, person) => sum + person.amount, 0) ?? 0;
  const totalOwing = overallDebts.data?.youOwe.reduce((sum, person) => sum + person.amount, 0) ?? 0;
  const debtsCurrency = overallDebts.data?.displayCurrency ?? groups.data?.[0]?.currency ?? 'USD';

  return (
    <div className="space-y-8">
      {/* ---- Header ---- */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <Button nativeButton={false} render={<Link href="/groups/new" />}>
          <Plus className="mr-2 h-4 w-4" />
          {t('createGroup')}
        </Button>
      </div>

      {/* ---- Balance summary cards ---- */}
      <div className="grid gap-4 @2xl:grid-cols-2">
        {/* You are owed */}
        <Card className="relative overflow-hidden border-green-200/40 bg-gradient-to-br from-green-50/60 to-card dark:border-green-900/30 dark:from-green-950/30 dark:to-card">
          <div className="pointer-events-none absolute -right-4 -top-4 h-24 w-24 rounded-full bg-green-500/5 dark:bg-green-400/5" />
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-1">
            <CardTitle className="text-sm font-medium text-muted-foreground">{t('youAreOwed')}</CardTitle>
            <div className="hidden h-8 w-8 items-center justify-center rounded-full bg-green-100 sm:flex dark:bg-green-900/40">
              <TrendingUp className="h-4 w-4 text-green-600 dark:text-green-400" />
            </div>
          </CardHeader>
          <CardContent>
            {overallDebts.data ? (
              <span className="text-3xl font-bold tracking-tight tabular-nums text-green-600 dark:text-green-400">
                {formatCents(totalOwed, debtsCurrency, locale)}
              </span>
            ) : (
              <SummarySkeleton />
            )}
          </CardContent>
        </Card>

        {/* You owe */}
        <Card className="relative overflow-hidden border-red-200/40 bg-gradient-to-br from-red-50/60 to-card dark:border-red-900/30 dark:from-red-950/30 dark:to-card">
          <div className="pointer-events-none absolute -right-4 -top-4 h-24 w-24 rounded-full bg-red-500/5 dark:bg-red-400/5" />
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-1">
            <CardTitle className="text-sm font-medium text-muted-foreground">{t('youOwe')}</CardTitle>
            <div className="hidden h-8 w-8 items-center justify-center rounded-full bg-red-100 sm:flex dark:bg-red-900/40">
              <TrendingDown className="h-4 w-4 text-red-600 dark:text-red-400" />
            </div>
          </CardHeader>
          <CardContent>
            {overallDebts.data ? (
              <span className="text-3xl font-bold tracking-tight tabular-nums text-red-600 dark:text-red-400">
                {formatCents(totalOwing, debtsCurrency, locale)}
              </span>
            ) : (
              <SummarySkeleton />
            )}
          </CardContent>
        </Card>
      </div>

      {/* ---- Per-person debt cards ---- */}
      <div className="grid gap-4 @2xl:grid-cols-2">
        {/* People who owe you */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <ArrowDownLeft className="h-4 w-4 text-green-600 dark:text-green-400" />
              {t('owedToYouTitle')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {/* Pairwise, not simplify-debts: these rows only ever pair the
                viewer with someone they actually shared an expense with. */}
            {overallDebts.isLoading && (
              <div className="divide-y divide-border/60">
                {[0, 1, 2].map((i) => (
                  <PersonRowSkeleton key={i} />
                ))}
              </div>
            )}
            {overallDebts.data?.ratesUnavailable && (
              <p className="pb-2 text-xs text-muted-foreground">{t('approximateRates')}</p>
            )}
            {overallDebts.data?.owedToYou.length === 0 && (
              <p className="py-3 text-center text-sm text-muted-foreground">{t('settledUp')}</p>
            )}
            <div className="divide-y divide-border/60">
              {overallDebts.data?.owedToYou.map((person) => (
                <PersonRow
                  key={person.userId}
                  userId={person.userId}
                  name={person.userName}
                  amount={person.amount}
                  currency={debtsCurrency}
                  locale={locale}
                  tone="positive"
                />
              ))}
            </div>
          </CardContent>
        </Card>

        {/* People you owe */}
        <Card data-testid="you-owe-section">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <ArrowUpRight className="h-4 w-4 text-red-600 dark:text-red-400" />
              {t('youOweTitle')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {overallDebts.isLoading && (
              <div className="divide-y divide-border/60">
                {[0, 1, 2].map((i) => (
                  <PersonRowSkeleton key={i} />
                ))}
              </div>
            )}
            {overallDebts.data?.ratesUnavailable && (
              <p className="pb-2 text-xs text-muted-foreground">{t('approximateRates')}</p>
            )}
            {overallDebts.data?.youOwe.length === 0 && (
              <p className="py-3 text-center text-sm text-muted-foreground">{t('settledUp')}</p>
            )}
            <div className="divide-y divide-border/60">
              {overallDebts.data?.youOwe.map((person) => (
                <PersonRow
                  key={person.userId}
                  userId={person.userId}
                  name={person.userName}
                  amount={person.amount}
                  currency={debtsCurrency}
                  locale={locale}
                  tone="negative"
                />
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <Separator />

      {/* ---- Your Groups ---- */}
      <div>
        <h2 className="mb-4 text-lg font-semibold">{t('groups')}</h2>

        {groups.isLoading && (
          <div className="grid gap-4 @2xl:grid-cols-2">
            {[0, 1, 2, 3].map((i) => (
              <GroupCardSkeleton key={i} />
            ))}
          </div>
        )}

        {groups.data?.length === 0 && (
          <Card>
            <CardContent className="py-8 text-center">
              <p className="text-muted-foreground">{t('noGroupsDescription')}</p>
              <Button nativeButton={false} className="mt-4" render={<Link href="/groups/new" />}>
                <Plus className="mr-2 h-4 w-4" />
                {t('createGroup')}
              </Button>
            </CardContent>
          </Card>
        )}

        <div className="grid gap-4 @2xl:grid-cols-2">
          {visibleGroups?.map((group) => {
            const balance = dashboard.data?.perGroup.find((g) => g.groupId === group.id);
            // Limit displayed avatars to 5
            const visibleMembers = group.members.slice(0, 5);
            const overflowCount = group.members.length - visibleMembers.length;

            return (
              <Link key={group.id} href={`/groups/${group.id}`}>
                <Card className="group/link transition-all duration-200 hover:scale-[1.01] hover:shadow-md hover:ring-emerald-500/20 dark:hover:ring-emerald-400/20">
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <span className="text-lg">{group.emoji}</span>
                      <span className="flex-1 truncate">{group.name}</span>
                      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/50 transition-transform group-hover/link:translate-x-0.5" />
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-center justify-between text-sm">
                      {/* Overlapping member avatars */}
                      <div className="flex items-center gap-2">
                        <div className="flex -space-x-2">
                          {visibleMembers.map((member) => {
                            const name = member.user.placeholderName ?? member.user.name ?? member.user.email ?? '?';
                            return member.user.image ? (
                              <Image
                                key={member.user.id}
                                src={member.user.image}
                                alt={name}
                                width={28}
                                height={28}
                                className="h-7 w-7 rounded-full ring-2 ring-card"
                              />
                            ) : (
                              <div
                                key={member.user.id}
                                className={`flex h-7 w-7 items-center justify-center rounded-full text-[10px] font-medium text-white ring-2 ring-card ${avatarColor(member.user.id)}`}
                              >
                                {getInitials(name)}
                              </div>
                            );
                          })}
                        </div>
                        {overflowCount > 0 && <span className="text-xs text-muted-foreground">+{overflowCount}</span>}
                      </div>

                      {/* Balance */}
                      {balance && balance.balance !== 0 && (
                        <span
                          className={`font-semibold tabular-nums ${
                            balance.balance > 0
                              ? 'text-green-600 dark:text-green-400'
                              : 'text-red-600 dark:text-red-400'
                          }`}
                        >
                          {balance.balance > 0 ? '+' : ''}
                          {formatCents(balance.balance, balance.currency, locale)}
                        </span>
                      )}
                      {balance && balance.balance === 0 && (
                        <span className="text-muted-foreground">{t('settledUp')}</span>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>

        {hasMoreGroups && !showAllGroups && (
          <div className="mt-4 text-center">
            <Button variant="outline" size="sm" onClick={() => setShowAllGroups(true)}>
              {t('showMore')}
            </Button>
          </div>
        )}

        {(archivedGroups.data?.length ?? 0) > 0 && (
          <div className="mt-3 text-center">
            <Link
              href="/groups?archived=1"
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              {t('archivedGroups', { count: archivedGroups.data?.length ?? 0 })}
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
