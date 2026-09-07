/**
 * Metered usage: aggregation, the cycle boundary, and late arrivals.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { aggregateUsage, meteredCharge, eventInPeriod, splitAtBoundary } from '../src/domain/usage.js';
import { createSubscription, renewSubscription } from '../src/services/subscriptionService.js';
import { recordUsage, getUsageSummary } from '../src/services/usageService.js';
import { createTestDb, seedPlans, createCustomer, T0, days } from './helpers.js';

// ---------------------------------------------------------------------------
// Pure aggregation
// ---------------------------------------------------------------------------

test('periods are half-open: an event at the exact boundary belongs to the NEXT period', () => {
  const boundary = T0 + days(30);

  assert.equal(eventInPeriod({ timestamp: boundary - 1 }, T0, boundary), true, 'one second before');
  assert.equal(eventInPeriod({ timestamp: boundary }, T0, boundary), false, 'exactly at the rollover');
  assert.equal(eventInPeriod({ timestamp: boundary }, boundary, boundary + days(30)), true,
    'and it lands in the next period -- counted once, never twice, never dropped');
});

test('splitting at the boundary puts the boundary instant in the later bucket', () => {
  const b = T0 + days(30);
  const events = [
    { timestamp: b - 1, quantity: 1 },
    { timestamp: b, quantity: 2 },
    { timestamp: b + 1, quantity: 4 },
  ];
  const { before, after } = splitAtBoundary(events, b);
  assert.deepEqual(before.map((e) => e.quantity), [1]);
  assert.deepEqual(after.map((e) => e.quantity), [2, 4]);
});

test('aggregation counts unbilled events below the upper bound', () => {
  const periodEnd = T0 + days(30);
  const events = [
    { timestamp: T0 + days(1), quantity: 100 },
    { timestamp: periodEnd - 1, quantity: 50 },
    { timestamp: periodEnd, quantity: 999 },                      // next period
    { timestamp: T0 + days(2), quantity: 700, billedInvoiceId: 'x' }, // already billed
  ];
  const { units } = aggregateUsage(events, { periodStart: T0, periodEnd });
  assert.equal(units, 150);
});

test('aggregation without a lower bound sweeps in unbilled stragglers', () => {
  const periodStart = T0 + days(30);
  const periodEnd = T0 + days(60);
  const events = [
    { timestamp: T0 + days(29), quantity: 40 }, // belongs to a CLOSED period, never billed
    { timestamp: periodStart + days(1), quantity: 10 },
  ];

  const windowed = aggregateUsage(events, { periodStart, periodEnd });
  assert.equal(windowed.units, 50, 'both are billable');
  assert.equal(windowed.lateUnits, 40, 'and the straggler is identified as late');
  assert.equal(windowed.inPeriodUnits, 10);
});

test('metered charge bills only usage above the included allowance', () => {
  // $0.01 per call over 10,000 -> 1_000_000 microcents per unit.
  assert.deepEqual(
    meteredCharge({ units: 12_000, includedUnits: 10_000, rateMicrocents: 1_000_000 }),
    { billableUnits: 2_000, amountCents: 2_000 },
    '2,000 billable calls at $0.01 = $20.00',
  );
  assert.deepEqual(
    meteredCharge({ units: 9_999, includedUnits: 10_000, rateMicrocents: 1_000_000 }),
    { billableUnits: 0, amountCents: 0 },
    'under the allowance costs nothing',
  );
  assert.deepEqual(
    meteredCharge({ units: 10_000, includedUnits: 10_000, rateMicrocents: 1_000_000 }),
    { billableUnits: 0, amountCents: 0 },
    'exactly at the allowance costs nothing',
  );
});

test('sub-cent rates stay exact', () => {
  // $0.0001 per call = 0.01 cents = 10_000 microcents.
  // 250,000 calls * 0.01c = 2500c = $25.00, with no floating-point drift.
  assert.deepEqual(
    meteredCharge({ units: 250_000, includedUnits: 0, rateMicrocents: 10_000 }),
    { billableUnits: 250_000, amountCents: 2_500 },
  );
  // A single call costs 0.01 cents, which rounds to 0 -- not to a phantom cent.
  assert.equal(meteredCharge({ units: 1, includedUnits: 0, rateMicrocents: 10_000 }).amountCents, 0);
});

test('a huge volume does not lose precision', () => {
  // 1e9 units * 1e6 microcents = 1e15, close enough to 2^53 to matter.
  const { amountCents } = meteredCharge({
    units: 1_000_000_000,
    includedUnits: 0,
    rateMicrocents: 1_000_000,
  });
  assert.equal(amountCents, 1_000_000_000, 'exact via BigInt');
});

test('rejects nonsense quantities rather than billing them', () => {
  assert.throws(() => meteredCharge({ units: -5, rateMicrocents: 1 }), /non-negative integer/);
  assert.throws(() => meteredCharge({ units: 1.5, rateMicrocents: 1 }), /non-negative integer/);
});

// ---------------------------------------------------------------------------
// Against the database
// ---------------------------------------------------------------------------

async function setup(db) {
  await seedPlans(db);
  const customer = await createCustomer(db);
  const { subscription } = await createSubscription(db, {
    customerId: customer.id,
    planId: 'starter',
    at: T0,
  });
  return { customer, subscription };
}

test('an event at the exact rollover instant is billed to the NEXT period', async () => {
  const db = await createTestDb();
  const { subscription } = await setup(db);
  const periodEnd = Number(subscription.current_period_end);

  await recordUsage(db, { subscriptionId: subscription.id, quantity: 11_000, timestamp: periodEnd - 1 });
  await recordUsage(db, { subscriptionId: subscription.id, quantity: 5_000, timestamp: periodEnd });

  const renewal = await renewSubscription(db, { subscriptionId: subscription.id, at: periodEnd });

  // Only the pre-boundary event is billed: 11,000 - 10,000 included = 1,000 @ $0.01 = $10.00
  assert.equal(renewal.usage.units, 11_000, 'the boundary event is not swept into the closing period');
  const metered = await db.query(
    "SELECT amount_cents FROM invoice_lines WHERE invoice_id = $1 AND kind = 'metered'",
    [renewal.invoice.id],
  );
  assert.equal(Number(metered.rows[0].amount_cents), 1_000);

  // The boundary event is still unbilled and waiting for the next period.
  const summary = await getUsageSummary(db, subscription.id);
  assert.equal(summary.unbilledUnits, 5_000);
  await db.close();
});

test('an event that ARRIVES late but belongs to a closed period is still billed', async () => {
  const db = await createTestDb();
  const { subscription } = await setup(db);
  const periodEnd = Number(subscription.current_period_end);

  await recordUsage(db, { subscriptionId: subscription.id, quantity: 10_500, timestamp: T0 + days(3) });

  // Period closes and is invoiced: 500 billable @ $0.01 = $5.00
  const first = await renewSubscription(db, { subscriptionId: subscription.id, at: periodEnd });
  const firstMetered = await db.query(
    "SELECT amount_cents FROM invoice_lines WHERE invoice_id = $1 AND kind = 'metered'",
    [first.invoice.id],
  );
  assert.equal(Number(firstMetered.rows[0].amount_cents), 500);

  // NOW a straggler arrives, timestamped inside the period we already invoiced.
  // A batching meter or a request that finished at 23:59:59 does exactly this.
  await recordUsage(db, {
    subscriptionId: subscription.id,
    quantity: 2_000,
    timestamp: periodEnd - 5,
  });

  const summary = await getUsageSummary(db, subscription.id);
  assert.equal(summary.lateUnits, 2_000, 'recognised as belonging to a closed period');
  assert.equal(summary.unbilledUnits, 2_000, 'and still owed');

  // It is swept onto the NEXT invoice rather than silently dropped.
  const second = await renewSubscription(db, {
    subscriptionId: subscription.id,
    at: Number(first.subscription.current_period_end),
  });
  assert.equal(second.usage.units, 2_000);

  const total = await db.query(
    'SELECT COUNT(*)::int AS n FROM usage_events WHERE subscription_id = $1 AND billed_invoice_id IS NULL',
    [subscription.id],
  );
  assert.equal(total.rows[0].n, 0, 'no usage left unbilled');
  await db.close();
});

test('usage is claimed exactly once, so two renewals cannot double-bill it', async () => {
  const db = await createTestDb();
  const { subscription } = await setup(db);
  const periodEnd = Number(subscription.current_period_end);

  await recordUsage(db, { subscriptionId: subscription.id, quantity: 12_000, timestamp: T0 + days(2) });

  const first = await renewSubscription(db, { subscriptionId: subscription.id, at: periodEnd });
  assert.equal(first.usage.units, 12_000);

  const second = await renewSubscription(db, {
    subscriptionId: subscription.id,
    at: Number(first.subscription.current_period_end),
  });
  assert.equal(second.usage.units, 0, 'already claimed by the first invoice');

  const meteredLines = await db.query(
    "SELECT COUNT(*)::int AS n FROM invoice_lines WHERE kind = 'metered'",
  );
  assert.equal(meteredLines.rows[0].n, 1, 'billed on exactly one invoice');
  await db.close();
});

test('a replayed usage report with the same idempotency key is not counted twice', async () => {
  const db = await createTestDb();
  const { subscription } = await setup(db);

  const first = await recordUsage(db, {
    subscriptionId: subscription.id, quantity: 5_000, timestamp: T0 + days(1), idempotencyKey: 'batch-42',
  });
  const replay = await recordUsage(db, {
    subscriptionId: subscription.id, quantity: 5_000, timestamp: T0 + days(1), idempotencyKey: 'batch-42',
  });

  assert.equal(first.duplicate, false);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.event.id, first.event.id, 'the original row is returned');

  const summary = await getUsageSummary(db, subscription.id);
  assert.equal(summary.unbilledUnits, 5_000, 'counted once');
  await db.close();
});

test('events without an idempotency key are all recorded', async () => {
  const db = await createTestDb();
  const { subscription } = await setup(db);

  // The partial unique index must not collapse distinct NULL-key events.
  for (let i = 0; i < 3; i += 1) {
    await recordUsage(db, { subscriptionId: subscription.id, quantity: 100, timestamp: T0 + days(1) });
  }
  const summary = await getUsageSummary(db, subscription.id);
  assert.equal(summary.unbilledUnits, 300);
  assert.equal(summary.unbilledEvents, 3);
  await db.close();
});

test('usage cannot be recorded against a canceled subscription', async () => {
  const db = await createTestDb();
  const { subscription } = await setup(db);
  await db.query("UPDATE subscriptions SET status = 'canceled' WHERE id = $1", [subscription.id]);

  await assert.rejects(
    recordUsage(db, { subscriptionId: subscription.id, quantity: 10, timestamp: T0 }),
    /canceled subscription/,
  );
  await db.close();
});

test('the projected charge matches what the invoice actually bills', async () => {
  const db = await createTestDb();
  const { subscription } = await setup(db);
  const periodEnd = Number(subscription.current_period_end);

  await recordUsage(db, { subscriptionId: subscription.id, quantity: 13_333, timestamp: T0 + days(4) });

  const projected = await getUsageSummary(db, subscription.id);
  const renewal = await renewSubscription(db, { subscriptionId: subscription.id, at: periodEnd });
  const billed = await db.query(
    "SELECT amount_cents FROM invoice_lines WHERE invoice_id = $1 AND kind = 'metered'",
    [renewal.invoice.id],
  );

  assert.equal(
    projected.projectedMeteredCents,
    Number(billed.rows[0].amount_cents),
    'the projection and the invoice use the same predicate, so they cannot disagree',
  );
  assert.equal(projected.projectedMeteredCents, 3_333, '3,333 over the allowance at $0.01');
  await db.close();
});
