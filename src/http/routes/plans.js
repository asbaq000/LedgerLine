import { wrap } from '../app.js';
import { dollarsToCents, MICROCENTS_PER_CENT } from '../../domain/money.js';

export function mountPlanRoutes(app) {
  app.get('/plans', wrap(async (req, res) => {
    const { rows } = await req.app.locals.db.query(
      'SELECT * FROM plans WHERE active = TRUE ORDER BY base_price_cents',
    );
    res.json(rows.map(present));
  }));

  app.post('/plans', wrap(async (req, res) => {
    const {
      id, name, basePrice, includedUnits = 0, meteredRate = 0,
      meteredUnitLabel = null, interval = 'month', intervalCount = 1, trialDays = 0,
    } = req.body ?? {};

    if (!id || !name || basePrice === undefined) {
      return res.status(400).json({ error: 'bad_request', message: 'id, name and basePrice are required' });
    }

    // meteredRate arrives as dollars per unit and may be sub-cent
    // ($0.0001/call). Store microcents so it stays exact.
    const rateMicrocents = Math.round(Number(meteredRate) * 100 * MICROCENTS_PER_CENT);

    const { rows } = await req.app.locals.db.query(
      `INSERT INTO plans (id, name, base_price_cents, interval, interval_count,
                          included_units, metered_rate_microcents, metered_unit_label, trial_days)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        id, name, dollarsToCents(basePrice), interval, intervalCount,
        Number(includedUnits), rateMicrocents, meteredUnitLabel, Number(trialDays),
      ],
    );
    return res.status(201).json(present(rows[0]));
  }));
}

function present(plan) {
  return {
    id: plan.id,
    name: plan.name,
    basePriceCents: Number(plan.base_price_cents),
    currency: plan.currency,
    interval: plan.interval,
    intervalCount: Number(plan.interval_count),
    includedUnits: Number(plan.included_units),
    meteredRateMicrocents: Number(plan.metered_rate_microcents),
    meteredRatePerUnit: Number(plan.metered_rate_microcents) / (100 * MICROCENTS_PER_CENT),
    meteredUnitLabel: plan.metered_unit_label,
    trialDays: Number(plan.trial_days),
  };
}
