/**
 * Invoice assembly.
 *
 * ---------------------------------------------------------------------------
 * Transaction boundary
 * ---------------------------------------------------------------------------
 * Building an invoice is transactional. CHARGING it is not, and must not be:
 * an HTTP round trip to Stripe inside an open transaction holds row locks for
 * the duration of a network call, which is how a billing system deadlocks under
 * load. So the flow is deliberately split:
 *
 *   1. tx  : assemble lines, claim usage, insert the invoice, COMMIT
 *   2. net : ask Stripe to collect (no DB transaction open)
 *   3. tx  : a webhook reports the outcome and moves state
 *
 * Step 3 is the only thing that writes the paid/failed status. That is what
 * keeps local state from drifting from Stripe: we never optimistically mark an
 * invoice paid because an API call returned 200.
 */

import { sumCents } from '../domain/money.js';
import { meteredCharge } from '../domain/usage.js';
import { LINE_KINDS } from '../domain/proration.js';

/**
 * Claim unbilled usage for an invoice and total it IN ONE STATEMENT.
 *
 * This is `UPDATE ... RETURNING` rather than `SELECT sum(...)` followed by an
 * `UPDATE`, and the difference is a real bug class. Between a separate select
 * and update, a concurrently inserted event can be counted but not claimed
 * (billed twice, on this invoice and the next) or claimed but not counted
 * (billed never). One statement makes counting and claiming the same atomic act.
 *
 * The predicate `billed_invoice_id IS NULL AND ts < periodEnd` mirrors
 * domain/usage.js exactly: half-open upper bound, no lower bound. Omitting the
 * lower bound is what sweeps in late arrivals whose timestamp belongs to an
 * already-closed period, so they land on this invoice as billable usage instead
 * of being silently dropped.
 */
export async function claimUsage(tx, { subscriptionId, invoiceId, periodEnd }) {
  const claimed = await tx.query(
    `UPDATE usage_events
        SET billed_invoice_id = $1
      WHERE subscription_id = $2
        AND billed_invoice_id IS NULL
        AND ts < $3
      RETURNING quantity, ts`,
    [invoiceId, subscriptionId, periodEnd],
  );

  let units = 0;
  for (const row of claimed.rows) units += Number(row.quantity);
  return { units, eventCount: claimed.rows.length, rows: claimed.rows };
}

/** Build the metered line for already-claimed usage, or null if nothing is billable. */
export function buildMeteredLine({ plan, units, periodStart, periodEnd }) {
  const { billableUnits, amountCents } = meteredCharge({
    units,
    includedUnits: Number(plan.included_units ?? 0),
    rateMicrocents: Number(plan.metered_rate_microcents ?? 0),
  });

  if (billableUnits === 0) return null;

  const label = plan.metered_unit_label ?? 'units';
  return {
    kind: LINE_KINDS.METERED,
    planId: plan.id,
    description: `${billableUnits.toLocaleString('en-US')} ${label} over the included ${Number(plan.included_units ?? 0).toLocaleString('en-US')}`,
    quantity: billableUnits,
    unitAmountMicrocents: Number(plan.metered_rate_microcents ?? 0),
    amountCents,
    periodStart,
    periodEnd,
  };
}

/**
 * Reserve a draft invoice so its id exists before usage is claimed against it.
 *
 * Claiming usage requires an invoice id, and the metered line's amount is only
 * known after the claim -- a genuine ordering cycle. Reserving a draft row
 * breaks it without leaving a window: the whole reserve/claim/finalize sequence
 * runs inside one transaction, so a draft never survives a failure.
 */
export async function reserveInvoice(tx, { subscription, periodStart, periodEnd, stripeInvoiceId = null }) {
  const { rows } = await tx.query(
    `INSERT INTO invoices
       (subscription_id, customer_id, amount_cents, currency, status,
        period_start, period_end, stripe_invoice_id)
     VALUES ($1,$2,0,$3,'draft',$4,$5,$6)
     RETURNING *`,
    [
      subscription.id,
      subscription.customer_id,
      subscription.currency ?? 'USD',
      periodStart,
      periodEnd,
      stripeInvoiceId,
    ],
  );
  return rows[0];
}

/**
 * Attach lines to a reserved invoice, apply banked credit, and set the total.
 *
 * Credit is applied as an explicit negative line rather than by quietly
 * shrinking another line, so the customer can see where it came from. An
 * invoice never goes below zero: leftover credit stays banked for next time.
 */
