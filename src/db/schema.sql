-- SaaS Billing Engine schema.
--
-- Conventions:
--   * Money is BIGINT cents. Never NUMERIC, never float.
--   * Metered rates are BIGINT microcents (cents * 1e6) so sub-cent rates are exact.
--   * Instants that participate in billing math are BIGINT epoch SECONDS, matching
--     Stripe's representation and the domain layer. `created_at`-style audit columns
--     stay TIMESTAMPTZ because they are for humans, not for arithmetic.

CREATE TABLE IF NOT EXISTS customers (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email               TEXT NOT NULL UNIQUE,
  name                TEXT,
  stripe_customer_id  TEXT UNIQUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS plans (
  id                      TEXT PRIMARY KEY,           -- slug, e.g. 'pro'
  name                    TEXT NOT NULL,
  base_price_cents        BIGINT NOT NULL CHECK (base_price_cents >= 0),
  currency                TEXT NOT NULL DEFAULT 'USD',
  interval                TEXT NOT NULL DEFAULT 'month'
                            CHECK (interval IN ('day', 'week', 'month', 'year')),
  interval_count          INTEGER NOT NULL DEFAULT 1 CHECK (interval_count > 0),
  -- Metered component. included_units are bundled into base_price_cents.
  included_units          BIGINT NOT NULL DEFAULT 0 CHECK (included_units >= 0),
  metered_rate_microcents BIGINT NOT NULL DEFAULT 0 CHECK (metered_rate_microcents >= 0),
  metered_unit_label      TEXT,
  trial_days              INTEGER NOT NULL DEFAULT 0 CHECK (trial_days >= 0),
  stripe_price_id         TEXT,
  active                  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id              UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  plan_id                  TEXT NOT NULL REFERENCES plans(id),
  status                   TEXT NOT NULL
                             CHECK (status IN ('trialing','active','past_due','paused','canceled')),
  current_period_start     BIGINT NOT NULL,
  current_period_end       BIGINT NOT NULL,
  -- Day-of-month the cycle is anchored to, so a Jan-31 subscription returns to
  -- the 31st after passing through February instead of drifting to the 28th.
  billing_anchor_day       INTEGER NOT NULL CHECK (billing_anchor_day BETWEEN 1 AND 31),
  trial_end                BIGINT,
  cancel_at_period_end     BOOLEAN NOT NULL DEFAULT FALSE,
  canceled_at              BIGINT,
  -- Negative balance = credit we owe the customer, applied to the next invoice.
  -- A downgrade banks credit here rather than refunding cash.
  credit_balance_cents     BIGINT NOT NULL DEFAULT 0,
  stripe_subscription_id   TEXT UNIQUE,
  -- Order key of the last webhook applied to THIS subscription. See domain/ordering.js.
  last_event_created       BIGINT,
  last_event_seq           INTEGER,
  last_event_rank          INTEGER,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (current_period_end > current_period_start)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_customer ON subscriptions(customer_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_period_end ON subscriptions(current_period_end)
  WHERE status IN ('trialing','active','past_due');

-- The proration ledger. One row per span actually billed to the customer.
-- amount_cents is the amount RETAINED (billed minus credits issued against it),
-- which is what a later mid-cycle change must prorate against.
CREATE TABLE IF NOT EXISTS billed_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id  UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  plan_id          TEXT NOT NULL REFERENCES plans(id),
  amount_cents     BIGINT NOT NULL,
  credited_cents   BIGINT NOT NULL DEFAULT 0,
  starts_at        BIGINT NOT NULL,
  ends_at          BIGINT NOT NULL,
  closed_at        BIGINT,
  invoice_id       UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  -- The core proration invariant, enforced by the database and not only by code:
  -- you can never credit back more than you charged.
  CHECK (amount_cents >= 0)
);

CREATE INDEX IF NOT EXISTS idx_billed_items_open
  ON billed_items(subscription_id, ends_at) WHERE closed_at IS NULL;

CREATE TABLE IF NOT EXISTS usage_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id   UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  quantity          BIGINT NOT NULL CHECK (quantity > 0),
  ts                BIGINT NOT NULL,                 -- when the usage HAPPENED
  idempotency_key   TEXT,
  -- NULL until an invoice claims this event. This is what makes late-arriving
  -- events bill correctly instead of vanishing: aggregation selects unclaimed
  -- rows with ts < period_end, so stragglers land on the next invoice.
  billed_invoice_id UUID,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now()  -- when we HEARD about it
);

-- Same key twice for the same subscription must not double-count usage.
CREATE UNIQUE INDEX IF NOT EXISTS uq_usage_idem
  ON usage_events(subscription_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
-- The exact access path used by aggregation.
CREATE INDEX IF NOT EXISTS idx_usage_unbilled
  ON usage_events(subscription_id, ts) WHERE billed_invoice_id IS NULL;

CREATE TABLE IF NOT EXISTS invoices (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id    UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  customer_id        UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  amount_cents       BIGINT NOT NULL,
  currency           TEXT NOT NULL DEFAULT 'USD',
  status             TEXT NOT NULL CHECK (status IN ('draft','pending','paid','failed','void')),
  period_start       BIGINT NOT NULL,
  period_end         BIGINT NOT NULL,
  attempt_count      INTEGER NOT NULL DEFAULT 0,
  stripe_invoice_id  TEXT UNIQUE,
  -- Order key of the last webhook applied to THIS invoice.
  last_event_created BIGINT,
  last_event_seq     INTEGER,
  last_event_rank    INTEGER,
  first_failed_at    BIGINT,
  finalized_at       BIGINT,
  paid_at            BIGINT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invoices_subscription ON invoices(subscription_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id        UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL
                      CHECK (kind IN ('base','proration_credit','proration_charge','metered','adjustment','credit_balance')),
  plan_id           TEXT REFERENCES plans(id),
  description       TEXT NOT NULL,
  quantity          BIGINT,
  unit_amount_microcents BIGINT,
  amount_cents      BIGINT NOT NULL,
  period_start      BIGINT,
  period_end        BIGINT,
  sort_order        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_invoice_lines_invoice ON invoice_lines(invoice_id, sort_order);

-- Webhook idempotency ledger. The UNIQUE constraint on stripe_event_id is the
-- entire duplicate-suppression mechanism: the insert and the side effects share
-- one transaction, so a conflict means "already fully processed" and a crash
-- rolls the row back so redelivery reprocesses cleanly.
CREATE TABLE IF NOT EXISTS webhook_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_event_id  TEXT NOT NULL UNIQUE,
  type             TEXT NOT NULL,
  event_created    BIGINT NOT NULL,
  payload          JSONB NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('processed','duplicate','stale','ignored','failed')),
  error            TEXT,
  received_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_type ON webhook_events(type, received_at DESC);

-- Durable, DB-backed job rows for the dunning schedule. Also the source of truth
-- when BullMQ is in use: Redis holds the timer, Postgres holds the fact.
CREATE TABLE IF NOT EXISTS dunning_attempts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id  UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  invoice_id       UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  attempt          INTEGER NOT NULL CHECK (attempt >= 1),
  scheduled_for    BIGINT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','running','succeeded','failed','canceled')),
  started_at       BIGINT,
  finished_at      BIGINT,
  error            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per (invoice, attempt): a re-scheduled job cannot create a duplicate retry.
CREATE UNIQUE INDEX IF NOT EXISTS uq_dunning_invoice_attempt
  ON dunning_attempts(invoice_id, attempt);
CREATE INDEX IF NOT EXISTS idx_dunning_due
  ON dunning_attempts(scheduled_for) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS notifications (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   UUID REFERENCES customers(id) ON DELETE CASCADE,
  subscription_id UUID REFERENCES subscriptions(id) ON DELETE CASCADE,
  channel       TEXT NOT NULL DEFAULT 'console',
  template      TEXT NOT NULL,
  subject       TEXT NOT NULL,
  body          TEXT,
  sent_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_customer ON notifications(customer_id, sent_at DESC);
