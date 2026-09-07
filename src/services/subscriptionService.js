/**
 * Subscription lifecycle: create, change plan, cancel, renew.
 *
 * Every mutation runs in one transaction and every one of them re-reads the
 * subscription with SELECT ... FOR UPDATE. Two concurrent plan changes on the
 * same subscription would otherwise both read the same open ledger items,
 * both credit them, and hand back the unused time twice.
 */


import {
  planChangeProration,
  assertNoOverCredit,
  LINE_KINDS,
} from '../domain/proration.js';
import { nextPeriod, billingAnchorDay, days, toEpochSeconds } from '../domain/time.js';
import {
  STATES,
  transition,
  isBillable,
  IllegalTransitionError,
} from '../domain/subscriptionState.js';
import {
  reserveInvoice,
  finalizeInvoice,
  createInvoice,
  claimUsage,
  buildMeteredLine,
  bankCredit,
} from './invoiceService.js';
import { notify } from './notifier.js';

export class NotFoundError extends Error {
  constructor(what) {
    super(`${what} not found`);
    this.name = 'NotFoundError';
    this.statusCode = 404;
  }
}

export class BillingError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'BillingError';
    this.statusCode = statusCode;
  }
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

async function loadPlan(tx, planId) {
  const { rows } = await tx.query('SELECT * FROM plans WHERE id = $1', [planId]);
  if (rows.length === 0) throw new NotFoundError(`plan ${planId}`);
  return rows[0];
}

/** Re-read under a row lock. Every state mutation goes through this. */
async function lockSubscription(tx, subscriptionId) {
  const { rows } = await tx.query(
    'SELECT * FROM subscriptions WHERE id = $1 FOR UPDATE',
    [subscriptionId],
  );
  if (rows.length === 0) throw new NotFoundError(`subscription ${subscriptionId}`);
  return rows[0];
}

async function loadCustomer(tx, customerId) {
  const { rows } = await tx.query('SELECT * FROM customers WHERE id = $1', [customerId]);
  if (rows.length === 0) throw new NotFoundError(`customer ${customerId}`);
  return rows[0];
}

/**
 * Create a subscription.
 *
 * Base price is billed IN ADVANCE for the period; metered usage is billed in
 * arrears at the next renewal. That split is why a renewal invoice carries the
 * previous period's usage alongside the next period's base charge.
 *
 * A trial gets its own zero-cost period. The first paid period starts when the
 * trial period rolls over, which means trial expiry needs no special case --
 * it is the ordinary renewal path.
 */
