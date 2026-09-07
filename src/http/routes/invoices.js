import { wrap } from '../app.js';
import { getInvoiceWithLines } from '../../services/invoiceService.js';
import { payAndSettle } from '../../services/paymentService.js';
import { listAttemptsForInvoice } from '../../services/dunningService.js';

export function mountInvoiceRoutes(app) {
  app.get('/invoices/:id', wrap(async (req, res) => {
    const invoice = await getInvoiceWithLines(req.app.locals.db, req.params.id);
    if (!invoice) return res.status(404).json({ error: 'not_found' });
    const attempts = await listAttemptsForInvoice(req.app.locals.db, req.params.id);
    return res.json({ ...invoice, dunningAttempts: attempts });
  }));

  /** Retry collection manually (the customer updated their card). */
  app.post('/invoices/:id/pay', wrap(async (req, res) => {
    const result = await payAndSettle(req.app.locals.db, req.params.id, {
      stripe: req.app.locals.stripe,
    });
    const invoice = await getInvoiceWithLines(req.app.locals.db, req.params.id);
    res.json({ ...result, invoice });
  }));

  app.get('/invoices', wrap(async (req, res) => {
    const { status } = req.query;
    const params = [];
    let where = '';
    if (status) {
      params.push(status);
      where = 'WHERE i.status = $1';
    }
    const { rows } = await req.app.locals.db.query(
      `SELECT i.*, c.email FROM invoices i
         JOIN customers c ON c.id = i.customer_id
         ${where}
        ORDER BY i.created_at DESC LIMIT 200`,
      params,
    );
    res.json(rows);
  }));
}
