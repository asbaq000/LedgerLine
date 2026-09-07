/**
 * Proration.
 *
 * ---------------------------------------------------------------------------
 * The model, and why it is a ledger rather than a formula
 * ---------------------------------------------------------------------------
 * The naive implementation of "prorate a plan change" is:
 *
 *     credit = oldPlanPrice * remaining / periodLength
 *     charge = newPlanPrice * remaining / periodLength
 *
 * Be precise about when that is actually wrong, because it is easy to
 * over-claim here. For a chain of plain list-price plan changes the naive
 * formula and the ledger below are ALGEBRAICALLY IDENTICAL, and the tests
 * assert exactly that. Closing an item billed at P*(end-t1)/(end-start) and
 * crediting its unused tail over its own span gives P*(end-t2)/(end-start) --
 * the naive answer, up to a cent of rounding. No disagreement in that case.
 *
 * The naive formula breaks when the amount actually billed is NOT the list
 * price prorated. That happens constantly in practice: a coupon or discount, a
 * plan whose price changed mid-cycle, a credit already issued, a mid-period
 * signup billed for a partial period. Concretely -- customer on $29 starter
 * with a 50% coupon is billed 1450 for the period, then upgrades on day 10:
 *
 *   naive  credit = 2900 * 20/30 = 1933   <-- against a payment of 1450
 *   ledger credit = 1450 * 20/30 =  967
 *
 * The naive path hands back 966 cents that were never collected, and it does
 * so silently. That is how a billing system starts paying its customers.
 *
 * So: we keep a ledger of BILLED ITEMS. Each item records the amount actually
 * charged and the span it covers. A plan change closes the open item, credits
 * the unused fraction of the amount ACTUALLY BILLED for that item over that
 * item span, and opens a new item for the remainder of the period. This makes
 * the invariant structural rather than incidental.
 *
 *   credit_n = billedAmount_n * (periodEnd - changeAt) / (itemEnd_n - itemStart_n)
 *   charge   = newPlanPrice  * (periodEnd - changeAt) / (periodEnd - periodStart)
 *
 * The credit denominator is the span of the item being closed; the charge
 * denominator is the full period, because a plan price is quoted per full
 * period. Those two denominators being different is the whole point, and it is
 * the thing that is easy to get wrong.
 *
 * INVARIANT (enforced by assertNoOverCredit, tested directly):
 *   for every item, sum(credits against it) <= amount billed for it.
 *
 * ---------------------------------------------------------------------------
 * Rounding
 * ---------------------------------------------------------------------------
 * Every line is rounded to whole cents independently, half away from zero.
 * Independent rounding means a sequence of changes can land a cent or two away
 * from the ideal continuous-time integral. That is expected and
 * correct-by-design: an invoice line must be a whole number of cents, and each
 * line has to stand on its own because the customer sees it. The tests assert
 * the exact expected ledger rather than pretending the drift does not exist.
 */

import { mulDivRound, sumCents } from './money.js';
import { periodLength, toEpochSeconds } from './time.js';

/**
 * @typedef {object} BilledItem
 * @property {string} [id]
 * @property {string} planId
 * @property {number} amountCents  Amount retained for this item (billed minus credits).
 * @property {number} startsAt     Epoch seconds, inclusive.
 * @property {number} endsAt       Epoch seconds, exclusive.
 */

export const LINE_KINDS = Object.freeze({
  BASE: 'base',
  PRORATION_CREDIT: 'proration_credit',
  PRORATION_CHARGE: 'proration_charge',
  METERED: 'metered',
  ADJUSTMENT: 'adjustment',
});

/**
 * Charge for a plan covering [from, periodEnd) out of the full [periodStart, periodEnd).
 * from === periodStart yields the full price; from === periodEnd yields 0.
 */
export function proratedCharge({ priceCents, periodStart, periodEnd, from }) {
  const start = toEpochSeconds(periodStart);
  const end = toEpochSeconds(periodEnd);
  const at = toEpochSeconds(from);
  const total = periodLength(start, end);

  if (at < start || at > end) {
    throw new RangeError(`proratedCharge: from=${at} outside period [${start}, ${end}]`);
  }
  return mulDivRound(priceCents, end - at, total);
}

