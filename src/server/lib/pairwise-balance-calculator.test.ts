import { describe, test, expect } from 'vitest';
import { computePairwiseBalances, type PairwiseExpense, type PairwiseSettlement } from './pairwise-balance-calculator';
import { computeBalances, simplifyDebts } from './balance-calculator';

// Helper: an equal split of `total` across `userIds`, paid by `paidById`.
// The last participant absorbs the remainder, matching how the app splits.
function equalSplit(paidById: string, total: number, userIds: string[]): PairwiseExpense {
  const each = Math.floor(total / userIds.length);
  return {
    paidById,
    amount: total,
    shares: userIds.map((userId, i) => ({
      userId,
      amount: i === userIds.length - 1 ? total - each * (userIds.length - 1) : each,
    })),
  };
}

// ── the defect this engine exists to fix ───────────────────

describe('computePairwiseBalances — no invented debts', () => {
  // Alice pays 90 for Alice+Bob+Charlie; Bob pays 60 for Bob+Dave.
  // Nets: alice +60, bob 0, charlie -30, dave -30.
  // simplifyDebts sees one creditor (alice) and two debtors, so it routes
  // dave -> alice. Alice and Dave have never shared an expense.
  const expenses: PairwiseExpense[] = [
    equalSplit('alice', 9000, ['alice', 'bob', 'charlie']),
    equalSplit('bob', 6000, ['bob', 'dave']),
  ];

  test('the group heuristic really does invent an alice/dave debt', () => {
    const debts = simplifyDebts(computeBalances(expenses, []));
    expect(debts).toContainEqual({ from: 'dave', to: 'alice', amount: 3000 });
  });

  test('the pairwise ledger never pairs alice with dave', () => {
    const alice = computePairwiseBalances('alice', expenses, []);
    expect(alice.map((b) => b.userId)).not.toContain('dave');
    expect(alice).toEqual([
      { userId: 'bob', net: 3000 },
      { userId: 'charlie', net: 3000 },
    ]);
  });

  test('dave owes bob, the person he actually shared with', () => {
    expect(computePairwiseBalances('dave', expenses, [])).toEqual([{ userId: 'bob', net: -3000 }]);
  });

  test("bob's net is zero overall but non-zero against each counterparty", () => {
    // computeBalances collapses bob to net 0; the pairwise ledger must not.
    expect(computeBalances(expenses, []).find((b) => b.userId === 'bob')?.net).toBe(0);
    expect(computePairwiseBalances('bob', expenses, [])).toEqual([
      { userId: 'alice', net: -3000 },
      { userId: 'dave', net: 3000 },
    ]);
  });
});

// ── expense attribution ────────────────────────────────────

describe('computePairwiseBalances — expenses', () => {
  test('returns an empty array for empty input', () => {
    expect(computePairwiseBalances('alice', [], [])).toEqual([]);
  });

  test('viewer is the payer: every other participant owes their share', () => {
    const expenses = [equalSplit('alice', 3000, ['alice', 'bob', 'charlie'])];
    expect(computePairwiseBalances('alice', expenses, [])).toEqual([
      { userId: 'bob', net: 1000 },
      { userId: 'charlie', net: 1000 },
    ]);
  });

  test('viewer is a participant: the viewer owes the payer their own share', () => {
    const expenses = [equalSplit('alice', 3000, ['alice', 'bob', 'charlie'])];
    expect(computePairwiseBalances('bob', expenses, [])).toEqual([{ userId: 'alice', net: -1000 }]);
  });

  test("the payer's own share never becomes a debt to themselves", () => {
    const expenses = [equalSplit('alice', 3000, ['alice', 'bob', 'charlie'])];
    expect(computePairwiseBalances('alice', expenses, []).map((b) => b.userId)).not.toContain('alice');
  });

  test('an expense the viewer has no part in is ignored entirely', () => {
    const expenses = [equalSplit('bob', 5000, ['bob', 'charlie'])];
    expect(computePairwiseBalances('alice', expenses, [])).toEqual([]);
  });

  test('a payer with no share of their own is still credited in full', () => {
    // Alice pays 40 but consumes none of it.
    const expenses: PairwiseExpense[] = [
      { paidById: 'alice', amount: 4000, shares: [{ userId: 'bob', amount: 4000 }] },
    ];
    expect(computePairwiseBalances('alice', expenses, [])).toEqual([{ userId: 'bob', net: 4000 }]);
    expect(computePairwiseBalances('bob', expenses, [])).toEqual([{ userId: 'alice', net: -4000 }]);
  });

  test('debts accumulate across several expenses and net off in both directions', () => {
    const expenses = [
      equalSplit('alice', 2000, ['alice', 'bob']), // bob owes alice 1000
      equalSplit('bob', 600, ['alice', 'bob']), //    alice owes bob 300
    ];
    expect(computePairwiseBalances('alice', expenses, [])).toEqual([{ userId: 'bob', net: 700 }]);
    expect(computePairwiseBalances('bob', expenses, [])).toEqual([{ userId: 'alice', net: -700 }]);
  });

  test('a counterparty whose balance nets to zero is dropped', () => {
    const expenses = [equalSplit('alice', 2000, ['alice', 'bob']), equalSplit('bob', 2000, ['alice', 'bob'])];
    expect(computePairwiseBalances('alice', expenses, [])).toEqual([]);
  });

  test('results are sorted by userId regardless of input order', () => {
    const expenses = [equalSplit('alice', 4000, ['alice', 'zoe', 'bob', 'yara'])];
    expect(computePairwiseBalances('alice', expenses, []).map((b) => b.userId)).toEqual(['bob', 'yara', 'zoe']);
  });
});

