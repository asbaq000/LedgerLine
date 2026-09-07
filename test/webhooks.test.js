/**
 * Webhook correctness: signature verification, idempotency, ordering.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { processWebhook, WEBHOOK_STATUS } from '../src/services/webhookService.js';
import { verifySignature, signPayload, SignatureVerificationError } from '../src/stripe/signature.js';
import { STATES } from '../src/domain/subscriptionState.js';
import {
  createTestDb, seedPlans, createCustomer, makeSignedEvent, stripeEvent,
  TEST_WEBHOOK_SECRET, T0, days, getSubscriptionRow, getInvoiceRow,
} from './helpers.js';

/** A subscription with one open invoice, both linked to Stripe ids. */
async function fixture(db, { status = STATES.ACTIVE } = {}) {
  await seedPlans(db);
  const customer = await createCustomer(db);

  const sub = await db.query(
    `INSERT INTO subscriptions
       (customer_id, plan_id, status, current_period_start, current_period_end,
        billing_anchor_day, stripe_subscription_id)
     VALUES ($1,'starter',$2,$3,$4,1,'sub_stripe_1') RETURNING *`,
    [customer.id, status, T0, T0 + days(30)],
  );

  const inv = await db.query(
    `INSERT INTO invoices
       (subscription_id, customer_id, amount_cents, status, period_start, period_end, stripe_invoice_id)
     VALUES ($1,$2,2900,'pending',$3,$4,'in_stripe_1') RETURNING *`,
    [sub.rows[0].id, customer.id, T0, T0 + days(30)],
  );

  return { customer, subscription: sub.rows[0], invoice: inv.rows[0] };
}

const deliver = (db, event, opts) => processWebhook(db, makeSignedEvent(event, opts));

