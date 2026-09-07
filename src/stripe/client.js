/**
 * Stripe client selection, and the division of responsibility with Stripe.
 *
 * ---------------------------------------------------------------------------
 * Who owns the proration math
 * ---------------------------------------------------------------------------
 * WE do. Stripe can prorate on its own, and this system deliberately does not
 * let it: plan changes are sent with `proration_behavior: 'none'` and the
 * amounts this engine computed are pushed as explicit invoice items.
 *
 * The brief asks not to trust Stripe's proration blindly, and there is a
 * concrete reason beyond principle. Stripe prorates against the SUBSCRIPTION
 * ITEM's list price. Once a coupon, a mid-cycle price change, or an earlier
 * credit means the customer was billed something other than list price, that
 * diverges from what was actually collected -- the exact failure documented in
 * domain/proration.js. Owning the math means the invoice we show and the
 * ledger we can defend to a customer are the same numbers.
 *
 * Stripe remains the source of truth for one thing only, and it is the thing it
 * is actually authoritative about: whether money moved. That fact arrives by
 * webhook and drives the state machine.
 *
 * ---------------------------------------------------------------------------
 * Offline mode
 * ---------------------------------------------------------------------------
 * With no STRIPE_SECRET_KEY the fake in ./fake.js is used, so the server boots
 * and the full lifecycle is exercisable without credentials. The live path is
 * written against the documented API but is NOT exercised by the offline test
 * suite -- see README for what to run once a test key is present.
 */

import { createFakeStripe } from './fake.js';

let cached = null;

export async function getStripe({ fresh = false } = {}) {
  if (!fresh && cached) return cached;

  const key = process.env.STRIPE_SECRET_KEY;
  const client = key ? await createLiveStripe(key) : createOfflineStripe();

  if (!fresh) cached = client;
  return client;
}

export function resetStripe() {
  cached = null;
}

function createOfflineStripe() {
  const fake = createFakeStripe();
  fake.__live = false;
  return fake;
}

async function createLiveStripe(apiKey) {
  const Stripe = (await import('stripe')).default;
  const stripe = new Stripe(apiKey, {
    apiVersion: '2024-12-18.acacia',
    maxNetworkRetries: 2,
    appInfo: { name: 'saas-billing-engine' },
  });

  // Adapt the SDK surface to the narrow interface the services use, so service
  // code never branches on live-vs-fake.
  return {
    __live: true,
    __sdk: stripe,

    customers: {
      create: (params) => stripe.customers.create(params),
      retrieve: (id) => stripe.customers.retrieve(id),
    },

    subscriptions: {
      create: ({ customer, metadata, trial_end, priceId }) =>
        stripe.subscriptions.create({
          customer,
          items: priceId ? [{ price: priceId }] : [],
          trial_end: trial_end ?? undefined,
          metadata,
          // We invoice explicitly; Stripe should not also bill on its own cadence.
          collection_method: 'charge_automatically',
          proration_behavior: 'none',
        }),

      update: (id, params) =>
        stripe.subscriptions.update(id, { ...params, proration_behavior: 'none' }),

      cancel: (id, { at_period_end = false } = {}) =>
        (at_period_end
          ? stripe.subscriptions.update(id, { cancel_at_period_end: true })
          : stripe.subscriptions.cancel(id)),
    },

    invoices: {
      /**
       * Create a one-off invoice carrying the amounts THIS engine computed.
       * Each line is added as an explicit invoice item in cents.
       */
      async create({ customer, subscription, lines = [], metadata }) {
        for (const line of lines) {
          await stripe.invoiceItems.create({
            customer,
            subscription,
            amount: line.amount_cents,
            currency: (line.currency ?? 'usd').toLowerCase(),
            description: line.description,
          });
        }
        return stripe.invoices.create({
          customer,
          subscription,
          auto_advance: false,
          metadata,
        });
      },
      finalize: (id) => stripe.invoices.finalizeInvoice(id),
      pay: (id) => stripe.invoices.pay(id),
      retrieve: (id) => stripe.invoices.retrieve(id),
    },
  };
}
