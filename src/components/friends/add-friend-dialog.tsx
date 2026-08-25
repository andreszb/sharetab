'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { trpc } from '@/lib/trpc';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

type Mode = 'email' | 'name';

export function AddFriendDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations('friends');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('add.title')}</DialogTitle>
          <DialogDescription>{t('add.description')}</DialogDescription>
        </DialogHeader>
        {/* Mounted only while open, so each open starts on a clean form and a
            cleared error — same pattern as SettleDialog. */}
        {open && <AddFriendForm onOpenChange={onOpenChange} />}
      </DialogContent>
    </Dialog>
  );
}

function AddFriendForm({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const t = useTranslations('friends');
  const [mode, setMode] = useState<Mode>('email');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');

  const utils = trpc.useUtils();
  const onSuccess = () => {
    utils.friends.list.invalidate();
    onOpenChange(false);
  };

  const addByEmail = trpc.friends.addByEmail.useMutation({ onSuccess });
  const addPlaceholder = trpc.friends.addPlaceholder.useMutation({ onSuccess });

  const pending = addByEmail.isPending || addPlaceholder.isPending;
  const error = (mode === 'email' ? addByEmail.error : addPlaceholder.error)?.message;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;
    if (mode === 'email') {
      if (!email.trim()) return;
      addByEmail.mutate({ email: email.trim() });
    } else {
      if (!name.trim()) return;
      addPlaceholder.mutate({ name: name.trim() });
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-2 gap-2">
        {(['email', 'name'] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setMode(value)}
            className={cn(
              'rounded-md border p-2 text-sm font-medium transition-colors',
              mode === value ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:bg-muted',
            )}
          >
            {value === 'email' ? t('add.byEmail') : t('add.byName')}
          </button>
        ))}
      </div>

      {mode === 'email' ? (
        <div className="space-y-2">
          <Label htmlFor="friend-email">{t('add.emailLabel')}</Label>
          <Input
            id="friend-email"
            type="email"
            autoComplete="off"
            placeholder={t('add.emailPlaceholder')}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
      ) : (
        <div className="space-y-2">
          <Label htmlFor="friend-name">{t('add.nameLabel')}</Label>
          <Input
            id="friend-name"
            maxLength={100}
            placeholder={t('add.namePlaceholder')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <p className="text-xs text-muted-foreground">{t('add.nameHint')}</p>
        </div>
      )}

      {error && <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}

      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? t('add.submitting') : mode === 'email' ? t('add.submitEmail') : t('add.submitName')}
      </Button>
    </form>
  );
}
