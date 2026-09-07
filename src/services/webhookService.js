/**
 * Stripe webhook ingestion.
 *
 * ---------------------------------------------------------------------------
 * Idempotency
 * ---------------------------------------------------------------------------
 * The insert into webhook_events and every side effect the event causes share
 * ONE transaction. That single fact gives both guarantees at once:
 *
 *   duplicate  -> the UNIQUE index on stripe_event_id rejects the second
 *                 insert, we return early, and no side effect runs. Two
 *                 concurrent deliveries serialise on the index: the second
 *                 blocks until the first commits, then conflicts.
 *   crash      -> the transaction rolls back INCLUDING the ledger row, so
 *                 Stripe's redelivery is seen as new and reprocesses cleanly.
 *
 * Recording the event first and processing afterwards (the obvious approach)
 * gets this exactly backwards: a crash between the two leaves a row saying
 * "seen" for an event whose effects never happened, and the retry is discarded
 * as a duplicate. The event is then lost permanently and silently.
 *
 * ---------------------------------------------------------------------------
 * Out-of-order delivery
 * ---------------------------------------------------------------------------
 * Two mechanisms, because they solve different halves of the problem:
 *
 * 1. Per-object ordering guard (domain/ordering.js). Each invoice carries the
 *    order key of the last event applied to it. A strictly older event is
 *    recorded as `stale` and not allowed to mutate anything. Within one
 *    invoice, `attempt_count` totally orders the payment attempts, so this is
 *    exact rather than best-effort.
 *
 * 2. DERIVED subscription status. The subscription's status is not mutated
 *    event-by-event; it is RECOMPUTED from the current set of invoice facts
 *    after each event. This matters because a per-subscription timestamp guard
 *    is subtly wrong: invoice X succeeding at t=200 would make a genuine
 *    failure of a different invoice Y at t=150 look stale, and the
 *    subscription would sit `active` while an invoice is unpaid.
 *
 *    Deriving status from facts makes cross-invoice ordering irrelevant --
 *    whatever order the events arrive in, once they have all landed the status
 *    is the same function of the same facts. Ordering then only has to be
 *    correct WITHIN one invoice, which is the case attempt_count nails.
 */

import { verifySignature } from '../stripe/signature.js';
import { orderKey, isStale, fromColumns } from '../domain/ordering.js';
import { STATES, fromStripeStatus } from '../domain/subscriptionState.js';
import { config } from '../config.js';
import { notify } from './notifier.js';
import { scheduleDunningForInvoice, cancelDunningForInvoice } from './dunningService.js';

export const WEBHOOK_STATUS = Object.freeze({
  PROCESSED: 'processed',
  DUPLICATE: 'duplicate',
  STALE: 'stale',
  IGNORED: 'ignored',
  FAILED: 'failed',
});

/**
 * Verify, deduplicate and apply one webhook delivery.
 *
 * @param {object} db
 * @param {object} args
 * @param {Buffer|string} args.rawBody EXACT bytes received. Never re-serialised JSON.
 * @param {string} args.signatureHeader
 * @param {string} [args.secret]
 * @param {number} [args.now] epoch seconds, injectable for tests
 */
export async function processWebhook(db, {
  rawBody,
  signatureHeader,
  secret = config.stripe.webhookSecret,
  toleranceSeconds = config.stripe.toleranceSeconds,
  now,
}) {
  // Throws SignatureVerificationError (statusCode 400) on anything unverified.
  verifySignature({
    payload: rawBody,
    header: signatureHeader,
    secret,
    toleranceSeconds,
    ...(now === undefined ? {} : { now }),
  });

  const event = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody);
  if (!event?.id || !event?.type) {
    const err = new Error('malformed event: missing id or type');
    err.statusCode = 400;
    throw err;
  }

  return db.tx(async (tx) => {
    // The whole idempotency mechanism, in one statement.
    const claim = await tx.query(
      `INSERT INTO webhook_events (stripe_event_id, type, event_created, payload, status)
       VALUES ($1, $2, $3, $4, 'processed')
       ON CONFLICT (stripe_event_id) DO NOTHING
       RETURNING id`,
      [event.id, event.type, event.created ?? 0, JSON.stringify(event)],
    );

    if (claim.rows.length === 0) {
      return { status: WEBHOOK_STATUS.DUPLICATE, eventId: event.id, type: event.type };
    }
    const webhookRowId = claim.rows[0].id;

    const handler = HANDLERS[event.type];
    if (!handler) {
      await finish(tx, webhookRowId, WEBHOOK_STATUS.IGNORED);
      return { status: WEBHOOK_STATUS.IGNORED, eventId: event.id, type: event.type };
    }

    const outcome = await handler(tx, event);
    const status = outcome?.stale ? WEBHOOK_STATUS.STALE : WEBHOOK_STATUS.PROCESSED;
    await finish(tx, webhookRowId, status);

    // The handler's result is NESTED, never spread. A handler returning its own
    // `status` (a subscription's, say) would otherwise overwrite the webhook
    // processing status and make every caller read the wrong field.
    return { status, eventId: event.id, type: event.type, detail: outcome ?? null };
  });
}

