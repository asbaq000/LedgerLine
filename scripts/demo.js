/**
 * A narrated walk through the four hard problems, against a throwaway database.
 *
 *   npm run demo
 *
 * Everything here goes through the same service code the HTTP API uses, and
 * every webhook is signed and verified through the real verification path.
 */

import { getDb, migrate } from '../src/db/index.js';
import { createFakeStripe } from '../src/stripe/fake.js';
import { createSubscription, changePlan, renewSubscription } from '../src/services/subscriptionService.js';
import { recordUsage, getUsageSummary } from '../src/services/usageService.js';
import { payAndSettle } from '../src/services/paymentService.js';
import { processWebhook } from '../src/services/webhookService.js';
import { runDueDunning } from '../src/jobs/dunningWorker.js';
import { listInvoicesForCustomer } from '../src/services/invoiceService.js';
import { signPayload } from '../src/stripe/signature.js';
import { formatCents } from '../src/domain/money.js';
import { days } from '../src/domain/time.js';
import { config } from '../src/config.js';

const T0 = Math.floor(Date.UTC(2025, 0, 1) / 1000);
const day = (n) => `day ${String(n).padStart(2)}`;

const h = (title) => console.log(`\n\x1b[1m${title}\x1b[0m\n${'-'.repeat(title.length)}`);
const line = (label, value) => console.log(`  ${label.padEnd(38)} ${value}`);

// Quiet the notifier: the demo narrates for itself.
const realLog = console.log;
const mute = (fn) => { const l = console.log; console.log = () => {}; return fn().finally(() => { console.log = l; }); };

const db = await getDb({ fresh: true });
await migrate(db);

let clock = T0;
const stripe = createFakeStripe({ now: () => clock });

await db.query(`
  INSERT INTO plans (id,name,base_price_cents,included_units,metered_rate_microcents,metered_unit_label)
  VALUES ('starter','Starter',2900,10000,1000000,'API calls'),
         ('pro','Pro',9900,100000,500000,'API calls')`);
const customer = (await db.query(
  "INSERT INTO customers (email,name) VALUES ('ada@example.com','Ada') RETURNING *",
)).rows[0];

// ---------------------------------------------------------------------------
h('1. Subscription and advance billing');

const created = await mute(() => createSubscription(db, { customerId: customer.id, planId: 'starter', at: T0 }));
const sub = created.subscription;
await mute(() => payAndSettle(db, created.invoice.id, { stripe }));

const periodEnd = Number(sub.current_period_end);
line('period', `2025-01-01 -> 2025-02-01 (${(periodEnd - T0) / days(1)} days)`);
line('charged in advance', formatCents(Number(created.invoice.amount_cents)));
line('status', sub.status);

// ---------------------------------------------------------------------------
h('2. Proration across two mid-cycle changes');

await mute(() => recordUsage(db, { subscriptionId: sub.id, quantity: 12_000, timestamp: T0 + days(5) }));

const up = await mute(() => changePlan(db, { subscriptionId: sub.id, newPlanId: 'pro', at: T0 + days(10) }));
await mute(() => payAndSettle(db, up.invoice.id, { stripe }));
line(`${day(10)} upgrade starter -> pro`, '');
for (const l of [...up.proration.credits, ...up.proration.charges]) {
  line(`    ${l.description}`, formatCents(l.amountCents));
}
line('    net charged today', formatCents(up.proration.netCents));

const down = await mute(() => changePlan(db, { subscriptionId: sub.id, newPlanId: 'starter', at: T0 + days(20) }));
line(`${day(20)} downgrade pro -> starter`, '');
for (const l of [...down.proration.credits, ...down.proration.charges]) {
  line(`    ${l.description}`, formatCents(l.amountCents));
}
line('    net (banked, not refunded)', formatCents(down.proration.netCents));

const items = await db.query(
  'SELECT plan_id, amount_cents, starts_at, ends_at FROM billed_items WHERE subscription_id=$1 ORDER BY starts_at',
  [sub.id],
);
console.log('\n  ledger -- what each segment actually cost:');
for (const i of items.rows) {
  line(`    ${i.plan_id} d${(i.starts_at - T0) / days(1)}-${(i.ends_at - T0) / days(1)}`,
    formatCents(Number(i.amount_cents)));
}
line('    period total', formatCents(items.rows.reduce((a, i) => a + Number(i.amount_cents), 0)));

// ---------------------------------------------------------------------------
h('3. Metered usage across the cycle boundary');

await mute(() => recordUsage(db, { subscriptionId: sub.id, quantity: 500, timestamp: periodEnd - 1 }));
await mute(() => recordUsage(db, { subscriptionId: sub.id, quantity: 900, timestamp: periodEnd }));
line('event 1s BEFORE rollover', '500 calls  -> this period');
line('event AT the rollover instant', '900 calls  -> next period (half-open)');

