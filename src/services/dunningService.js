/**
 * Dunning: retry a failed payment on a schedule, then give up.
 *
 * The schedule itself is pure (domain/dunning.js). This module is the durable
 * part: one row per (invoice, attempt) with a UNIQUE index, which is what makes
 * scheduling idempotent. Stripe can deliver `invoice.payment_failed` twice for
 * the same attempt, or a worker can be restarted mid-run; either way the
 * ON CONFLICT DO NOTHING means one attempt is scheduled exactly once.
 *
 * Attempts live in Postgres even when BullMQ is driving the timers. Redis holds
 * WHEN to run; Postgres holds WHETHER it ran. If Redis is flushed the schedule
 * is rebuilt from the table rather than lost, and a customer does not silently
 * escape cancellation because a queue was cleared.
 */

import {
  nextDunningStep,
  dunningNotification,
  DUNNING_ACTIONS,
} from '../domain/dunning.js';
import { STATES } from '../domain/subscriptionState.js';
import { config } from '../config.js';
import { notify } from './notifier.js';

const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * Decide and record the next dunning step after a failure.
 * Called from inside the webhook transaction, so it performs no network I/O.
 */
export async function scheduleDunningForInvoice(tx, {
  invoiceId,
  subscriptionId,
  firstFailedAt,
  attemptsMade,
  retryOffsetDays = config.dunning.retryOffsetDays,
  maxAttempts = config.dunning.maxAttempts,
}) {
  const step = nextDunningStep({
    firstFailedAt,
    attemptsMade,
    retryOffsetDays,
    maxAttempts,
  });

  const invoice = await loadInvoice(tx, invoiceId);
  const customer = await loadCustomer(tx, invoice.customer_id);
  const limit = Math.min(maxAttempts, retryOffsetDays.length);

  if (step.action === DUNNING_ACTIONS.CANCEL) {
    await cancelForNonPayment(tx, { subscriptionId, invoice, customer });
    return { action: DUNNING_ACTIONS.CANCEL, reason: step.reason };
  }

  // UNIQUE (invoice_id, attempt) makes redelivery of the same failure a no-op.
  const inserted = await tx.query(
    `INSERT INTO dunning_attempts (subscription_id, invoice_id, attempt, scheduled_for)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (invoice_id, attempt) DO NOTHING
     RETURNING *`,
    [subscriptionId, invoiceId, step.attempt, step.at],
  );

  if (inserted.rows.length === 0) {
    return { action: 'already_scheduled', attempt: step.attempt, at: step.at };
  }

  const template = dunningNotification({
    action: step.action,
    attempt: step.attempt,
    maxAttempts: limit,
    at: step.at,
  }).template;

  await notify(tx, {
    customerId: invoice.customer_id,
    subscriptionId,
    email: customer?.email,
    template,
    data: {
      amountCents: Number(invoice.amount_cents),
      attempt: step.attempt,
      maxAttempts: limit,
      retryAt: step.at,
    },
  });

  return { action: DUNNING_ACTIONS.RETRY, attempt: step.attempt, at: step.at };
}

async function cancelForNonPayment(tx, { subscriptionId, invoice, customer }) {
  await tx.query(
    `UPDATE subscriptions
        SET status = $1, canceled_at = $2, updated_at = now()
      WHERE id = $3 AND status <> $1`,
    [STATES.CANCELED, nowSeconds(), subscriptionId],
  );
  await tx.query(
    `UPDATE dunning_attempts SET status = 'canceled'
      WHERE subscription_id = $1 AND status = 'pending'`,
    [subscriptionId],
  );
  await notify(tx, {
    customerId: invoice.customer_id,
    subscriptionId,
    email: customer?.email,
    template: 'subscription_canceled_for_nonpayment',
    data: { amountCents: Number(invoice.amount_cents) },
  });
}

/** A settled invoice ends its dunning cycle. */
export async function cancelDunningForInvoice(tx, invoiceId) {
  const { rowCount } = await tx.query(
    `UPDATE dunning_attempts SET status = 'canceled'
      WHERE invoice_id = $1 AND status = 'pending'`,
    [invoiceId],
  );
  return rowCount;
}

/**
 * Claim due attempts for execution.
 *
 * FOR UPDATE SKIP LOCKED so multiple workers can share the queue without two of
 * them retrying the same invoice -- which would charge the customer twice.
 */
export async function claimDueAttempts(db, { at = nowSeconds(), limit = 25 } = {}) {
  return db.tx(async (tx) => {
    const due = await tx.query(
      `SELECT * FROM dunning_attempts
        WHERE status = 'pending' AND scheduled_for <= $1
        ORDER BY scheduled_for
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      [at, limit],
    );
    if (due.rows.length === 0) return [];

    const ids = due.rows.map((r) => r.id);
    await tx.query(
      `UPDATE dunning_attempts SET status = 'running', started_at = $1 WHERE id = ANY($2)`,
      [at, ids],
    );
    return due.rows;
  });
}

export async function markAttemptFinished(db, attemptId, { status, error = null, at = nowSeconds() }) {
  await db.query(
    `UPDATE dunning_attempts SET status = $1, finished_at = $2, error = $3 WHERE id = $4`,
    [status, at, error, attemptId],
  );
}

export async function listAttemptsForInvoice(db, invoiceId) {
  const { rows } = await db.query(
    'SELECT * FROM dunning_attempts WHERE invoice_id = $1 ORDER BY attempt',
    [invoiceId],
  );
  return rows;
}

async function loadInvoice(tx, invoiceId) {
  const { rows } = await tx.query('SELECT * FROM invoices WHERE id = $1', [invoiceId]);
  if (rows.length === 0) throw new Error(`dunning: invoice ${invoiceId} not found`);
  return rows[0];
}

async function loadCustomer(tx, customerId) {
  const { rows } = await tx.query('SELECT * FROM customers WHERE id = $1', [customerId]);
  return rows[0] ?? null;
}

export { nowSeconds };
