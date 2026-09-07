/**
 * Admin analytics.
 *
 * Revenue is measured from PAID invoices only. Counting pending or failed
 * invoices as revenue is the standard way a billing dashboard ends up reporting
 * numbers that finance cannot reconcile -- an invoice that was issued is not
 * money that arrived.
 */

const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * Revenue grouped by plan.
 *
 * Attributed through the invoice's LINES rather than the subscription's current
 * plan. A customer who upgraded last month would otherwise have their entire
 * billing history retroactively re-attributed to the new plan, which quietly
 * rewrites past months every time someone changes tier.
 *
 * Balance movements (`credit_balance`, `adjustment`) are excluded. Those lines
 * move money between the customer's balance and an invoice; they are deferred
 * revenue, not revenue. Counting them would book a banked downgrade credit as
 * income at the moment it is granted and again when it is spent.
 */
export async function revenueByPlan(db, { since = 0, until = null } = {}) {
  const upper = until ?? nowSeconds() + 1;
  const { rows } = await db.query(
    `SELECT COALESCE(l.plan_id, 'unattributed') AS plan_id,
            p.name AS plan_name,
            COALESCE(SUM(l.amount_cents), 0)::bigint AS revenue_cents,
            COUNT(DISTINCT i.id)::int AS invoice_count
       FROM invoices i
       JOIN invoice_lines l ON l.invoice_id = i.id
       LEFT JOIN plans p ON p.id = l.plan_id
      WHERE i.status = 'paid'
        AND l.kind NOT IN ('credit_balance', 'adjustment')
        AND i.period_start >= $1
        AND i.period_start < $2
      GROUP BY COALESCE(l.plan_id, 'unattributed'), p.name
      ORDER BY revenue_cents DESC`,
    [since, upper],
  );
  return rows.map((r) => ({
    planId: r.plan_id,
    planName: r.plan_name ?? r.plan_id,
    revenueCents: Number(r.revenue_cents),
    invoiceCount: Number(r.invoice_count),
  }));
}

/** Subscription counts by state. */
export async function statusBreakdown(db) {
  const { rows } = await db.query(
    `SELECT status, COUNT(*)::int AS n FROM subscriptions GROUP BY status`,
  );
  const counts = { trialing: 0, active: 0, past_due: 0, paused: 0, canceled: 0 };
  for (const r of rows) counts[r.status] = Number(r.n);
  counts.total = Object.values(counts).reduce((a, b) => a + b, 0);
  return counts;
}

/**
 * Failed payment rate.
 *
 * Denominator is invoices that were actually ATTEMPTED (paid + failed).
 * Including drafts and zero-total invoices would dilute the rate toward zero
 * and hide a worsening decline problem.
 */
export async function failedPaymentRate(db, { since = 0 } = {}) {
  const { rows } = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
       COUNT(*) FILTER (WHERE status = 'paid')::int AS paid,
       COUNT(*) FILTER (WHERE status = 'pending')::int AS pending
     FROM invoices
     WHERE period_start >= $1 AND amount_cents > 0`,
    [since],
  );
  const { failed, paid, pending } = rows[0];
  const attempted = Number(failed) + Number(paid);
  return {
    failed: Number(failed),
    paid: Number(paid),
    pending: Number(pending),
    attempted,
    rate: attempted === 0 ? 0 : Number(failed) / attempted,
  };
}

/**
 * Monthly recurring revenue from live subscriptions, normalised to a month.
 * Base price only -- metered usage is variable and is not recurring revenue.
 */
export async function mrr(db) {
  const { rows } = await db.query(
    `SELECT p.id AS plan_id, p.name AS plan_name, p.base_price_cents, p.interval,
            p.interval_count, COUNT(*)::int AS subscribers
       FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id
      WHERE s.status IN ('active','past_due')
      GROUP BY p.id, p.name, p.base_price_cents, p.interval, p.interval_count`,
  );

  const MONTHS_PER = { day: 1 / 30, week: 7 / 30, month: 1, year: 12 };

  let totalCents = 0;
  const byPlan = rows.map((r) => {
    const months = MONTHS_PER[r.interval] * Number(r.interval_count);
    const monthlyCents = Math.round((Number(r.base_price_cents) * Number(r.subscribers)) / months);
    totalCents += monthlyCents;
    return {
      planId: r.plan_id,
      planName: r.plan_name,
      subscribers: Number(r.subscribers),
      monthlyCents,
    };
  });

  return { totalCents, byPlan };
}

/** Dunning pipeline health: what is in flight and what it is worth. */
export async function dunningOverview(db) {
  const { rows } = await db.query(
    `SELECT d.status, COUNT(*)::int AS n,
            COALESCE(SUM(i.amount_cents), 0)::bigint AS amount_cents
       FROM dunning_attempts d
       JOIN invoices i ON i.id = d.invoice_id
      GROUP BY d.status`,
  );
  const out = {};
  for (const r of rows) {
    out[r.status] = { count: Number(r.n), amountCents: Number(r.amount_cents) };
  }

  const atRisk = await db.query(
    `SELECT COALESCE(SUM(amount_cents), 0)::bigint AS cents
       FROM invoices WHERE status = 'failed'`,
  );
  return { byStatus: out, atRiskCents: Number(atRisk.rows[0].cents) };
}

/** Webhook processing health -- the duplicate/stale counts prove the guards fire. */
export async function webhookStats(db) {
  const { rows } = await db.query(
    `SELECT status, COUNT(*)::int AS n FROM webhook_events GROUP BY status`,
  );
  const out = { processed: 0, duplicate: 0, stale: 0, ignored: 0, failed: 0 };
  for (const r of rows) out[r.status] = Number(r.n);
  return out;
}

export async function dashboard(db, opts = {}) {
  const [revenue, statuses, failures, recurring, dunning, webhooks] = await Promise.all([
    revenueByPlan(db, opts),
    statusBreakdown(db),
    failedPaymentRate(db, opts),
    mrr(db),
    dunningOverview(db),
    webhookStats(db),
  ]);

  return {
    generatedAt: nowSeconds(),
    revenueByPlan: revenue,
    totalRevenueCents: revenue.reduce((a, r) => a + r.revenueCents, 0),
    subscriptions: statuses,
    payments: failures,
    mrr: recurring,
    dunning,
    webhooks,
  };
}
