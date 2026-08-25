'use client';

import { use, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useSession } from 'next-auth/react';
import { Link, useRouter } from '@/i18n/navigation';
import { trpc } from '@/lib/trpc';
import { parseToCents } from '@/lib/money';
import { COMMON_CURRENCIES } from '@/lib/currencies';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { EqualSplit } from '@/components/expenses/equal-split';
import { ExactSplit } from '@/components/expenses/exact-split';
import { PercentageSplit } from '@/components/expenses/percentage-split';
import { SharesSplit } from '@/components/expenses/shares-split';
import { ArrowLeft } from 'lucide-react';
import { cn } from '@/lib/utils';

type SplitMode = 'EQUAL' | 'EXACT' | 'PERCENTAGE' | 'SHARES';

type ShareEntry = {
  userId: string;
  amount: number;
  shares?: number;
  percentage?: number;
};

/**
 * The group expense form minus the group.
 *
 * The split editors are already group-agnostic — they take a plain `members`
 * array — so the only real differences are where that array comes from and
 * what anchors the currency. A direct expense has no group currency to convert
 * into, so there is no exchange-rate block here at all: the row is denominated
 * in whatever is picked, which is exactly what `baseCurrencyAmount: null` on a
 * groupless row means.
 */
export default function NewDirectExpensePage({ params }: { params: Promise<{ friendId: string }> }) {
  const { friendId } = use(params);
  const router = useRouter();
  const locale = useLocale();
  const t = useTranslations('friends');
  const tExpenses = useTranslations('expenses');
  const { data: session } = useSession();
  const viewerId = session?.user?.id;

  const friends = trpc.friends.list.useQuery();
  const profile = trpc.auth.getProfile.useQuery();

  const friend = friends.data?.friends.find((f) => f.userId === friendId);
  const friendName = friend?.user?.name ?? '?';

  const [title, setTitle] = useState('');
  const [amountStr, setAmountStr] = useState('');
  const [category, setCategory] = useState('');
  const [paidByChoice, setPaidByChoice] = useState('');
  const [splitMode, setSplitMode] = useState<SplitMode>('EQUAL');
  const [shares, setShares] = useState<ShareEntry[]>([]);
  const [currency, setCurrency] = useState('');
  const [extraIds, setExtraIds] = useState<string[]>([]);

  const effectiveCurrency = currency || profile.data?.defaultCurrency || 'USD';

  // Anyone whose amounts the viewer can already see may join the expense —
  // the same rule the server enforces, so the picker cannot offer a choice
  // that will be refused.
  const eligible = useMemo(
    () => (friends.data?.friends ?? []).filter((f) => f.canViewAmounts && f.userId !== friendId),
    [friends.data?.friends, friendId],
  );

  const members = useMemo(() => {
    if (!viewerId) return [];
    const extras = eligible.filter((f) => extraIds.includes(f.userId));
    return [
      { id: viewerId, name: session?.user?.name ?? t('expense.you') },
      { id: friendId, name: friendName },
      ...extras.map((f) => ({ id: f.userId, name: f.user?.name ?? '?' })),
    ];
  }, [viewerId, session?.user?.name, friendId, friendName, eligible, extraIds, t]);

  // The split editors deliberately keep `members` out of their effect deps —
  // including it re-runs the effect on every render and loops. That makes them
  // blind to a member leaving, so a friend de-selected above would stay in the
  // submitted shares. Remounting on the roster is what actually drops them.
  const memberKey = members.map((m) => m.id).join(',');

  // Same staleness, other field: the stored choice can name someone who has
  // since been de-selected, so the payer is derived from the current roster
  // rather than stored and patched up afterwards.
  const paidById = members.some((m) => m.id === paidByChoice) ? paidByChoice : '';

  const splitModes = useMemo(
    () => [
      {
        value: 'EQUAL' as SplitMode,
        label: tExpenses('new.splitEqual'),
        description: tExpenses('new.splitEqualDescription'),
      },
      {
        value: 'EXACT' as SplitMode,
        label: tExpenses('new.splitExact'),
        description: tExpenses('new.splitExactDescription'),
      },
      {
        value: 'PERCENTAGE' as SplitMode,
        label: tExpenses('new.splitPercentage'),
        description: tExpenses('new.splitPercentageDescription'),
      },
      {
        value: 'SHARES' as SplitMode,
        label: tExpenses('new.splitShares'),
        description: tExpenses('new.splitSharesDescription'),
      },
    ],
    [tExpenses],
  );

  const utils = trpc.useUtils();
  const createExpense = trpc.expenses.create.useMutation({
    onSuccess: () => {
      utils.friends.list.invalidate();
      utils.friends.getLedger.invalidate({ friendId });
      utils.balances.getOverallDebts.invalidate();
      router.push(`/friends/${friendId}`);
    },
  });

  const amountCents = parseToCents(amountStr);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!paidById || amountCents <= 0 || shares.length === 0) return;
    createExpense.mutate({
      // No groupId — this is the direct scope.
      title,
      amount: amountCents,
      currency: effectiveCurrency,
      category: category || undefined,
      paidById,
      splitMode,
      shares,
    });
  }

  if (friends.isLoading || profile.isLoading || !viewerId) return <LoadingSpinner />;

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('expense.back', { name: friendName })}
          nativeButton={false}
          render={<Link href={`/friends/${friendId}`} />}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-2xl font-bold">{t('expense.title')}</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{tExpenses('new.expenseDetails')}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-4 text-sm text-muted-foreground">{t('expense.subtitle')}</p>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="title">{tExpenses('new.description')}</Label>
              <Input
                id="title"
                placeholder={tExpenses('new.descriptionPlaceholder')}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
              />
            </div>

            <div className="grid grid-cols-[1fr_auto] gap-2">
              <div className="space-y-2">
                <Label htmlFor="amount">{tExpenses('new.amount')}</Label>
                <Input
                  id="amount"
                  type="number"
                  step="0.01"
                  min="0.01"
                  placeholder={tExpenses('new.amountPlaceholder')}
                  value={amountStr}
                  onChange={(e) => setAmountStr(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="currency">{tExpenses('new.currency')}</Label>
                <select
                  id="currency"
                  value={effectiveCurrency}
                  onChange={(e) => setCurrency(e.target.value)}
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {COMMON_CURRENCIES.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.code}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="category">{tExpenses('new.category')}</Label>
              <Input
                id="category"
                placeholder={tExpenses('new.categoryPlaceholder')}
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              />
            </div>

            {eligible.length > 0 && (
              <div className="space-y-2">
                <Label>{t('expense.splitWith')}</Label>
                <div className="flex flex-wrap gap-2">
                  <span className="rounded-md border border-primary bg-primary/10 px-2.5 py-1 text-sm text-primary">
                    {friendName}
                  </span>
                  {eligible.map((f) => {
                    const on = extraIds.includes(f.userId);
                    return (
                      <button
                        key={f.userId}
                        type="button"
                        onClick={() =>
                          setExtraIds((ids) => (on ? ids.filter((id) => id !== f.userId) : [...ids, f.userId]))
                        }
                        className={cn(
                          'rounded-md border px-2.5 py-1 text-sm transition-colors',
                          on ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:bg-muted',
                        )}
                      >
                        {f.user?.name ?? '?'}
                      </button>
                    );
                  })}
                </div>
                <p className="text-xs text-muted-foreground">{t('expense.splitWithHint')}</p>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="paidBy">{tExpenses('new.paidBy')}</Label>
              <select
                id="paidBy"
                value={paidById}
                onChange={(e) => setPaidByChoice(e.target.value)}
                required
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="">{tExpenses('new.selectMember')}</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <Label>{tExpenses('new.splitType')}</Label>
              <div className="grid grid-cols-2 gap-2">
                {splitModes.map((mode) => (
                  <button
                    key={mode.value}
                    type="button"
                    onClick={() => setSplitMode(mode.value)}
                    className={cn(
                      'rounded-md border p-2 text-left text-sm transition-colors',
                      splitMode === mode.value ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted',
                    )}
                  >
                    <div className="font-medium">{mode.label}</div>
                    <div className="text-xs text-muted-foreground">{mode.description}</div>
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <Label>{tExpenses('new.splitBetween')}</Label>
              {splitMode === 'EQUAL' && (
                <EqualSplit
                  key={memberKey}
                  members={members}
                  totalCents={amountCents}
                  onChange={setShares}
                  locale={locale}
                  currency={effectiveCurrency}
                />
              )}
              {splitMode === 'EXACT' && (
                <ExactSplit
                  key={memberKey}
                  members={members}
                  totalCents={amountCents}
                  onChange={setShares}
                  locale={locale}
                  currency={effectiveCurrency}
                />
              )}
              {splitMode === 'PERCENTAGE' && (
                <PercentageSplit
                  key={memberKey}
                  members={members}
                  totalCents={amountCents}
                  onChange={setShares}
                  locale={locale}
                  currency={effectiveCurrency}
                />
              )}
              {splitMode === 'SHARES' && (
                <SharesSplit
                  key={memberKey}
                  members={members}
                  totalCents={amountCents}
                  onChange={setShares}
                  locale={locale}
                  currency={effectiveCurrency}
                />
              )}
            </div>

            {createExpense.error && (
              <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                {createExpense.error.message}
              </div>
            )}

            <Button
              type="submit"
              className="w-full"
              disabled={createExpense.isPending || amountCents <= 0 || shares.length === 0}
            >
              {createExpense.isPending ? tExpenses('new.submitting') : tExpenses('new.submit')}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