const invoiceObject = (overrides = {}) => ({
  id: 'in_stripe_1',
  object: 'invoice',
  status: 'paid',
  attempt_count: 1,
  amount_due: 2900,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

test('a correctly signed payload verifies', () => {
  const payload = Buffer.from('{"id":"evt_1"}', 'utf8');
  const header = signPayload({ payload, secret: TEST_WEBHOOK_SECRET, timestamp: T0 });
  const result = verifySignature({ payload, header, secret: TEST_WEBHOOK_SECRET, now: T0 });
  assert.equal(result.timestamp, T0);
});

test('a tampered payload is rejected', () => {
  const payload = Buffer.from('{"amount":100}', 'utf8');
  const header = signPayload({ payload, secret: TEST_WEBHOOK_SECRET, timestamp: T0 });
  const tampered = Buffer.from('{"amount":999}', 'utf8');

  assert.throws(
    () => verifySignature({ payload: tampered, header, secret: TEST_WEBHOOK_SECRET, now: T0 }),
    (e) => e instanceof SignatureVerificationError && e.code === 'signature_mismatch',
  );
});

test('a signature from the wrong secret is rejected', () => {
  const payload = Buffer.from('{"id":"evt_1"}', 'utf8');
  const header = signPayload({ payload, secret: 'whsec_attacker', timestamp: T0 });
  assert.throws(
    () => verifySignature({ payload, header, secret: TEST_WEBHOOK_SECRET, now: T0 }),
    /does not match/,
  );
});

test('missing and malformed signature headers are rejected', () => {
  const payload = Buffer.from('{}', 'utf8');
  const cases = [
    [undefined, 'missing_header'],
    ['', 'missing_header'],
    ['garbage', 'malformed_header'],
    ['v1=abc', 'malformed_header'],       // no timestamp
    ['t=123', 'malformed_header'],        // no signature
  ];
  for (const [header, code] of cases) {
    assert.throws(
      () => verifySignature({ payload, header, secret: TEST_WEBHOOK_SECRET, now: T0 }),
      (e) => e.code === code,
      `header ${JSON.stringify(header)} should fail with ${code}`,
    );
  }
});

test('a replayed old payload is rejected once outside the tolerance window', () => {
  const payload = Buffer.from('{"id":"evt_1"}', 'utf8');
  const header = signPayload({ payload, secret: TEST_WEBHOOK_SECRET, timestamp: T0 });

  // The signature itself stays valid forever -- only the window stops the replay.
  assert.doesNotThrow(
    () => verifySignature({ payload, header, secret: TEST_WEBHOOK_SECRET, now: T0 + 299 }),
  );
  assert.throws(
    () => verifySignature({ payload, header, secret: TEST_WEBHOOK_SECRET, now: T0 + 301 }),
    (e) => e.code === 'timestamp_too_old',
  );
});

test('a far-future timestamp is rejected', () => {
  const payload = Buffer.from('{"id":"evt_1"}', 'utf8');
  const header = signPayload({ payload, secret: TEST_WEBHOOK_SECRET, timestamp: T0 + 10_000 });
  assert.throws(
    () => verifySignature({ payload, header, secret: TEST_WEBHOOK_SECRET, now: T0 }),
    (e) => e.code === 'timestamp_in_future',
  );
});

test('during secret rotation either valid v1 signature is accepted', () => {
  const payload = Buffer.from('{"id":"evt_1"}', 'utf8');
  const good = signPayload({ payload, secret: TEST_WEBHOOK_SECRET, timestamp: T0 }).split('v1=')[1];
  const header = `t=${T0},v1=deadbeef,v1=${good}`;
  assert.doesNotThrow(
    () => verifySignature({ payload, header, secret: TEST_WEBHOOK_SECRET, now: T0 }),
  );
});

test('an unverified delivery never reaches the handlers', async () => {
  const db = await createTestDb();
  const { invoice } = await fixture(db);

  const event = stripeEvent('invoice.payment_succeeded', invoiceObject(), { created: T0 });
  const signed = makeSignedEvent(event);

  await assert.rejects(
    processWebhook(db, { ...signed, signatureHeader: `t=${T0},v1=forged` }),
    (e) => e instanceof SignatureVerificationError,
  );

  const after = await getInvoiceRow(db, invoice.id);
  assert.equal(after.status, 'pending', 'invoice untouched');
  const recorded = await db.query('SELECT count(*)::int AS n FROM webhook_events');
  assert.equal(recorded.rows[0].n, 0, 'nothing recorded for a forged delivery');
  await db.close();
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

test('the same event delivered twice is processed exactly once', async () => {
  const db = await createTestDb();
  const { invoice, subscription } = await fixture(db);

  const event = stripeEvent('invoice.payment_succeeded', invoiceObject(), { created: T0 + 60 });

  const first = await deliver(db, event);
  const second = await deliver(db, event);

  assert.equal(first.status, WEBHOOK_STATUS.PROCESSED);
  assert.equal(second.status, WEBHOOK_STATUS.DUPLICATE);

  // The observable side effect: a second delivery must not email the customer
  // a second payment receipt.
  const notes = await db.query(
    "SELECT count(*)::int AS n FROM notifications WHERE template = 'invoice_paid'",
  );
  assert.equal(notes.rows[0].n, 1, 'receipt sent once, not twice');

  const rows = await db.query('SELECT count(*)::int AS n FROM webhook_events');
  assert.equal(rows.rows[0].n, 1, 'one ledger row per event id');

  const inv = await getInvoiceRow(db, invoice.id);
  assert.equal(inv.status, 'paid');
  const sub = await getSubscriptionRow(db, subscription.id);
  assert.equal(sub.status, STATES.ACTIVE);
  await db.close();
});

test('duplicate delivery does not double-count a metered charge', async () => {
  const db = await createTestDb();
  const { subscription, invoice } = await fixture(db);

  // Usage claimed by this invoice must stay claimed exactly once.
  await db.query(
    `INSERT INTO usage_events (subscription_id, quantity, ts, billed_invoice_id)
     VALUES ($1, 5000, $2, $3)`,
    [subscription.id, T0 + days(1), invoice.id],
  );

  const event = stripeEvent('invoice.payment_succeeded', invoiceObject(), { created: T0 + 60 });
  await deliver(db, event);
  await deliver(db, event);

  const usage = await db.query(
    'SELECT count(*)::int AS n, SUM(quantity)::int AS q FROM usage_events WHERE billed_invoice_id = $1',
    [invoice.id],
  );
  assert.equal(usage.rows[0].n, 1);
  assert.equal(usage.rows[0].q, 5000, 'quantity unchanged by the replay');
  await db.close();
});

test('a handler failure rolls back the ledger row so redelivery reprocesses', async () => {
  const db = await createTestDb();
  const { subscription } = await fixture(db);

  // An unmappable Stripe status makes the handler throw mid-transaction.
  const broken = stripeEvent(
    'customer.subscription.updated',
    { id: 'sub_stripe_1', object: 'subscription', status: 'not_a_real_status' },
    { created: T0 + 60 },
  );

  await assert.rejects(deliver(db, broken), /unmapped Stripe subscription status/);

  const recorded = await db.query(
    'SELECT count(*)::int AS n FROM webhook_events WHERE stripe_event_id = $1',
    [broken.id],
  );
  assert.equal(
    recorded.rows[0].n, 0,
    'the ledger row rolled back with the failed side effects -- otherwise the retry would be discarded as a duplicate and the event lost forever',
  );

  // Stripe redelivers the same event id; this time it is handled.
  const repaired = { ...broken, data: { object: { id: 'sub_stripe_1', object: 'subscription', status: 'canceled' } } };
  const result = await deliver(db, repaired);
  assert.equal(result.status, WEBHOOK_STATUS.PROCESSED);

  const sub = await getSubscriptionRow(db, subscription.id);
  assert.equal(sub.status, STATES.CANCELED);
  await db.close();
});

test('an unrecognised event type is acknowledged, not retried forever', async () => {
  const db = await createTestDb();
  await fixture(db);
  const event = stripeEvent('reporting.report_run.succeeded', { id: 'rr_1' }, { created: T0 });
  const result = await deliver(db, event);
  assert.equal(result.status, WEBHOOK_STATUS.IGNORED);
  await db.close();
});

// ---------------------------------------------------------------------------
// Out-of-order delivery
// ---------------------------------------------------------------------------

test('in-order failure then success leaves the subscription active', async () => {
  const db = await createTestDb();
  const { subscription, invoice } = await fixture(db);

  await deliver(db, stripeEvent(
    'invoice.payment_failed',
    invoiceObject({ status: 'open', attempt_count: 1 }),
    { created: T0 + 100 },
  ));

  let sub = await getSubscriptionRow(db, subscription.id);
  assert.equal(sub.status, STATES.PAST_DUE, 'failure moves it to past_due');

  await deliver(db, stripeEvent(
    'invoice.payment_succeeded',
    invoiceObject({ status: 'paid', attempt_count: 2 }),
    { created: T0 + 200 },
  ));

  sub = await getSubscriptionRow(db, subscription.id);
  assert.equal(sub.status, STATES.ACTIVE, 'the retry succeeded');
  const inv = await getInvoiceRow(db, invoice.id);
  assert.equal(inv.status, 'paid');
  await db.close();
});

test('REVERSED delivery does not corrupt state: success first, then a stale failure', async () => {
  // The exact scenario from the brief: invoice.payment_failed (t=100) and
  // invoice.payment_succeeded (t=200) delivered in reverse order. Applying by
  // arrival order would strand the subscription in past_due while Stripe
  // considers it active.
  const db = await createTestDb();
  const { subscription, invoice } = await fixture(db);

  const succeeded = await deliver(db, stripeEvent(
    'invoice.payment_succeeded',
    invoiceObject({ status: 'paid', attempt_count: 2 }),
    { created: T0 + 200 },
  ));
  assert.equal(succeeded.status, WEBHOOK_STATUS.PROCESSED);

  const failed = await deliver(db, stripeEvent(
    'invoice.payment_failed',
    invoiceObject({ status: 'open', attempt_count: 1 }),
    { created: T0 + 100 },
  ));

  assert.equal(failed.status, WEBHOOK_STATUS.STALE, 'the older event is recorded but not applied');

  const sub = await getSubscriptionRow(db, subscription.id);
  assert.equal(sub.status, STATES.ACTIVE, 'state reflects the NEWER event, not the last to arrive');
  const inv = await getInvoiceRow(db, invoice.id);
  assert.equal(inv.status, 'paid');

  // And no dunning was scheduled off the stale failure.
  const dunning = await db.query('SELECT count(*)::int AS n FROM dunning_attempts');
  assert.equal(dunning.rows[0].n, 0);
  await db.close();
});

test('same-second events are ordered by attempt_count, not by arrival', async () => {
  // Stripe's event.created has one-second granularity, so a failure and its
  // retry genuinely can share a timestamp. attempt_count breaks the tie.
  const db = await createTestDb();
  const { subscription } = await fixture(db);

  await deliver(db, stripeEvent(
    'invoice.payment_succeeded',
    invoiceObject({ status: 'paid', attempt_count: 3 }),
    { created: T0 + 500 },
  ));

  const stale = await deliver(db, stripeEvent(
    'invoice.payment_failed',
    invoiceObject({ status: 'open', attempt_count: 2 }),
    { created: T0 + 500 }, // identical timestamp, lower attempt
  ));

  assert.equal(stale.status, WEBHOOK_STATUS.STALE);
  const sub = await getSubscriptionRow(db, subscription.id);
  assert.equal(sub.status, STATES.ACTIVE);
  await db.close();
});

test('same second and same attempt: success outranks failure', async () => {
  const db = await createTestDb();
  const { subscription } = await fixture(db);

  await deliver(db, stripeEvent(
    'invoice.payment_succeeded',
    invoiceObject({ status: 'paid', attempt_count: 1 }),
    { created: T0 + 700 },
  ));
  const stale = await deliver(db, stripeEvent(
    'invoice.payment_failed',
    invoiceObject({ status: 'open', attempt_count: 1 }),
    { created: T0 + 700 },
  ));

  assert.equal(stale.status, WEBHOOK_STATUS.STALE, 'type rank is the last-resort tiebreak');
  const sub = await getSubscriptionRow(db, subscription.id);
  assert.equal(sub.status, STATES.ACTIVE);
  await db.close();
});

test('a late success cannot resurrect a canceled subscription', async () => {
  const db = await createTestDb();
  const { subscription } = await fixture(db);

  await deliver(db, stripeEvent(
    'customer.subscription.deleted',
    { id: 'sub_stripe_1', object: 'subscription', status: 'canceled', canceled_at: T0 + 900 },
    { created: T0 + 900 },
  ));
  assert.equal((await getSubscriptionRow(db, subscription.id)).status, STATES.CANCELED);

  // A payment webhook that was stuck in a queue finally lands.
  await deliver(db, stripeEvent(
    'invoice.payment_succeeded',
    invoiceObject({ status: 'paid', attempt_count: 1 }),
    { created: T0 + 950 },
  ));

  const sub = await getSubscriptionRow(db, subscription.id);
  assert.equal(sub.status, STATES.CANCELED, 'canceled is terminal and absorbing');
  await db.close();
});

test('a failure on one invoice is not masked by a newer success on another', async () => {
  // This is why subscription status is DERIVED from invoice facts rather than
  // stamped by a per-subscription timestamp. With a shared timestamp guard the
  // older failure on invoice B would look stale and be dropped, leaving the
  // subscription active while an invoice is genuinely unpaid.
  const db = await createTestDb();
  const { subscription, customer } = await fixture(db);

  const invB = await db.query(
    `INSERT INTO invoices
       (subscription_id, customer_id, amount_cents, status, period_start, period_end, stripe_invoice_id)
     VALUES ($1,$2,1500,'pending',$3,$4,'in_stripe_2') RETURNING *`,
    [subscription.id, customer.id, T0, T0 + days(30)],
  );

  // Invoice A succeeds at t=200.
  await deliver(db, stripeEvent(
    'invoice.payment_succeeded',
    invoiceObject({ status: 'paid', attempt_count: 1 }),
    { created: T0 + 200 },
  ));
  assert.equal((await getSubscriptionRow(db, subscription.id)).status, STATES.ACTIVE);

  // Invoice B failed EARLIER at t=150 but arrives now.
  const result = await deliver(db, stripeEvent(
    'invoice.payment_failed',
    { id: 'in_stripe_2', object: 'invoice', status: 'open', attempt_count: 1, amount_due: 1500 },
    { created: T0 + 150 },
  ));

  assert.notEqual(result.status, WEBHOOK_STATUS.STALE, 'a different invoice has its own ordering');
  assert.equal((await getInvoiceRow(db, invB.rows[0].id)).status, 'failed');
  assert.equal(
    (await getSubscriptionRow(db, subscription.id)).status,
    STATES.PAST_DUE,
    'derived from the full set of invoice facts',
  );
  await db.close();
});

test('replaying the same events in any order converges on the same state', async () => {
  // The property that makes derived status trustworthy.
  const events = [
    stripeEvent('invoice.payment_failed', invoiceObject({ status: 'open', attempt_count: 1 }), { created: T0 + 100 }),
    stripeEvent('invoice.payment_succeeded', invoiceObject({ status: 'paid', attempt_count: 2 }), { created: T0 + 200 }),
  ];

  const orders = [[0, 1], [1, 0]];
  const finals = [];

  for (const order of orders) {
    const db = await createTestDb();
    const { subscription } = await fixture(db);
    for (const i of order) await deliver(db, events[i]);
    finals.push((await getSubscriptionRow(db, subscription.id)).status);
    await db.close();
  }

  assert.deepEqual(finals, [STATES.ACTIVE, STATES.ACTIVE], 'order-independent');
});
