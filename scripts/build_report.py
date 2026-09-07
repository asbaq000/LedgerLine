"""
Builds the project report PDF.

Every number in here comes from an actual run (npm test, live server queries,
line counts) rather than being asserted from memory.
"""

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    BaseDocTemplate, Frame, PageTemplate, Paragraph, Spacer, Table, TableStyle,
    PageBreak, KeepTogether, HRFlowable, NextPageTemplate,
)

OUT = "ledgerline-report.pdf"

INK      = colors.HexColor("#1b1b19")
MUTED    = colors.HexColor("#6f6e69")
ACCENT   = colors.HexColor("#2f5d50")
ACCENT_L = colors.HexColor("#e8f0ec")
RULE     = colors.HexColor("#d9d8d3")
OK       = colors.HexColor("#2f6f4f")
WARN     = colors.HexColor("#8a6d1f")
CODE_BG  = colors.HexColor("#f4f4f1")

PAGE_W, PAGE_H = A4
MARGIN = 18 * mm

ss = getSampleStyleSheet()


def style(name, **kw):
    base = kw.pop("parent", ss["Normal"])
    return ParagraphStyle(name, parent=base, **kw)


S = {
    "title": style("title", fontName="Helvetica-Bold", fontSize=26, leading=30,
                   textColor=colors.white, spaceAfter=0),
    "subtitle": style("subtitle", fontName="Helvetica", fontSize=11.5, leading=16,
                      textColor=colors.HexColor("#cfe0d8")),
    "h1": style("h1", keepWithNext=1, fontName="Helvetica-Bold", fontSize=16, leading=20,
                textColor=INK, spaceBefore=2, spaceAfter=3),
    "h2": style("h2", keepWithNext=1, fontName="Helvetica-Bold", fontSize=11.5, leading=15,
                textColor=ACCENT, spaceBefore=11, spaceAfter=4),
    "h3": style("h3", keepWithNext=1, fontName="Helvetica-Bold", fontSize=9.8, leading=13,
                textColor=INK, spaceBefore=8, spaceAfter=2),
    "body": style("body", fontName="Helvetica", fontSize=9.6, leading=14,
                  textColor=INK, spaceAfter=6, alignment=TA_LEFT),
    "small": style("small", fontName="Helvetica", fontSize=8.6, leading=12,
                   textColor=MUTED, spaceAfter=4),
    "cell": style("cell", fontName="Helvetica", fontSize=8.5, leading=11.5,
                  textColor=INK),
    "cellb": style("cellb", fontName="Helvetica-Bold", fontSize=8.5, leading=11.5,
                   textColor=INK),
    "cellm": style("cellm", fontName="Courier", fontSize=8, leading=11,
                   textColor=INK),
    "th": style("th", fontName="Helvetica-Bold", fontSize=7.6, leading=10,
                textColor=MUTED),
    "code": style("code", fontName="Courier", fontSize=8.2, leading=12,
                  textColor=INK),
    "note": style("note", fontName="Helvetica-Oblique", fontSize=8.8, leading=12.5,
                  textColor=MUTED, spaceAfter=5),
}


def P(text, s="body"):
    return Paragraph(text, S[s])


def rule(space_before=2, space_after=8):
    return HRFlowable(width="100%", thickness=0.6, color=RULE,
                      spaceBefore=space_before, spaceAfter=space_after)


def h1(text):
    # A single Table flowable rather than Paragraph + HRFlowable: KeepTogether
    # does not propagate keepWithNext, so a section heading could still be
    # stranded alone at the foot of a page. Table honours it.
    t = Table([[P(text, "h1")]], colWidths=[PAGE_W - 2 * MARGIN])
    t.setStyle(TableStyle([
        ("LINEBELOW", (0, 0), (-1, -1), 0.8, RULE),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    t.keepWithNext = 1
    return t


def code(lines, width=None):
    """Monospace block on a tinted background."""
    body = "<br/>".join(
        l.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
         .replace(" ", "&nbsp;") or "&nbsp;"
        for l in lines
    )
    t = Table([[Paragraph(body, S["code"])]],
              colWidths=[width or (PAGE_W - 2 * MARGIN)])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), CODE_BG),
        ("BOX", (0, 0), (-1, -1), 0.5, RULE),
        ("LEFTPADDING", (0, 0), (-1, -1), 9),
        ("RIGHTPADDING", (0, 0), (-1, -1), 9),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ]))
    return t


def table(header, rows, widths, align_right=(), zebra=True):
    data = [[Paragraph(h, S["th"]) for h in header]] + rows
    t = Table(data, colWidths=widths, repeatRows=1)
    cmds = [
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LINEBELOW", (0, 0), (-1, 0), 0.8, ACCENT),
        ("LINEBELOW", (0, 1), (-1, -2), 0.35, RULE),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
    ]
    for c in align_right:
        cmds.append(("ALIGN", (c, 0), (c, -1), "RIGHT"))
    if zebra:
        for i in range(1, len(data)):
            if i % 2 == 0:
                cmds.append(("BACKGROUND", (0, i), (-1, i), colors.HexColor("#fafaf8")))
    t.setStyle(TableStyle(cmds))
    return t