export async function finalizeInvoice(tx, {
  invoice,
  subscription,
  lines,
  status = 'pending',
  applyCreditBalance = true,
}) {
  const subtotal = sumCents(lines.map((l) => l.amountCents));

  let creditApplied = 0;
  const allLines = [...lines];

  if (applyCreditBalance && subtotal > 0) {
    const available = Number(subscription.credit_balance_cents ?? 0);
    creditApplied = Math.min(available, subtotal);
    if (creditApplied > 0) {
      allLines.push({
        kind: 'credit_balance',
        planId: null,
        description: 'Credit from a previous plan change',
        amountCents: -creditApplied,
        periodStart: invoice.period_start,
        periodEnd: invoice.period_end,
      });
    }
  }

  const total = subtotal - creditApplied;

  // A zero-total invoice has nothing to collect, so it is settled on creation
  // rather than sent to Stripe to wait for a webhook that will never describe a
  // real payment.
  const effectiveStatus = total <= 0 && status === 'pending' ? 'paid' : status;

  await insertLines(tx, invoice.id, allLines);

  const { rows } = await tx.query(
    `UPDATE invoices
        SET amount_cents = $1, status = $2, paid_at = $3
      WHERE id = $4
      RETURNING *`,
    [total, effectiveStatus, effectiveStatus === 'paid' ? invoice.period_start : null, invoice.id],
  );

  if (creditApplied > 0) {
    await tx.query(
      'UPDATE subscriptions SET credit_balance_cents = credit_balance_cents - $1 WHERE id = $2',
      [creditApplied, subscription.id],
    );
  }

  return { invoice: rows[0], lines: allLines, subtotal, creditApplied, total };
}

/** reserve + finalize, for invoices that do not need to claim usage first. */
export async function createInvoice(tx, {
  subscription,
  lines,
  periodStart,
  periodEnd,
  status = 'pending',
  applyCreditBalance = true,
  stripeInvoiceId = null,
}) {
  const invoice = await reserveInvoice(tx, { subscription, periodStart, periodEnd, stripeInvoiceId });
  return finalizeInvoice(tx, { invoice, subscription, lines, status, applyCreditBalance });
}

export async function insertLines(tx, invoiceId, lines) {
  let order = 0;
  for (const line of lines) {
    await tx.query(
      `INSERT INTO invoice_lines
         (invoice_id, kind, plan_id, description, quantity,
          unit_amount_microcents, amount_cents, period_start, period_end, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        invoiceId,
        line.kind,
        line.planId ?? null,
        line.description,
        line.quantity ?? null,
        line.unitAmountMicrocents ?? null,
        line.amountCents,
        line.periodStart ?? null,
        line.periodEnd ?? null,
        order += 1,
      ],
    );
  }
}

/** Bank a credit (from a downgrade) against future invoices. */
export async function bankCredit(tx, subscriptionId, amountCents) {
  if (amountCents <= 0) return;
  await tx.query(
    'UPDATE subscriptions SET credit_balance_cents = credit_balance_cents + $1 WHERE id = $2',
    [amountCents, subscriptionId],
  );
}

export async function getInvoiceWithLines(db, invoiceId) {
  const inv = await db.query('SELECT * FROM invoices WHERE id = $1', [invoiceId]);
  if (inv.rows.length === 0) return null;
  const lines = await db.query(
    'SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY sort_order',
    [invoiceId],
  );
  return { ...inv.rows[0], lines: lines.rows };
}

export async function listInvoicesForCustomer(db, customerId, { limit = 50, offset = 0 } = {}) {
  const invoices = await db.query(
    `SELECT i.*, s.plan_id
       FROM invoices i
       JOIN subscriptions s ON s.id = i.subscription_id
      WHERE i.customer_id = $1
      ORDER BY i.created_at DESC, i.id
      LIMIT $2 OFFSET $3`,
    [customerId, limit, offset],
  );
  if (invoices.rows.length === 0) return [];

  const ids = invoices.rows.map((r) => r.id);
  const lines = await db.query(
    'SELECT * FROM invoice_lines WHERE invoice_id = ANY($1) ORDER BY invoice_id, sort_order',
    [ids],
  );

  const byInvoice = new Map(ids.map((id) => [id, []]));
  for (const line of lines.rows) byInvoice.get(line.invoice_id)?.push(line);

  return invoices.rows.map((i) => ({ ...i, lines: byInvoice.get(i.id) ?? [] }));
}
