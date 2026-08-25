import { describe, it, expect } from 'vitest';
import { TRPCError } from '@trpc/server';
import { assertReceiptUsableInScope } from './receipt-scope';

const uploader = 'user-uploader';
const stranger = 'user-stranger';

describe('assertReceiptUsableInScope', () => {
  it('allows a grouped receipt in its own group', () => {
    expect(() =>
      assertReceiptUsableInScope({ groupId: 'group-a', uploadedById: uploader }, 'group-a', stranger),
    ).not.toThrow();
  });

  it('rejects a grouped receipt in a different group', () => {
    expect(() =>
      assertReceiptUsableInScope({ groupId: 'group-a', uploadedById: uploader }, 'group-b', uploader),
    ).toThrow(TRPCError);
  });

  it('rejects a grouped receipt in a direct (groupless) scope', () => {
    // The hijack the direct scope would otherwise open: `Expense.receiptId` is
    // unique, so this would also deny group-a its own expense forever.
    expect(() => assertReceiptUsableInScope({ groupId: 'group-a', uploadedById: uploader }, null, uploader)).toThrow(
      TRPCError,
    );
  });

  it('allows the uploader to use an ungrouped receipt in either scope', () => {
    expect(() => assertReceiptUsableInScope({ groupId: null, uploadedById: uploader }, null, uploader)).not.toThrow();
    expect(() =>
      assertReceiptUsableInScope({ groupId: null, uploadedById: uploader }, 'group-a', uploader),
    ).not.toThrow();
  });

  it('rejects anyone but the uploader on an ungrouped receipt', () => {
    expect(() => assertReceiptUsableInScope({ groupId: null, uploadedById: uploader }, null, stranger)).toThrow(
      TRPCError,
    );
  });

  it('rejects everyone on an ungrouped guest upload, which has no owner', () => {
    expect(() => assertReceiptUsableInScope({ groupId: null, uploadedById: null }, null, uploader)).toThrow(TRPCError);
  });
});
