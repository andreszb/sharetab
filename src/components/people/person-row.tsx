'use client';

import { Link } from '@/i18n/navigation';
import { avatarColor, getInitials } from '@/lib/avatar';
import { formatCents } from '@/lib/money';
import { cn } from '@/lib/utils';

/**
 * One person and one figure.
 *
 * The dashboard's "owes you" and "you owe" lists and the friends list are the
 * same row with a different tone, and the friends list adds a third case the
 * dashboard never has: an amount the viewer is not allowed to see yet. That
 * case is `amount: null` — deliberately distinct from `0`, because rendering a
 * withheld balance as "settled up" would leak the fact that it is not.
 */
export type PersonRowTone = 'positive' | 'negative' | 'neutral';

export function toneForNet(net: number): PersonRowTone {
  if (net > 0) return 'positive';
  if (net < 0) return 'negative';
  return 'neutral';
}

const TONE_CLASSES: Record<PersonRowTone, string> = {
  positive: 'text-green-600 dark:text-green-400',
  negative: 'text-red-600 dark:text-red-400',
  neutral: 'text-muted-foreground',
};

export function PersonRow({
  userId,
  name,
  amount,
  currency,
  locale,
  tone = 'neutral',
  subtitle,
  placeholder,
  trailing,
  href,
}: {
  userId: string;
  name: string;
  /** Cents, already in `currency`. `null` renders `placeholder` instead. */
  amount: number | null;
  currency: string;
  locale: string;
  tone?: PersonRowTone;
  subtitle?: React.ReactNode;
  /** Shown in place of the amount when `amount` is null. */
  placeholder?: string;
  /** Actions rendered after the amount, e.g. accept / decline on an invite. */
  trailing?: React.ReactNode;
  /** Makes the row navigate. Rendered as an overlay so `trailing` stays clickable. */
  href?: string;
}) {
  return (
    <div className="relative flex items-center justify-between gap-3 rounded-md px-1 py-2.5 transition-colors hover:bg-muted/50">
      {/* Stretched link: covers the row, sits under `trailing` so buttons in
          there still receive their own clicks. Nesting them inside an anchor
          instead would swallow those clicks. */}
      {href && <Link href={href} className="absolute inset-0 rounded-md" aria-label={name} />}
      <div className="pointer-events-none flex min-w-0 items-center gap-3">
        <div
          className={cn(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-medium text-white shadow-sm',
            avatarColor(userId),
          )}
        >
          {getInitials(name)}
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{name}</p>
          {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
        </div>
      </div>
      {/* Only `trailing` is lifted above the stretched link. The amount must not
          be: a positioned amount paints over the link and swallows a click on
          the widest part of the row, which then simply does nothing. */}
      <div className="flex shrink-0 items-center gap-2">
        {amount === null ? (
          <span className="pointer-events-none text-xs text-muted-foreground">{placeholder}</span>
        ) : (
          <span className={cn('pointer-events-none text-sm font-semibold tabular-nums', TONE_CLASSES[tone])}>
            {formatCents(Math.abs(amount), currency, locale)}
          </span>
        )}
        {trailing && <span className="relative flex items-center">{trailing}</span>}
      </div>
    </div>
  );
}

export function PersonRowSkeleton() {
  return (
    <div className="flex items-center justify-between py-2.5">
      <div className="flex items-center gap-3">
        <div className="h-9 w-9 animate-pulse rounded-full bg-muted" />
        <div className="h-4 w-28 animate-pulse rounded bg-muted" />
      </div>
      <div className="h-4 w-16 animate-pulse rounded bg-muted" />
    </div>
  );
}