// ── settlements ────────────────────────────────────────────

describe('computePairwiseBalances — settlements', () => {
  const owed = [equalSplit('alice', 2000, ['alice', 'bob'])]; // bob owes alice 1000

  test('a payment from the counterparty reduces what they owe the viewer', () => {
    const settlements: PairwiseSettlement[] = [{ fromId: 'bob', toId: 'alice', amount: 400 }];
    expect(computePairwiseBalances('alice', owed, settlements)).toEqual([{ userId: 'bob', net: 600 }]);
  });

  test('a payment from the viewer increases what the counterparty owes them', () => {
    const settlements: PairwiseSettlement[] = [{ fromId: 'alice', toId: 'bob', amount: 400 }];
    expect(computePairwiseBalances('alice', owed, settlements)).toEqual([{ userId: 'bob', net: 1400 }]);
  });

  test('an exact settlement clears the balance', () => {
    const settlements: PairwiseSettlement[] = [{ fromId: 'bob', toId: 'alice', amount: 1000 }];
    expect(computePairwiseBalances('alice', owed, settlements)).toEqual([]);
  });

  test('overpaying flips the direction of the debt', () => {
    const settlements: PairwiseSettlement[] = [{ fromId: 'bob', toId: 'alice', amount: 1500 }];
    expect(computePairwiseBalances('alice', owed, settlements)).toEqual([{ userId: 'bob', net: -500 }]);
    expect(computePairwiseBalances('bob', owed, settlements)).toEqual([{ userId: 'alice', net: 500 }]);
  });

  test('a settlement between two other people is ignored', () => {
    const settlements: PairwiseSettlement[] = [{ fromId: 'bob', toId: 'charlie', amount: 900 }];
    expect(computePairwiseBalances('alice', [], settlements)).toEqual([]);
  });

  test('a settlement alone, with no expenses, still creates a balance', () => {
    const settlements: PairwiseSettlement[] = [{ fromId: 'alice', toId: 'bob', amount: 2500 }];
    expect(computePairwiseBalances('alice', [], settlements)).toEqual([{ userId: 'bob', net: 2500 }]);
  });
});

// ── currency conversion ────────────────────────────────────

