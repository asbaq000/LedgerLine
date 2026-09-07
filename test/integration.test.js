/**
 * Whole-system behaviour: the money has to reconcile, and the HTTP surface has
 * to preserve the properties the service layer depends on.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/http/app.js';
import { createSubscription, changePlan, renewSubscription } from '../src/services/subscriptionService.js';
import { payAndSettle } from '../src/services/paymentService.js';
import { listInvoicesForCustomer } from '../src/services/invoiceService.js';
import { recordUsage } from '../src/services/usageService.js';
import { dashboard } from '../src/services/adminService.js';
import { STATES } from '../src/domain/subscriptionState.js';
import { signPayload } from '../src/stripe/signature.js';
import { toDate } from '../src/domain/time.js';
import {
  createTestDb, createTestStripe, seedPlans, seedTrialPlan, createCustomer,
  T0, days, TEST_WEBHOOK_SECRET, stripeEvent,
} from './helpers.js';

/** Sum of every invoice ever issued to a customer. */
async function cashCollected(db, customerId) {
  const { rows } = await db.query(
    'SELECT COALESCE(SUM(amount_cents), 0)::bigint AS total FROM invoices WHERE customer_id = $1',
    [customerId],
  );
  return Number(rows[0].total);
}

test('a full cycle with two plan changes reconciles to the penny', async () => {
  // The invariant that matters: total invoiced === what the customer actually
  // consumed. This is the test that caught a real bug -- the downgrade credit
  // was being granted twice, once as a negative invoice and again as banked
  // balance applied to the next invoice.
  const db = await createTestDb();
  const stripe = createTestStripe();
  await seedPlans(db);
  const customer = await createCustomer(db);

  // Jan 1 -> Feb 1 is 31 days.
  const { subscription, invoice } = await createSubscription(db, {
    customerId: customer.id, planId: 'starter', at: T0,
  });
  await payAndSettle(db, invoice.id, { stripe });
  const periodEnd = Number(subscription.current_period_end);
  assert.equal((periodEnd - T0) / days(1), 31, 'January is 31 days');

  await recordUsage(db, { subscriptionId: subscription.id, quantity: 12_000, timestamp: T0 + days(5) });

  const up = await changePlan(db, { subscriptionId: subscription.id, newPlanId: 'pro', at: T0 + days(10) });
  await payAndSettle(db, up.invoice.id, { stripe });

  const down = await changePlan(db, { subscriptionId: subscription.id, newPlanId: 'starter', at: T0 + days(20) });

  // Hand-worked ledger for the 31-day period:
  //   starter [0,10)   2900 - round(2900*21/31)=1965  ->  935
  //   pro     [10,20)  6706 - round(6706*11/21)=3513  -> 3193
  //   starter [20,31)  round(2900*11/31)                -> 1029
  const items = await db.query(
    'SELECT plan_id, amount_cents FROM billed_items WHERE subscription_id = $1 ORDER BY starts_at',
    [subscription.id],
  );
  assert.deepEqual(items.rows.map((r) => Number(r.amount_cents)), [935, 3193, 1029]);
  const periodCost = 935 + 3193 + 1029; // 5157

  // The downgrade banks credit rather than refunding cash, so its invoice nets zero.
  assert.equal(Number(down.invoice.amount_cents), 0, 'no cash goes back to the card');
  const banked = await db.query('SELECT credit_balance_cents FROM subscriptions WHERE id = $1', [subscription.id]);
  assert.equal(Number(banked.rows[0].credit_balance_cents), 2484);

  // Renew: metered arrears for January + base in advance for February - credit.
  const renewal = await renewSubscription(db, { subscriptionId: subscription.id, at: periodEnd });
  await payAndSettle(db, renewal.invoice.id, { stripe });

  const meteredCents = 2_000;  // 12,000 - 10,000 included, at $0.01
  const februaryBase = 2_900;
  const expectedCash = periodCost + meteredCents + februaryBase;

  assert.equal(
    await cashCollected(db, customer.id),
    expectedCash,
    'every cent invoiced is a cent consumed -- the banked credit is spent exactly once',
  );
  assert.equal(expectedCash, 10_057);

  // And every invoice is visible in billing history.
  const history = await listInvoicesForCustomer(db, customer.id);
  assert.equal(history.length, 4, 'created, upgrade, downgrade, renewal');
  assert.ok(history.every((i) => i.lines.length > 0), 'every invoice has line detail');
  await db.close();
});

