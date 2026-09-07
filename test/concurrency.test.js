/**
 * Races that only a real Postgres server can exhibit.
 *
 * PGlite is a single connection, so two deliveries cannot genuinely overlap in
 * it -- the in-process suite proves the LOGIC of the guards but not that they
 * hold under real contention. These tests need a real server and skip
 * themselves without one, so `npm test` stays green on a clean checkout while
 * the properties are still verifiable where it counts:
 *
 *   DATABASE_URL=postgres://... npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getDb, migrate, dropAll } from '../src/db/index.js';
import { processWebhook } from '../src/services/webhookService.js';
import { changePlan, createSubscription } from '../src/services/subscriptionService.js';
import { seedPlans, createCustomer, makeSignedEvent, stripeEvent, T0, days } from './helpers.js';

const REAL_PG = Boolean(process.env.DATABASE_URL);
const opts = {
  skip: REAL_PG ? false : 'needs a real Postgres server (set DATABASE_URL)',
};

async function realDb() {
  const db = await getDb({ fresh: true });
  await dropAll(db);
  await migrate(db);
  return db;
}

test('concurrent deliveries of one event process it exactly once', opts, async () => {
  const db = await realDb();
  await seedPlans(db);
  const customer = await createCustomer(db);

  const sub = await db.query(
    `INSERT INTO subscriptions
       (customer_id, plan_id, status, current_period_start, current_period_end,
        billing_anchor_day, stripe_subscription_id)
     VALUES ($1,'starter','active',$2,$3,1,'sub_conc_1') RETURNING *`,
    [customer.id, T0, T0 + days(30)],
  );
  await db.query(
    `INSERT INTO invoices
       (subscription_id, customer_id, amount_cents, status, period_start, period_end, stripe_invoice_id)
     VALUES ($1,$2,2900,'pending',$3,$4,'in_conc_1')`,
    [sub.rows[0].id, customer.id, T0, T0 + days(30)],
  );

  const event = stripeEvent(
    'invoice.payment_succeeded',
    { id: 'in_conc_1', object: 'invoice', status: 'paid', attempt_count: 1, amount_due: 2900 },
    { created: T0 + 60 },
  );
  const signed = makeSignedEvent(event);

  // Fire them together. The UNIQUE index on stripe_event_id must serialise
  // them: the second blocks on the index until the first commits, then
  // conflicts and returns 'duplicate'.
  const results = await Promise.all([
    processWebhook(db, signed),
    processWebhook(db, signed),
    processWebhook(db, signed),
  ]);

  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, ['duplicate', 'duplicate', 'processed']);

  const receipts = await db.query(
    "SELECT COUNT(*)::int AS n FROM notifications WHERE template = 'invoice_paid'",
  );
  assert.equal(receipts.rows[0].n, 1, 'the customer is emailed one receipt, not three');

  await db.close();
});

test('concurrent plan changes cannot both credit the same ledger item', opts, async () => {
  // Without SELECT ... FOR UPDATE both transactions read the same open item,
  // both issue a credit against it, and the customer is refunded the unused
  // time twice. The row lock plus the CHECK (amount_cents >= 0) constraint
  // means one of them must lose.
  const db = await realDb();
  await seedPlans(db);
  const customer = await createCustomer(db);

  const { subscription } = await createSubscription(db, {
    customerId: customer.id, planId: 'starter', at: T0,
  });

  const results = await Promise.allSettled([
    changePlan(db, { subscriptionId: subscription.id, newPlanId: 'pro', at: T0 + days(10) }),
    changePlan(db, { subscriptionId: subscription.id, newPlanId: 'scale', at: T0 + days(10) }),
  ]);

  // Both may succeed (serialised, the second prorating against the first's
  // result) but they must never both credit the ORIGINAL item.
  const items = await db.query(
    'SELECT amount_cents FROM billed_items WHERE subscription_id = $1',
    [subscription.id],
  );
  for (const row of items.rows) {
    assert.ok(Number(row.amount_cents) >= 0, 'no item was credited below zero');
  }

  const succeeded = results.filter((r) => r.status === 'fulfilled');
  assert.ok(succeeded.length >= 1, 'at least one change went through');

  const totalRetained = items.rows.reduce((a, r) => a + Number(r.amount_cents), 0);
  assert.ok(totalRetained > 0, 'the period still costs something');
  await db.close();
});

test('two workers cannot claim the same dunning attempt', opts, async () => {
  // FOR UPDATE SKIP LOCKED is what stops two workers retrying one invoice on
  // the same tick, which would charge the customer twice.
  const db = await realDb();
  await seedPlans(db);
  const customer = await createCustomer(db);

  const sub = await db.query(
    `INSERT INTO subscriptions
       (customer_id, plan_id, status, current_period_start, current_period_end, billing_anchor_day)
     VALUES ($1,'starter','past_due',$2,$3,1) RETURNING *`,
    [customer.id, T0, T0 + days(30)],
  );
  const inv = await db.query(
    `INSERT INTO invoices
       (subscription_id, customer_id, amount_cents, status, period_start, period_end)
     VALUES ($1,$2,2900,'failed',$3,$4) RETURNING *`,
    [sub.rows[0].id, customer.id, T0, T0 + days(30)],
  );
  await db.query(
    `INSERT INTO dunning_attempts (subscription_id, invoice_id, attempt, scheduled_for)
     VALUES ($1,$2,1,$3)`,
    [sub.rows[0].id, inv.rows[0].id, T0],
  );

  const { claimDueAttempts } = await import('../src/services/dunningService.js');
  const [a, b] = await Promise.all([
    claimDueAttempts(db, { at: T0 + 1 }),
    claimDueAttempts(db, { at: T0 + 1 }),
  ]);

  assert.equal(a.length + b.length, 1, 'exactly one worker got the attempt');
  await db.close();
});