async function finish(tx, id, status, error = null) {
  await tx.query(
    'UPDATE webhook_events SET status = $1, processed_at = now(), error = $2 WHERE id = $3',
    [status, error, id],
  );
}

// ---------------------------------------------------------------------------
// Object lookup
// ---------------------------------------------------------------------------

async function findInvoiceByStripeId(tx, stripeInvoiceId) {
  const { rows } = await tx.query(
    'SELECT * FROM invoices WHERE stripe_invoice_id = $1 FOR UPDATE',
    [stripeInvoiceId],
  );
  return rows[0] ?? null;
}

async function findSubscriptionByStripeId(tx, stripeSubscriptionId) {
  const { rows } = await tx.query(
    'SELECT * FROM subscriptions WHERE stripe_subscription_id = $1 FOR UPDATE',
    [stripeSubscriptionId],
  );
  return rows[0] ?? null;
}

async function stampInvoice(tx, invoiceId, key) {
  await tx.query(
    `UPDATE invoices SET last_event_created = $1, last_event_seq = $2, last_event_rank = $3
      WHERE id = $4`,
    [key[0], key[1], key[2], invoiceId],
  );
}

async function stampSubscription(tx, subscriptionId, key) {
  await tx.query(
    `UPDATE subscriptions SET last_event_created = $1, last_event_seq = $2, last_event_rank = $3
      WHERE id = $4`,
    [key[0], key[1], key[2], subscriptionId],
  );
}

/**
 * Recompute subscription status from invoice facts.
 *
 * Order-insensitive by construction: it reads the current set of invoices and
 * returns a pure function of them, so replaying the same events in any order
 * converges on the same answer.
 *
 * `canceled` is absorbing -- a late success cannot resurrect a subscription
 * that dunning already gave up on.
 */
