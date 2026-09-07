import { wrap } from '../app.js';
import { dashboard } from '../../services/adminService.js';
import { runDueDunning } from '../../jobs/dunningWorker.js';

export function mountAdminRoutes(app) {
  app.get('/admin/dashboard', wrap(async (req, res) => {
    const since = req.query.since ? Number(req.query.since) : 0;
    res.json(await dashboard(req.app.locals.db, { since }));
  }));

  app.get('/admin/webhooks', wrap(async (req, res) => {
    const { rows } = await req.app.locals.db.query(
      `SELECT id, stripe_event_id, type, event_created, status, received_at, processed_at, error
         FROM webhook_events ORDER BY received_at DESC LIMIT 100`,
    );
    res.json(rows);
  }));

  app.get('/admin/dunning', wrap(async (req, res) => {
    const { rows } = await req.app.locals.db.query(
      `SELECT d.*, i.amount_cents, c.email
         FROM dunning_attempts d
         JOIN invoices i ON i.id = d.invoice_id
         JOIN customers c ON c.id = i.customer_id
        ORDER BY d.scheduled_for DESC LIMIT 100`,
    );
    res.json(rows);
  }));

  /**
   * Run the dunning queue now, optionally at a simulated time.
   * `at` lets a demo jump to day 7 without waiting a week.
   */
  app.post('/admin/dunning/run', wrap(async (req, res) => {
    const result = await runDueDunning(req.app.locals.db, {
      stripe: req.app.locals.stripe,
      ...(req.body?.at ? { at: Number(req.body.at) } : {}),
    });
    res.json(result);
  }));
}