test('a trial converts to a paying subscription at rollover', async () => {
  const db = await createTestDb();
  const stripe = createTestStripe();
  await seedTrialPlan(db, { trialDays: 14 });
  const customer = await createCustomer(db);

  const { subscription, invoice } = await createSubscription(db, {
    customerId: customer.id, planId: 'trial', at: T0,
  });

  assert.equal(subscription.status, STATES.TRIALING);
  assert.equal(invoice, null, 'a trial is not invoiced');
  assert.equal(Number(subscription.current_period_end), T0 + days(14));

  const renewal = await renewSubscription(db, {
    subscriptionId: subscription.id,
    at: Number(subscription.current_period_end),
  });
  await payAndSettle(db, renewal.invoice.id, { stripe });

  assert.equal(renewal.subscription.status, STATES.ACTIVE, 'trial expiry is just the renewal path');
  assert.equal(Number(renewal.invoice.amount_cents), 4900, 'first real charge');
  await db.close();
});

test('the billing anchor survives a short month', async () => {
  // A Jan-31 subscription must bill Feb 28 and then return to Mar 31, rather
  // than sticking to the 28th for the rest of its life.
  const db = await createTestDb();
  await seedPlans(db);
  const customer = await createCustomer(db);

  const jan31 = Math.floor(Date.UTC(2025, 0, 31) / 1000);
  const { subscription } = await createSubscription(db, {
    customerId: customer.id, planId: 'starter', at: jan31,
  });
  assert.equal(Number(subscription.billing_anchor_day), 31);

  let current = subscription;
  const boundaries = [];
  for (let i = 0; i < 3; i += 1) {
    const result = await renewSubscription(db, {
      subscriptionId: current.id,
      at: Number(current.current_period_end),
    });
    current = result.subscription;
    boundaries.push(toDate(Number(current.current_period_start)).toISOString().slice(0, 10));
  }

  assert.deepEqual(boundaries, ['2025-02-28', '2025-03-31', '2025-04-30']);
  await db.close();
});

test('an immediate cancellation stops billing and blocks further changes', async () => {
  const db = await createTestDb();
  const stripe = createTestStripe();
  await seedPlans(db);
  const customer = await createCustomer(db);

  const { subscription, invoice } = await createSubscription(db, {
    customerId: customer.id, planId: 'starter', at: T0,
  });
  await payAndSettle(db, invoice.id, { stripe });

  const { cancelSubscription } = await import('../src/services/subscriptionService.js');
  const result = await cancelSubscription(db, { subscriptionId: subscription.id, at: T0 + days(5) });
  assert.equal(result.subscription.status, STATES.CANCELED);

  await assert.rejects(
    changePlan(db, { subscriptionId: subscription.id, newPlanId: 'pro', at: T0 + days(6) }),
    /illegal subscription transition/,
  );
  await db.close();
});

test('cancel-at-period-end lets the period finish, then stops', async () => {
  const db = await createTestDb();
  const stripe = createTestStripe();
  await seedPlans(db);
  const customer = await createCustomer(db);

  const { subscription, invoice } = await createSubscription(db, {
    customerId: customer.id, planId: 'starter', at: T0,
  });
  await payAndSettle(db, invoice.id, { stripe });

  const { cancelSubscription } = await import('../src/services/subscriptionService.js');
  const pending = await cancelSubscription(db, {
    subscriptionId: subscription.id, atPeriodEnd: true, at: T0 + days(5),
  });
  assert.equal(pending.subscription.status, STATES.ACTIVE, 'still active until the period ends');
  assert.equal(pending.subscription.cancel_at_period_end, true);

  const renewal = await renewSubscription(db, {
    subscriptionId: subscription.id,
    at: Number(subscription.current_period_end),
  });
  assert.equal(renewal.renewed, false);
  assert.equal(renewal.invoice, null, 'no renewal invoice is issued');
  assert.equal(renewal.subscription.status, STATES.CANCELED);
  await db.close();
});

