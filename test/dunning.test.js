/**
 * Dunning: retry schedule, idempotent scheduling, and auto-cancellation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { nextDunningStep, dunningSchedule, DUNNING_ACTIONS } from '../src/domain/dunning.js';
import { createSubscription, renewSubscription } from '../src/services/subscriptionService.js';
import { payAndSettle } from '../src/services/paymentService.js';
import { runDueDunning } from '../src/jobs/dunningWorker.js';
import { STATES } from '../src/domain/subscriptionState.js';
import { createFakeStripe } from '../src/stripe/fake.js';
import { processWebhook } from '../src/services/webhookService.js';
import {
  createTestDb, seedPlans, createCustomer, T0, days, getSubscriptionRow,
  stripeEvent, makeSignedEvent,
} from './helpers.js';

// ---------------------------------------------------------------------------
// The schedule, in isolation
// ---------------------------------------------------------------------------

test('retries land on days 1, 3 and 7 after the first failure, then it gives up', () => {
  const steps = dunningSchedule({ firstFailedAt: T0 });

  assert.deepEqual(
    steps.map((s) => (s.action === DUNNING_ACTIONS.RETRY ? (s.at - T0) / days(1) : s.action)),
    [1, 3, 7, 'cancel'],
  );
});

test('offsets are measured from the FIRST failure, so a late run cannot shift the schedule', () => {
  // Attempt 2 is always day 3 after the origin, whether or not attempt 1 fired
  // on time. Gap-based scheduling would let one slow worker push every
  // subsequent retry later and stretch a 7-day cycle into a fortnight.
  const step = nextDunningStep({ firstFailedAt: T0, attemptsMade: 1 });
  assert.equal(step.at, T0 + days(3));
  assert.equal(step.attempt, 2);
});

test('the schedule is configurable', () => {
  const steps = dunningSchedule({
    firstFailedAt: T0,
    retryOffsetDays: [2, 5],
    maxAttempts: 2,
  });
  assert.deepEqual(steps.map((s) => s.action), ['retry', 'retry', 'cancel']);
  assert.equal(steps[0].at, T0 + days(2));
  assert.equal(steps[1].at, T0 + days(5));
});

test('maxAttempts below the schedule length gives up early', () => {
  const step = nextDunningStep({ firstFailedAt: T0, attemptsMade: 1, maxAttempts: 1 });
  assert.equal(step.action, DUNNING_ACTIONS.CANCEL);
});

test('a non-increasing schedule is rejected rather than retrying in the past', () => {
  assert.throws(
    () => nextDunningStep({ firstFailedAt: T0, attemptsMade: 0, retryOffsetDays: [3, 1] }),
    /strictly increasing/,
  );
  assert.throws(
    () => nextDunningStep({ firstFailedAt: T0, attemptsMade: 0, retryOffsetDays: [] }),
    /non-empty/,
  );
});

// ---------------------------------------------------------------------------
// End to end, driven by real payment failures
// ---------------------------------------------------------------------------

/** A subscription with a failing renewal invoice, ready to dun. */
async function failingRenewal(db) {
  let clock = T0;
  const stripe = createFakeStripe({ now: () => clock });
  const setClock = (t) => { clock = t; };

  await seedPlans(db);
  const customer = await createCustomer(db);
  const { subscription, invoice } = await createSubscription(db, {
    customerId: customer.id, planId: 'starter', at: T0,
  });
  await payAndSettle(db, invoice.id, { stripe }); // first period paid

  // Roll into the next period, and make the card decline.
  const periodEnd = Number(subscription.current_period_end);
  setClock(periodEnd);
  stripe.__failNextPayment();

  const renewal = await renewSubscription(db, { subscriptionId: subscription.id, at: periodEnd });
  await payAndSettle(db, renewal.invoice.id, { stripe });

  return { stripe, setClock, customer, subscription, invoice: renewal.invoice, firstFailedAt: periodEnd };
}

test('a failed payment moves the subscription to past_due and schedules retry 1', async () => {
  const db = await createTestDb();
  const { subscription, invoice, firstFailedAt } = await failingRenewal(db);

  const sub = await getSubscriptionRow(db, subscription.id);
  assert.equal(sub.status, STATES.PAST_DUE);

  const attempts = await db.query(
    'SELECT * FROM dunning_attempts WHERE invoice_id = $1 ORDER BY attempt',
    [invoice.id],
  );
  assert.equal(attempts.rows.length, 1);
  assert.equal(attempts.rows[0].attempt, 1);
  assert.equal(Number(attempts.rows[0].scheduled_for), firstFailedAt + days(1));
  assert.equal(attempts.rows[0].status, 'pending');
  await db.close();
});

