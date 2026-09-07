/**
 * Seed plans and a handful of customers in assorted states, so the admin
 * dashboard has something real to show on a fresh install.
 */

import { getDb, migrate } from '../src/db/index.js';
import { getStripe } from '../src/stripe/client.js';
import { createSubscription, renewSubscription } from '../src/services/subscriptionService.js';
import { recordUsage } from '../src/services/usageService.js';
import { payAndSettle } from '../src/services/paymentService.js';
import { formatCents } from '../src/domain/money.js';
import { days } from '../src/domain/time.js';

const db = await getDb();
await migrate(db);
const stripe = await getStripe();

const now = Math.floor(Date.now() / 1000);
const start = now - days(40); // far enough back that one period has closed

await db.query(`
  INSERT INTO plans (id, name, base_price_cents, included_units, metered_rate_microcents,
                     metered_unit_label, trial_days)
  VALUES
    ('starter','Starter',  2900,   10000, 1000000, 'API calls', 0),
    ('pro',    'Pro',      9900,  100000,  500000, 'API calls', 0),
    ('scale',  'Scale',   29900, 1000000,  250000, 'API calls', 0),
    ('trial',  'Pro Trial',9900,  100000,  500000, 'API calls', 14)
  ON CONFLICT (id) DO NOTHING
`);

async function customer(email, name) {
  const { rows } = await db.query(
    `INSERT INTO customers (email, name) VALUES ($1,$2)
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING *`,
    [email, name],
  );
  return rows[0];
}

console.log('seeding...\n');

// 1. A healthy customer, one closed period with metered overage.
const ada = await customer('ada@example.com', 'Ada Lovelace');
const adaSub = await createSubscription(db, { customerId: ada.id, planId: 'starter', at: start });
await payAndSettle(db, adaSub.invoice.id, { stripe });
await recordUsage(db, { subscriptionId: adaSub.subscription.id, quantity: 14_200, timestamp: start + days(5) });
const adaRenewal = await renewSubscription(db, {
  subscriptionId: adaSub.subscription.id,
  at: Number(adaSub.subscription.current_period_end),
});
await payAndSettle(db, adaRenewal.invoice.id, { stripe });
console.log(`  ada@example.com     starter, renewed, invoice ${formatCents(Number(adaRenewal.invoice.amount_cents))}`);

// 2. A customer who upgraded mid-cycle.
const grace = await customer('grace@example.com', 'Grace Hopper');
const graceSub = await createSubscription(db, { customerId: grace.id, planId: 'starter', at: start });
await payAndSettle(db, graceSub.invoice.id, { stripe });
const { changePlan } = await import('../src/services/subscriptionService.js');
const upgrade = await changePlan(db, {
  subscriptionId: graceSub.subscription.id, newPlanId: 'pro', at: start + days(10),
});
await payAndSettle(db, upgrade.invoice.id, { stripe });
console.log(`  grace@example.com   upgraded to pro, prorated ${formatCents(upgrade.proration.netCents)}`);

// 3. A customer in dunning: their renewal declined.
const alan = await customer('alan@example.com', 'Alan Turing');
const alanSub = await createSubscription(db, { customerId: alan.id, planId: 'pro', at: start });
await payAndSettle(db, alanSub.invoice.id, { stripe });
if (!stripe.__live) stripe.__failNextPayment();
const alanRenewal = await renewSubscription(db, {
  subscriptionId: alanSub.subscription.id,
  at: Number(alanSub.subscription.current_period_end),
});
await payAndSettle(db, alanRenewal.invoice.id, { stripe });
if (!stripe.__live) stripe.__succeedNextPayment();
console.log('  alan@example.com    pro, payment declined -> past_due, dunning scheduled');

// 4. A customer on trial.
const katherine = await customer('katherine@example.com', 'Katherine Johnson');
await createSubscription(db, { customerId: katherine.id, planId: 'trial', at: now - days(3) });
console.log('  katherine@example.com  on a 14-day trial');

const counts = await db.query('SELECT status, COUNT(*)::int AS n FROM subscriptions GROUP BY status');
console.log(`\nsubscriptions: ${counts.rows.map((r) => `${r.status}=${r.n}`).join(' ')}`);
console.log('\nrun `npm start` and open http://localhost:3000/admin');
await db.close();
