# ledgerline

**A SaaS subscription billing engine. Proration as a ledger, not a formula.**

Plans, metered usage, mid-cycle proration, webhook-driven state sync and dunning.
Node + Express + Postgres + Stripe + BullMQ.

[![tests](https://img.shields.io/badge/tests-94%20passing-2f6f4f)](#the-test-suite)
[![node](https://img.shields.io/badge/node-%3E%3D20.11-2f5d50)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-6f6e69)](LICENSE)

The hard part of this problem is correctness under real-world messiness, so that is
where the effort went: the billing rules live in pure, directly-testable modules,
and the tests assert hand-calculated numbers rather than re-deriving expectations
from the code under test.

```bash
npm install
npm test     # 97 tests, no Docker, no Stripe key, no setup
npm run demo # narrated walk through proration, usage, webhooks and dunning
```

```bash
npm run seed && npm start   # http://localhost:3000/admin
```

## Running with no infrastructure

The brief specifies Postgres, Redis and Stripe. All three are supported and used
when configured — but the default path needs none of them installed, because a
test suite you cannot run is a test suite nobody runs:

| | configured | default |
|---|---|---|
| Database | `DATABASE_URL` → `pg` | **PGlite** — real Postgres 16 compiled to WASM, in-process |
| Payments | `STRIPE_SECRET_KEY` → Stripe SDK | in-memory Stripe double that emits real event shapes |
| Jobs | `REDIS_URL` → BullMQ | Postgres-backed poller |
| Email | `RESEND_API_KEY` | console + `notifications` table |

PGlite is not a mock. `CHECK` constraints, `ON CONFLICT`, transaction rollback and
`FOR UPDATE SKIP LOCKED` all behave as they will in production, so the correctness
tests are real. The one thing it cannot do is genuine concurrency — it is a single
connection. Those tests are in `test/concurrency.test.js` and **skip themselves**
unless you point at a real server:

```bash
docker compose up -d
DATABASE_URL=postgres://billing:billing@localhost:5432/billing npm test
```

The offline Stripe double emits the same event shapes the live handler parses, and
those events are **signed and verified through the real verification path** before
being applied. Offline mode exercises production code, not a shortcut around it.

> **Not verified:** the live Stripe integration in `src/stripe/client.js` is written
> against the documented API but has never run against a real test key — there was
> no key available. Everything else in this README is covered by the test suite.

## The four hard problems

### 1. Proration is a ledger, not a formula

The obvious implementation prorates the *plan's list price*:

```
credit = oldPlanPrice * remaining / periodLength
```

For a chain of plain list-price changes that is **algebraically identical** to what
this engine computes, and `test/proration.test.js` asserts exactly that rather than
overstating the case. It breaks when the amount actually billed is not the list
price prorated — a coupon, a mid-cycle price change, a partial-period signup:

```
customer on $29 starter with a 50% coupon is billed 1450, upgrades on day 10

  naive  credit = 2900 * 20/30 = 1933   ← against a payment of 1450
  ledger credit = 1450 * 20/30 =  967
```

The naive path hands back 966 cents that were never collected, silently. So
`billed_items` records the amount **actually charged** for each span, and a plan
change credits the unused fraction of *that*, over *that item's own span*:

```
credit_n = billedAmount_n * (periodEnd - changeAt) / (itemEnd_n - itemStart_n)
charge   = newPlanPrice  * (periodEnd - changeAt) / (periodEnd - periodStart)
```

The two denominators differ, and that is the whole point. The invariant — never
credit back more than you charged — is enforced by `assertNoOverCredit()` *and* by
a `CHECK (amount_cents >= 0)` constraint in the schema, so it holds even if a
future code path forgets to call the check.

Money is integer cents throughout, with `mulDivRound` doing exact `(a*b)/c` in
BigInt (a high-volume metered line can reach 10^15, uncomfortably close to the
float safe-integer limit). Rounding is half-away-from-zero so credit/charge pairs
stay symmetric. Every line rounds independently, because every line is money a
customer sees — so a chain of changes can land a cent from the continuous-time
ideal. The tests assert the exact ledger rather than pretending otherwise.

The brief's checkpoint case, worked by hand and asserted as a literal:

```
$29 → $99, exactly 10 days into a 30-day cycle
  unused old   = 2900 * 20/30 = 1933.33 → $19.33
  remaining new= 9900 * 20/30 = 6600.00 → $66.00
  net charged                           → $46.67
```

### 2. Metered usage: two different boundary problems

They get conflated and they need different fixes.

**An event at the exact rollover instant.** Every period is half-open,
`[start, end)`. The boundary instant belongs to the next period — counted once,
never twice, never dropped.

**An event that *belongs* to a period but *arrives* after it was invoiced.** A
request finishing at 23:59:59 can reach the meter seconds later. You cannot edit a
finalised invoice, and you must not drop the usage.

The fix is to aggregate by **claim** rather than by time window. Each event carries
`billed_invoice_id`, NULL until an invoice claims it. Invoicing selects unclaimed
events with `ts < periodEnd` — no lower bound — so stragglers from a closed period
are swept onto the next invoice automatically. Ordinary and late events flow
through one code path, so there is no separate branch to forget.

The claim is `UPDATE ... RETURNING`, not `SELECT sum()` then `UPDATE`. Between a
separate select and update, a concurrent insert can be counted but not claimed
(billed twice) or claimed but not counted (billed never). One statement makes
counting and claiming the same atomic act.

### 3. Webhooks: idempotency and ordering

**Idempotency.** The insert into `webhook_events` and every side effect share **one
transaction**. A duplicate hits the `UNIQUE` index on `stripe_event_id` and returns
early with nothing applied; a crash rolls back *including the ledger row*, so
Stripe's redelivery is seen as new. Recording first and processing after — the
obvious approach — gets this exactly backwards: a crash between the two leaves a
row saying "seen" for an event whose effects never happened, and the retry is
discarded as a duplicate. The event is then lost permanently and silently. There
is a test for precisely this.

**Ordering.** Two mechanisms, because there are two problems:

*Per-invoice ordering guard.* Each invoice stores the order key of the last event
applied to it; a strictly older event is recorded as `stale` and applied to
nothing. The key is `[created, payloadSeq, typeRank]`. `created` alone is not
enough — Stripe's timestamps have **one-second granularity**, so a failure and its
retry genuinely can collide. `payloadSeq` is `invoice.attempt_count`, which totally
orders a dunning sequence regardless of clock resolution; that is real ordering
information. `typeRank` is a documented heuristic that only ever breaks ties the
first two could not.

*Derived subscription status.* The subscription's status is **recomputed from the
current set of invoice facts** after each event, not mutated event-by-event. A
per-subscription timestamp guard is subtly wrong: invoice A succeeding at t=200
would make a genuine failure of invoice B at t=150 look stale, leaving the
subscription `active` while an invoice is unpaid. Deriving status from facts makes
cross-order arrival irrelevant — the tests assert that replaying the same events in
either order converges on the same state.

`canceled` is terminal and absorbing, so a late success cannot resurrect a
subscription dunning already gave up on.

**Signatures** are verified against the raw request bytes, in constant time, within
a replay window. The webhook route is mounted with `express.raw()` *before*
`express.json()`; if JSON parsing ran first the original bytes would be gone, every
signature would fail, and the usual "fix" is to weaken the check. That ordering is
a security property, and there is a test that would catch its regression.

### 4. Dunning

Retries are scheduled as **day offsets from the first failure** (`1, 3, 7` by
default), not as gaps between attempts. Offsets-from-origin means a delayed worker
cannot make the schedule drift; with gap-based scheduling one slow run stretches
every subsequent retry.

One row per `(invoice, attempt)` with a `UNIQUE` index makes scheduling idempotent:
a redelivered failure, or a restarted worker, cannot double the retry queue and
charge the customer twice. Workers claim with `FOR UPDATE SKIP LOCKED`.

Attempts live in Postgres even when BullMQ drives the timers. Redis holds *when*;
Postgres holds *whether*. Flushing Redis costs latency, never correctness.

## Division of responsibility with Stripe

**This engine owns the proration math.** Plan changes go to Stripe with
`proration_behavior: 'none'` and the amounts computed here are pushed as explicit
invoice items. Stripe prorates against the subscription item's *list price*, which
diverges from what was actually collected the moment a coupon or credit exists —
the failure described above.

**Stripe owns whether money moved**, which is the thing it is actually
authoritative about. That fact arrives by webhook and is the *only* thing that
writes a paid/failed status. An API call returning 200 never marks an invoice paid;
that is how local state drifts.

Payment attempts are made with **no transaction open**. Building an invoice is
transactional, charging it is not — an HTTP round trip inside an open transaction
holds row locks for the length of a network call.

## Design decisions worth flagging

- **Downgrades bank credit, they do not refund cash.** The proration invoice nets
  to zero via an explicit balancing line and the surplus goes to
  `credit_balance_cents`, consumed by the next invoice. Refunding to card would
  make every downgrade a chargeback risk. *(An earlier version granted the credit
  twice — once as a negative invoice and again as banked balance. The
  cash-reconciliation test in `test/integration.test.js` is what caught it and now
  pins it down.)*
- **Billing anchors survive short months.** A Jan-31 subscription bills Feb 28 and
  then returns to Mar 31, rather than sticking to the 28th forever.
- **Trial expiry is not a special case.** A trial is a zero-cost period; when it
  rolls over, the ordinary renewal path issues the first real invoice.
- **Revenue is attributed through invoice *lines*, not the subscription's current
  plan** — otherwise an upgrade retroactively rewrites every past month. Balance
  movements are excluded from revenue: banked credit is deferred revenue, not
  income.
- **Illegal state transitions throw** rather than silently no-op. A billing system
  that quietly ignores an impossible transition is one whose state drifts without
  anyone noticing.

## Layout

```
src/
  domain/        pure, no I/O -- proration, usage, money, time, ordering,
                 dunning schedule, state machine
  services/      transactional orchestration over the domain
  stripe/        signature verification, client selection, offline double
  jobs/          dunning + renewal workers, BullMQ or in-process poller
  http/          Express routes; webhook route mounted raw, first
  db/            schema.sql and the pg/PGlite adapter
test/            94 offline + 3 real-Postgres-only
```

The `domain/` modules take `now` as an argument and read no clocks, so the whole
dunning schedule and every proration case is testable without waiting or mocking
timers.

## API

```
GET    /health
GET    /plans                             POST /plans
POST   /customers                         GET  /customers/:id
GET    /customers/:id/invoices            GET  /customers/:id/notifications

POST   /subscriptions                     GET  /subscriptions/:id
POST   /subscriptions/:id/change-plan     { planId, at? }
POST   /subscriptions/:id/cancel          { atPeriodEnd? }
POST   /subscriptions/:id/renew           force a period rollover
POST   /subscriptions/:id/usage           { quantity, timestamp?, idempotencyKey? }
GET    /subscriptions/:id/usage           projected metered charge

GET    /invoices  /invoices/:id           POST /invoices/:id/pay
POST   /webhooks/stripe                   signed, raw body

GET    /admin/dashboard  /admin/webhooks  /admin/dunning
POST   /admin/dunning/run                 { at? }  -- jump the clock in a demo
```

`at` parameters accept epoch seconds or ISO strings and exist so a reviewer can
advance the billing clock without waiting a week.

## Going live with Stripe

```bash
export STRIPE_SECRET_KEY=sk_test_...
stripe listen --forward-to localhost:3000/webhooks/stripe   # prints whsec_...
export STRIPE_WEBHOOK_SECRET=whsec_...
npm start
```

`stripe trigger invoice.payment_failed` exercises the dunning path against real
deliveries. Sending the same event twice should show one `processed` and one
`duplicate` at `/admin/webhooks`.

## Out of scope

Multi-currency, tax, annual-billing discounts, and a self-serve plan comparison
page, per the brief.