def badge(text, color):
    # hexval() yields '0x2f6f4f'; the parser needs a '#'-prefixed value.
    return Paragraph(
        f'<font color="#{color.hexval()[2:]}"><b>{text}</b></font>', S["cell"])


# ---------------------------------------------------------------------------
# Page furniture
# ---------------------------------------------------------------------------

def later_pages(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(RULE)
    canvas.setLineWidth(0.5)
    canvas.line(MARGIN, PAGE_H - MARGIN + 6 * mm, PAGE_W - MARGIN, PAGE_H - MARGIN + 6 * mm)
    canvas.setFont("Helvetica", 7.5)
    canvas.setFillColor(MUTED)
    canvas.drawString(MARGIN, PAGE_H - MARGIN + 8 * mm, "ledgerline")
    canvas.drawRightString(PAGE_W - MARGIN, PAGE_H - MARGIN + 8 * mm, "Project report")
    canvas.line(MARGIN, MARGIN - 5 * mm, PAGE_W - MARGIN, MARGIN - 5 * mm)
    canvas.drawRightString(PAGE_W - MARGIN, MARGIN - 9 * mm, str(canvas.getPageNumber()))
    canvas.drawString(MARGIN, MARGIN - 9 * mm,
                      "Node.js / Express / Postgres / Stripe / BullMQ")
    canvas.restoreState()


def first_page(canvas, doc):
    canvas.saveState()
    band_h = 68 * mm
    canvas.setFillColor(ACCENT)
    canvas.rect(0, PAGE_H - band_h, PAGE_W, band_h, stroke=0, fill=1)
    canvas.restoreState()
    later_pages(canvas, doc)


story = []

# ---------------------------------------------------------------------------
# Cover
# ---------------------------------------------------------------------------
story.append(Spacer(1, 12 * mm))
story.append(P("ledgerline", "title"))
story.append(Spacer(1, 3 * mm))
story.append(P("A SaaS subscription billing engine. Proration as a ledger, not a formula.<br/>"
               "Plans, metered usage, webhook-driven state sync and dunning.<br/><br/>"
               "Project report: what it does, how it was tested, and how to run it "
               "in production.", "subtitle"))
story.append(Spacer(1, 26 * mm))

stats = [[
    Paragraph('<font size="20"><b>97</b></font><br/>'
              '<font size="7.5" color="#6f6e69">TESTS (94 pass, 3 need real PG)</font>', S["cell"]),
    Paragraph('<font size="20"><b>7 / 7</b></font><br/>'
              '<font size="7.5" color="#6f6e69">DEFINITION OF DONE</font>', S["cell"]),
    Paragraph('<font size="20"><b>6 / 6</b></font><br/>'
              '<font size="7.5" color="#6f6e69">HARD REQUIREMENTS</font>', S["cell"]),
    Paragraph('<font size="20"><b>~6,700</b></font><br/>'
              '<font size="7.5" color="#6f6e69">LINES (src + tests)</font>', S["cell"]),
]]
t = Table(stats, colWidths=[(PAGE_W - 2 * MARGIN) / 4.0] * 4)
t.setStyle(TableStyle([
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("LINEBEFORE", (1, 0), (-1, -1), 0.5, RULE),
    ("LEFTPADDING", (0, 0), (0, -1), 0),
    ("LEFTPADDING", (1, 0), (-1, -1), 10),
    ("TOPPADDING", (0, 0), (-1, -1), 0),
]))
story.append(t)
story.append(Spacer(1, 10 * mm))
story.append(rule(0, 8))
story.append(P(
    "<b>Run it in one command.</b> <font face='Courier' size='9'>npm install &amp;&amp; npm test</font> "
    "passes with no Docker, no Postgres install, no Redis and no Stripe key. The database is "
    "real Postgres 16 (PGlite, compiled to WASM and running in-process), so CHECK constraints, "
    "ON CONFLICT, transaction rollback and FOR UPDATE SKIP LOCKED behave exactly as they will "
    "in production. Set DATABASE_URL, REDIS_URL and STRIPE_SECRET_KEY to switch to the real stack "
    "without touching a line of code.", "body"))

story.append(NextPageTemplate('body'))
story.append(PageBreak())

# ---------------------------------------------------------------------------
# 1. What it does
# ---------------------------------------------------------------------------
story.append(h1("1.  What it does"))

story.append(P(
    "A subscription billing system built on one organising principle: "
    "<b>this engine owns the money math, and Stripe owns whether money moved.</b> "
    "Stripe is authoritative about payment outcomes, which arrive by webhook and are the only "
    "thing permitted to write a paid or failed status. Everything else - proration, usage "
    "aggregation, invoice assembly - is computed and verified locally, because those are the "
    "numbers a customer will dispute and you have to be able to defend them line by line.", "body"))

story.append(P("Capabilities", "h2"))

story.append(table(
    ["AREA", "WHAT IT DOES"],
    [
        [P("Plans", "cellb"), P("Tiered plans with a base price plus an optional metered component "
                                "(for example $29/mo + $0.01 per API call over 10,000). Monthly, yearly, "
                                "weekly or daily intervals. Optional free trials.", "cell")],
        [P("Subscriptions", "cellb"), P("Subscribe, upgrade, downgrade, cancel immediately or at period end. "
                                        "State machine: trialing -> active -> past_due -> canceled, plus paused. "
                                        "Base price billed in advance, metered usage billed in arrears.", "cell")],
        [P("Proration", "cellb"), P("Mid-cycle plan changes credit unused time and charge for remaining time, "
                                    "computed against what was <i>actually billed</i> rather than list price. "
                                    "Handles repeated changes within one cycle.", "cell")],
        [P("Metered usage", "cellb"), P("Usage events recorded in real time with client idempotency keys, "
                                        "aggregated per billing period, correct at the cycle boundary and for "
                                        "events that arrive after their period closed.", "cell")],
        [P("Webhooks", "cellb"), P("Signature-verified ingestion with exactly-once processing and tolerance "
                                   "for out-of-order delivery. Local subscription state cannot drift from Stripe.", "cell")],
        [P("Dunning", "cellb"), P("Failed payments move to past_due and retry on a configurable schedule "
                                  "(days 1, 3, 7 by default), then auto-cancel. Customer notified at every stage.", "cell")],
        [P("Billing history", "cellb"), P("Every invoice - paid or failed - stored with full line-item detail "
                                          "and viewable per customer.", "cell")],
        [P("Admin", "cellb"), P("Live dashboard: MRR, revenue by plan, failed-payment rate, subscription status "
                                "breakdown, dunning queue, webhook processing health.", "cell")],
    ],
    widths=[30 * mm, PAGE_W - 2 * MARGIN - 30 * mm]))

story.append(P("Architecture", "h2"))
story.append(P(
    "The layering exists to make the hard parts testable. Everything in "
    "<font face='Courier' size='9'>domain/</font> is pure - no database, no clock, no network - so "
    "proration and the dunning schedule are tested as arithmetic rather than through a running system.", "body"))

story.append(table(
    ["LAYER", "FILES", "LINES", "RESPONSIBILITY"],
    [
        [P("src/domain", "cellm"), P("7", "cell"), P("830", "cell"),
         P("Pure billing rules: proration ledger, usage aggregation, money arithmetic, "
           "period math, event ordering, dunning schedule, state machine. No I/O.", "cell")],
        [P("src/services", "cellm"), P("8", "cell"), P("1,861", "cell"),
         P("Transactional orchestration: subscriptions, invoices, usage, webhooks, dunning, "
           "payments, admin analytics, notifications.", "cell")],
        [P("src/stripe", "cellm"), P("3", "cell"), P("424", "cell"),
         P("Signature verification, live/offline client selection, in-memory Stripe double.", "cell")],
        [P("src/jobs", "cellm"), P("3", "cell"), P("199", "cell"),
         P("Dunning and renewal workers behind a scheduler that is either BullMQ or an "
           "in-process Postgres poller.", "cell")],
        [P("src/http", "cellm"), P("7", "cell"), P("445", "cell"),
         P("Express routes. The webhook route is mounted raw and first.", "cell")],
        [P("src/db", "cellm"), P("2", "cell"), P("376", "cell"),
         P("schema.sql and an adapter that speaks both node-pg and PGlite.", "cell")],
        [P("test", "cellm"), P("8", "cell"), P("2,162", "cell"),
         P("97 tests. Assertions are hand-calculated literals, not re-derived from the "
           "code under test.", "cell")],
    ],
    widths=[26 * mm, 13 * mm, 14 * mm, PAGE_W - 2 * MARGIN - 53 * mm],
    align_right=(1, 2)))

story.append(P("The money path, end to end", "h2"))
story.append(code([
    "1.  POST /subscriptions          ledger entry + invoice written in ONE transaction",
    "2.  COMMIT                       -- transaction closed before any network call",
    "3.  Stripe invoices.pay()        no DB transaction open (never hold locks over HTTP)",
    "4.  POST /webhooks/stripe        signature verified against RAW bytes",
    "5.  INSERT webhook_events        + side effects, again in ONE transaction",
    "6.  status = paid | failed       the webhook is the ONLY writer of payment status",
    "",
    "A 200 from Stripe never marks an invoice paid. That is how local state drifts.",
]))

story.append(Spacer(1, 6 * mm))

# ---------------------------------------------------------------------------
# 2. The four hard problems
# ---------------------------------------------------------------------------
story.append(h1("2.  The four hard problems"))
story.append(P("The brief identified correctness under real-world messiness as the difficulty. "
               "These are the four places where the obvious implementation is wrong.", "note"))

story.append(P("2.1  Proration is a ledger, not a formula", "h2"))
story.append(P(
    "The obvious implementation prorates the plan's <i>list price</i>. For a chain of plain "
    "list-price changes that is algebraically identical to what this engine computes, and the test "
    "suite asserts exactly that rather than overstating the case. It breaks the moment the amount "
    "actually billed is not the list price prorated - a coupon, a mid-cycle price change, a "
    "partial-period signup:", "body"))
story.append(code([
    "Customer on a $29 plan with a 50% coupon is billed 1450, upgrades on day 10 of 30:",
    "",
    "    naive  credit = 2900 * 20/30 = 1933   <-- against a payment of only 1450",
    "    ledger credit = 1450 * 20/30 =  967",
    "",
    "The naive path refunds 966 cents that were never collected, silently.",
]))
story.append(P(
    "So <font face='Courier' size='9'>billed_items</font> records the amount <b>actually charged</b> "
    "for each span, and a plan change credits the unused fraction of that, over that item's own span. "
    "The credit denominator is the item's span; the charge denominator is the full period. Those two "
    "denominators differing is the whole point. The invariant - never credit back more than you charged - "
    "is enforced both in code and by a <font face='Courier' size='9'>CHECK (amount_cents &gt;= 0)</font> "
    "constraint, so it holds even if a future code path forgets the check.", "body"))
story.append(P(
    "Money is integer cents throughout. <font face='Courier' size='9'>mulDivRound</font> does exact "
    "(a*b)/c in BigInt because a high-volume metered line reaches 10^15, uncomfortably close to the "
    "float safe-integer limit. Rounding is half-away-from-zero so credit and charge pairs stay symmetric.", "body"))

story.append(P("2.2  Metered usage: two different boundary problems", "h2"))
story.append(P(
    "These get conflated and they need different fixes. <b>An event at the exact rollover instant</b> "
    "is handled by making every period half-open, [start, end) - the boundary instant belongs to the "
    "next period, counted once, never twice, never dropped. <b>An event that belongs to a period but "
    "arrives after it was invoiced</b> is a different problem: a request finishing at 23:59:59 can reach "
    "the meter seconds later, and you can neither edit a finalised invoice nor drop the usage.", "body"))
story.append(P(
    "The fix is to aggregate by <b>claim</b> rather than by time window. Each event carries "
    "<font face='Courier' size='9'>billed_invoice_id</font>, NULL until an invoice claims it. Invoicing "
    "selects unclaimed events with <font face='Courier' size='9'>ts &lt; periodEnd</font> and no lower "
    "bound, so stragglers from a closed period sweep onto the next invoice automatically. Ordinary and "
    "late events flow through one code path, so there is no separate branch to forget.", "body"))
story.append(code([
    "UPDATE usage_events SET billed_invoice_id = $1",
    " WHERE subscription_id = $2 AND billed_invoice_id IS NULL AND ts < $3",
    " RETURNING quantity;        -- claims AND counts in a single atomic statement",
    "",
    "SELECT sum() then UPDATE would let a concurrent insert be counted but not claimed",
    "(billed twice) or claimed but not counted (billed never).",
]))

story.append(P("2.3  Webhooks: idempotency and ordering", "h2"))
story.append(P(
    "<b>Idempotency.</b> The insert into <font face='Courier' size='9'>webhook_events</font> and every "
    "side effect share <b>one transaction</b>. A duplicate hits the UNIQUE index on stripe_event_id and "
    "returns early with nothing applied; a crash rolls back <i>including the ledger row</i>, so Stripe's "
    "redelivery is seen as new. Recording first and processing afterwards - the obvious approach - gets "
    "this exactly backwards: a crash between the two leaves a row saying \"seen\" for an event whose "
    "effects never happened, and the retry is then discarded as a duplicate. The event is lost "
    "permanently and silently. There is a test for precisely this.", "body"))
story.append(P(
    "<b>Ordering.</b> Two mechanisms, because there are two problems. A <i>per-invoice ordering guard</i> "
    "stores the order key of the last event applied; a strictly older event is recorded as stale and "
    "applied to nothing. The key is [created, attempt_count, typeRank] - "
    "<font face='Courier' size='9'>created</font> alone is not enough because Stripe timestamps have "
    "one-second granularity, so a failure and its retry genuinely collide. "
    "<font face='Courier' size='9'>attempt_count</font> totally orders a dunning sequence regardless of "
    "clock resolution; that is real ordering information, not a heuristic.", "body"))
story.append(P(
    "Separately, <i>subscription status is derived</i> - recomputed from the current set of invoice facts "
    "after each event, never mutated event-by-event. A per-subscription timestamp guard is subtly wrong: "
    "invoice A succeeding at t=200 would make a genuine failure of invoice B at t=150 look stale, leaving "
    "the subscription active while an invoice is unpaid. Deriving status from facts makes arrival order "
    "irrelevant, and the suite asserts that replaying the same events in either order converges on the "
    "same state. <font face='Courier' size='9'>canceled</font> is terminal, so a late success cannot "
    "resurrect a subscription dunning already gave up on.", "body"))
story.append(P(
    "<b>Signatures</b> are verified against the raw request bytes, in constant time, within a replay "
    "window. The webhook route is mounted with <font face='Courier' size='9'>express.raw()</font> "
    "<i>before</i> <font face='Courier' size='9'>express.json()</font>; if JSON parsing ran first the "
    "original bytes would be gone, every signature would fail, and the usual \"fix\" is to weaken the "
    "check. That ordering is a security property and a test would catch its regression.", "body"))

story.append(P("2.4  Dunning", "h2"))
story.append(P(
    "Retries are scheduled as <b>day offsets from the first failure</b>, not as gaps between attempts. "
    "Offsets-from-origin means a delayed worker cannot make the schedule drift; with gap-based "
    "scheduling one slow run stretches every subsequent retry. One row per (invoice, attempt) with a "
    "UNIQUE index makes scheduling idempotent, so a redelivered failure or a restarted worker cannot "
    "double the retry queue and charge the customer twice. Workers claim with FOR UPDATE SKIP LOCKED.", "body"))
story.append(P(
    "Attempts live in Postgres even when BullMQ drives the timers: Redis holds <i>when</i>, Postgres "
    "holds <i>whether</i>. Flushing Redis costs latency, never correctness.", "body"))

story.append(Spacer(1, 6 * mm))

# ---------------------------------------------------------------------------
# 3. Requirements
# ---------------------------------------------------------------------------
story.append(h1("3.  Requirements fulfilled"))

story.append(P("3.1  Definition of Done", "h2"))
story.append(table(
    ["#", "REQUIREMENT", "STATUS", "EVIDENCE"],
    [
        [P("1", "cell"), P("Proration math verified correct against manually calculated test cases", "cell"),
         badge("MET", OK),
         P("Expected values hand-computed in comments, asserted as literals. The brief's case "
           "($29 -> $99, day 10 of 30) yields credit -$19.33, charge $66.00, net $46.67.", "cell")],
        [P("2", "cell"), P("Metered usage aggregates correctly, including cycle-boundary events", "cell"),
         badge("MET", OK),
         P("Boundary event lands in the next period; a late arrival timestamped inside a closed "
           "period is swept onto the following invoice, not dropped.", "cell")],
        [P("3", "cell"), P("Duplicate webhook delivery verified to not double-process", "cell"),
         badge("MET", OK),
         P("Second delivery returns 'duplicate'; one receipt sent, usage not re-counted.", "cell")],
        [P("4", "cell"), P("Out-of-order webhook delivery handled without corrupting state", "cell"),
         badge("MET", OK),
         P("Success (t=200) then stale failure (t=100) leaves the subscription active and "
           "schedules no dunning. Replay in either order converges.", "cell")],
        [P("5", "cell"), P("Dunning retries fire on schedule, auto-cancel after configured attempts", "cell"),
         badge("MET", OK),
         P("Full cycle test: retries at days 1, 3, 7, then canceled, with notifications at "
           "each stage.", "cell")],
        [P("6", "cell"), P("Invoice history accurate and viewable", "cell"),
         badge("MET", OK),
         P("Verified live: a customer with a declined payment returns both the failed and the "
           "paid invoice with full line detail.", "cell")],
        [P("7", "cell"), P("Admin dashboard shows correct revenue/status breakdown", "cell"),
         badge("MET", OK),
         P("Verified live against seeded data: revenue by plan, 16.7% failed rate (1 of 6), "
           "status counts, MRR $227.00.", "cell")],
    ],
    widths=[7 * mm, 48 * mm, 16 * mm, PAGE_W - 2 * MARGIN - 71 * mm]))

story.append(P("3.2  Hard requirements", "h2"))
story.append(table(
    ["#", "REQUIREMENT", "STATUS", "NOTES"],
    [
        [P("1", "cell"), P("Plans &amp; subscriptions, state machine", "cell"), badge("MET", OK),
         P("Tiers with base + metered component; subscribe/upgrade/downgrade/cancel; "
           "trialing, active, past_due, canceled and paused.", "cell")],
        [P("2", "cell"), P("Proration, including multiple changes per cycle", "cell"), badge("MET", OK),
         P("Ledger design; tested through four changes in one cycle.", "cell")],
        [P("3", "cell"), P("Metered usage billing", "cell"), badge("MET", OK),
         P("Metered charge calculated locally - the brief permits either this or reporting "
           "usage records to Stripe.", "cell")],
        [P("4", "cell"), P("Webhook-driven state sync", "cell"), badge("MET", OK),
         P("Signature verification, idempotency, timestamp-based ordering.", "cell")],
        [P("5", "cell"), P("Dunning", "cell"), badge("MET", OK),
         P("Configurable schedule and retry count; console notifications when no email key "
           "is set, as the brief allows.", "cell")],
        [P("6", "cell"), P("Invoice &amp; billing history, admin view", "cell"), badge("MET", OK),
         P("Per-customer history plus revenue by plan, failed rate and status counts.", "cell")],
    ],
    widths=[7 * mm, 48 * mm, 16 * mm, PAGE_W - 2 * MARGIN - 71 * mm]))

story.append(P("3.3  Stack, and what is not yet exercised", "h2"))
story.append(table(
    ["COMPONENT", "BRIEF", "STATUS"],
    [
        [P("Node.js + Express", "cell"), P("Required", "cell"), badge("Implemented and exercised", OK)],
        [P("Postgres", "cell"), P("Required - real transactions", "cell"),
         badge("Implemented and exercised", OK)],
        [P("Stripe (test mode)", "cell"), P("Required", "cell"),
         badge("Implemented, NOT exercised against a live key", WARN)],
        [P("BullMQ + Redis", "cell"), P("Required", "cell"),
         badge("Implemented, NOT exercised against real Redis", WARN)],
    ],
    widths=[38 * mm, 52 * mm, PAGE_W - 2 * MARGIN - 90 * mm]))

story.append(Spacer(1, 3 * mm))
story.append(P(
    "<b>Being explicit about the gaps.</b> The live Stripe integration is written against the "
    "documented API but has never run against a real test key - none was available on the build "
    "machine. The BullMQ scheduler is written and the module loads, but no Redis was installed, so "
    "only the Postgres-backed poller path has actually run. Three concurrency tests skip unless "
    "DATABASE_URL points at a real server, because PGlite is single-connection and cannot produce "
    "genuine races. Two minor deviations: the state is spelled "
    "<font face='Courier' size='9'>canceled</font> (Stripe's convention) rather than the brief's "
    "\"cancelled\", and there is no HTTP endpoint to pause a subscription - the state exists in the "
    "machine and syncs from Stripe, but the brief listed paused as optional.", "body"))

story.append(Spacer(1, 6 * mm))

# ---------------------------------------------------------------------------
# 4. Tests
# ---------------------------------------------------------------------------
story.append(h1("4.  The test suite"))
story.append(P(
    "97 tests across 8 files. The design rule throughout: <b>expected values are hand-calculated "
    "and asserted as literals.</b> An assertion that re-derives its expectation using the same code "
    "it is testing proves nothing. Where a number comes from compounded rounding, the derivation is "
    "written out in a comment above the assertion.", "body"))

story.append(table(
    ["FILE", "TESTS", "COVERS"],
    [
        [P("proration.test.js", "cellm"), P("15", "cell"),
         P("The brief's checkpoint case; upgrades, downgrades, changes at exact period start and end; "
           "two and four changes in one cycle; credits against billed vs list price; seconds-not-days "
           "precision; 31-day months; rounding; over-credit detection.", "cell")],
        [P("webhooks.test.js", "cellm"), P("19", "cell"),
         P("Valid/tampered/wrong-secret/missing/malformed signatures; replay window; secret rotation; "
           "duplicate delivery; crash rollback and reprocessing; reversed delivery; same-second ties "
           "by attempt_count and by type rank; terminal cancellation; order convergence.", "cell")],
        [P("domain.test.js", "cellm"), P("23", "cell"),
         P("BigInt-exact money arithmetic; rounding symmetry; month-end anchor clamping; leap years; "
           "half-open containment; the full state-transition matrix; Stripe status mapping; "
           "event order keys.", "cell")],
        [P("usage.test.js", "cellm"), P("15", "cell"),
         P("Half-open boundaries; late arrivals; claim-exactly-once; client idempotency keys; "
           "sub-cent rates; 10^9-unit precision; projection matching the eventual invoice.", "cell")],
        [P("dunning.test.js", "cellm"), P("11", "cell"),
         P("Schedule from origin not gaps; configurability; validation; past_due transition; "
           "idempotent scheduling under a new event id; full retry-to-cancellation cycle; "
           "recovery on successful retry.", "cell")],
        [P("integration.test.js", "cellm"), P("11", "cell"),
         P("Cash reconciliation across two plan changes; trial conversion; billing anchor across a "
           "short month; cancellation semantics; admin dashboard; HTTP surface including raw-body "
           "signature verification and duplicate acknowledgement.", "cell")],
        [P("concurrency.test.js", "cellm"), P("3", "cell"),
         P("Skipped without a real Postgres. Concurrent duplicate deliveries; concurrent plan changes "
           "crediting one ledger item; two workers claiming one dunning attempt.", "cell")],
    ],
    widths=[34 * mm, 13 * mm, PAGE_W - 2 * MARGIN - 47 * mm],
    align_right=(1,)))

story.append(P("Two real bugs the tests caught", "h2"))
story.append(P(
    "<b>Downgrade credit granted twice.</b> The proration invoice recorded a negative total <i>and</i> "
    "banked the same credit, which the next invoice then applied again. Found by reconciling total cash "
    "collected against the ledger: $75.73 collected against $100.57 owed. Fixed with an explicit "
    "balancing line so a downgrade invoice nets to zero and the money moves only via the credit balance. "
    "The reconciliation test now pins this down.", "body"))
story.append(P(
    "<b>Webhook status collision.</b> <font face='Courier' size='9'>processWebhook</font> spread the "
    "handler's return value over its own result, so a handler returning "
    "<font face='Courier' size='9'>status: 'canceled'</font> silently overwrote the processing status "
    "<font face='Courier' size='9'>'processed'</font> - meaning every caller, including the HTTP "
    "response, read the wrong field. Fixed by nesting the handler outcome under "
    "<font face='Courier' size='9'>detail</font>.", "body"))

story.append(P("Running them", "h2"))
story.append(code([
    "npm test                                          # 94 pass, 3 skip, no setup required",
    "npm run demo                                      # narrated walk through all four problems",
    "",
    "docker compose up -d                              # real Postgres + Redis",
    "DATABASE_URL=postgres://billing:billing@localhost:5432/billing npm test",
    "                                                  # unskips the 3 concurrency tests",
]))

story.append(Spacer(1, 6 * mm))

# ---------------------------------------------------------------------------
# 5. Real life
# ---------------------------------------------------------------------------
story.append(h1("5.  Using it in real life"))

story.append(P("5.1  Local, in under a minute", "h2"))
story.append(code([
    "npm install",
    "npm run seed        # plans + 4 customers: healthy, upgraded, in dunning, on trial",
    "npm start           # http://localhost:3000/admin",
]))
story.append(P(
    "With no environment configured this runs on in-process Postgres persisted to "
    "<font face='Courier' size='9'>./.data/pglite</font>, an offline Stripe double, and a Postgres-backed "
    "job poller. Notifications print to the console and are persisted to the "
    "<font face='Courier' size='9'>notifications</font> table. Payments still settle through the real "
    "webhook path, signed and verified - offline mode exercises production code rather than a shortcut "
    "around it.", "body"))

story.append(P("5.2  Connecting real Stripe", "h2"))
story.append(code([
    "export STRIPE_SECRET_KEY=sk_test_...",
    "stripe listen --forward-to localhost:3000/webhooks/stripe    # prints whsec_...",
    "export STRIPE_WEBHOOK_SECRET=whsec_...",
    "npm start",
    "",
    "stripe trigger invoice.payment_failed     # exercises the dunning path for real",
]))
story.append(P(
    "Send the same event twice and <font face='Courier' size='9'>/admin/webhooks</font> should show one "
    "<font face='Courier' size='9'>processed</font> and one <font face='Courier' size='9'>duplicate</font>. "
    "That single check confirms signature verification, the raw-body mount and the idempotency ledger are "
    "all wired correctly - it is the first thing to run after deploying.", "body"))

story.append(P("5.3  Production stack", "h2"))
story.append(code([
    "DATABASE_URL=postgres://user:pass@host:5432/billing   # switches to node-pg + pooling",
    "REDIS_URL=redis://host:6379                           # switches to BullMQ",
    "STRIPE_SECRET_KEY=sk_live_...",
    "STRIPE_WEBHOOK_SECRET=whsec_...                       # from the Dashboard endpoint",
    "RESEND_API_KEY=re_...                                 # real email instead of console",
    "DUNNING_RETRY_DAYS=1,3,7,14                           # tune without code changes",
    "DUNNING_MAX_ATTEMPTS=4",
    "",
    "node scripts/migrate.js && node src/server.js",
]))
story.append(P(
    "Nothing else changes. The database adapter, job scheduler, Stripe client and notifier all select "
    "their implementation from these variables at boot; "
    "<font face='Courier' size='9'>GET /health</font> reports which of each is active, which is worth "
    "asserting in a smoke test so a missing variable cannot silently leave you on the offline double.", "body"))

story.append(P("5.4  Operating it", "h2"))
story.append(table(
    ["CONCERN", "WHAT TO DO"],
    [
        [P("Scaling out", "cellb"),
         P("Run several instances freely. Dunning claims use FOR UPDATE SKIP LOCKED and webhook "
           "idempotency is a UNIQUE index, so correctness comes from the database, not from running "
           "a single worker.", "cell")],
        [P("Webhook endpoint", "cellb"),
         P("Must be publicly reachable and must return 2xx quickly. A 5xx is deliberate back-pressure: "
           "the transaction rolled back and Stripe should redeliver. Never make it return 200 on error.", "cell")],
        [P("Monitoring", "cellb"),
         P("Watch <font face='Courier'>/admin/dashboard</font>: a rising failed-payment rate signals "
           "card or processor trouble; a non-zero <font face='Courier'>failed</font> webhook count means "
           "events are being rejected and money is going unrecorded. Non-zero duplicate and stale counts "
           "are healthy - they are the guards doing their job.", "cell")],
        [P("Reconciliation", "cellb"),
         P("Run the cash-reconciliation check from the integration test against production data "
           "periodically: total invoiced should equal what the ledger says was consumed. That is the "
           "check that caught the double-credit bug.", "cell")],
        [P("Backups", "cellb"),
         P("<font face='Courier'>billed_items</font> is the proration ledger and "
           "<font face='Courier'>webhook_events</font> is the idempotency ledger. Losing either means "
           "losing the ability to prorate correctly or to reject replays. Back up like financial records, "
           "because they are.", "cell")],
        [P("Timezones", "cellb"),
         P("All billing math is in UTC epoch seconds. Present local times in the UI if you like, but "
           "never let a local date reach the billing path.", "cell")],
    ],
    widths=[30 * mm, PAGE_W - 2 * MARGIN - 30 * mm]))

story.append(P("5.5  Before you take real money", "h2"))
story.append(P(
    "This is a complete and tested billing engine, but a production deployment handling live cards "
    "needs the following, none of which the brief asked for:", "body"))
story.append(table(
    ["ITEM", "WHY"],
    [
        [P("Authentication and authorisation", "cellb"),
         P("Every route is currently open. The admin endpoints expose revenue across all customers, and "
           "the customer endpoints expose billing history. This is the single largest gap between the "
           "current state and production.", "cell")],
        [P("Verify the live Stripe path", "cellb"),
         P("The integration is written but unexercised. Run the full lifecycle against a test key before "
           "trusting it, and confirm that invoice items land with the amounts this engine computed.", "cell")],
        [P("Verify BullMQ against real Redis", "cellb"),
         P("The poller path is proven; the BullMQ path is not. Confirm repeatable jobs fire and that "
           "flushing Redis does not lose scheduled dunning.", "cell")],
        [P("Rate-limit the usage endpoint", "cellb"),
         P("It accepts high-frequency writes by design. Without limits it is the easiest way to "
           "overwhelm the database.", "cell")],
        [P("Tax and multi-currency", "cellb"),
         P("Explicitly out of scope per the brief. Currency is stored per-invoice but no conversion "
           "or tax logic exists. Do not add tax by adjusting line amounts - it needs its own lines.", "cell")],
        [P("Structured logging and alerting", "cellb"),
         P("Currently console. Route webhook failures and dunning cancellations to real alerting - "
           "an auto-cancellation is a customer about to churn.", "cell")],
    ],
    widths=[46 * mm, PAGE_W - 2 * MARGIN - 46 * mm]))

story.append(P("5.6  API surface", "h2"))
story.append(code([
    "GET    /health                          runtime: which DB, queue, Stripe and email are live",
    "GET    /plans                           POST /plans",
    "POST   /customers                       GET  /customers/:id",
    "GET    /customers/:id/invoices          full billing history with line items",
    "GET    /customers/:id/notifications",
    "",
    "POST   /subscriptions                   { customerId, planId, at? }",
    "GET    /subscriptions/:id",
    "POST   /subscriptions/:id/change-plan   { planId, at? }   upgrade or downgrade",
    "POST   /subscriptions/:id/cancel        { atPeriodEnd? }",
    "POST   /subscriptions/:id/renew         force a period rollover",
    "POST   /subscriptions/:id/usage         { quantity, timestamp?, idempotencyKey? }",
    "GET    /subscriptions/:id/usage         projected metered charge for the open period",
    "",
    "GET    /invoices    GET /invoices/:id   POST /invoices/:id/pay",
    "POST   /webhooks/stripe                 signed, raw body, mounted first",
    "",
    "GET    /admin/dashboard                 revenue, MRR, failed rate, status counts",
    "GET    /admin/webhooks                  processing ledger: processed/duplicate/stale",
    "GET    /admin/dunning                   the retry queue",
    "POST   /admin/dunning/run               { at? }  run due retries at a simulated time",
]))
story.append(P(
    "Every <font face='Courier' size='9'>at</font> parameter accepts epoch seconds or an ISO string. "
    "They exist so the billing clock can be advanced deliberately - you can demonstrate a full "
    "seven-day dunning cycle in a single request rather than waiting a week. In production they are "
    "simply omitted and the real clock is used.", "body"))

story.append(Spacer(1, 6 * mm))
story.append(rule(0, 6))
story.append(P(
    "Every figure in this report was produced by an actual run: <font face='Courier' size='9'>npm test</font> "
    "for the test counts, live HTTP queries against a seeded server for the dashboard and invoice figures, "
    "and line counts from the source tree. Where something was not verified, it is labelled as such.", "small"))

# ---------------------------------------------------------------------------

doc = BaseDocTemplate(
    OUT, pagesize=A4,
    leftMargin=MARGIN, rightMargin=MARGIN,
    topMargin=MARGIN, bottomMargin=MARGIN,
    title="ledgerline - Project Report",
    author="asbaq000",
    subject="What it does, tests, requirements fulfilled, and production use",
)

frame_cover = Frame(MARGIN, MARGIN, PAGE_W - 2 * MARGIN, PAGE_H - 2 * MARGIN,
                    id="cover", leftPadding=0, rightPadding=0,
                    topPadding=0, bottomPadding=0)
frame_body = Frame(MARGIN, MARGIN, PAGE_W - 2 * MARGIN, PAGE_H - 2 * MARGIN,
                   id="body", leftPadding=0, rightPadding=0,
                   topPadding=0, bottomPadding=0)

doc.addPageTemplates([
    PageTemplate(id="cover", frames=[frame_cover], onPage=first_page),
    PageTemplate(id="body", frames=[frame_body], onPage=later_pages),
])

doc.build(story)
print(f"wrote {OUT}")
