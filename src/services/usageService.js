/**
 * Usage ingestion and projection.
 *
 * Two things stop usage being double-counted, and they cover different threats:
 *
 *   idempotency_key  -- the CLIENT retried the same report (network blip,
 *                       at-least-once producer). UNIQUE(subscription_id, key)
 *                       makes the second insert a no-op.
 *   billed_invoice_id -- WE already billed it. Claimed at invoice time by
 *                       UPDATE ... RETURNING, so an event can be claimed once.
 *
 * An event's `ts` is when the usage HAPPENED; `received_at` is when we heard.
 * Billing uses `ts`, monitoring uses the gap between them.
 */

import { toEpochSeconds } from '../domain/time.js';
import { meteredCharge } from '../domain/usage.js';

const nowSeconds = () => Math.floor(Date.now() / 1000);

export class UsageError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'UsageError';
    this.statusCode = statusCode;
  }
}

/**
 * Record a usage event.
 *
 * Accepts events timestamped in the past on purpose: a meter that batches, or a
 * request that finished just before a cycle rolled, legitimately reports late.
 * The invoice-time claim predicate is what routes those to the right invoice.
 */
export async function recordUsage(db, {
  subscriptionId,
  quantity,
  timestamp = nowSeconds(),
  idempotencyKey = null,
}) {
  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty <= 0) {
    throw new UsageError(`quantity must be a positive integer, got ${quantity}`);
  }
  const ts = toEpochSeconds(timestamp);

  const sub = await db.query(
    "SELECT id, status FROM subscriptions WHERE id = $1",
    [subscriptionId],
  );
  if (sub.rows.length === 0) throw new UsageError(`subscription ${subscriptionId} not found`, 404);
  if (sub.rows[0].status === 'canceled') {
    throw new UsageError('cannot record usage against a canceled subscription', 409);
  }

  const { rows } = await db.query(
    `INSERT INTO usage_events (subscription_id, quantity, ts, idempotency_key)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (subscription_id, idempotency_key) WHERE idempotency_key IS NOT NULL
     DO NOTHING
     RETURNING *`,
    [subscriptionId, qty, ts, idempotencyKey],
  );

  if (rows.length === 0) {
    const existing = await db.query(
      'SELECT * FROM usage_events WHERE subscription_id = $1 AND idempotency_key = $2',
      [subscriptionId, idempotencyKey],
    );
    return { event: existing.rows[0] ?? null, duplicate: true };
  }
  return { event: rows[0], duplicate: false };
}

/**
 * Unbilled usage for a subscription, and what it would cost if the period
 * closed right now. Mirrors the invoice-time predicate exactly -- unbilled and
 * ts < periodEnd -- so the projection and the eventual invoice agree.
 */
export async function getUsageSummary(db, subscriptionId) {
  const { rows } = await db.query(
    `SELECT s.*, p.name AS plan_name, p.included_units, p.metered_rate_microcents,
            p.metered_unit_label
       FROM subscriptions s JOIN plans p ON p.id = s.plan_id
      WHERE s.id = $1`,
    [subscriptionId],
  );
  if (rows.length === 0) throw new UsageError(`subscription ${subscriptionId} not found`, 404);
  const sub = rows[0];

  const agg = await db.query(
    `SELECT COALESCE(SUM(quantity), 0)::bigint AS units,
            COUNT(*)::int AS events,
            COALESCE(SUM(quantity) FILTER (WHERE ts >= $3), 0)::bigint AS in_period_units,
            COALESCE(SUM(quantity) FILTER (WHERE ts < $3), 0)::bigint AS late_units
       FROM usage_events
      WHERE subscription_id = $1
        AND billed_invoice_id IS NULL
        AND ts < $2`,
    [subscriptionId, Number(sub.current_period_end), Number(sub.current_period_start)],
  );

  const units = Number(agg.rows[0].units);
  const { billableUnits, amountCents } = meteredCharge({
    units,
    includedUnits: Number(sub.included_units),
    rateMicrocents: Number(sub.metered_rate_microcents),
  });

  return {
    subscriptionId,
    planId: sub.plan_id,
    planName: sub.plan_name,
    periodStart: Number(sub.current_period_start),
    periodEnd: Number(sub.current_period_end),
    unbilledUnits: units,
    unbilledEvents: Number(agg.rows[0].events),
    inPeriodUnits: Number(agg.rows[0].in_period_units),
    // Usage timestamped before this period that is still unbilled: it belongs
    // to a closed period and will be swept onto the next invoice.
    lateUnits: Number(agg.rows[0].late_units),
    includedUnits: Number(sub.included_units),
    billableUnits,
    unitLabel: sub.metered_unit_label,
    projectedMeteredCents: amountCents,
  };
}

export async function listUsageEvents(db, subscriptionId, { limit = 100, offset = 0 } = {}) {
  const { rows } = await db.query(
    `SELECT * FROM usage_events
      WHERE subscription_id = $1
      ORDER BY ts DESC, received_at DESC
      LIMIT $2 OFFSET $3`,
    [subscriptionId, limit, offset],
  );
  return rows;
}

export { nowSeconds };