export async function createSubscription(db, { customerId, planId, at = nowSeconds() }) {
  const start = toEpochSeconds(at);

  return db.tx(async (tx) => {
    const customer = await loadCustomer(tx, customerId);
    const plan = await loadPlan(tx, planId);

    const trialing = Number(plan.trial_days) > 0;
    const anchorDay = billingAnchorDay(start);
    const periodEnd = trialing
      ? start + days(Number(plan.trial_days))
      : nextPeriod(start, { interval: plan.interval, intervalCount: plan.interval_count, anchorDay });

    const { rows } = await tx.query(
      `INSERT INTO subscriptions
         (customer_id, plan_id, status, current_period_start, current_period_end,
          billing_anchor_day, trial_end)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [
        customer.id,
        plan.id,
        trialing ? STATES.TRIALING : STATES.ACTIVE,
        start,
        periodEnd,
        anchorDay,
        trialing ? periodEnd : null,
      ],
    );
    const subscription = rows[0];

    if (trialing) {
      await notify(tx, {
        customerId: customer.id,
        subscriptionId: subscription.id,
        email: customer.email,
        template: 'trial_ending',
        data: { planName: plan.name, trialEnd: periodEnd },
      });
      return { subscription, invoice: null, plan };
    }

    // Ledger entry for the full first period, then bill it.
    const basePrice = Number(plan.base_price_cents);
    await insertBilledItem(tx, {
      subscriptionId: subscription.id,
      planId: plan.id,
      amountCents: basePrice,
      startsAt: start,
      endsAt: periodEnd,
    });

    const { invoice } = await createInvoice(tx, {
      subscription,
      periodStart: start,
      periodEnd,
      lines: [{
        kind: LINE_KINDS.BASE,
        planId: plan.id,
        description: `${plan.name} (${plan.interval}ly)`,
        amountCents: basePrice,
        periodStart: start,
        periodEnd,
      }],
    });

    await notify(tx, {
      customerId: customer.id,
      subscriptionId: subscription.id,
      email: customer.email,
      template: 'subscription_created',
      data: { planName: plan.name, amountCents: invoice.amount_cents, periodEnd },
    });

    return { subscription, invoice, plan };
  });
}

async function insertBilledItem(tx, { subscriptionId, planId, amountCents, startsAt, endsAt, invoiceId = null }) {
  const { rows } = await tx.query(
    `INSERT INTO billed_items (subscription_id, plan_id, amount_cents, starts_at, ends_at, invoice_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [subscriptionId, planId, amountCents, startsAt, endsAt, invoiceId],
  );
  return rows[0];
}

/**
 * Upgrade or downgrade mid-cycle.
 *
 * Upgrades (net > 0) are invoiced immediately. Downgrades (net < 0) are NOT
 * refunded in cash -- the surplus is banked as account credit and consumed by
 * the next invoice. That is the standard SaaS treatment and it avoids handing
 * out cash refunds for a plan the customer chose to leave; the alternative
 * (refunding to card) turns every downgrade into a chargeback risk.
 *
 * The proration input is every ledger item still running at `changeAt`, and
 * crucially those carry the amounts ACTUALLY billed, including the reductions
 * applied by earlier changes in the same cycle. That is what makes the third
 * and fourth change in one cycle behave.
 */
export async function changePlan(db, { subscriptionId, newPlanId, at = nowSeconds() }) {
  const changeAt = toEpochSeconds(at);

  return db.tx(async (tx) => {
    const subscription = await lockSubscription(tx, subscriptionId);
    const customer = await loadCustomer(tx, subscription.customer_id);

    if (!isBillable(subscription.status)) {
      throw new IllegalTransitionError(subscription.status, 'plan change');
    }
    if (subscription.plan_id === newPlanId) {
      return { changed: false, subscription, reason: 'already on this plan' };
    }

    const oldPlan = await loadPlan(tx, subscription.plan_id);
    const newPlan = await loadPlan(tx, newPlanId);

    const periodStart = Number(subscription.current_period_start);
    const periodEnd = Number(subscription.current_period_end);

    if (changeAt < periodStart || changeAt > periodEnd) {
      throw new BillingError(
        `change time ${changeAt} is outside the current period [${periodStart}, ${periodEnd}]`,
      );
    }

    // A trialing subscription has no billed base to credit -- switch the plan
    // and let the first real invoice reflect the new price.
    if (subscription.status === STATES.TRIALING) {
      const { rows } = await tx.query(
        'UPDATE subscriptions SET plan_id = $1, updated_at = now() WHERE id = $2 RETURNING *',
        [newPlan.id, subscription.id],
      );
      return { changed: true, subscription: rows[0], proration: null, invoice: null };
    }

    const items = await tx.query(
      `SELECT id, plan_id, amount_cents, credited_cents, starts_at, ends_at
         FROM billed_items
        WHERE subscription_id = $1 AND ends_at > $2
        ORDER BY starts_at`,
      [subscription.id, changeAt],
    );

    const domainItems = items.rows.map((r) => ({
      id: r.id,
      planId: r.plan_id,
      amountCents: Number(r.amount_cents),
      creditedCents: Number(r.credited_cents),
      startsAt: Number(r.starts_at),
      endsAt: Number(r.ends_at),
    }));

    const proration = planChangeProration({
      items: domainItems,
      changeAt,
      periodStart,
      periodEnd,
      newPlan: { id: newPlan.id, basePriceCents: Number(newPlan.base_price_cents) },
    });

    // Belt and braces: the DB CHECK enforces this too, but failing here gives a
    // usable error instead of a constraint violation.
    assertNoOverCredit(proration.items.filter((i) => i.id));

    for (const item of proration.items) {
      if (!item.id) continue; // the newly opened item is inserted below
      await tx.query(
        `UPDATE billed_items
            SET amount_cents = $1, credited_cents = $2, ends_at = $3, closed_at = $4
          WHERE id = $5`,
        [item.amountCents, item.creditedCents ?? 0, item.endsAt, item.closedAt ?? null, item.id],
      );
    }

    await insertBilledItem(tx, {
      subscriptionId: subscription.id,
      planId: newPlan.id,
      amountCents: proration.charges[0].amountCents,
      startsAt: changeAt,
      endsAt: periodEnd,
    });

    const { rows: updatedRows } = await tx.query(
      'UPDATE subscriptions SET plan_id = $1, updated_at = now() WHERE id = $2 RETURNING *',
      [newPlan.id, subscription.id],
    );
    const updated = updatedRows[0];

    const lines = [
      ...proration.credits.map((c) => ({
        kind: c.kind,
        planId: c.planId,
        description: c.description,
        amountCents: c.amountCents,
        periodStart: c.periodStart,
        periodEnd: c.periodEnd,
      })),
      ...proration.charges.map((c) => ({
        kind: c.kind,
        planId: c.planId,
        description: c.description,
        amountCents: c.amountCents,
        periodStart: c.periodStart,
        periodEnd: c.periodEnd,
      })),
    ];

    // A downgrade must not pay cash back to the card. The credit is banked and
    // consumed by the next invoice, so this invoice has to NET TO ZERO -- an
    // explicit balancing line does that and keeps the document self-explanatory.
    //
    // Without it the credit is granted twice: once as a negative invoice total
    // and again as the banked balance the next invoice applies. That is a real
    // bug this code had, caught by reconciling cash collected against the
    // ledger, and it is what the reconciliation test now pins down.
    if (proration.netCents < 0) {
      lines.push({
        kind: LINE_KINDS.ADJUSTMENT,
        planId: null,
        description: 'Credit added to your account balance',
        amountCents: -proration.netCents,
        periodStart: changeAt,
        periodEnd,
      });
    }

    const { invoice } = await createInvoice(tx, {
      subscription: updated,
      periodStart: changeAt,
      periodEnd,
      lines,
      // A downgrade CREATES credit balance rather than consuming it.
      applyCreditBalance: proration.netCents > 0,
    });

    if (proration.netCents < 0) {
      await bankCredit(tx, subscription.id, -proration.netCents);
    }

    await notify(tx, {
      customerId: customer.id,
      subscriptionId: subscription.id,
      email: customer.email,
      template: 'plan_changed',
      data: { fromPlan: oldPlan.name, toPlan: newPlan.name, netCents: proration.netCents },
    });

    return { changed: true, subscription: updated, proration, invoice, oldPlan, newPlan };
  });
}

/**
 * Renew: close the current period and open the next one.
 *
 * The renewal invoice carries two different things, deliberately:
 *   - metered usage for the period that just ENDED (arrears)
 *   - the base charge for the period about to START (advance)
 *
 * Usage is claimed before the period rolls, using the OLD period end as the
 * upper bound, so an event timestamped a millisecond before rollover is billed
 * to the period it belongs to even if it arrived after.
 */
export async function renewSubscription(db, { subscriptionId, at = nowSeconds() }) {
  const at_ = toEpochSeconds(at);

  return db.tx(async (tx) => {
    const subscription = await lockSubscription(tx, subscriptionId);
    if (!isBillable(subscription.status)) {
      throw new IllegalTransitionError(subscription.status, 'renewal');
    }

    const plan = await loadPlan(tx, subscription.plan_id);
    const customer = await loadCustomer(tx, subscription.customer_id);

    const closingPeriodStart = Number(subscription.current_period_start);
    const closingPeriodEnd = Number(subscription.current_period_end);
    const newPeriodStart = closingPeriodEnd;
    const newPeriodEnd = nextPeriod(newPeriodStart, {
      interval: plan.interval,
      intervalCount: plan.interval_count,
      anchorDay: Number(subscription.billing_anchor_day),
    });

    if (subscription.cancel_at_period_end) {
      const status = transition(subscription.status, STATES.CANCELED);
      const { rows } = await tx.query(
        `UPDATE subscriptions SET status = $1, canceled_at = $2, updated_at = now()
          WHERE id = $3 RETURNING *`,
        [status, closingPeriodEnd, subscription.id],
      );
      return { subscription: rows[0], invoice: null, renewed: false, reason: 'canceled at period end' };
    }

    const invoiceShell = await reserveInvoice(tx, {
      subscription,
      periodStart: newPeriodStart,
      periodEnd: newPeriodEnd,
    });

    const { units, eventCount } = await claimUsage(tx, {
      subscriptionId: subscription.id,
      invoiceId: invoiceShell.id,
      periodEnd: closingPeriodEnd,
    });

    const lines = [];
    const meteredLine = buildMeteredLine({
      plan,
      units,
      periodStart: closingPeriodStart,
      periodEnd: closingPeriodEnd,
    });
    if (meteredLine) lines.push(meteredLine);

    const basePrice = Number(plan.base_price_cents);
    lines.push({
      kind: LINE_KINDS.BASE,
      planId: plan.id,
      description: `${plan.name} (${plan.interval}ly)`,
      amountCents: basePrice,
      periodStart: newPeriodStart,
      periodEnd: newPeriodEnd,
    });

    const { invoice } = await finalizeInvoice(tx, {
      invoice: invoiceShell,
      subscription,
      lines,
    });

    await insertBilledItem(tx, {
      subscriptionId: subscription.id,
      planId: plan.id,
      amountCents: basePrice,
      startsAt: newPeriodStart,
      endsAt: newPeriodEnd,
      invoiceId: invoice.id,
    });

    // A trial that reaches its end becomes a paying subscription.
    const nextStatus = subscription.status === STATES.TRIALING
      ? transition(subscription.status, STATES.ACTIVE)
      : subscription.status;

    const { rows } = await tx.query(
      `UPDATE subscriptions
          SET current_period_start = $1, current_period_end = $2, status = $3, updated_at = now()
        WHERE id = $4
        RETURNING *`,
      [newPeriodStart, newPeriodEnd, nextStatus, subscription.id],
    );

    return {
      subscription: rows[0],
      invoice,
      renewed: true,
      usage: { units, eventCount },
      customer,
      at: at_,
    };
  });
}

/** Cancel now, or at period end. */
export async function cancelSubscription(db, { subscriptionId, atPeriodEnd = false, at = nowSeconds() }) {
  const canceledAt = toEpochSeconds(at);

  return db.tx(async (tx) => {
    const subscription = await lockSubscription(tx, subscriptionId);

    if (atPeriodEnd) {
      const { rows } = await tx.query(
        `UPDATE subscriptions SET cancel_at_period_end = TRUE, updated_at = now()
          WHERE id = $1 RETURNING *`,
        [subscription.id],
      );
      return { subscription: rows[0], immediate: false };
    }

    const status = transition(subscription.status, STATES.CANCELED);
    const { rows } = await tx.query(
      `UPDATE subscriptions SET status = $1, canceled_at = $2, updated_at = now()
        WHERE id = $3 RETURNING *`,
      [status, canceledAt, subscription.id],
    );
    return { subscription: rows[0], immediate: true };
  });
}

export async function getSubscription(db, subscriptionId) {
  const { rows } = await db.query(
    `SELECT s.*, p.name AS plan_name, p.base_price_cents, p.included_units,
            p.metered_rate_microcents, p.metered_unit_label, c.email AS customer_email
       FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id
       JOIN customers c ON c.id = s.customer_id
      WHERE s.id = $1`,
    [subscriptionId],
  );
  return rows[0] ?? null;
}

/** Subscriptions whose period has ended and that are due to roll over. */
export async function findDueForRenewal(db, { at = nowSeconds(), limit = 100 } = {}) {
  const { rows } = await db.query(
    `SELECT id FROM subscriptions
      WHERE status IN ('trialing','active','past_due')
        AND current_period_end <= $1
      ORDER BY current_period_end
      LIMIT $2`,
    [toEpochSeconds(at), limit],
  );
  return rows.map((r) => r.id);
}

export { nowSeconds, lockSubscription, loadPlan, insertBilledItem };
