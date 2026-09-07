import { wrap } from '../app.js';
import {
  createSubscription,
  changePlan,
  cancelSubscription,
  renewSubscription,
  getSubscription,
} from '../../services/subscriptionService.js';
import { recordUsage, getUsageSummary, listUsageEvents } from '../../services/usageService.js';
import { payAndSettle } from '../../services/paymentService.js';

export function mountSubscriptionRoutes(app) {
  app.post('/subscriptions', wrap(async (req, res) => {
    const { customerId, planId, at } = req.body ?? {};
    if (!customerId || !planId) {
      return res.status(400).json({ error: 'bad_request', message: 'customerId and planId are required' });
    }

    const result = await createSubscription(req.app.locals.db, { customerId, planId, ...(at ? { at } : {}) });

    // Charge outside the creation transaction (see invoiceService).
    let payment = null;
    if (result.invoice && result.invoice.amount_cents > 0) {
      payment = await payAndSettle(req.app.locals.db, result.invoice.id, { stripe: req.app.locals.stripe });
    }

    return res.status(201).json({
      subscription: await getSubscription(req.app.locals.db, result.subscription.id),
      invoice: result.invoice,
      payment,
    });
  }));

  app.get('/subscriptions/:id', wrap(async (req, res) => {
    const sub = await getSubscription(req.app.locals.db, req.params.id);
    if (!sub) return res.status(404).json({ error: 'not_found' });
    return res.json(sub);
  }));

  /** Upgrade or downgrade mid-cycle. */
  app.post('/subscriptions/:id/change-plan', wrap(async (req, res) => {
    const { planId, at } = req.body ?? {};
    if (!planId) {
      return res.status(400).json({ error: 'bad_request', message: 'planId is required' });
    }

    const result = await changePlan(req.app.locals.db, {
      subscriptionId: req.params.id,
      newPlanId: planId,
      ...(at ? { at } : {}),
    });

    if (!result.changed) {
      return res.status(200).json({ changed: false, reason: result.reason });
    }

    let payment = null;
    if (result.invoice && result.invoice.amount_cents > 0) {
      payment = await payAndSettle(req.app.locals.db, result.invoice.id, { stripe: req.app.locals.stripe });
    }

    return res.json({
      changed: true,
      subscription: await getSubscription(req.app.locals.db, req.params.id),
      proration: result.proration && {
        netCents: result.proration.netCents,
        direction: result.proration.direction,
        credits: result.proration.credits,
        charges: result.proration.charges,
      },
      invoice: result.invoice,
      payment,
    });
  }));

  app.post('/subscriptions/:id/cancel', wrap(async (req, res) => {
    const { atPeriodEnd = false, at } = req.body ?? {};
    const result = await cancelSubscription(req.app.locals.db, {
      subscriptionId: req.params.id,
      atPeriodEnd,
      ...(at ? { at } : {}),
    });
    res.json(result);
  }));

  /**
   * Force a period rollover. In production the scheduler drives this; exposed
   * so the billing cycle can be advanced deliberately in a demo or test.
   */
  app.post('/subscriptions/:id/renew', wrap(async (req, res) => {
    const result = await renewSubscription(req.app.locals.db, {
      subscriptionId: req.params.id,
      ...(req.body?.at ? { at: req.body.at } : {}),
    });

    let payment = null;
    if (result.invoice && result.invoice.amount_cents > 0) {
      payment = await payAndSettle(req.app.locals.db, result.invoice.id, { stripe: req.app.locals.stripe });
    }
    res.json({ ...result, payment });
  }));

  // -- metered usage ------------------------------------------------------

  app.post('/subscriptions/:id/usage', wrap(async (req, res) => {
    const { quantity, timestamp, idempotencyKey } = req.body ?? {};
    const result = await recordUsage(req.app.locals.db, {
      subscriptionId: req.params.id,
      quantity,
      ...(timestamp !== undefined ? { timestamp } : {}),
      idempotencyKey: idempotencyKey ?? req.get('idempotency-key') ?? null,
    });
    // 200 (not 201) on a suppressed duplicate: nothing was created.
    res.status(result.duplicate ? 200 : 201).json(result);
  }));

  app.get('/subscriptions/:id/usage', wrap(async (req, res) => {
    const summary = await getUsageSummary(req.app.locals.db, req.params.id);
    res.json(summary);
  }));

  app.get('/subscriptions/:id/usage/events', wrap(async (req, res) => {
    const events = await listUsageEvents(req.app.locals.db, req.params.id, {
      limit: Math.min(Number(req.query.limit ?? 100), 500),
      offset: Number(req.query.offset ?? 0),
    });
    res.json(events);
  }));
}
