import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { getDb } from '../db/index.js';
import { getStripe } from '../stripe/client.js';
import { config, describeRuntime } from '../config.js';

import { mountWebhookRoute } from './routes/webhooks.js';
import { mountPlanRoutes } from './routes/plans.js';
import { mountCustomerRoutes } from './routes/customers.js';
import { mountSubscriptionRoutes } from './routes/subscriptions.js';
import { mountInvoiceRoutes } from './routes/invoices.js';
import { mountAdminRoutes } from './routes/admin.js';

const here = dirname(fileURLToPath(import.meta.url));

export async function createApp({ db, stripe } = {}) {
  const database = db ?? (await getDb());
  const payments = stripe ?? (await getStripe());

  const app = express();
  app.disable('x-powered-by');
  app.locals.db = database;
  app.locals.stripe = payments;

  /**
   * The webhook route is mounted FIRST and with a raw body parser.
   *
   * Signature verification hashes the exact bytes Stripe sent. If express.json()
   * runs first the original bytes are gone -- re-serialising the parsed object
   * changes key order and whitespace, every signature fails, and the usual
   * "fix" is to weaken the check. Ordering here is a security property, not a
   * style preference.
   */
  mountWebhookRoute(app);

  app.use(express.json({ limit: '1mb' }));

  app.get('/health', async (_req, res) => {
    await database.query('SELECT 1');
    res.json({ ok: true, runtime: describeRuntime() });
  });

  mountPlanRoutes(app);
  mountCustomerRoutes(app);
  mountSubscriptionRoutes(app);
  mountInvoiceRoutes(app);
  mountAdminRoutes(app);

  app.use('/admin', express.static(join(here, '..', '..', 'public')));
  app.get('/', (_req, res) => res.redirect('/admin'));

  app.use((req, res) => {
    res.status(404).json({ error: 'not_found', message: `no route for ${req.method} ${req.path}` });
  });

  // Central error handler. Domain errors carry their own statusCode; anything
  // without one is a bug and must surface as a 500 rather than be flattened
  // into a 400 that looks like the caller's fault.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = Number.isInteger(err.statusCode) ? err.statusCode : 500;
    if (status >= 500) {
      // eslint-disable-next-line no-console
      console.error('[error]', err);
    }
    res.status(status).json({
      error: err.name ?? 'error',
      message: err.message,
      ...(err.code ? { code: err.code } : {}),
      ...(config.nodeEnv === 'development' && status >= 500 ? { stack: err.stack } : {}),
    });
  });

  return app;
}

/** Wrap an async handler so rejections reach the error middleware. */
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
