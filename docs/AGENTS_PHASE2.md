# Phase 2 — Agents (spec)

Status: **built 28 Sep 2026** (all nine agents). Written 27 Sep 2026 after the "Textile Brain — Discussed Changes" review. Code: `src/lib/agents/*` (one module per agent), shared helpers in `src/lib/{stock,pricing,billing,parties,orderStatus}.ts`, contracts in `docs/PHASE2_CONTRACTS.md`. Invoices: both — GST invoices made here and invoices recorded from Tally (+ Tally export).

## Principles (same as Phase 1)
- **Deterministic code first.** An "agent" is mostly rules + fixed queries. An LLM is used only to understand free text (a WhatsApp inquiry, a question) or to write a draft a person approves.
- **Cheapest tier that works.** Low tier for classifying / extracting; high tier only for images or long documents. Every call is logged in `llm_usage` with the agent name as `feature` (e.g. `agent.inquiry`).
- **No AI-written SQL.** Agents read data through fixed query functions, and write only through the existing ledger functions (`recordIncoming`, `recordOutgoing`, `createJobCard`, …) so all Phase 1 validation applies.
- **A person approves anything that commits the firm** (price, promise date, credit, dispatch). Agents suggest; people confirm.

## How owners meet agents (no "agent" screens)
1. **Invisible automation** inside Capture and Chat — e.g. a captured dispatch challan is matched to its order automatically; "what's pending for Balaji?" is answered by the Order agent.
2. **Alerts** in "Needs your attention" and the bell — e.g. "Lot 257A allocated twice", "Party X is 20 days over credit".
3. **Suggested actions** with one-tap accept/reject — e.g. "Allocate DEMO-103 (1,500 m Rayon) to order #41?".

Every suggestion is stored so acceptance rate can be measured per agent.

## Shared data model (new tables)
| Table | Purpose |
|---|---|
| `parties` | Clients: canonical name, phone, GST no, credit limit ₹, credit days, active. Seeded from distinct `stock_movements.party`. |
| `inquiries` | Incoming requests: source (whatsapp/phone/visit), party_id, raw text, parsed JSON (quality, meters, target rate, date), status (new/quoted/won/lost), created_by. |
| `orders` | Confirmed orders: party_id, quality, design, meters, rate ₹/m, promise date, status (open/partly_dispatched/dispatched/cancelled). |
| `order_lines` | Optional split of an order by design/colour. |
| `allocations` | Order ↔ lot reservation: order_id, lot_id, meters, status (reserved/released/dispatched). Unique on active (lot_id) meters ≤ balance. |
| `dispatches` | Groups one or more OUT `stock_movements` under an order + transport details (transporter, LR no, vehicle, packages). |
| `rates` | ₹ per meter by quality (and optionally party) with valid_from — replaces the owner's per-device average rate. |
| `costs` | Process cost per meter by section (weaving, dyeing, folding…), valid_from. |
| `invoices` / `payments` | Invoice per dispatch (amount, due date) and payments received (amount, date, mode, reference). |
| `agent_suggestions` | agent, kind, payload JSON, target (order/lot/party), status (open/accepted/rejected/expired), decided_by, decided_at. |
| `generated_docs` | Document generation output: kind, ref, storage path, created_by. |

## The nine agents

### 1. Inquiry Handling
- **Does:** turns a free-text inquiry ("need 2000 m DON-2 by 10th, rate?") into a structured inquiry, checks stock + allocations, and drafts a reply with available meters and a rate from `rates`.
- **Deterministic:** stock check, rate lookup, promise-date estimate from open job cards.
- **LLM:** low tier to extract fields from the text; low tier to phrase the reply (en/hi/gu).
- **Surfaces:** Chat ("new inquiry from…"), suggested reply to copy/send.
- **Needs:** `parties`, `inquiries`, `rates`.

### 2. Order Management
- **Does:** converts an accepted inquiry into an order, tracks status from dispatches, flags orders close to the promise date with too little allocated.
- **Deterministic:** entirely (status machine + date rules).
- **Surfaces:** alerts ("Order #41 due in 2 days, 60% allocated"), Chat answers ("pending for Balaji?").
- **Needs:** `orders`, `allocations`, `dispatches`.

