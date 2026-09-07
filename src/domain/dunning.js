/**
 * Dunning: what to do after a payment fails.
 *
 * Schedule is expressed as day offsets from the FIRST failure, not as gaps
 * between retries. Offsets-from-origin means a delayed or re-run job cannot
 * make the schedule drift: retry 3 is always day 7 after the initial failure,
 * whether or not retry 2 fired late. With gap-based scheduling, one slow worker
 * shifts every subsequent attempt.
 *
 * These functions are pure and take `now` explicitly -- no clock reads, so the
 * whole schedule is testable without waiting or mocking timers.
 */

import { days, toEpochSeconds } from './time.js';

export const DEFAULT_RETRY_OFFSET_DAYS = Object.freeze([1, 3, 7]);

export const DUNNING_ACTIONS = Object.freeze({
  RETRY: 'retry',
  CANCEL: 'cancel',
});

/**
 * Plan the next dunning step.
 *
 * @param {object} args
 * @param {number|Date|string} args.firstFailedAt When the invoice first failed.
 * @param {number} args.attemptsMade Retries already ATTEMPTED (0 right after the initial failure).
 * @param {number[]} [args.retryOffsetDays] Day offsets from firstFailedAt.
 * @param {number} [args.maxAttempts] Retries allowed before giving up. Defaults
 *   to the length of the schedule.
 * @returns {{action: 'retry', at: number, attempt: number}|{action: 'cancel', reason: string}}
 */
export function nextDunningStep({
  firstFailedAt,
  attemptsMade = 0,
  retryOffsetDays = DEFAULT_RETRY_OFFSET_DAYS,
  maxAttempts = retryOffsetDays.length,
}) {
  const origin = toEpochSeconds(firstFailedAt);

  if (!Number.isInteger(attemptsMade) || attemptsMade < 0) {
    throw new TypeError(`nextDunningStep: attemptsMade must be a non-negative integer, got ${attemptsMade}`);
  }
  if (!Array.isArray(retryOffsetDays) || retryOffsetDays.length === 0) {
    throw new TypeError('nextDunningStep: retryOffsetDays must be a non-empty array');
  }
  for (let i = 1; i < retryOffsetDays.length; i += 1) {
    if (retryOffsetDays[i] <= retryOffsetDays[i - 1]) {
      throw new TypeError(`nextDunningStep: retryOffsetDays must be strictly increasing, got ${retryOffsetDays}`);
    }
  }

  const limit = Math.min(maxAttempts, retryOffsetDays.length);
  if (attemptsMade >= limit) {
    return {
      action: DUNNING_ACTIONS.CANCEL,
      reason: `exhausted ${limit} retry attempt(s)`,
    };
  }

  return {
    action: DUNNING_ACTIONS.RETRY,
    at: origin + days(retryOffsetDays[attemptsMade]),
    attempt: attemptsMade + 1,
  };
}

/**
 * The full schedule for one dunning cycle, for display and for tests that want
 * to assert the whole thing at once rather than stepping.
 */
export function dunningSchedule({
  firstFailedAt,
  retryOffsetDays = DEFAULT_RETRY_OFFSET_DAYS,
  maxAttempts = retryOffsetDays.length,
}) {
  const steps = [];
  for (let attemptsMade = 0; ; attemptsMade += 1) {
    const step = nextDunningStep({ firstFailedAt, attemptsMade, retryOffsetDays, maxAttempts });
    steps.push(step);
    if (step.action === DUNNING_ACTIONS.CANCEL) return steps;
  }
}

/** Which notification to send at each stage. */
export function dunningNotification({ action, attempt, maxAttempts, at }) {
  if (action === DUNNING_ACTIONS.CANCEL) {
    return {
      template: 'subscription_canceled_for_nonpayment',
      subject: 'Your subscription has been canceled',
    };
  }
  const isFinal = attempt >= maxAttempts;
  return {
    template: isFinal ? 'payment_failed_final_notice' : 'payment_failed_retry',
    subject: isFinal
      ? 'Final notice: update your payment method'
      : `Payment failed - we will retry (attempt ${attempt} of ${maxAttempts})`,
    retryAt: at,
  };
}
