/**
 * Whether a receipt may be attached to an expense written in a given scope.
 *
 * Two write paths ask this — `expenses.create` with a `receiptId`, and
 * `receipts.assignItemsAndCreateExpense` — and they must answer identically.
 * `Expense.receiptId` is unique, so attaching a receipt from the wrong scope is
 * not only a read leak (`expenses.get` includes the receipt row) but a
 * permanent denial: the receipt's real group can never create its own expense
 * and the receipt drops out of `listPending`, which filters on `expense: null`.
 *
 * Kept pure — the caller loads the receipt — so the rule can be read and tested
 * without a database.
 */

import { TRPCError } from '@trpc/server';

export function assertReceiptUsableInScope(
  // `uploadedById` is nullable: a guest upload has no owner, and so nobody
  // may attach it — the comparison below fails for every viewer.
  receipt: { groupId: string | null; uploadedById: string | null },
  scopeGroupId: string | null,
  viewerId: string,
): void {
  if (receipt.groupId) {
    // Already assigned to a group: it must be *this* group. A direct expense
    // has no group, so a grouped receipt can never feed one.
    if (receipt.groupId !== scopeGroupId) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Receipt belongs to a different group' });
    }
  } else if (receipt.uploadedById !== viewerId) {
    // Ungrouped receipt: only the uploader can use it.
    throw new TRPCError({ code: 'FORBIDDEN' });
  }
}
