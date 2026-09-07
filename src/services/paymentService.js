/**
 * Collecting money, and getting the answer back.
 *
 * This is the only place that talks to Stripe over the network, and it does so
 * with NO database transaction open (see invoiceService for why). It also never
 * writes a paid/failed status: the API response is a hint, the webhook is the
 * fact. Marking an invoice paid because `invoices.pay()` returned 200 is how
 * local state drifts -- the charge can still be reversed, and the webhook is
 * the thing that reflects the final truth.
 */

import { getStripe } from '../stripe/client.js';
import { signPayload } from '../stripe/signature.js';
import { processWebhook } from './webhookService.js';
import { config } from '../config.js';

/**
 * Push an invoice to Stripe and attempt collection.
 * Returns without waiting for the outcome; the webhook carries that.
 */
export async function payInvoice(db, invoiceId, { stripe } = {}) {
  const client = stripe ?? (await getStripe());

  const { rows } = await db.query(
    `SELECT i.*, c.email, c.name, c.stripe_customer_id, s.stripe_subscription_id
       FROM invoices i
       JOIN customers c ON c.id = i.customer_id
       JOIN subscriptions s ON s.id = i.subscription_id
      WHERE i.id = $1`,
    [invoiceId],
  );
  const invoice = rows[0];
  if (!invoice) throw Object.assign(new Error(`invoice ${invoiceId} not found`), { statusCode: 404 });

  if (invoice.amount_cents <= 0) {
    return { skipped: true, reason: 'nothing to collect' };
  }
  if (invoice.status === 'paid') {
    return { skipped: true, reason: 'already paid' };
  }

  const stripeCustomerId = invoice.stripe_customer_id
    ?? (await ensureStripeCustomer(db, client, invoice));

  const lines = await db.query(
    'SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY sort_order',
    [invoiceId],
  );

  let stripeInvoiceId = invoice.stripe_invoice_id;
  if (!stripeInvoiceId) {
    const created = await client.invoices.create({
      customer: stripeCustomerId,
      subscription: invoice.stripe_subscription_id ?? undefined,
      amount_due: Number(invoice.amount_cents),
      lines: lines.rows.map((l) => ({
        amount_cents: Number(l.amount_cents),
        description: l.description,
        currency: invoice.currency,
      })),
      metadata: { local_invoice_id: invoice.id },
    });
    stripeInvoiceId = created.id;

    // Link BEFORE attempting payment. If the process dies between the charge
    // and this write, the resulting webhook would have no local invoice to
    // match and the payment would be invisible.
    await db.query('UPDATE invoices SET stripe_invoice_id = $1 WHERE id = $2', [
      stripeInvoiceId,
      invoice.id,
    ]);
  }

  await client.invoices.finalize(stripeInvoiceId);
  const result = await client.invoices.pay(stripeInvoiceId);

  return { stripeInvoiceId, stripeStatus: result.status, attemptCount: result.attempt_count };
}

async function ensureStripeCustomer(db, client, invoice) {
  const created = await client.customers.create({
    email: invoice.email,
    name: invoice.name,
    metadata: { local_customer_id: invoice.customer_id },
  });
  await db.query('UPDATE customers SET stripe_customer_id = $1 WHERE id = $2', [
    created.id,
    invoice.customer_id,
  ]);
  return created.id;
}

/**
 * Offline only: feed the fake's emitted events through the REAL webhook path,
 * signed with the real secret and verified by the real verifier.
 *
 * The point is that offline mode exercises the production code path rather than
 * a shortcut. Nothing here is reachable when a live Stripe key is configured --
 * with one, actual Stripe delivers to the HTTP endpoint instead.
 */
export async function drainFakeWebhooks(db, stripe, { secret = config.stripe.webhookSecret } = {}) {
  if (stripe.__live) {
    throw new Error('drainFakeWebhooks called with a live Stripe client');
  }
  const events = [...stripe.__events()];
  stripe.__clearEvents();

  const results = [];
  for (const event of events) {
    const rawBody = Buffer.from(JSON.stringify(event), 'utf8');
    const header = signPayload({ payload: rawBody, secret, timestamp: event.created });
    results.push(await processWebhook(db, {
      rawBody,
      signatureHeader: header,
      secret,
      now: event.created,
    }));
  }
  return results;
}

/** Convenience for the demo/tests: charge, then settle the resulting webhooks. */
export async function payAndSettle(db, invoiceId, { stripe } = {}) {
  const client = stripe ?? (await getStripe());
  const paid = await payInvoice(db, invoiceId, { stripe: client });
  if (client.__live) return { ...paid, settled: null };
  const settled = await drainFakeWebhooks(db, client);
  return { ...paid, settled };
}
