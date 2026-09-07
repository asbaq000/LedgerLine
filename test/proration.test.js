/**
 * Proration correctness.
 *
 * Every expected number here is computed BY HAND in the comments first, then
 * asserted as a literal. That is the point of the exercise: an assertion that
 * re-derives the expectation with the same code it is testing proves nothing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  planChangeProration,
  proratedCharge,
  unusedCredit,
  ledgerTotal,
  assertNoOverCredit,
} from '../src/domain/proration.js';
import { mulDivRound } from '../src/domain/money.js';
import { days } from '../src/domain/time.js';

const CYCLE_30 = { start: 0, end: days(30) };

test('the brief case: $29 -> $99, exactly 10 days into a 30-day cycle', () => {
  // Manual arithmetic, done first:
  //
  //   period       = 30 days, change at day 10, so 20 days remain
  //   unused old   = $29.00 * 20/30 = $19.3333... -> $19.33  (1933 cents)
  //   remaining new= $99.00 * 20/30 = $66.0000    -> $66.00  (6600 cents)
  //   net charge   = 6600 - 1933                  =  $46.67  (4667 cents)
  //
  const items = [{ id: 'L1', planId: 'starter', amountCents: 2900, startsAt: 0, endsAt: days(30) }];

  const result = planChangeProration({
    items,
    changeAt: days(10),
    periodStart: CYCLE_30.start,
    periodEnd: CYCLE_30.end,
    newPlan: { id: 'pro', basePriceCents: 9900 },
  });

  assert.equal(result.credits.length, 1);
  assert.equal(result.credits[0].amountCents, -1933, 'credit for 20 unused days of $29');
  assert.equal(result.charges[0].amountCents, 6600, 'charge for 20 remaining days of $99');
  assert.equal(result.netCents, 4667, 'net = $46.67');
  assert.equal(result.direction, 'upgrade');
});

test('downgrade mid-cycle produces a net credit', () => {
  //   unused old   = $99.00 * 20/30 = $66.00 -> 6600
  //   remaining new= $29.00 * 20/30 = $19.33 -> 1933
  //   net          = 1933 - 6600 = -4667
  const items = [{ id: 'L1', planId: 'pro', amountCents: 9900, startsAt: 0, endsAt: days(30) }];

  const result = planChangeProration({
    items,
    changeAt: days(10),
    periodStart: CYCLE_30.start,
    periodEnd: CYCLE_30.end,
    newPlan: { id: 'starter', basePriceCents: 2900 },
  });

  assert.equal(result.netCents, -4667);
  assert.equal(result.direction, 'downgrade');
});

test('change at the exact start of the period is a full swap', () => {
  const items = [{ id: 'L1', planId: 'starter', amountCents: 2900, startsAt: 0, endsAt: days(30) }];
  const result = planChangeProration({
    items,
    changeAt: 0,
    periodStart: 0,
    periodEnd: days(30),
    newPlan: { id: 'pro', basePriceCents: 9900 },
  });

  assert.equal(result.credits[0].amountCents, -2900, 'the entire old charge comes back');
  assert.equal(result.charges[0].amountCents, 9900, 'the entire new charge applies');
  assert.equal(result.netCents, 7000, '9900 - 2900');
});

test('change at the exact end of the period charges nothing for the old cycle', () => {
  const items = [{ id: 'L1', planId: 'starter', amountCents: 2900, startsAt: 0, endsAt: days(30) }];
  const result = planChangeProration({
    items,
    changeAt: days(30),
    periodStart: 0,
    periodEnd: days(30),
    newPlan: { id: 'pro', basePriceCents: 9900 },
  });

  assert.equal(result.credits.length, 0, 'nothing unused to credit');
  assert.equal(result.charges[0].amountCents, 0, 'no time left to charge for');
  assert.equal(result.netCents, 0);
});

test('multiple changes in one cycle: up on day 10, down on day 20', () => {
  // Hand-worked ledger for a 30-day cycle:
  //
  //   day  0: billed starter                        2900   covering [0, 30)
  //   day 10: credit unused starter 2900 * 20/30 = -1933   starter retains  967
  //           charge pro            9900 * 20/30 =  6600   covering [10, 30)
  //   day 20: credit unused pro     6600 * 10/20 = -3300   pro     retains 3300
  //           charge starter        2900 * 10/30 =   967   covering [20, 30)
  //
  //   period cost = 967 + 3300 + 967 = 5234
  //
  // The continuous-time ideal is 966.67 + 3300 + 966.67 = 5233.33. We land on
  // 5234 because each line is rounded to whole cents independently, which is
  // required: every line is money a customer sees on an invoice.
  let items = [{ id: 'L1', planId: 'starter', amountCents: 2900, startsAt: 0, endsAt: days(30) }];

  const up = planChangeProration({
    items,
    changeAt: days(10),
    periodStart: 0,
    periodEnd: days(30),
    newPlan: { id: 'pro', basePriceCents: 9900 },
  });
  assert.equal(up.credits[0].amountCents, -1933);
  assert.equal(up.charges[0].amountCents, 6600);

  const down = planChangeProration({
    items: up.items,
    changeAt: days(20),
    periodStart: 0,
    periodEnd: days(30),
    newPlan: { id: 'starter', basePriceCents: 2900 },
  });

  assert.equal(down.credits[0].amountCents, -3300, 'credits the pro STUB (6600), not the list price');
  assert.equal(down.charges[0].amountCents, 967);
  assert.equal(down.netCents, -2333);

  const retained = down.items.map((i) => i.amountCents);
  assert.deepEqual(retained, [967, 3300, 967], 'ten days of each segment');
  assert.equal(ledgerTotal(down.items), 5234);
  assert.ok(assertNoOverCredit(down.items));
});

test('four changes in one cycle stay consistent and never over-credit', () => {
  // starter -> pro (d5) -> scale (d10) -> starter (d20) -> pro (d25)
  const plans = {
    starter: 2900, pro: 9900, scale: 29900,
  };
  let items = [{ id: 'L1', planId: 'starter', amountCents: 2900, startsAt: 0, endsAt: days(30) }];

  const sequence = [
    { at: days(5), to: 'pro' },
    { at: days(10), to: 'scale' },
    { at: days(20), to: 'starter' },
    { at: days(25), to: 'pro' },
  ];

  let netTotal = 0;
  for (const step of sequence) {
    const result = planChangeProration({
      items,
      changeAt: step.at,
      periodStart: 0,
      periodEnd: days(30),
      newPlan: { id: step.to, basePriceCents: plans[step.to] },
    });
    netTotal += result.netCents;
    items = result.items;
    assert.ok(assertNoOverCredit(items), `invariant holds after switching to ${step.to}`);
  }

  // Total billed for the period = the initial charge plus every net movement,
  // and that must equal the sum the ledger retained.
  assert.equal(2900 + netTotal, ledgerTotal(items));

  // Each segment retains what it was billed minus what was credited back, and
  // that is NOT the same as re-prorating the list price -- the difference is
  // compounded rounding, and it is why the ledger is the source of truth.
  //
  //   [0,5)   starter billed 2900,               credit 2900*25/30 = 2417 -> retains  483
  //   [5,10)  pro     billed 9900*25/30 = 8250,  credit 8250*20/25 = 6600 -> retains 1650
  //   [10,20) scale   billed 29900*20/30 = 19933,credit 19933*10/20= 9967 -> retains 9966
  //   [20,25) starter billed 2900*10/30 =   967, credit  967* 5/10 =  484 -> retains  483
  //   [25,30) pro     billed 9900* 5/30 =  1650, still open              -> retains 1650
  //
  // Note the scale row: re-prorating the list price would give 29900*10/30 =
  // 9967, one cent more than the 9966 actually retained. Crediting against the
  // billed stub is what keeps the books internally consistent.
  assert.deepEqual(items.map((i) => i.amountCents), [483, 1650, 9966, 483, 1650]);
  assert.equal(ledgerTotal(items), 14232);
});

test('credits are computed against what was BILLED, not the list price', () => {
  // A 50% coupon means the customer paid 1450, not 2900, for the period.
  // Crediting the list price would hand back 1933 -- 483 cents that were never
  // collected -- and would drive the item's retained amount negative.
  const discounted = [{ id: 'L1', planId: 'starter', amountCents: 1450, startsAt: 0, endsAt: days(30) }];

  const result = planChangeProration({
    items: discounted,
    changeAt: days(10),
    periodStart: 0,
    periodEnd: days(30),
    newPlan: { id: 'pro', basePriceCents: 9900 },
  });

  assert.equal(result.credits[0].amountCents, -967, '1450 * 20/30 = 966.67 -> 967');
  assert.notEqual(result.credits[0].amountCents, -1933, 'the list-price answer would be wrong');
  assert.equal(result.items[0].amountCents, 483, 'retained 1450 - 967, still non-negative');
  assert.ok(assertNoOverCredit(result.items));
});

test('for plain list-price changes the ledger agrees with the naive formula', () => {
  // Stated explicitly so the ledger's value is not over-claimed: when nothing
  // but list-price changes has happened, the two approaches are algebraically
  // identical. The ledger earns its keep in the discounted case above.
  for (const changeDay of [1, 7, 10, 15, 23, 29]) {
    const items = [{ id: 'L1', planId: 'starter', amountCents: 2900, startsAt: 0, endsAt: days(30) }];
    const result = planChangeProration({
      items,
      changeAt: days(changeDay),
      periodStart: 0,
      periodEnd: days(30),
      newPlan: { id: 'pro', basePriceCents: 9900 },
    });
    const naive = -mulDivRound(2900, days(30) - days(changeDay), days(30));
    assert.equal(result.credits[0].amountCents, naive, `day ${changeDay}`);
  }
});

test('proration uses seconds, not whole days', () => {
  // Half a day into a 30-day cycle: 29.5/30 of the period remains.
  //   2900 * (29.5*86400) / (30*86400) = 2851.67 -> 2852
  const items = [{ id: 'L1', planId: 'starter', amountCents: 2900, startsAt: 0, endsAt: days(30) }];
  const result = planChangeProration({
    items,
    changeAt: days(0.5),
    periodStart: 0,
    periodEnd: days(30),
    newPlan: { id: 'pro', basePriceCents: 9900 },
  });
  assert.equal(result.credits[0].amountCents, -2852);
});

test('a 31-day month prorates over 31 days, not a hardcoded 30', () => {
  // January: 31 days. Upgrade on day 10 leaves 21 days.
  //   credit = 2900 * 21/31 = 1964.52 -> 1965
  //   charge = 9900 * 21/31 = 6706.45 -> 6706
  const items = [{ id: 'L1', planId: 'starter', amountCents: 2900, startsAt: 0, endsAt: days(31) }];
  const result = planChangeProration({
    items,
    changeAt: days(10),
    periodStart: 0,
    periodEnd: days(31),
    newPlan: { id: 'pro', basePriceCents: 9900 },
  });
  assert.equal(result.credits[0].amountCents, -1965);
  assert.equal(result.charges[0].amountCents, 6706);
  assert.equal(result.netCents, 4741);
});

test('primitives round half away from zero', () => {
  // 2900 * 20/30 = 1933.333 -> 1933 (down)
  assert.equal(proratedCharge({ priceCents: 2900, periodStart: 0, periodEnd: 30, from: 10 }), 1933);
  // 100 * 1/8 = 12.5 -> 13 (half away from zero, not banker's rounding)
  assert.equal(mulDivRound(100, 1, 8), 13);
  assert.equal(mulDivRound(-100, 1, 8), -13, 'symmetric for credits');
});

test('an item already fully consumed yields no credit', () => {
  const item = { planId: 'starter', amountCents: 2900, startsAt: 0, endsAt: days(10) };
  assert.equal(unusedCredit(item, days(10)), 0, 'at the boundary');
  assert.equal(unusedCredit(item, days(20)), 0, 'past the end');
});

test('rejects a change outside the billing period', () => {
  const items = [{ id: 'L1', planId: 'starter', amountCents: 2900, startsAt: 0, endsAt: days(30) }];
  assert.throws(
    () => planChangeProration({
      items,
      changeAt: days(31),
      periodStart: 0,
      periodEnd: days(30),
      newPlan: { id: 'pro', basePriceCents: 9900 },
    }),
    /outside period/,
  );
});

test('rejects a zero-length period instead of dividing by zero', () => {
  assert.throws(
    () => proratedCharge({ priceCents: 2900, periodStart: 100, periodEnd: 100, from: 100 }),
    /must be positive/,
  );
});

test('over-crediting is detected', () => {
  assert.throws(
    () => assertNoOverCredit([{ id: 'L1', planId: 'starter', amountCents: -1 }]),
    /invariant violated/,
  );
});
