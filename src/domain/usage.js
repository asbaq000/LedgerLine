/**
 * Metered usage aggregation.
 *
 * ---------------------------------------------------------------------------
 * The cycle-boundary problem
 * ---------------------------------------------------------------------------
 * Two different things get conflated as "the boundary case", and they need
 * different fixes:
 *
 * 1. An event whose timestamp lands exactly on the rollover instant.
 *    Fixed by making every period half-open: [periodStart, periodEnd).
 *    An event at exactly periodEnd belongs to the NEXT period, never both and
 *    never neither. Using closed intervals on both ends double-bills the
 *    instant; using exclusive on both ends drops it.
 *
 * 2. An event that BELONGS to a period but ARRIVES after that period was
 *    invoiced. A request made at 23:59:59.9 can reach the meter seconds later,
 *    after the cycle rolled and possibly after the invoice was finalized. You
 *    cannot retroactively edit a finalized invoice, and you must not silently
 *    drop the usage.
 *
 * The fix for (2) is to aggregate by CLAIM rather than by time window. Each
 * usage event carries billedInvoiceId, NULL until an invoice claims it.
 * Aggregation for a period selects unclaimed events with ts < periodEnd -- so
 * late arrivals from an already-closed period are swept onto the NEXT invoice
 * as an explicit adjustment line instead of vanishing. Ordinary events and late
 * events flow through exactly the same query; there is no separate code path to
 * forget about.
 *
 * These functions are pure. The SQL in usageService mirrors this predicate
 * exactly, and integration tests assert the two agree.
 */

import { mulDivRound, MICROCENTS_PER_CENT } from './money.js';
import { toEpochSeconds } from './time.js';

/**
 * Does an event fall in [periodStart, periodEnd)?
 * Half-open by construction -- this is the boundary rule, in one place.
 */
export function eventInPeriod(event, periodStart, periodEnd) {
  const ts = toEpochSeconds(event.timestamp ?? event.ts);
  return ts >= toEpochSeconds(periodStart) && ts < toEpochSeconds(periodEnd);
}

/**
 * Total quantity for a period, counting only events not already billed.
 *
 * @param {Array<{timestamp: number|Date, quantity: number, billedInvoiceId?: string|null}>} events
 * @param {object} window
 * @param {number|Date} window.periodEnd    Exclusive upper bound.
 * @param {number|Date} [window.periodStart] Inclusive lower bound. Omit to sweep
 *   in unbilled stragglers from earlier periods (the normal invoicing case).
 */
export function aggregateUsage(events, { periodStart, periodEnd } = {}) {
  const end = toEpochSeconds(periodEnd);
  const start = periodStart === undefined ? null : toEpochSeconds(periodStart);

  let units = 0;
  let inPeriod = 0;
  let late = 0;

  for (const e of events) {
    if (e.billedInvoiceId) continue; // already claimed by a finalized invoice
    const ts = toEpochSeconds(e.timestamp ?? e.ts);
    if (ts >= end) continue; // belongs to a future period (half-open upper bound)
    if (start !== null && ts < start) {
      late += e.quantity;
    } else {
      inPeriod += e.quantity;
    }
    units += e.quantity;
  }

  return { units, inPeriodUnits: inPeriod, lateUnits: late };
}

/**
 * Split events at a rollover instant, applying the half-open rule.
 * An event at exactly `boundary` lands in `after`.
 */
export function splitAtBoundary(events, boundary) {
  const b = toEpochSeconds(boundary);
  const before = [];
  const after = [];
  for (const e of events) {
    const ts = toEpochSeconds(e.timestamp ?? e.ts);
    (ts < b ? before : after).push(e);
  }
  return { before, after };
}

/**
 * Metered charge in whole cents.
 * Only usage ABOVE includedUnits is billable ("$29/mo + $0.01 per call over 10,000").
 *
 * rateMicrocents is cents * 1e6 per unit, so $0.01/call === 1_000_000.
 */
export function meteredCharge({ units, includedUnits = 0, rateMicrocents = 0 }) {
  if (!Number.isInteger(units) || units < 0) {
    throw new TypeError(`meteredCharge: units must be a non-negative integer, got ${units}`);
  }
  if (!Number.isInteger(includedUnits) || includedUnits < 0) {
    throw new TypeError(`meteredCharge: includedUnits must be a non-negative integer, got ${includedUnits}`);
  }
  const billable = Math.max(0, units - includedUnits);
  if (billable === 0 || rateMicrocents === 0) {
    return { billableUnits: billable, amountCents: 0 };
  }
  return {
    billableUnits: billable,
    amountCents: mulDivRound(billable, rateMicrocents, MICROCENTS_PER_CENT),
  };
}
