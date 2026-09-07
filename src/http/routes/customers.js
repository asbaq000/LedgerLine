import { wrap } from '../app.js';
import { listInvoicesForCustomer } from '../../services/invoiceService.js';

export function mountCustomerRoutes(app) {
  app.post('/customers', wrap(async (req, res) => {
    const { email, name = null } = req.body ?? {};
    if (!email) {
      return res.status(400).json({ error: 'bad_request', message: 'email is required' });
    }
    const { rows } = await req.app.locals.db.query(
      `INSERT INTO customers (email, name) VALUES ($1,$2)
       ON CONFLICT (email) DO UPDATE SET name = COALESCE(EXCLUDED.name, customers.name)
       RETURNING *`,
      [email, name],
    );
    return res.status(201).json(rows[0]);
  }));

  app.get('/customers', wrap(async (req, res) => {
    const { rows } = await req.app.locals.db.query(
      'SELECT * FROM customers ORDER BY created_at DESC LIMIT 200',
    );
    res.json(rows);
  }));

  app.get('/customers/:id', wrap(async (req, res) => {
    const db = req.app.locals.db;
    const { rows } = await db.query('SELECT * FROM customers WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'not_found' });

    const subs = await db.query(
      `SELECT s.*, p.name AS plan_name FROM subscriptions s
         JOIN plans p ON p.id = s.plan_id
        WHERE s.customer_id = $1 ORDER BY s.created_at DESC`,
      [req.params.id],
    );
    return res.json({ ...rows[0], subscriptions: subs.rows });
  }));

  /** Billing history: every invoice, successful or failed, with its lines. */
  app.get('/customers/:id/invoices', wrap(async (req, res) => {
    const invoices = await listInvoicesForCustomer(req.app.locals.db, req.params.id, {
      limit: Math.min(Number(req.query.limit ?? 50), 200),
      offset: Number(req.query.offset ?? 0),
    });
    res.json(invoices);
  }));

  app.get('/customers/:id/notifications', wrap(async (req, res) => {
    const { rows } = await req.app.locals.db.query(
      'SELECT * FROM notifications WHERE customer_id = $1 ORDER BY sent_at DESC LIMIT 100',
      [req.params.id],
    );
    res.json(rows);
  }));
}