### 3. Fabric Inventory
- **Does:** keeps the stock picture honest — low-stock alerts per quality, ageing lots (no movement in N days), lots with no location, grey→finished loss outliers by mill.
- **Deterministic:** entirely (queries over `stock_movements`, `lot_locations`).
- **Surfaces:** alerts, weekly summary in Chat.
- **Needs:** nothing new (thresholds in `app_settings`).

### 4. Fabric Allocation
- **Does:** proposes which lot(s) fill an order: same quality/design, enough free balance (balance − active allocations), oldest first, fewest lots.
- **Deterministic:** entirely (greedy match with tie-breaks). No LLM.
- **Surfaces:** suggested action on the order; double-allocation alert.
- **Needs:** `orders`, `allocations`.

### 5. Logistics & Dispatch
- **Does:** when a dispatch challan is captured, matches it to the open order + allocation, fills transport details, and prepares the packing list.
- **Deterministic:** matching by party + quality + meters within tolerance.
- **LLM:** only if the captured challan layout is new (goes through the Phase 1 capture decision layer).
- **Surfaces:** invisible on Capture; alert on mismatch ("dispatched 980 m, order said 1,000 m").
- **Needs:** `dispatches`, `orders`, `allocations`.

### 6. Costing & Margin
- **Does:** cost per meter of a lot = purchase rate (grey) + process costs by section + shortage loss; margin per order and per party.
- **Deterministic:** entirely. Uses the cutting-report Pu.Rate / Gp.Rate the OCR already reads.
- **Surfaces:** Owner Overview (Detailed), Chat ("margin on Balaji this month").
- **Needs:** `rates`, `costs`; store Pu.Rate / Gp.Rate from captures on the IN movement.
- **Owner only** (₹).

### 7. Document Generation
- **Does:** produces dispatch challan, packing list, invoice PDF, and party statement from ledger data.
- **Deterministic:** templates filled from data (no LLM needed).
- **Surfaces:** "Download challan / invoice" buttons; sent to the party by the owner.
- **Needs:** `generated_docs`, firm letterhead fields in Settings (address, GSTIN, bank details).

### 8. Analytics & Reporting
- **Does:** scheduled summaries — daily (stock in/out, reads, shortage), weekly (party-wise dispatch, mill-wise receipts, worker efficiency), monthly (time saved, AI cost, margin).
- **Deterministic:** fixed query templates (extends the Phase 1 chat templates).
- **LLM:** low tier only to write a 3-line narrative on top of the numbers (optional).
- **Surfaces:** Overview, Chat, optional WhatsApp/email to the owner.

### 9. Credit & Payment
- **Does:** tracks invoices vs payments per party, flags overdue and over-limit parties, blocks/asks before a new dispatch to an over-limit party, drafts a polite reminder.
- **Deterministic:** ageing buckets, limit checks.
- **LLM:** low tier to phrase reminders.
- **Surfaces:** alerts, suggested reminder, a warning on the dispatch capture.
- **Needs:** `parties` (credit limit/days), `invoices`, `payments`. **Owner only.**

## Not doing (decided 27 Sep 2026)
Supply-chain visibility, quality / inspection, and production agents.

## Suggested build order
1. Master data: `parties`, `rates`, `costs` (+ Settings screens, Excel import). Everything else depends on these.
2. Orders + Allocation (agents 2 and 4) — deterministic, immediate value.
3. Logistics & Dispatch (5) on top of the capture flow.
4. Document Generation (7) — challan / invoice PDFs.
5. Credit & Payment (9) — needs invoices from step 4.
6. Costing & Margin (6).
7. Inquiry Handling (1) — needs orders, rates, stock.
8. Analytics & Reporting (8) — grows with each agent; Fabric Inventory (3) alerts can ship any time.

## Open questions for the owner
- Where do inquiries arrive today (WhatsApp, phone, broker)? Is a WhatsApp Business number available?
- Are rates per quality, per party, or per order? Who can change them?
- Is GST invoicing done in another system (Tally / ERP)? If yes, we export to it rather than generate invoices.
- Credit limits: per party amount, days, or both? Who can override a block?
- Mill / weaver / party master data in the old ERP (see TODO §3) — migrate first, since agents 1, 2, 5, 9 need clean party records.