describe('computePairwiseBalances — currency', () => {
  test('baseCurrencyAmount is used in place of the raw amount', () => {
    // 10.00 EUR billed, recorded as 11.00 in the group's currency.
    const expenses: PairwiseExpense[] = [
      {
        paidById: 'alice',
        amount: 1000,
        baseCurrencyAmount: 1100,
        shares: [
          { userId: 'alice', amount: 500 },
          { userId: 'bob', amount: 500 },
        ],
      },
    ];
    expect(computePairwiseBalances('alice', expenses, [])).toEqual([{ userId: 'bob', net: 550 }]);
  });

  test('displayRate converts into the viewer currency', () => {
    const expenses: PairwiseExpense[] = [{ ...equalSplit('alice', 2000, ['alice', 'bob']), displayRate: 2 }];
    expect(computePairwiseBalances('alice', expenses, [])).toEqual([{ userId: 'bob', net: 2000 }]);
  });

  test('baseCurrencyAmount and displayRate compose', () => {
    const expenses: PairwiseExpense[] = [
      {
        paidById: 'alice',
        amount: 1000,
        baseCurrencyAmount: 1100,
        displayRate: 0.5,
        shares: [
          { userId: 'alice', amount: 500 },
          { userId: 'bob', amount: 500 },
        ],
      },
    ];
    // 1100 base -> 550 display, split evenly -> bob owes 275
    expect(computePairwiseBalances('alice', expenses, [])).toEqual([{ userId: 'bob', net: 275 }]);
  });

  test('a displayRate of 1 (or omitted) leaves amounts untouched', () => {
    const withRate: PairwiseExpense[] = [{ ...equalSplit('alice', 2000, ['alice', 'bob']), displayRate: 1 }];
    const without = [equalSplit('alice', 2000, ['alice', 'bob'])];
    expect(computePairwiseBalances('alice', withRate, [])).toEqual(computePairwiseBalances('alice', without, []));
  });

  test('settlements honour baseCurrencyAmount and displayRate', () => {
    const settlements: PairwiseSettlement[] = [
      { fromId: 'bob', toId: 'alice', amount: 1000, baseCurrencyAmount: 1100, displayRate: 2 },
    ];
    expect(computePairwiseBalances('alice', [], settlements)).toEqual([{ userId: 'bob', net: -2200 }]);
  });

  test('converted shares still sum to the converted total (no cents invented or lost)', () => {
    // 1.00 split three ways is 34/33/33; tripling it must land on exactly 300.
    const expenses: PairwiseExpense[] = [
      {
        paidById: 'dora',
        amount: 100,
        displayRate: 3,
        shares: [
          { userId: 'alice', amount: 34 },
          { userId: 'bob', amount: 33 },
          { userId: 'carl', amount: 33 },
        ],
      },
    ];
    const owedToDora = computePairwiseBalances('dora', expenses, []);
    expect(owedToDora.reduce((sum, b) => sum + b.net, 0)).toBe(300);
  });

  test('conversion drift lands on the last share in userId order', () => {
    const expenses: PairwiseExpense[] = [
      {
        paidById: 'alice',
        amount: 100,
        displayRate: 1.005, // 100 -> 101 (rounded), shares would scale to 50.25 each
        shares: [
          { userId: 'alice', amount: 50 },
          { userId: 'bob', amount: 50 },
        ],
      },
    ];
    // 100 -> 101 overall; alice rounds up to 51, so bob takes the remainder 50
    expect(computePairwiseBalances('alice', expenses, [])).toEqual([{ userId: 'bob', net: 50 }]);
  });
});

// ── symmetry ───────────────────────────────────────────────

describe('computePairwiseBalances — the two sides of a pair always agree', () => {
  // Rounding has to land somewhere, and scaleShares puts the remainder on the
  // last share in userId order. That is fine as long as BOTH parties read the
  // same rescaled share for the same expense, which these cover: a ledger where
  // A thinks B owes 51 while B thinks A is owed 50 would be a real defect.
  const everyPairMirrors = (people: string[], expenses: PairwiseExpense[], settlements: PairwiseSettlement[] = []) => {
    for (const a of people) {
      const fromA = computePairwiseBalances(a, expenses, settlements);
      for (const b of people) {
        if (a === b) continue;
        const fromB = computePairwiseBalances(b, expenses, settlements);
        const aSeesB = fromA.find((x) => x.userId === b)?.net ?? 0;
        const bSeesA = fromB.find((x) => x.userId === a)?.net ?? 0;
        expect({ pair: `${a}/${b}`, sum: aSeesB + bSeesA }).toEqual({ pair: `${a}/${b}`, sum: 0 });
      }
    }
  };

  test('holds for a converted three-way split with an ugly remainder', () => {
    everyPairMirrors(
      ['alice', 'bob', 'carl'],
      [
        {
          paidById: 'alice',
          amount: 100,
          baseCurrencyAmount: 101,
          displayRate: 1.0037,
          shares: [
            { userId: 'alice', amount: 34 },
            { userId: 'bob', amount: 33 },
            { userId: 'carl', amount: 33 },
          ],
        },
      ],
    );
  });

  test('holds when the payer sorts last, so the payer absorbs the remainder', () => {
    everyPairMirrors(
      ['aaron', 'brian', 'zach'],
      [
        {
          paidById: 'zach',
          amount: 1000,
          displayRate: 1.0001,
          shares: [
            { userId: 'aaron', amount: 333 },
            { userId: 'brian', amount: 333 },
            { userId: 'zach', amount: 334 },
          ],
        },
      ],
    );
  });

  test('holds across several expenses and settlements at once', () => {
    everyPairMirrors(
      ['alice', 'bob', 'carl', 'dora'],
      [
        { ...equalSplit('alice', 999, ['alice', 'bob', 'carl']), displayRate: 0.77 },
        { ...equalSplit('carl', 12345, ['carl', 'dora']), displayRate: 1.33 },
        equalSplit('dora', 7, ['alice', 'dora']),
      ],
      [
        { fromId: 'bob', toId: 'alice', amount: 123, displayRate: 0.77 },
        { fromId: 'dora', toId: 'carl', amount: 4000, baseCurrencyAmount: 4321, displayRate: 1.33 },
      ],
    );
  });
});
