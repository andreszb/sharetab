'use client';

import { use, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { trpc, type RouterOutputs } from '@/lib/trpc';
import { formatCents } from '@/lib/money';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { FriendSettleDialog } from '@/components/friends/friend-settle-dialog';
import { avatarColor, getInitials } from '@/lib/avatar';
import { cn } from '@/lib/utils';
import { ArrowLeft, HandCoins, Plus } from 'lucide-react';

type LedgerEntry = RouterOutputs['friends']['getLedger']['entries'][number];

const LEDGER_LIMIT = 50;

export default function FriendDetailPage({ params }: { params: Promise<{ friendId: string }> }) {
  const { friendId } = use(params);
  const t = useTranslations('friends');
  const locale = useLocale();
  const [settleOpen, setSettleOpen] = useState(false);

  // The list is what carries the friend's name, status and actions; the ledger
  // carries the rows. Both are folded into the viewer's own currency by the
  // same loader, so they cannot disagree about the balance.
  const friends = trpc.friends.list.useQuery();
  const ledger = trpc.friends.getLedger.useQuery({ friendId, limit: LEDGER_LIMIT });

  const entry = friends.data?.friends.find((f) => f.userId === friendId);
  const name = entry?.user?.name ?? '?';
  const currency = ledger.data?.displayCurrency ?? friends.data?.displayCurrency ?? 'USD';

  // Whether amounts may be shown is the list's answer, not the ledger's. Reading
  // it off `ledger.data?.net ?? null` conflates three different states — withheld,
  // still loading, and failed — and renders all of them as "accept the invite to
  // share balances", which is a lie in two of the three.
  const canViewAmounts = entry?.canViewAmounts ?? false;
  const net = canViewAmounts ? (ledger.data?.net ?? null) : null;
  const balanceReady = canViewAmounts && !ledger.isLoading && !ledger.error && net !== null;

  const utils = trpc.useUtils();
  const invalidate = () => {
    utils.friends.list.invalidate();
    utils.friends.getLedger.invalidate({ friendId });
  };
  const respond = trpc.friends.respondToInvite.useMutation({ onSuccess: invalidate });
  const resend = trpc.friends.resendInvite.useMutation({ onSuccess: invalidate });
  const answering = respond.isPending || resend.isPending;

  if (friends.isLoading) return <LoadingSpinner />;

  // `friends.list` unions exactly the connections `friendProcedure` authorizes
  // on, so an id missing from it is one the ledger query would refuse anyway.
  if (!entry) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <p className="text-muted-foreground">{t('detail.notFound')}</p>
          <Button className="mt-4" variant="outline" nativeButton={false} render={<Link href="/friends" />}>
            {t('detail.back')}
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('detail.back')}
          nativeButton={false}
          render={<Link href="/friends" />}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div
          className={cn(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-medium text-white shadow-sm',
            avatarColor(friendId),
          )}
        >
          {getInitials(name)}
        </div>
        <h1 className="flex-1 truncate text-2xl font-bold">{name}</h1>
        {entry.user?.isPlaceholder && <Badge variant="outline">{t('status.placeholder')}</Badge>}
      </div>

      <Card>
        <CardContent className="space-y-4 py-6 text-center">
          {!canViewAmounts ? (
            <p className="text-sm text-muted-foreground">
              {entry.direction === 'incoming'
                ? t('detail.hiddenIncoming', { name })
                : t('detail.hiddenOutgoing', { name })}
            </p>
          ) : ledger.error ? (
            <p className="text-sm text-destructive">{ledger.error.message}</p>
          ) : net === null ? (
            <LoadingSpinner />
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                {net === 0
                  ? t('detail.settled', { name })
                  : net > 0
                    ? t('detail.owesYou', { name })
                    : t('detail.youOwe', { name })}
              </p>
              {net !== 0 && (
                <p
                  className={cn(
                    'text-3xl font-bold tracking-tight tabular-nums',
                    net > 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400',
                  )}
                  data-testid="friend-net"
                >
                  {formatCents(Math.abs(net), currency, locale)}
                </p>
              )}
              {ledger.data?.ratesUnavailable && (
                <p className="text-xs text-muted-foreground">{t('approximateRates')}</p>
              )}
            </>
          )}

          {/* Actions only make sense once amounts are visible: an expense with
              someone who cannot see amounts is refused server-side anyway. */}
          {balanceReady && (
            <div className="flex flex-wrap justify-center gap-2">
              <Button nativeButton={false} render={<Link href={`/friends/${friendId}/expenses/new`} />}>
                <Plus className="mr-2 h-4 w-4" />
                {t('detail.addExpense')}
              </Button>
              <Button variant="outline" onClick={() => setSettleOpen(true)}>
                <HandCoins className="mr-2 h-4 w-4" />
                {t('detail.settleUp')}
              </Button>
            </div>
          )}

          {entry.actions.length > 0 && (
            <div className="flex flex-wrap justify-center gap-2">
              {entry.actions.includes('accept') && (
                <Button disabled={answering} onClick={() => respond.mutate({ friendId, response: 'accept' })}>
                  {t('actions.accept')}
                </Button>
              )}
              {entry.actions.includes('reject') && (
                <Button
                  variant="outline"
                  disabled={answering}
                  onClick={() => respond.mutate({ friendId, response: 'reject' })}
                >
                  {t('actions.reject')}
                </Button>
              )}
              {entry.actions.includes('resend') && (
                <Button variant="outline" disabled={answering} onClick={() => resend.mutate({ friendId })}>
                  {t('actions.resend')}
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">{t('detail.ledgerTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          {ledger.isLoading && <LoadingSpinner />}
          {!ledger.isLoading && (ledger.data?.entries.length ?? 0) === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">{t('detail.noLedger')}</p>
          )}
          <div className="divide-y divide-border/60">
            {ledger.data?.entries.map((row) => (
              <LedgerRow
                key={`${row.kind}:${row.id}`}
                row={row}
                friendName={name}
                currency={currency}
                locale={locale}
              />
            ))}
          </div>
          {ledger.data?.truncated && (
            <p className="pt-3 text-center text-xs text-muted-foreground">
              {t('detail.truncated', { count: LEDGER_LIMIT })}
            </p>
          )}
        </CardContent>
      </Card>

      {balanceReady && net !== null && (
        <FriendSettleDialog
          friendId={friendId}
          friendName={name}
          friendIsPlaceholder={entry.user?.isPlaceholder ?? false}
          net={net}
          currency={currency}
          open={settleOpen}
          onOpenChange={setSettleOpen}
        />
      )}
    </div>
  );
}

function LedgerRow({
  row,
  friendName,
  currency,
  locale,
}: {
  row: LedgerEntry;
  friendName: string;
  currency: string;
  locale: string;
}) {
  const t = useTranslations('friends');

  // `delta` is this row's contribution to the balance above, taken from the
  // same attribution the balance is folded from — so the rows visibly add up.
  const positive = row.delta > 0;
  const who =
    row.kind === 'settlement'
      ? row.paidByYou
        ? t('detail.youSettled', { name: friendName })
        : t('detail.friendSettled', { name: friendName })
      : row.paidByYou
        ? t('detail.youPaid')
        : t('detail.friendPaid', { name: friendName });

  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">
          {row.title || (row.kind === 'settlement' ? t('detail.payment') : '—')}
        </p>
        <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
          <span>{new Date(row.date).toLocaleDateString(locale)}</span>
          <span>·</span>
          <span>{who}</span>
          {row.groupId ? (
            <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-normal">
              {row.groupName}
            </Badge>
          ) : (
            <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-normal">
              {t('detail.direct')}
            </Badge>
          )}
        </p>
      </div>
      <span
        className={cn(
          'shrink-0 text-sm font-semibold tabular-nums',
          row.delta === 0
            ? 'text-muted-foreground'
            : positive
              ? 'text-green-600 dark:text-green-400'
              : 'text-red-600 dark:text-red-400',
        )}
      >
        {positive ? '+' : row.delta < 0 ? '−' : ''}
        {formatCents(Math.abs(row.delta), currency, locale)}
      </span>
    </div>
  );
}