async function recomputeSubscriptionStatus(tx, subscriptionId, { at } = {}) {
  const { rows } = await tx.query('SELECT * FROM subscriptions WHERE id = $1', [subscriptionId]);
  const sub = rows[0];
  if (!sub) return null;
  if (sub.status === STATES.CANCELED) return sub;

  const unpaid = await tx.query(
    `SELECT count(*)::int AS n FROM invoices
      WHERE subscription_id = $1 AND status = 'failed'`,
    [subscriptionId],
  );

  let next;
  if (Number(unpaid.rows[0].n) > 0) {
    next = STATES.PAST_DUE;
  } else if (sub.trial_end && Number(sub.trial_end) > (at ?? Number(sub.current_period_start))) {
    next = STATES.TRIALING;
  } else {
    next = STATES.ACTIVE;
  }

  if (next === sub.status) return sub;

  const updated = await tx.query(
    'UPDATE subscriptions SET status = $1, updated_at = now() WHERE id = $2 RETURNING *',
    [next, subscriptionId],
  );
  return updated.rows[0];
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleInvoicePaid(tx, event) {
  const object = event.data.object;
  const invoice = await findInvoiceByStripeId(tx, object.id);
  if (!invoice) return { unmatched: true, stripeInvoiceId: object.id };

  const key = orderKey(event);
  if (isStale(fromColumns(invoice, 'last_event'), key)) {
    return { stale: true, invoiceId: invoice.id, reason: 'older than the last event applied' };
  }

  await tx.query(
    `UPDATE invoices
        SET status = 'paid', paid_at = $1, attempt_count = GREATEST(attempt_count, $2)
      WHERE id = $3`,
    [event.created, Number(object.attempt_count ?? 0), invoice.id],
  );
  await stampInvoice(tx, invoice.id, key);

  // A settled invoice ends its dunning cycle.
  await cancelDunningForInvoice(tx, invoice.id);

  const subscription = await recomputeSubscriptionStatus(tx, invoice.subscription_id, { at: event.created });

  const customer = await tx.query('SELECT * FROM customers WHERE id = $1', [invoice.customer_id]);
  await notify(tx, {
    customerId: invoice.customer_id,
    subscriptionId: invoice.subscription_id,
    email: customer.rows[0]?.email,
    template: 'invoice_paid',
    data: { amountCents: Number(invoice.amount_cents), invoiceId: invoice.id },
  });

  return { invoiceId: invoice.id, subscriptionStatus: subscription?.status };
}

async function handleInvoicePaymentFailed(tx, event) {
  const object = event.data.object;
  const invoice = await findInvoiceByStripeId(tx, object.id);
  if (!invoice) return { unmatched: true, stripeInvoiceId: object.id };

  const key = orderKey(event);
  if (isStale(fromColumns(invoice, 'last_event'), key)) {
    return { stale: true, invoiceId: invoice.id, reason: 'older than the last event applied' };
  }

  const firstFailedAt = invoice.first_failed_at ?? event.created;

  await tx.query(
    `UPDATE invoices
        SET status = 'failed',
            attempt_count = GREATEST(attempt_count, $1),
            first_failed_at = $2
      WHERE id = $3`,
    [Number(object.attempt_count ?? 1), firstFailedAt, invoice.id],
  );
  await stampInvoice(tx, invoice.id, key);

  const subscription = await recomputeSubscriptionStatus(tx, invoice.subscription_id, { at: event.created });

  await scheduleDunningForInvoice(tx, {
    invoiceId: invoice.id,
    subscriptionId: invoice.subscription_id,
    firstFailedAt,
    attemptsMade: Number(object.attempt_count ?? 1) - 1,
  });

  return { invoiceId: invoice.id, subscriptionStatus: subscription?.status, firstFailedAt };
}

async function handleSubscriptionUpdated(tx, event) {
  const object = event.data.object;
  const subscription = await findSubscriptionByStripeId(tx, object.id);
  if (!subscription) return { unmatched: true, stripeSubscriptionId: object.id };

  const key = orderKey(event);
  if (isStale(fromColumns(subscription, 'last_event'), key)) {
    return { stale: true, subscriptionId: subscription.id };
  }

  // Stripe is authoritative about whether it considers the subscription live.
  // Our own derived status still wins for past_due, which we compute from
  // invoice facts -- so only take Stripe's word for cancellation and pausing.
  const stripeState = fromStripeStatus(object.status);
  const updates = [];
  const params = [];

  if (stripeState === STATES.CANCELED || stripeState === STATES.PAUSED) {
    params.push(stripeState);
    updates.push(`status = $${params.length}`);
  }
  if (object.cancel_at_period_end !== undefined) {
    params.push(Boolean(object.cancel_at_period_end));
    updates.push(`cancel_at_period_end = $${params.length}`);
  }

  if (updates.length > 0) {
    params.push(subscription.id);
    await tx.query(
      `UPDATE subscriptions SET ${updates.join(', ')}, updated_at = now() WHERE id = $${params.length}`,
      params,
    );
  }
  await stampSubscription(tx, subscription.id, key);

  const refreshed = await recomputeSubscriptionStatus(tx, subscription.id, { at: event.created });
  return { subscriptionId: subscription.id, subscriptionStatus: refreshed?.status };
}

async function handleSubscriptionDeleted(tx, event) {
  const object = event.data.object;
  const subscription = await findSubscriptionByStripeId(tx, object.id);
  if (!subscription) return { unmatched: true, stripeSubscriptionId: object.id };

  const key = orderKey(event);
  if (isStale(fromColumns(subscription, 'last_event'), key)) {
    return { stale: true, subscriptionId: subscription.id };
  }

  await tx.query(
    `UPDATE subscriptions
        SET status = $1, canceled_at = $2, updated_at = now()
      WHERE id = $3`,
    [STATES.CANCELED, object.canceled_at ?? event.created, subscription.id],
  );
  await stampSubscription(tx, subscription.id, key);
  await tx.query(
    `UPDATE dunning_attempts SET status = 'canceled'
      WHERE subscription_id = $1 AND status = 'pending'`,
    [subscription.id],
  );

  return { subscriptionId: subscription.id, subscriptionStatus: STATES.CANCELED };
}

async function handleInvoiceCreatedOrFinalized(tx, event) {
  const object = event.data.object;
  const invoice = await findInvoiceByStripeId(tx, object.id);
  if (!invoice) return { unmatched: true, stripeInvoiceId: object.id };

  const key = orderKey(event);
  if (isStale(fromColumns(invoice, 'last_event'), key)) {
    return { stale: true, invoiceId: invoice.id };
  }
  if (event.type === 'invoice.finalized') {
    await tx.query('UPDATE invoices SET finalized_at = $1 WHERE id = $2', [event.created, invoice.id]);
  }
  await stampInvoice(tx, invoice.id, key);
  return { invoiceId: invoice.id };
}

async function handleTrialWillEnd(tx, event) {
  const object = event.data.object;
  const subscription = await findSubscriptionByStripeId(tx, object.id);
  if (!subscription) return { unmatched: true, stripeSubscriptionId: object.id };

  const plan = await tx.query('SELECT * FROM plans WHERE id = $1', [subscription.plan_id]);
  const customer = await tx.query('SELECT * FROM customers WHERE id = $1', [subscription.customer_id]);

  await notify(tx, {
    customerId: subscription.customer_id,
    subscriptionId: subscription.id,
    email: customer.rows[0]?.email,
    template: 'trial_ending',
    data: { planName: plan.rows[0]?.name ?? subscription.plan_id, trialEnd: subscription.trial_end },
  });
  return { subscriptionId: subscription.id };
}

const HANDLERS = Object.freeze({
  'invoice.payment_succeeded': handleInvoicePaid,
  'invoice.paid': handleInvoicePaid,
  'invoice.payment_failed': handleInvoicePaymentFailed,
  'invoice.created': handleInvoiceCreatedOrFinalized,
  'invoice.finalized': handleInvoiceCreatedOrFinalized,
  'customer.subscription.updated': handleSubscriptionUpdated,
  'customer.subscription.deleted': handleSubscriptionDeleted,
  'customer.subscription.trial_will_end': handleTrialWillEnd,
});

export const __handlers = HANDLERS;
export { recomputeSubscriptionStatus };
