/**
 * In-memory Stripe double.
 *
 * Not a mock with canned returns -- it keeps real state (customers,
 * subscriptions, invoices, attempt counts) so the same service code runs
 * against it, and it EMITS the same event shapes the live webhook handler
 * parses. That is what makes it possible to exercise duplicate delivery,
 * out-of-order delivery and the full dunning cycle deterministically, with no
 * network and no test-mode key.
 *
 * Deliberately not simulated: Stripe's own proration. This system computes
 * proration itself and pushes explicit amounts (see stripe/client.js for why),
 * so there is nothing to fake.
 */

import { randomUUID } from 'node:crypto';

let counter = 0;
const nextId = (prefix) => `${prefix}_${String(++counter).padStart(6, '0')}${randomUUID().slice(0, 8)}`;

export function createFakeStripe({ now = () => Math.floor(Date.now() / 1000) } = {}) {
  const state = {
    customers: new Map(),
    subscriptions: new Map(),
    invoices: new Map(),
    events: [],
    /** Set false to make the next payment attempt fail (dunning tests). */
    nextPaymentSucceeds: true,
  };

  function emit(type, object) {
    const event = {
      id: nextId('evt'),
      object: 'event',
      type,
      created: now(),
      data: { object },
      livemode: false,
    };
    state.events.push(event);
    return event;
  }

  const api = {
    __state: state,
    __events: () => state.events,
    __clearEvents: () => { state.events.length = 0; },
    __failNextPayment: () => { state.nextPaymentSucceeds = false; },
    __succeedNextPayment: () => { state.nextPaymentSucceeds = true; },

    customers: {
      async create({ email, name, metadata } = {}) {
        const customer = { id: nextId('cus'), object: 'customer', email, name, metadata: metadata ?? {} };
        state.customers.set(customer.id, customer);
        return customer;
      },
      async retrieve(id) {
        const c = state.customers.get(id);
        if (!c) throw Object.assign(new Error(`No such customer: ${id}`), { statusCode: 404 });
        return c;
      },
    },

    subscriptions: {
      async create({ customer, metadata, trial_end, current_period_start, current_period_end } = {}) {
        const start = current_period_start ?? now();
        const sub = {
          id: nextId('sub'),
          object: 'subscription',
          customer,
          status: trial_end && trial_end > now() ? 'trialing' : 'active',
          current_period_start: start,
          current_period_end: current_period_end ?? start + 30 * 86400,
          trial_end: trial_end ?? null,
          cancel_at_period_end: false,
          metadata: metadata ?? {},
        };
        state.subscriptions.set(sub.id, sub);
        emit('customer.subscription.created', sub);
        return sub;
      },
      async update(id, params = {}) {
        const sub = state.subscriptions.get(id);
        if (!sub) throw Object.assign(new Error(`No such subscription: ${id}`), { statusCode: 404 });
        Object.assign(sub, params);
        emit('customer.subscription.updated', sub);
        return sub;
      },
      async cancel(id, { at_period_end = false } = {}) {
        const sub = state.subscriptions.get(id);
        if (!sub) throw Object.assign(new Error(`No such subscription: ${id}`), { statusCode: 404 });
        if (at_period_end) {
          sub.cancel_at_period_end = true;
          emit('customer.subscription.updated', sub);
        } else {
          sub.status = 'canceled';
          sub.canceled_at = now();
          emit('customer.subscription.deleted', sub);
        }
        return sub;
      },
    },

    invoices: {
      async create({ customer, subscription, amount_due, lines = [], metadata } = {}) {
        const invoice = {
          id: nextId('in'),
          object: 'invoice',
          customer,
          subscription,
          amount_due,
          amount_paid: 0,
          attempt_count: 0,
          status: 'draft',
          lines: { data: lines },
          metadata: metadata ?? {},
          created: now(),
        };
        state.invoices.set(invoice.id, invoice);
        emit('invoice.created', invoice);
        return invoice;
      },
      async finalize(id) {
        const inv = state.invoices.get(id);
        inv.status = 'open';
        emit('invoice.finalized', inv);
        return inv;
      },
      /**
       * Attempt payment. Emits invoice.payment_succeeded or
       * invoice.payment_failed with an incremented attempt_count -- the counter
       * the ordering layer uses to totally order a dunning sequence.
       */
      async pay(id) {
        const inv = state.invoices.get(id);
        if (!inv) throw Object.assign(new Error(`No such invoice: ${id}`), { statusCode: 404 });
        inv.attempt_count += 1;

        if (state.nextPaymentSucceeds) {
          inv.status = 'paid';
          inv.amount_paid = inv.amount_due;
          inv.paid_at = now();
          emit('invoice.payment_succeeded', inv);
        } else {
          inv.status = 'open';
          inv.last_payment_error = { code: 'card_declined', message: 'Your card was declined.' };
          emit('invoice.payment_failed', inv);
        }
        return inv;
      },
      async retrieve(id) {
        const inv = state.invoices.get(id);
        if (!inv) throw Object.assign(new Error(`No such invoice: ${id}`), { statusCode: 404 });
        return inv;
      },
    },
  };

  return api;
}
