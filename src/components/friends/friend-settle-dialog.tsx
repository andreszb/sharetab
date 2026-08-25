'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useSession } from 'next-auth/react';
import { trpc } from '@/lib/trpc';
import { formatCents, parseToCents } from '@/lib/money';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/**
 * Settling a balance that belongs to no group.
 *
 * Deliberately not `SettleDialog`: that one picks two members out of a group
 * and can be filed by an admin on someone else's behalf. Here the pair is
 * fixed, and the direction is only ever "you paid them" — unless the friend is
 * a placeholder, who has no account to record their own payment with.
 */
export function FriendSettleDialog({
  friendId,
  friendName,
  friendIsPlaceholder,
  net,
  currency,
  open,
  onOpenChange,
}: {
  friendId: string;
  friendName: string;
  friendIsPlaceholder: boolean;
  /** Positive: they owe the viewer. Negative: the viewer owes them. */
  net: number;
  currency: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('friends');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('settle.title', { name: friendName })}</DialogTitle>
          <DialogDescription>{t('settle.description')}</DialogDescription>
        </DialogHeader>
        {/* Mounted only while open so each open re-reads the current balance
            into the suggestion — fresh initializers, no reset effect. */}
        {open && (
          <FriendSettleForm
            friendId={friendId}
            friendName={friendName}
            friendIsPlaceholder={friendIsPlaceholder}
            net={net}
            currency={currency}
            onOpenChange={onOpenChange}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function FriendSettleForm({
  friendId,
  friendName,
  friendIsPlaceholder,
  net,
  currency,
  onOpenChange,
}: {
  friendId: string;
  friendName: string;
  friendIsPlaceholder: boolean;
  net: number;
  currency: string;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('friends');
  const locale = useLocale();
  const { data: session } = useSession();
  const viewerId = session?.user?.id;

  // Default to the direction that clears the balance: if they owe you, the
  // payment to record is theirs. Only offered at all for a placeholder.
  const [friendPays, setFriendPays] = useState(friendIsPlaceholder && net > 0);

  // The suggestion follows the direction, and is offered only when recording
  // it *reduces* the balance. A flat `Math.abs(net)` is how a friend who owes
  // you gets a payment filed the wrong way round: the toggle is hidden for a
  // real account, so "use $20.00" would have recorded a second $20 owed to
  // you rather than clearing the first.
  const suggestedFor = (theyPay: boolean) => Math.max(theyPay ? net : -net, 0);
  const suggested = suggestedFor(friendPays);
  const [amountStr, setAmountStr] = useState(suggested > 0 ? (suggested / 100).toFixed(2) : '');
  const [note, setNote] = useState('');

  function chooseDirection(theyPay: boolean) {
    setFriendPays(theyPay);
    const next = suggestedFor(theyPay);
    setAmountStr(next > 0 ? (next / 100).toFixed(2) : '');
  }

  // They owe the viewer, but they hold a real account, so only they can record
  // the payment that clears it — see `mayRecordDirectPaymentFrom`.
  const awaitingTheirPayment = !friendIsPlaceholder && net > 0;

  const utils = trpc.useUtils();
  const settle = trpc.settlements.create.useMutation({
    onSuccess: () => {
      utils.friends.getBalance.invalidate({ friendId });
      utils.friends.getLedger.invalidate({ friendId });
      utils.friends.list.invalidate();
      utils.balances.getOverallDebts.invalidate();
      utils.balances.getDashboard.invalidate();
      onOpenChange(false);
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const amount = parseToCents(amountStr);
    if (amount <= 0) return;
    // `friendPays` needs the viewer's own id on the receiving end, so the
    // button stays disabled until the session resolves rather than silently
    // recording the payment the wrong way round.
    if (friendPays && !viewerId) return;
    settle.mutate({
      // No groupId: this is the direct scope, so only the cross-group Friends
      // figure moves. Group balances are computed per group and a groupless
      // row can never reach them.
      fromId: friendPays ? friendId : undefined,
      toId: friendPays ? viewerId! : friendId,
      amount,
      currency,
      ...(note ? { note } : {}),
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {friendIsPlaceholder && (
        <div className="space-y-2">
          <Label>{t('settle.direction')}</Label>
          <div className="grid grid-cols-2 gap-2">
            {[false, true].map((value) => (
              <button
                key={String(value)}
                type="button"
                onClick={() => chooseDirection(value)}
                className={cn(
                  'rounded-md border p-2 text-sm font-medium transition-colors',
                  friendPays === value ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:bg-muted',
                )}
              >
                {value ? t('settle.friendPaid', { name: friendName }) : t('settle.youPaid', { name: friendName })}
              </button>
            ))}
          </div>
          {friendPays && (
            <p className="text-xs text-muted-foreground">{t('settle.friendPaidHint', { name: friendName })}</p>
          )}
        </div>
      )}

      {!friendIsPlaceholder && (
        <p className="text-sm text-muted-foreground">{t('settle.youPaid', { name: friendName })}</p>
      )}

      {awaitingTheirPayment && (
        <p className="rounded-md bg-muted p-3 text-xs text-muted-foreground">
          {t('settle.theirPaymentHint', { name: friendName })}
        </p>
      )}

      <div className="space-y-2">
        <Label htmlFor="friend-settle-amount">{t('settle.amount')}</Label>
        <Input
          id="friend-settle-amount"
          type="number"
          step="0.01"
          min="0.01"
          placeholder="0.00"
          value={amountStr}
          onChange={(e) => setAmountStr(e.target.value)}
          required
        />
        {suggested > 0 && (
          <button
            type="button"
            onClick={() => setAmountStr((suggested / 100).toFixed(2))}
            className="text-xs text-primary hover:underline"
          >
            {t('settle.useSuggested', { amount: formatCents(suggested, currency, locale) })}
          </button>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="friend-settle-note">{t('settle.note')}</Label>
        <Input
          id="friend-settle-note"
          placeholder={t('settle.notePlaceholder')}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>

      {settle.error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{settle.error.message}</div>
      )}

      <Button type="submit" className="w-full" disabled={settle.isPending || (friendPays && !viewerId)}>
        {settle.isPending ? t('settle.submitting') : t('settle.submit')}
      </Button>
    </form>
  );
}