/**
 * Credit for the unused tail of an already-billed item, as a NEGATIVE amount.
 * Prorated against the amount actually billed for the item, over the span the
 * item actually covers.
 */
export function unusedCredit(item, changeAt) {
  const at = toEpochSeconds(changeAt);
  const start = toEpochSeconds(item.startsAt);
  const end = toEpochSeconds(item.endsAt);
  const span = periodLength(start, end);

  if (at < start) {
    throw new RangeError(`unusedCredit: changeAt=${at} precedes item start=${start}`);
  }
  if (at >= end) return 0; // already fully consumed -- nothing to give back

  return -mulDivRound(item.amountCents, end - at, span);
}

/**
 * Compute the proration for a mid-cycle plan change.
 *
 * @param {object} args
 * @param {BilledItem[]} args.items Open billed items covering the current period.
 * @param {number|Date|string} args.changeAt
 * @param {number|Date|string} args.periodStart
 * @param {number|Date|string} args.periodEnd
 * @param {{id: string, basePriceCents: number}} args.newPlan
 */
export function planChangeProration({ items, changeAt, periodStart, periodEnd, newPlan }) {
  const start = toEpochSeconds(periodStart);
  const end = toEpochSeconds(periodEnd);
  const at = toEpochSeconds(changeAt);
  periodLength(start, end); // validates end > start

  if (at < start || at > end) {
    throw new RangeError(`planChangeProration: changeAt=${at} outside period [${start}, ${end}]`);
  }
  if (!newPlan || !Number.isInteger(newPlan.basePriceCents)) {
    throw new TypeError('planChangeProration: newPlan.basePriceCents must be an integer');
  }

  const credits = [];
  const nextItems = [];

  for (const item of items) {
    const itemEnd = toEpochSeconds(item.endsAt);
    if (itemEnd <= at) {
      nextItems.push({ ...item }); // fully consumed before the change
      continue;
    }
    const creditCents = unusedCredit(item, at);
    if (creditCents !== 0) {
      credits.push({
        kind: LINE_KINDS.PRORATION_CREDIT,
        planId: item.planId,
        amountCents: creditCents,
        periodStart: at,
        periodEnd: itemEnd,
        sourceItemId: item.id,
        description: `Unused time on ${item.planId}`,
      });
    }
    // The item now covers only what was actually consumed, and its retained
    // amount drops by the credit just issued. Both matter: a LATER change must
    // prorate against the retained amount, not against the original list price.
    nextItems.push({
      ...item,
      endsAt: at,
      amountCents: item.amountCents + creditCents, // creditCents <= 0
      creditedCents: (item.creditedCents ?? 0) - creditCents,
      closedAt: at,
    });
  }

  const chargeCents = proratedCharge({
    priceCents: newPlan.basePriceCents,
    periodStart: start,
    periodEnd: end,
    from: at,
  });

  const charges = [{
    kind: LINE_KINDS.PRORATION_CHARGE,
    planId: newPlan.id,
    amountCents: chargeCents,
    periodStart: at,
    periodEnd: end,
    description: `Remaining time on ${newPlan.id}`,
  }];

  nextItems.push({
    planId: newPlan.id,
    amountCents: chargeCents,
    startsAt: at,
    endsAt: end,
  });

  const netCents = sumCents([...credits.map((c) => c.amountCents), chargeCents]);

  return {
    credits,
    charges,
    netCents,
    items: nextItems,
    direction: netCents > 0 ? 'upgrade' : netCents < 0 ? 'downgrade' : 'lateral',
  };
}

/**
 * The invariant that makes the ledger trustworthy: you can never hand back more
 * than you took for a given item. Called from the service layer on every change.
 */
export function assertNoOverCredit(items) {
  for (const item of items) {
    if (item.amountCents < 0) {
      throw new Error(
        `proration invariant violated: item ${item.id ?? item.planId} retained ${item.amountCents} cents (credits exceeded charges)`,
      );
    }
  }
  return true;
}

/** Total retained across all items for the period -- what the period actually costs. */
export function ledgerTotal(items) {
  return sumCents(items.map((i) => i.amountCents));
}
