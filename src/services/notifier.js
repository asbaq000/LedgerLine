/**
 * Customer notifications.
 *
 * Every notification is PERSISTED as well as delivered. Console logging alone
 * would make "did the day-3 dunning email actually go out?" unanswerable after
 * the process restarts, and that question is exactly what you need to answer
 * when a customer disputes a cancellation.
 */

import { config } from '../config.js';
import { formatCents } from '../domain/money.js';
import { toDate } from '../domain/time.js';

const TEMPLATES = {
  subscription_created: ({ planName, amountCents, periodEnd }) => ({
    subject: `Welcome to ${planName}`,
    body: `Your ${planName} subscription is active. You were charged ${formatCents(amountCents)}. `
      + `Next renewal: ${toDate(periodEnd).toISOString().slice(0, 10)}.`,
  }),

  plan_changed: ({ fromPlan, toPlan, netCents }) => ({
    subject: `Your plan changed to ${toPlan}`,
    body: netCents >= 0
      ? `Switched from ${fromPlan} to ${toPlan}. Prorated charge today: ${formatCents(netCents)}.`
      : `Switched from ${fromPlan} to ${toPlan}. A credit of ${formatCents(-netCents)} `
        + 'has been applied to your account and will reduce your next invoice.',
  }),

  invoice_paid: ({ amountCents, invoiceId }) => ({
    subject: `Payment received - ${formatCents(amountCents)}`,
    body: `Thanks. Invoice ${invoiceId} is paid.`,
  }),

  payment_failed_retry: ({ amountCents, attempt, maxAttempts, retryAt }) => ({
    subject: `Payment failed - we will retry (attempt ${attempt} of ${maxAttempts})`,
    body: `We could not collect ${formatCents(amountCents)}. We will try again on `
      + `${toDate(retryAt).toISOString().slice(0, 10)}. Update your card to avoid interruption.`,
  }),

  payment_failed_final_notice: ({ amountCents, retryAt }) => ({
    subject: 'Final notice: update your payment method',
    body: `This is the last automatic retry for ${formatCents(amountCents)}, on `
      + `${toDate(retryAt).toISOString().slice(0, 10)}. If it fails your subscription will be canceled.`,
  }),

  subscription_canceled_for_nonpayment: ({ amountCents }) => ({
    subject: 'Your subscription has been canceled',
    body: `After several attempts we were unable to collect ${formatCents(amountCents)}. `
      + 'Your subscription is now canceled. You can resubscribe at any time.',
  }),

  trial_ending: ({ planName, trialEnd }) => ({
    subject: `Your ${planName} trial ends soon`,
    body: `Your trial ends ${toDate(trialEnd).toISOString().slice(0, 10)} and billing begins.`,
  }),
};

/**
 * Render, deliver, and record a notification.
 * `db` may be a transaction scope -- notifications written inside the same
 * transaction as the state change they describe cannot survive a rollback.
 */
export async function notify(db, { customerId, subscriptionId, template, data = {}, email }) {
  const render = TEMPLATES[template];
  if (!render) throw new TypeError(`notify: unknown template ${template}`);

  const { subject, body } = render(data);
  const channel = config.email.apiKey ? 'email' : 'console';

  if (channel === 'console') {
    // eslint-disable-next-line no-console
    console.log(`[notify] to=${email ?? customerId} template=${template}\n  ${subject}\n  ${body}`);
  } else {
    await deliverEmail({ to: email, subject, body });
  }

  await db.query(
    `INSERT INTO notifications (customer_id, subscription_id, channel, template, subject, body)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [customerId ?? null, subscriptionId ?? null, channel, template, subject, body],
  );

  return { subject, body, channel };
}

async function deliverEmail({ to, subject, body }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.email.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: config.email.from, to, subject, text: body }),
  });
  if (!res.ok) {
    // Never let a failed notification roll back the billing state change that
    // triggered it -- the money movement is the important part.
    // eslint-disable-next-line no-console
    console.error(`[notify] delivery failed (${res.status}): ${await res.text()}`);
  }
}

export const __templates = TEMPLATES;
