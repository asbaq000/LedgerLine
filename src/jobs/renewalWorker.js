/**
 * Rolls subscriptions whose period has ended into the next period, issuing the
 * renewal invoice (previous period's metered usage + next period's base).
 */

import { findDueForRenewal, renewSubscription } from '../services/subscriptionService.js';
import { payInvoice, drainFakeWebhooks } from '../services/paymentService.js';
import { getStripe } from '../stripe/client.js';

const nowSeconds = () => Math.floor(Date.now() / 1000);

export async function runDueRenewals(db, { stripe, at = nowSeconds(), limit = 100 } = {}) {
  const client = stripe ?? (await getStripe());
  const due = await findDueForRenewal(db, { at, limit });

  const results = [];
  for (const subscriptionId of due) {
    try {
      const result = await renewSubscription(db, { subscriptionId, at });

      if (result.invoice && Number(result.invoice.amount_cents) > 0) {
        await payInvoice(db, result.invoice.id, { stripe: client });
        if (!client.__live) await drainFakeWebhooks(db, client);
      }

      results.push({
        subscriptionId,
        renewed: result.renewed,
        invoiceId: result.invoice?.id ?? null,
        amountCents: result.invoice ? Number(result.invoice.amount_cents) : 0,
        usage: result.usage,
      });
    } catch (err) {
      // One failing subscription must not stop the rest of the run.
      // eslint-disable-next-line no-console
      console.error(`[renewal] subscription ${subscriptionId} failed:`, err.message);
      results.push({ subscriptionId, error: err.message });
    }
  }

  return { ranAt: at, due: due.length, results };
}
