/**
 * Subscription state machine.
 *
 *   trialing --> active --> past_due --> canceled
 *
 * plus `paused`, and `canceled` as a terminal absorbing state.
 *
 * Two rules carry the weight here:
 *
 * 1. Illegal transitions THROW rather than silently no-op. A billing system
 *    that quietly ignores an impossible transition is a billing system whose
 *    state drifts from the payment provider without anyone noticing.
 *
 * 2. `canceled` is terminal. A late webhook cannot resurrect a canceled
 *    subscription. Combined with the timestamp ordering guard in ordering.js,
 *    that is what stops an out-of-order `invoice.payment_succeeded` from
 *    reviving a subscription the dunning process already gave up on.
 */

export const STATES = Object.freeze({
  TRIALING: 'trialing',
  ACTIVE: 'active',
  PAST_DUE: 'past_due',
  PAUSED: 'paused',
  CANCELED: 'canceled',
});

export const ALL_STATES = Object.freeze(Object.values(STATES));

/** Allowed target states, keyed by current state. */
const TRANSITIONS = Object.freeze({
  [STATES.TRIALING]: [STATES.ACTIVE, STATES.PAST_DUE, STATES.PAUSED, STATES.CANCELED],
  [STATES.ACTIVE]: [STATES.PAST_DUE, STATES.PAUSED, STATES.CANCELED],
  [STATES.PAST_DUE]: [STATES.ACTIVE, STATES.PAUSED, STATES.CANCELED],
  [STATES.PAUSED]: [STATES.ACTIVE, STATES.CANCELED],
  [STATES.CANCELED]: [], // terminal
});

export class IllegalTransitionError extends Error {
  constructor(from, to) {
    super(`illegal subscription transition: ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
    this.from = from;
    this.to = to;
    this.statusCode = 409;
  }
}

export function isTerminal(state) {
  return state === STATES.CANCELED;
}

export function canTransition(from, to) {
  if (!ALL_STATES.includes(from)) throw new TypeError(`unknown state: ${from}`);
  if (!ALL_STATES.includes(to)) throw new TypeError(`unknown state: ${to}`);
  if (from === to) return true; // idempotent re-application of the same state
  return TRANSITIONS[from].includes(to);
}

/** Returns `to`, or throws IllegalTransitionError. */
export function transition(from, to) {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
  return to;
}

/**
 * Map a Stripe subscription status onto ours.
 * Stripe's `incomplete` / `incomplete_expired` / `unpaid` have no distinct
 * local meaning here, so they collapse onto the nearest state we do model.
 */
export function fromStripeStatus(stripeStatus) {
  switch (stripeStatus) {
    case 'trialing': return STATES.TRIALING;
    case 'active': return STATES.ACTIVE;
    case 'past_due': return STATES.PAST_DUE;
    case 'unpaid': return STATES.PAST_DUE;
    case 'incomplete': return STATES.PAST_DUE;
    case 'paused': return STATES.PAUSED;
    case 'canceled': return STATES.CANCELED;
    case 'incomplete_expired': return STATES.CANCELED;
    default: throw new TypeError(`unmapped Stripe subscription status: ${stripeStatus}`);
  }
}

/** States that should keep accruing usage and generating invoices. */
export function isBillable(state) {
  return state === STATES.ACTIVE || state === STATES.PAST_DUE || state === STATES.TRIALING;
}
