/**
 * Out-of-order webhook handling.
 *
 * ---------------------------------------------------------------------------
 * The problem
 * ---------------------------------------------------------------------------
 * Stripe does not guarantee delivery order. The canonical break is a retried
 * payment: `invoice.payment_failed` (t=100) then `invoice.payment_succeeded`
 * (t=200), delivered in reverse. Applying by ARRIVAL order leaves the
 * subscription `past_due` forever while Stripe considers it `active` -- exactly
 * the drift the brief forbids.
 *
 * ---------------------------------------------------------------------------
 * The rule
 * ---------------------------------------------------------------------------
 * Every mutable object (subscription, invoice) records the order key of the
 * last event applied to it. An incoming event mutates state only if it is not
 * STRICTLY OLDER than what was already applied. Stale events are still
 * persisted and acknowledged -- they are just not allowed to move state.
 *
 * The order key is a triple, compared lexicographically:
 *
 *   [ event.created , payloadSeq , typeRank ]
 *
 * `event.created` alone is not enough, and this is the part that is usually
 * skipped: Stripe's `created` has ONE-SECOND granularity. A failure and its
 * immediate retry genuinely can share a timestamp, so a bare timestamp
 * comparison has real ties in production, not just in theory.
 *
 *   payloadSeq -- a monotonic counter pulled from the object itself.
 *                 `invoice.attempt_count` increments on every payment attempt,
 *                 so it totally orders the dunning sequence for one invoice
 *                 regardless of clock granularity. This is real ordering
 *                 information, not a heuristic.
 *
 *   typeRank   -- last-resort tiebreak for same-second, same-attempt events.
 *                 This one IS a heuristic and is documented as such: a success
 *                 outranks a failure, and a deletion outranks everything,
 *                 because those are the terminal facts for an attempt. It only
 *                 ever decides ties the first two components could not.
 *
 * "Not strictly older" (rather than "strictly newer") is deliberate: on an
 * exact tie we apply. Erring toward applying is safe because true duplicates
 * are caught by event-id idempotency upstream, whereas erring toward skipping
 * would silently drop distinct events that happen to collide.
 */

/**
 * Terminal facts outrank in-flight ones. Only consulted when `created` and
 * `payloadSeq` are both tied.
 */
const TYPE_RANK = Object.freeze({
  'invoice.created': 5,
  'invoice.finalized': 8,
  'invoice.payment_action_required': 10,
  'invoice.payment_failed': 10,
  'customer.subscription.trial_will_end': 12,
  'customer.subscription.updated': 15,
  'invoice.payment_succeeded': 20,
  'invoice.paid': 20,
  'customer.subscription.deleted': 90,
});

export const DEFAULT_TYPE_RANK = 15;

/** Pull a monotonic counter out of the event payload, if the object carries one. */
export function payloadSeq(event) {
  const object = event?.data?.object ?? {};
  if (Number.isInteger(object.attempt_count)) return object.attempt_count;
  // Subscription objects have no counter of their own; `created` + rank decide.
  return 0;
}

/**
 * @param {object} event A Stripe event (or anything with .type and .created).
 * @returns {[number, number, number]} Lexicographically comparable order key.
 */
export function orderKey(event) {
  const created = event?.created;
  if (!Number.isFinite(created)) {
    throw new TypeError(`orderKey: event.created must be a number, got ${created}`);
  }
  return [created, payloadSeq(event), TYPE_RANK[event.type] ?? DEFAULT_TYPE_RANK];
}

/** Lexicographic comparison. Negative when `a` is older than `b`. */
export function compareOrderKeys(a, b) {
  for (let i = 0; i < 3; i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Should this event be allowed to mutate state?
 *
 * @param {?[number,number,number]} lastApplied Order key of the last applied
 *   event for this object, or null if none has been applied yet.
 * @param {[number,number,number]} incoming
 */
export function isStale(lastApplied, incoming) {
  if (!lastApplied) return false; // nothing applied yet -- never stale
  return compareOrderKeys(incoming, lastApplied) < 0; // strictly older
}

/** Convenience: does `event` supersede the state stamped with `lastApplied`? */
export function supersedes(lastApplied, event) {
  return !isStale(lastApplied, orderKey(event));
}

/** Serialise an order key for storage in three integer columns. */
export function toColumns(key) {
  return { eventCreated: key[0], eventSeq: key[1], eventRank: key[2] };
}

/** Rebuild an order key from stored columns; null when never stamped. */
export function fromColumns(row, prefix = 'last_event') {
  const created = row?.[`${prefix}_created`];
  if (created === null || created === undefined) return null;
  return [Number(created), Number(row[`${prefix}_seq`] ?? 0), Number(row[`${prefix}_rank`] ?? 0)];
}
