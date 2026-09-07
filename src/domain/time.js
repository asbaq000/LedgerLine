/**
 * Billing-period arithmetic.
 *
 * All internal math is in integer epoch SECONDS. Seconds (not days) is the
 * proration basis: a plan change at 14:30 on day 10 should not be rounded to a
 * whole day boundary, and using seconds makes the 30-day-cycle test cases exact
 * anyway (a day is exactly 86400 seconds in UTC).
 */

export const SECONDS_PER_DAY = 86_400;

export function toEpochSeconds(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`toEpochSeconds: ${value}`);
    // Heuristic-free: numbers are always treated as epoch seconds.
    return Math.trunc(value);
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError('toEpochSeconds: Invalid Date');
    return Math.floor(value.getTime() / 1000);
  }
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) throw new TypeError(`toEpochSeconds: cannot parse ${value}`);
    return Math.floor(ms / 1000);
  }
  throw new TypeError(`toEpochSeconds: unsupported ${typeof value}`);
}

export function toDate(epochSeconds) {
  return new Date(toEpochSeconds(epochSeconds) * 1000);
}

export function days(n) {
  return n * SECONDS_PER_DAY;
}

/**
 * Advance a billing anchor by `count` months, clamping to the end of the target
 * month. A subscription that starts Jan 31 bills Feb 28, then Mar 31 -- the
 * anchor day is preserved rather than drifting to the 28th forever, which is
 * what Stripe does and what customers expect.
 */
export function addMonths(epochSeconds, count, anchorDay = null) {
  const d = toDate(epochSeconds);
  const day = anchorDay ?? d.getUTCDate();
  const targetMonth = d.getUTCMonth() + count;
  const targetYear = d.getUTCFullYear() + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  const lastDay = daysInMonth(targetYear, normalizedMonth);

  const result = new Date(Date.UTC(
    targetYear,
    normalizedMonth,
    Math.min(day, lastDay),
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
  ));
  return Math.floor(result.getTime() / 1000);
}

export function daysInMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/** The day-of-month a subscription's billing cycle is anchored to. */
export function billingAnchorDay(epochSeconds) {
  return toDate(epochSeconds).getUTCDate();
}

/**
 * Next billing period after `periodStart`, given an interval.
 * `anchorDay` should be the day-of-month of the ORIGINAL subscription start so
 * that a Jan-31 subscription returns to the 31st after passing through February.
 */
export function nextPeriod(periodStart, { interval = 'month', intervalCount = 1, anchorDay = null } = {}) {
  const start = toEpochSeconds(periodStart);
  if (interval === 'month') return addMonths(start, intervalCount, anchorDay);
  if (interval === 'year') return addMonths(start, 12 * intervalCount, anchorDay);
  if (interval === 'week') return start + days(7 * intervalCount);
  if (interval === 'day') return start + days(intervalCount);
  throw new TypeError(`nextPeriod: unsupported interval ${interval}`);
}

/** Length of a period in seconds. Throws on a zero/negative period. */
export function periodLength(periodStart, periodEnd) {
  const start = toEpochSeconds(periodStart);
  const end = toEpochSeconds(periodEnd);
  const length = end - start;
  if (length <= 0) {
    throw new RangeError(`periodLength: period must be positive (start=${start}, end=${end})`);
  }
  return length;
}

/** Half-open containment: start <= t < end. The boundary belongs to the NEXT period. */
export function containsInstant(periodStart, periodEnd, t) {
  const at = toEpochSeconds(t);
  return at >= toEpochSeconds(periodStart) && at < toEpochSeconds(periodEnd);
}
