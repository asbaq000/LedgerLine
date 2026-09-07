import { getDb, migrate } from '../src/db/index.js';
import { createFakeStripe } from '../src/stripe/fake.js';
import { signPayload } from '../src/stripe/signature.js';
import { config } from '../src/config.js';

/**
 * Bound to the configured secret rather than hardcoded.
 *
 * Tests that post to the real HTTP endpoint sign here and are verified by the
 * server using config. If these could differ, the suite would pass or fail
 * depending on whether STRIPE_WEBHOOK_SECRET happened to be exported -- and
 * would fail on a clean `npm test`.
 */
export const TEST_WEBHOOK_SECRET = config.stripe.webhookSecret;

/** 2025-01-01T00:00:00Z. A fixed origin so every assertion is a literal. */
export const T0 = Math.floor(Date.UTC(2025, 0, 1) / 1000);

export const DAY = 86_400;
export const days = (n) => n * DAY;

/** An isolated in-process Postgres per call. */
export async function createTestDb() {
  const db = await getDb({ fresh: true });
  await migrate(db);
  return db;
}

export function createTestStripe({ now = () => T0 } = {}) {
  return createFakeStripe({ now });
}

/** Standard plan fixtures: a $29 starter and a $99 pro, both metered. */
export async function seedPlans(db) {
  await db.query(
    `INSERT INTO plans (id, name, base_price_cents, included_units, metered_rate_microcents, metered_unit_label)
     VALUES ('starter','Starter',2900,10000,1000000,'API calls'),
            ('pro','Pro',9900,100000,500000,'API calls'),
            ('scale','Scale',29900,1000000,250000,'API calls')`,
  );
}

export async function seedTrialPlan(db, { trialDays = 14 } = {}) {
  await db.query(
    `INSERT INTO plans (id, name, base_price_cents, trial_days) VALUES ('trial','Trial Plan',4900,$1)`,
    [trialDays],
  );
}

export async function createCustomer(db, email = 'ada@example.com') {
  const { rows } = await db.query(
    'INSERT INTO customers (email, name) VALUES ($1,$2) RETURNING *',
    [email, 'Ada Lovelace'],
  );
  return rows[0];
}

/**
 * Build a signed webhook delivery exactly as Stripe would send it.
 * Returns the raw bytes AND the header, because verification depends on the
 * bytes being the same object the signature was computed over.
 */
export function makeSignedEvent(event, { secret = TEST_WEBHOOK_SECRET, timestamp } = {}) {
  const rawBody = Buffer.from(JSON.stringify(event), 'utf8');
  const ts = timestamp ?? event.created ?? T0;
  return {
    rawBody,
    signatureHeader: signPayload({ payload: rawBody, secret, timestamp: ts }),
    secret,
    now: ts,
  };
}

let eventCounter = 0;

/** A Stripe-shaped event with a stable, unique id. */
export function stripeEvent(type, object, { created = T0, id } = {}) {
  eventCounter += 1;
  return {
    id: id ?? `evt_test_${String(eventCounter).padStart(5, '0')}`,
    object: 'event',
    type,
    created,
    livemode: false,
    data: { object },
  };
}

/** Link a local invoice to a Stripe id so webhook handlers can find it. */
export async function linkStripeInvoice(db, invoiceId, stripeInvoiceId) {
  await db.query('UPDATE invoices SET stripe_invoice_id = $1 WHERE id = $2', [
    stripeInvoiceId,
    invoiceId,
  ]);
}

export async function getSubscriptionRow(db, id) {
  const { rows } = await db.query('SELECT * FROM subscriptions WHERE id = $1', [id]);
  return rows[0];
}

export async function getInvoiceRow(db, id) {
  const { rows } = await db.query('SELECT * FROM invoices WHERE id = $1', [id]);
  return rows[0];
}
