/**
 * Money arithmetic, period math, the state machine, and event ordering.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { mulDivRound, sumCents, formatCents, dollarsToCents } from '../src/domain/money.js';
import { nextPeriod, addMonths, periodLength, toEpochSeconds, containsInstant, toDate } from '../src/domain/time.js';
import {
  STATES, canTransition, transition, isTerminal, isBillable,
  fromStripeStatus, IllegalTransitionError,
} from '../src/domain/subscriptionState.js';
import { orderKey, compareOrderKeys, isStale, payloadSeq } from '../src/domain/ordering.js';
import { T0, days } from './helpers.js';

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

test('mulDivRound rounds half away from zero, symmetrically', () => {
  assert.equal(mulDivRound(100, 1, 8), 13, '12.5 -> 13');
  assert.equal(mulDivRound(-100, 1, 8), -13, '-12.5 -> -13');
  assert.equal(mulDivRound(100, 3, 8), 38, '37.5 -> 38');
  assert.equal(mulDivRound(2900, 20, 30), 1933, '1933.33 -> 1933');
  assert.equal(mulDivRound(0, 5, 3), 0);
});

test('mulDivRound stays exact past the float safe-integer range', () => {
  // 1e9 * 1e6 = 1e15; naive float arithmetic starts losing integers near 9e15.
  assert.equal(mulDivRound(1_000_000_000, 1_000_000, 1_000_000), 1_000_000_000);
  assert.equal(mulDivRound(999_999_999, 1_000_003, 1_000_000), 1_000_002_999);
});

test('mulDivRound refuses to guess about bad input', () => {
  assert.throws(() => mulDivRound(100, 1, 0), /division by zero/);
  assert.throws(() => mulDivRound(1.5, 1, 2), /must be an integer/);
});

test('sumCents rejects non-integer money instead of silently drifting', () => {
  assert.equal(sumCents([100, -50, 25]), 75);
  assert.throws(() => sumCents([100, 0.5]), /non-integer/);
});

test('formatting and parsing round-trip', () => {
  assert.equal(formatCents(2900), '$29.00');
  assert.equal(formatCents(-1933), '-$19.33');
  assert.equal(formatCents(5), '$0.05');
  assert.equal(formatCents(0), '$0.00');

  assert.equal(dollarsToCents('29'), 2900);
  assert.equal(dollarsToCents('29.99'), 2999);
  assert.equal(dollarsToCents('$1,299.50'), 129950);
  assert.equal(dollarsToCents('0.01'), 1);
  assert.equal(dollarsToCents(29.9), 2990);
  assert.throws(() => dollarsToCents('29.999'), /cannot parse/);
  assert.throws(() => dollarsToCents('abc'), /cannot parse/);
});

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

test('month arithmetic clamps to the end of a short month but keeps the anchor', () => {
  const jan31 = Math.floor(Date.UTC(2025, 0, 31) / 1000);
  const iso = (t) => toDate(t).toISOString().slice(0, 10);

  let p = jan31;
  const seen = [];
  for (let i = 0; i < 5; i += 1) {
    p = nextPeriod(p, { anchorDay: 31 });
    seen.push(iso(p));
  }
  assert.deepEqual(seen, ['2025-02-28', '2025-03-31', '2025-04-30', '2025-05-31', '2025-06-30']);
});

test('February 29 in a leap year is handled', () => {
  const jan31_2024 = Math.floor(Date.UTC(2024, 0, 31) / 1000);
  assert.equal(toDate(addMonths(jan31_2024, 1, 31)).toISOString().slice(0, 10), '2024-02-29');
});

test('supported intervals', () => {
  const start = T0;
  assert.equal(nextPeriod(start, { interval: 'day', intervalCount: 10 }) - start, days(10));
  assert.equal(nextPeriod(start, { interval: 'week' }) - start, days(7));
  assert.equal(toDate(nextPeriod(start, { interval: 'year' })).getUTCFullYear(), 2026);
  assert.throws(() => nextPeriod(start, { interval: 'fortnight' }), /unsupported interval/);
});

test('a period must have positive length', () => {
  assert.throws(() => periodLength(100, 100), /must be positive/);
  assert.throws(() => periodLength(200, 100), /must be positive/);
  assert.equal(periodLength(100, 200), 100);
});

test('period containment is half-open', () => {
  assert.equal(containsInstant(0, 100, 0), true);
  assert.equal(containsInstant(0, 100, 99), true);
  assert.equal(containsInstant(0, 100, 100), false);
});

test('timestamps are accepted as seconds, Dates or ISO strings', () => {
  assert.equal(toEpochSeconds(1_700_000_000), 1_700_000_000);
  assert.equal(toEpochSeconds(new Date('2025-01-01T00:00:00Z')), T0);
  assert.equal(toEpochSeconds('2025-01-01T00:00:00Z'), T0);
  assert.throws(() => toEpochSeconds('not a date'), /cannot parse/);
  assert.throws(() => toEpochSeconds(new Date('nope')), /Invalid Date/);
});

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

test('the documented lifecycle is permitted', () => {
  assert.ok(canTransition(STATES.TRIALING, STATES.ACTIVE));
  assert.ok(canTransition(STATES.ACTIVE, STATES.PAST_DUE));
  assert.ok(canTransition(STATES.PAST_DUE, STATES.CANCELED));
  assert.ok(canTransition(STATES.PAST_DUE, STATES.ACTIVE), 'a successful retry recovers');
  assert.ok(canTransition(STATES.ACTIVE, STATES.PAUSED));
  assert.ok(canTransition(STATES.PAUSED, STATES.ACTIVE));
});

test('canceled is terminal and absorbing', () => {
  assert.ok(isTerminal(STATES.CANCELED));
  for (const target of [STATES.ACTIVE, STATES.TRIALING, STATES.PAST_DUE, STATES.PAUSED]) {
    assert.equal(canTransition(STATES.CANCELED, target), false, `canceled -> ${target}`);
    assert.throws(() => transition(STATES.CANCELED, target), IllegalTransitionError);
  }
  assert.equal(canTransition(STATES.CANCELED, STATES.CANCELED), true, 're-cancelling is a no-op');
});

test('you cannot go back to trialing once billing has started', () => {
  assert.equal(canTransition(STATES.ACTIVE, STATES.TRIALING), false);
  assert.equal(canTransition(STATES.PAST_DUE, STATES.TRIALING), false);
});

test('an illegal transition throws with a 409, rather than silently no-opping', () => {
  assert.throws(
    () => transition(STATES.CANCELED, STATES.ACTIVE),
    (err) => {
      assert.ok(err instanceof IllegalTransitionError);
      assert.equal(err.statusCode, 409, 'surfaces as a conflict, not a 500');
      assert.equal(err.from, STATES.CANCELED);
      assert.equal(err.to, STATES.ACTIVE);
      assert.match(err.message, /canceled -> active/);
      return true;
    },
  );
});

test('unknown states are rejected', () => {
  assert.throws(() => canTransition('bogus', STATES.ACTIVE), /unknown state/);
});

test('Stripe statuses map onto the local model', () => {
  assert.equal(fromStripeStatus('active'), STATES.ACTIVE);
  assert.equal(fromStripeStatus('trialing'), STATES.TRIALING);
  assert.equal(fromStripeStatus('past_due'), STATES.PAST_DUE);
  assert.equal(fromStripeStatus('unpaid'), STATES.PAST_DUE);
  assert.equal(fromStripeStatus('incomplete'), STATES.PAST_DUE);
  assert.equal(fromStripeStatus('canceled'), STATES.CANCELED);
  assert.equal(fromStripeStatus('incomplete_expired'), STATES.CANCELED);
  assert.throws(() => fromStripeStatus('brand_new_status'), /unmapped/);
});

test('billable states accrue usage', () => {
  assert.ok(isBillable(STATES.ACTIVE));
  assert.ok(isBillable(STATES.PAST_DUE), 'still owed for what they use');
  assert.ok(isBillable(STATES.TRIALING));
  assert.equal(isBillable(STATES.CANCELED), false);
  assert.equal(isBillable(STATES.PAUSED), false);
});

// ---------------------------------------------------------------------------
// Event ordering
// ---------------------------------------------------------------------------

const ev = (type, created, attempt) => ({
  id: 'evt', type, created, data: { object: attempt === undefined ? {} : { attempt_count: attempt } },
});

test('order keys compare on timestamp first', () => {
  assert.ok(compareOrderKeys(orderKey(ev('invoice.payment_failed', 100, 1)),
    orderKey(ev('invoice.payment_succeeded', 200, 2))) < 0);
});

test('attempt_count breaks same-second ties with real information', () => {
  // Stripe's `created` is second-granularity, so this collision is routine.
  const earlier = orderKey(ev('invoice.payment_failed', 500, 1));
  const later = orderKey(ev('invoice.payment_failed', 500, 2));
  assert.ok(compareOrderKeys(earlier, later) < 0);
  assert.equal(payloadSeq(ev('invoice.payment_failed', 500, 7)), 7);
  assert.equal(payloadSeq(ev('customer.subscription.updated', 500)), 0, 'no counter on subscriptions');
});

test('type rank is the last-resort tiebreak: success outranks failure', () => {
  const failed = orderKey(ev('invoice.payment_failed', 500, 1));
  const succeeded = orderKey(ev('invoice.payment_succeeded', 500, 1));
  assert.ok(compareOrderKeys(failed, succeeded) < 0);

  const deleted = orderKey(ev('customer.subscription.deleted', 500));
  const updated = orderKey(ev('customer.subscription.updated', 500));
  assert.ok(compareOrderKeys(updated, deleted) < 0, 'deletion is terminal and outranks');
});

test('staleness means STRICTLY older, so exact ties still apply', () => {
  const key = orderKey(ev('invoice.payment_succeeded', 200, 1));

  assert.equal(isStale(null, key), false, 'nothing applied yet');
  assert.equal(isStale(key, key), false, 'a tie applies -- duplicates are caught by event id');
  assert.equal(isStale(key, orderKey(ev('invoice.payment_failed', 100, 1))), true);
  assert.equal(isStale(key, orderKey(ev('invoice.payment_succeeded', 300, 2))), false);
});

test('an event without a usable timestamp is rejected rather than ordered arbitrarily', () => {
  assert.throws(() => orderKey({ type: 'invoice.paid' }), /must be a number/);
});
