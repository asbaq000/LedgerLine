/**
 * Executes due dunning retries.
 *
 * The worker deliberately does NOT decide the outcome. It re-attempts
 * collection and stops; whether that moves the subscription to active or
 * schedules the next retry (or cancels) is decided by the resulting webhook.
 * Keeping the decision in one place is what stops the worker and the webhook
 * handler from disagreeing about state.
 */

import { claimDueAttempts, markAttemptFinished } from '../services/dunningService.js';
import { payInvoice, drainFakeWebhooks } from '../services/paymentService.js';
import { getStripe } from '../stripe/client.js';

const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * @param {object} db
 * @param {object} [opts]
 * @param {object} [opts.stripe]
 * @param {number} [opts.at] Simulated clock, so a demo can jump to day 7.
 * @param {number} [opts.limit]
 */
export async function runDueDunning(db, { stripe, at = nowSeconds(), limit = 25 } = {}) {
  const client = stripe ?? (await getStripe());
  const attempts = await claimDueAttempts(db, { at, limit });

  const results = [];
  for (const attempt of attempts) {
    try {
      const outcome = await payInvoice(db, attempt.invoice_id, { stripe: client });

      // Offline: deliver the emitted events through the real webhook path so
      // the outcome is applied exactly as it would be in production.
      if (!client.__live) await drainFakeWebhooks(db, client);

      await markAttemptFinished(db, attempt.id, { status: 'succeeded', at });
      results.push({ attemptId: attempt.id, invoiceId: attempt.invoice_id, ...outcome });
    } catch (err) {
      // 'failed' here means the RETRY MECHANISM failed (Stripe unreachable),
      // not that the card was declined -- a decline arrives as a webhook and is
      // a successful execution of this job.
      await markAttemptFinished(db, attempt.id, {
        status: 'failed',
        error: err.message,
        at,
      });
      results.push({ attemptId: attempt.id, invoiceId: attempt.invoice_id, error: err.message });
    }
  }

  return { ranAt: at, claimed: attempts.length, results };
}