test('a payment recovers when the provider has no record of the linked invoice', async () => {
  // Two ways this happens: a real Stripe invoice deleted upstream, and the
  // offline double after a process restart -- its state is in memory while the
  // invoice link is in Postgres. `npm run seed && npm start` hits the second
  // one, and it used to crash the dunning worker with a TypeError, stranding a
  // debt that was still collectable.
  const db = await createTestDb();
  await seedPlans(db);
  const customer = await createCustomer(db);

  const original = createTestStripe();
  const { subscription, invoice } = await createSubscription(db, {
    customerId: customer.id, planId: 'starter', at: T0,
  });
  await payAndSettle(db, invoice.id, { stripe: original });

  // A renewal that declines, leaving a failed invoice linked to a provider id.
  original.__failNextPayment();
  const renewal = await renewSubscription(db, {
    subscriptionId: subscription.id,
    at: Number(subscription.current_period_end),
  });
  await payAndSettle(db, renewal.invoice.id, { stripe: original });

  const before = await db.query('SELECT status, stripe_invoice_id FROM invoices WHERE id = $1',
    [renewal.invoice.id]);
  assert.equal(before.rows[0].status, 'failed');
  const staleId = before.rows[0].stripe_invoice_id;
  assert.ok(staleId, 'linked to a provider invoice');

  // The process restarts: a brand new double that has never heard of staleId.
  const restarted = createTestStripe();
  await assert.rejects(
    restarted.invoices.finalize(staleId),
    (e) => e.statusCode === 404,
    'the double reports a missing invoice the way Stripe does, not as a TypeError',
  );

  // The retry must recover rather than abandon the debt.
  await payAndSettle(db, renewal.invoice.id, { stripe: restarted });

  const after = await db.query('SELECT status, stripe_invoice_id FROM invoices WHERE id = $1',
    [renewal.invoice.id]);
  assert.equal(after.rows[0].status, 'paid', 'collected on the retry');
  assert.notEqual(after.rows[0].stripe_invoice_id, staleId, 're-linked to a fresh provider invoice');

  const sub = await db.query('SELECT status FROM subscriptions WHERE id = $1', [subscription.id]);
  assert.equal(sub.rows[0].status, STATES.ACTIVE, 'and the subscription recovered');
  await db.close();
});

test('the admin dashboard reports revenue, status and payment health', async () => {
  const db = await createTestDb();
  const stripe = createTestStripe();
  await seedPlans(db);

  const a = await createCustomer(db, 'a@example.com');
  const b = await createCustomer(db, 'b@example.com');

  const subA = await createSubscription(db, { customerId: a.id, planId: 'starter', at: T0 });
  await payAndSettle(db, subA.invoice.id, { stripe });

  const subB = await createSubscription(db, { customerId: b.id, planId: 'pro', at: T0 });
  await payAndSettle(db, subB.invoice.id, { stripe });

  const view = await dashboard(db);

  assert.equal(view.subscriptions.active, 2);
  assert.equal(view.subscriptions.total, 2);
  assert.equal(view.mrr.totalCents, 2900 + 9900, 'MRR is base price only');
  assert.equal(view.totalRevenueCents, 2900 + 9900);
  assert.equal(view.payments.paid, 2);
  assert.equal(view.payments.rate, 0, 'no failures yet');
  assert.ok(view.webhooks.processed > 0);

  const planIds = view.revenueByPlan.map((r) => r.planId).sort();
  assert.deepEqual(planIds, ['pro', 'starter']);
  await db.close();
});

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

async function withServer(fn) {
  const db = await createTestDb();
  const stripe = createTestStripe();
  const app = await createApp({ db, stripe });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn({ base, db, stripe });
  } finally {
    server.close();
    await db.close();
  }
}

test('the webhook endpoint rejects an unsigned delivery with 400', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/webhooks/stripe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(stripeEvent('invoice.payment_succeeded', { id: 'in_x' })),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'signature_verification_failed');
    assert.equal(body.message, undefined, 'no detail leaks to an unauthenticated caller');
  });
});

