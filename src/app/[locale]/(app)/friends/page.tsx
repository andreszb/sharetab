'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { trpc, type RouterOutputs } from '@/lib/trpc';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { PersonRow, PersonRowSkeleton, toneForNet } from '@/components/people/person-row';
import { AddFriendDialog } from '@/components/friends/add-friend-dialog';
import { Plus, Search, UserPlus } from 'lucide-react';

type FriendEntry = RouterOutputs['friends']['list']['friends'][number];

export default function FriendsPage() {
  const t = useTranslations('friends');
  const locale = useLocale();
  const [search, setSearch] = useState('');
  const [addOpen, setAddOpen] = useState(false);

  const friends = trpc.friends.list.useQuery();
  const currency = friends.data?.displayCurrency ?? 'USD';

  const nameOf = (entry: FriendEntry) => entry.user?.name ?? '?';

  // `buildFriendsList` returns cuid order, which is stable but looks random on
  // screen. This is its first UI consumer, so the sort belongs here.
  const all = [...(friends.data?.friends ?? [])].sort((a, b) =>
    nameOf(a).localeCompare(nameOf(b), locale, { sensitivity: 'base' }),
  );
  const filtered = all.filter((entry) => nameOf(entry).toLowerCase().includes(search.toLowerCase()));

  // An invite the viewer must answer is the only row on this page that carries
  // an action, so it gets its own section rather than being lost mid-list.
  const incoming = filtered.filter((entry) => entry.actions.includes('accept'));
  const rest = filtered.filter((entry) => !entry.actions.includes('accept'));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        <Button onClick={() => setAddOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          {t('addFriend')}
        </Button>
      </div>

      {all.length > 0 && (
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={t('searchPlaceholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
      )}

      {friends.data?.ratesUnavailable && <p className="text-xs text-muted-foreground">{t('approximateRates')}</p>}

      {friends.isLoading && (
        <Card>
          <CardContent className="divide-y divide-border/60 py-2">
            {[0, 1, 2].map((i) => (
              <PersonRowSkeleton key={i} />
            ))}
          </CardContent>
        </Card>
      )}

      {/* Without this the empty state below claims the viewer has no friends
          whenever the query merely failed. */}
      {friends.error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{friends.error.message}</div>
      )}

      {!friends.isLoading && !friends.error && all.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center">
            <UserPlus className="mx-auto mb-3 h-8 w-8 text-muted-foreground/60" />
            <p className="text-muted-foreground">{t('noFriends')}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t('noFriendsDescription')}</p>
            <Button className="mt-4" onClick={() => setAddOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              {t('addFriend')}
            </Button>
          </CardContent>
        </Card>
      )}

      {all.length > 0 && filtered.length === 0 && (
        <p className="text-center text-muted-foreground">{t('noSearchResults')}</p>
      )}

      {incoming.length > 0 && (
        <FriendsCard title={t('pendingTitle')} testId="friend-invites">
          {incoming.map((entry) => (
            <FriendListRow key={entry.userId} entry={entry} currency={currency} locale={locale} />
          ))}
        </FriendsCard>
      )}

      {rest.length > 0 && (
        <FriendsCard title={t('allTitle')} testId="friends-list">
          {rest.map((entry) => (
            <FriendListRow key={entry.userId} entry={entry} currency={currency} locale={locale} />
          ))}
        </FriendsCard>
      )}

      <AddFriendDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}

function FriendsCard({ title, testId, children }: { title: string; testId: string; children: React.ReactNode }) {
  return (
    <Card data-testid={testId}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="divide-y divide-border/60">{children}</div>
      </CardContent>
    </Card>
  );
}

function FriendListRow({ entry, currency, locale }: { entry: FriendEntry; currency: string; locale: string }) {
  const t = useTranslations('friends');
  const utils = trpc.useUtils();
  const name = entry.user?.name ?? '?';

  const invalidate = () => {
    utils.friends.list.invalidate();
    utils.friends.getBalance.invalidate({ friendId: entry.userId });
  };
  const respond = trpc.friends.respondToInvite.useMutation({ onSuccess: invalidate });
  const resend = trpc.friends.resendInvite.useMutation({ onSuccess: invalidate });
  const pending = respond.isPending || resend.isPending;

  const net = entry.net;

  return (
    <PersonRow
      href={`/friends/${entry.userId}`}
      userId={entry.userId}
      name={name}
      amount={net}
      currency={currency}
      locale={locale}
      tone={net === null ? 'neutral' : toneForNet(net)}
      placeholder={t('amountHidden')}
      subtitle={subtitleFor(entry, t)}
      trailing={
        entry.actions.length > 0 ? (
          <span className="flex items-center gap-1" data-testid={`friend-actions-${entry.userId}`}>
            {entry.actions.includes('accept') && (
              <Button
                size="xs"
                disabled={pending}
                onClick={() => respond.mutate({ friendId: entry.userId, response: 'accept' })}
              >
                {t('actions.accept')}
              </Button>
            )}
            {entry.actions.includes('reject') && (
              <Button
                size="xs"
                variant="outline"
                disabled={pending}
                onClick={() => respond.mutate({ friendId: entry.userId, response: 'reject' })}
              >
                {t('actions.reject')}
              </Button>
            )}
            {entry.actions.includes('resend') && (
              <Button
                size="xs"
                variant="outline"
                disabled={pending}
                onClick={() => resend.mutate({ friendId: entry.userId })}
              >
                {t('actions.resend')}
              </Button>
            )}
          </span>
        ) : null
      }
    />
  );
}

/**
 * The line under the name: the relationship if it is worth stating, then which
 * way the balance runs. A settled friend says so; a withheld one says nothing,
 * because the badge already explains why the amount is hidden.
 */
function subtitleFor(entry: FriendEntry, t: (key: string) => string): React.ReactNode {
  const status = statusLabel(entry, t);
  const direction =
    entry.net === null ? null : entry.net === 0 ? t('settledUp') : entry.net > 0 ? t('owesYou') : t('youOwe');

  if (!status) return direction;
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-normal">
        {status}
      </Badge>
      {direction}
    </span>
  );
}

/**
 * The badge on a row, or null for an ordinary accepted friend — a badge on
 * every row would carry no information.
 */
function statusLabel(entry: FriendEntry, t: (key: string) => string): string | null {
  if (entry.user?.isPlaceholder) return t('status.placeholder');
  if (entry.status === 'PENDING') {
    return entry.direction === 'incoming' ? t('status.pendingIncoming') : t('status.pendingOutgoing');
  }
  if (entry.status === 'REJECTED') return t('status.rejected');
  if (entry.status === 'IMPLICIT') {
    return entry.sources.includes('group') ? t('sources.group') : t('sources.expense');
  }
  return null;
}