test('the same failed attempt reported under a NEW event id schedules one retry', async () => {
  // Event-id idempotency cannot help here: this is a genuinely distinct event
  // describing an attempt already accounted for, and it is new enough to pass
  // the ordering guard. The UNIQUE index on (invoice_id, attempt) is the only
  // thing standing between this and a doubled retry queue -- which would mean
  // charging the customer twice on the same day.
  const db = await createTestDb();
  const { invoice, firstFailedAt } = await failingRenewal(db);

  const before = await db.query('SELECT COUNT(*)::int AS n FROM dunning_attempts');
  assert.equal(before.rows[0].n, 1);

  const { rows } = await db.query('SELECT stripe_invoice_id FROM invoices WHERE id = $1', [invoice.id]);
  const stripeInvoiceId = rows[0].stripe_invoice_id;

  const replay = stripeEvent(
    'invoice.payment_failed',
    {
      id: stripeInvoiceId,
      object: 'invoice',
      status: 'open',
      attempt_count: 1, // SAME attempt as the original failure
      amount_due: Number(invoice.amount_cents),
    },
    { created: firstFailedAt + 30 }, // later, so it is not rejected as stale
  );

  const result = await processWebhook(db, makeSignedEvent(replay));
  assert.equal(result.status, 'processed', 'a distinct event id is processed, not deduplicated');

  const after = await db.query('SELECT COUNT(*)::int AS n FROM dunning_attempts');
  assert.equal(after.rows[0].n, 1, 'still exactly one retry scheduled');

  const attempts = await db.query(
    'SELECT attempt, scheduled_for FROM dunning_attempts WHERE invoice_id = $1',
    [invoice.id],
  );
  assert.equal(Number(attempts.rows[0].scheduled_for), firstFailedAt + days(1),
    'and it kept its original slot rather than sliding');
  await db.close();
});

test('the full cycle: three retries then automatic cancellation', async () => {
  const db = await createTestDb();
  const { stripe, setClock, subscription, invoice, firstFailedAt } = await failingRenewal(db);

  const expectedRetryDays = [1, 3, 7];

  for (const [i, offset] of expectedRetryDays.entries()) {
    const at = firstFailedAt + days(offset);
    setClock(at);

    const run = await runDueDunning(db, { stripe, at });
    assert.equal(run.claimed, 1, `retry ${i + 1} fired on day ${offset}`);

    const sub = await getSubscriptionRow(db, subscription.id);
    if (i < expectedRetryDays.length - 1) {
      assert.equal(sub.status, STATES.PAST_DUE, 'still trying');
      const next = await db.query(
        "SELECT * FROM dunning_attempts WHERE invoice_id = $1 AND status = 'pending'",
        [invoice.id],
      );
      assert.equal(next.rows.length, 1, 'the next retry is queued');
      assert.equal(
        Number(next.rows[0].scheduled_for),
        firstFailedAt + days(expectedRetryDays[i + 1]),
      );
    }
  }

  // The third retry failed, exhausting the schedule.
  const sub = await getSubscriptionRow(db, subscription.id);
  assert.equal(sub.status, STATES.CANCELED, 'auto-cancelled after the configured attempts');
  assert.ok(Number(sub.canceled_at) > 0);

  const pending = await db.query(
    "SELECT COUNT(*)::int AS n FROM dunning_attempts WHERE status = 'pending'",
  );
  assert.equal(pending.rows[0].n, 0, 'nothing left queued');

  // The customer was told at every stage.
  const notes = await db.query(
    'SELECT template FROM notifications ORDER BY sent_at, id',
  );
  const templates = notes.rows.map((r) => r.template);
  assert.ok(templates.filter((t) => t === 'payment_failed_retry').length >= 2, 'retry notices');
  assert.ok(templates.includes('payment_failed_final_notice'), 'a final warning before cancelling');
  assert.ok(templates.includes('subscription_canceled_for_nonpayment'), 'and a cancellation notice');
  await db.close();
});

test('a successful retry stops the dunning cycle and restores the subscription', async () => {
  const db = await createTestDb();
  const { stripe, setClock, subscription, invoice, firstFailedAt } = await failingRenewal(db);

  assert.equal((await getSubscriptionRow(db, subscription.id)).status, STATES.PAST_DUE);

  // The customer updates their card before the day-1 retry.
  const at = firstFailedAt + days(1);
  setClock(at);
  stripe.__succeedNextPayment();

  await runDueDunning(db, { stripe, at });

  const sub = await getSubscriptionRow(db, subscription.id);
  assert.equal(sub.status, STATES.ACTIVE, 'recovered');

  const inv = await db.query('SELECT status FROM invoices WHERE id = $1', [invoice.id]);
  assert.equal(inv.rows[0].status, 'paid');

  const pending = await db.query(
    "SELECT COUNT(*)::int AS n FROM dunning_attempts WHERE invoice_id = $1 AND status = 'pending'",
    [invoice.id],
  );
  assert.equal(pending.rows[0].n, 0, 'no further retries scheduled');
  await db.close();
});

test('retries are not claimed before they are due', async () => {
  const db = await createTestDb();
  const { stripe, firstFailedAt } = await failingRenewal(db);

  const early = await runDueDunning(db, { stripe, at: firstFailedAt + days(1) - 1 });
  assert.equal(early.claimed, 0, 'one second early is not due');

  const onTime = await runDueDunning(db, { stripe, at: firstFailedAt + days(1) });
  assert.equal(onTime.claimed, 1);
  await db.close();
});

test('cancelling a subscription clears its pending dunning', async () => {
  const db = await createTestDb();
  const { subscription, invoice } = await failingRenewal(db);

  await db.query(
    "UPDATE subscriptions SET status = 'canceled' WHERE id = $1",
    [subscription.id],
  );
  const { cancelDunningForInvoice } = await import('../src/services/dunningService.js');
  await db.tx((tx) => cancelDunningForInvoice(tx, invoice.id));

  const pending = await db.query(
    "SELECT COUNT(*)::int AS n FROM dunning_attempts WHERE status = 'pending'",
  );
  assert.equal(pending.rows[0].n, 0);
  await db.close();
});