test('the webhook endpoint verifies against the RAW bytes, not re-serialised JSON', async () => {
  // The property this protects: express.json() must not run before the raw
  // parser on this route. If it did, the signature could only be checked
  // against re-encoded JSON, whose byte order differs -- and every real
  // delivery would fail.
  await withServer(async ({ base, db }) => {
    await seedPlans(db);
    const customer = await createCustomer(db);
    const sub = await db.query(
      `INSERT INTO subscriptions
         (customer_id, plan_id, status, current_period_start, current_period_end,
          billing_anchor_day, stripe_subscription_id)
       VALUES ($1,'starter','active',$2,$3,1,'sub_http_1') RETURNING *`,
      [customer.id, T0, T0 + days(30)],
    );
    await db.query(
      `INSERT INTO invoices
         (subscription_id, customer_id, amount_cents, status, period_start, period_end, stripe_invoice_id)
       VALUES ($1,$2,2900,'pending',$3,$4,'in_http_1')`,
      [sub.rows[0].id, customer.id, T0, T0 + days(30)],
    );

    // Key order here is deliberately not alphabetical; re-serialisation would
    // change the bytes and break the signature.
    const event = stripeEvent(
      'invoice.payment_succeeded',
      { status: 'paid', id: 'in_http_1', attempt_count: 1, amount_due: 2900 },
      { created: Math.floor(Date.now() / 1000) },
    );
    const raw = Buffer.from(JSON.stringify(event), 'utf8');
    const header = signPayload({ payload: raw, secret: TEST_WEBHOOK_SECRET });

    const res = await fetch(`${base}/webhooks/stripe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': header },
      body: raw,
    });

    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, 'processed');

    const invoice = await db.query("SELECT status FROM invoices WHERE stripe_invoice_id = 'in_http_1'");
    assert.equal(invoice.rows[0].status, 'paid');
  });
});

test('a duplicate delivery is acknowledged with 200, not retried', async () => {
  await withServer(async ({ base }) => {
    const event = stripeEvent('invoice.payment_succeeded', { id: 'in_absent', status: 'paid' }, {
      created: Math.floor(Date.now() / 1000),
    });
    const raw = Buffer.from(JSON.stringify(event), 'utf8');
    const header = signPayload({ payload: raw, secret: TEST_WEBHOOK_SECRET });
    const send = () => fetch(`${base}/webhooks/stripe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': header },
      body: raw,
    });

    const first = await send();
    const second = await send();

    assert.equal(first.status, 200);
    assert.equal(second.status, 200, 'a non-2xx would make Stripe redeliver forever');
    assert.equal((await second.json()).status, 'duplicate');
  });
});

test('the REST lifecycle works end to end over HTTP', async () => {
  await withServer(async ({ base, db }) => {
    await seedPlans(db);

    const customerRes = await fetch(`${base}/customers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'grace@example.com', name: 'Grace' }),
    });
    assert.equal(customerRes.status, 201);
    const customer = await customerRes.json();

    const subRes = await fetch(`${base}/subscriptions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ customerId: customer.id, planId: 'starter', at: T0 }),
    });
    assert.equal(subRes.status, 201);
    const { subscription } = await subRes.json();
    assert.equal(subscription.status, 'active');

    // Metered usage, with an idempotency key sent as a header.
    const usageOnce = await fetch(`${base}/subscriptions/${subscription.id}/usage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'k-1' },
      body: JSON.stringify({ quantity: 11_000, timestamp: T0 + days(2) }),
    });
    assert.equal(usageOnce.status, 201);

    const usageAgain = await fetch(`${base}/subscriptions/${subscription.id}/usage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'k-1' },
      body: JSON.stringify({ quantity: 11_000, timestamp: T0 + days(2) }),
    });
    assert.equal(usageAgain.status, 200, 'a suppressed duplicate creates nothing');
    assert.equal((await usageAgain.json()).duplicate, true);

    const summary = await (await fetch(`${base}/subscriptions/${subscription.id}/usage`)).json();
    assert.equal(summary.unbilledUnits, 11_000);
    assert.equal(summary.projectedMeteredCents, 1_000);

    const changeRes = await fetch(`${base}/subscriptions/${subscription.id}/change-plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planId: 'pro', at: T0 + days(10) }),
    });
    assert.equal(changeRes.status, 200);
    const change = await changeRes.json();
    assert.equal(change.proration.direction, 'upgrade');
    assert.equal(change.proration.netCents, 4741, '31-day January, upgrade on day 10');

    const invoices = await (await fetch(`${base}/customers/${customer.id}/invoices`)).json();
    assert.equal(invoices.length, 2);

    const dash = await (await fetch(`${base}/admin/dashboard`)).json();
    assert.equal(dash.subscriptions.active, 1);

    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.ok, true);
  });
});

test('unknown routes and bad input produce clean errors, not stack traces', async () => {
  await withServer(async ({ base, db }) => {
    await seedPlans(db);

    const missing = await fetch(`${base}/nope`);
    assert.equal(missing.status, 404);

    const badSub = await fetch(`${base}/subscriptions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planId: 'starter' }),
    });
    assert.equal(badSub.status, 400);
    assert.match((await badSub.json()).message, /customerId/);

    const customer = await createCustomer(db, 'x@example.com');
    const unknownPlan = await fetch(`${base}/subscriptions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ customerId: customer.id, planId: 'does_not_exist' }),
    });
    assert.equal(unknownPlan.status, 404);
  });
});