const summary = await getUsageSummary(db, sub.id);
line('unbilled this period', `${summary.unbilledUnits} calls`);

clock = periodEnd;
const renewal = await mute(() => renewSubscription(db, { subscriptionId: sub.id, at: periodEnd }));
await mute(() => payAndSettle(db, renewal.invoice.id, { stripe }));
line('renewal claimed', `${renewal.usage.units} calls`);

// A straggler: timestamped inside the period we already invoiced.
await mute(() => recordUsage(db, { subscriptionId: sub.id, quantity: 300, timestamp: periodEnd - 5 }));
const late = await getUsageSummary(db, sub.id);
line('late arrival, already-closed period', `${late.lateUnits} calls -> swept onto the NEXT invoice`);

console.log('\n  renewal invoice:');
const rlines = await db.query(
  'SELECT kind, description, amount_cents FROM invoice_lines WHERE invoice_id=$1 ORDER BY sort_order',
  [renewal.invoice.id],
);
for (const l of rlines.rows) line(`    ${l.description}`, formatCents(Number(l.amount_cents)));
line('    total', formatCents(Number(renewal.invoice.amount_cents)));

// ---------------------------------------------------------------------------
h('4. Webhooks: duplicate and out-of-order delivery');

const stripeInvoiceId = (await db.query('SELECT stripe_invoice_id FROM invoices WHERE id=$1', [renewal.invoice.id]))
  .rows[0].stripe_invoice_id;

const send = (type, object, created) => {
  const event = {
    id: `evt_demo_${type}_${created}`, object: 'event', type, created, data: { object },
  };
  const rawBody = Buffer.from(JSON.stringify(event), 'utf8');
  return processWebhook(db, {
    rawBody,
    signatureHeader: signPayload({ payload: rawBody, secret: config.stripe.webhookSecret, timestamp: created }),
    now: created,
  });
};

const inv = (status, attempt) => ({
  id: stripeInvoiceId, object: 'invoice', status, attempt_count: attempt, amount_due: 2900,
});

const dup1 = await mute(() => send('invoice.payment_succeeded', inv('paid', 1), periodEnd + 10));
const dup2 = await mute(() => send('invoice.payment_succeeded', inv('paid', 1), periodEnd + 10));
line('same event id delivered twice', `${dup1.status}, then ${dup2.status}`);

const stale = await mute(() => send('invoice.payment_failed', inv('open', 1), periodEnd + 5));
line('an OLDER failure arriving afterwards', `${stale.status} -- not applied`);
const status = (await db.query('SELECT status FROM subscriptions WHERE id=$1', [sub.id])).rows[0].status;
line('subscription status', `${status} (reflects the newer event, not the last to arrive)`);

// ---------------------------------------------------------------------------
h('5. Dunning: retry schedule and auto-cancellation');

const p2End = Number((await db.query('SELECT current_period_end FROM subscriptions WHERE id=$1', [sub.id])).rows[0].current_period_end);
clock = p2End;
stripe.__failNextPayment();
const failing = await mute(() => renewSubscription(db, { subscriptionId: sub.id, at: p2End }));
await mute(() => payAndSettle(db, failing.invoice.id, { stripe }));
line('renewal payment', `declined (${formatCents(Number(failing.invoice.amount_cents))})`);
line('subscription', (await db.query('SELECT status FROM subscriptions WHERE id=$1', [sub.id])).rows[0].status);

for (const offset of config.dunning.retryOffsetDays) {
  clock = p2End + days(offset);
  const run = await mute(() => runDueDunning(db, { stripe, at: clock }));
  const s = (await db.query('SELECT status FROM subscriptions WHERE id=$1', [sub.id])).rows[0].status;
  line(`retry on day +${offset}`, `${run.claimed} attempt(s) -> subscription ${s}`);
}

// ---------------------------------------------------------------------------
h('6. Billing history');

const history = await listInvoicesForCustomer(db, customer.id);
for (const i of history.reverse()) {
  line(`${i.status.padEnd(7)} ${i.lines.length} lines`, formatCents(Number(i.amount_cents)));
}
line('total invoiced', formatCents(history.reduce((a, i) => a + Number(i.amount_cents), 0)));

const notes = await db.query('SELECT template, COUNT(*)::int AS n FROM notifications GROUP BY template ORDER BY template');
console.log('\n  notifications sent:');
for (const n of notes.rows) line(`    ${n.template}`, n.n);

realLog('\nRun `npm test` for the assertions behind all of this.\n');
await db.close();
