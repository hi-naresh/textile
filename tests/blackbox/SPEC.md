# Textile ops app — functional spec for black-box testing

You are testing a **running** web app over HTTP only. You must NOT read its source code, build output
(`.next/`), git history, or any file outside your own test folder. Expectations come ONLY from this spec.
If the spec does not say what should happen, record the case as `ambiguous` — never infer the expected
value from what the app returns.

## Business context
A textile wholesale firm in Surat. Fabric arrives in **lots** (IN movements, meters), sits in stock, and is
sold to **parties** (clients) and sent out (OUT movements / dispatches). Phase 2 adds sales, dispatch,
GST invoicing, payments/credit, costing, reports and nine "agents" that raise suggestions.

## Access rules (apply to every endpoint)
- Callers pass `role` = `owner` | `supervisor` | `worker` and `actor` (user id). GET → query string, others → JSON body.
  Demo users: owner `usr-owner`, supervisor `usr-demo-sup`, worker `usr-demo-wrk`. Missing/unknown role = worker.
- **Owner** can do everything.
- **Supervisor** can see and work on orders, inquiries and dispatches, but must **never receive any money
  value** (₹ rate, amount, invoice total, margin, cost, credit limit, outstanding) in any response, and is
  refused (HTTP 403) on money-only endpoints (invoices, payments, credit, margin, costs, rates, billing settings, statements).
- **Worker** is refused (403) on orders, inquiries, dispatches, and all money endpoints.
- Bad input → HTTP 4xx with JSON `{ "error": "<plain message>" }`. Bad input must never cause a 500.

## R1 Stock ledger
- R1.1 A lot's balance = total IN meters − total OUT meters.
- R1.2 Meters must be > 0. OUT more than a lot's balance is refused.
- R1.3 **Free** meters of a lot = balance − meters currently **reserved** for orders.

## R2 Parties (clients)
- R2.1 Party names are unique ignoring case and surrounding spaces.
- R2.2 GSTIN, if given, must be a valid 15-character Indian GSTIN (2-digit state code, PAN, entity char, `Z`, check char); invalid → 4xx.
- R2.3 Each party may have a credit limit (₹) and credit days (default 30 if not given).

## R3 Rates and process costs (owner only)
- R3.1 A selling rate ₹/m is set per quality, optionally per party, with a `valid_from` date.
- R3.2 Rate lookup for (quality, party, date): a party-specific rate beats the general rate; among candidates, the one with the latest `valid_from` ≤ date wins. A rate valid from a future date is not used today.
- R3.3 Process cost ₹/m is set per section (e.g. folding, dyeing) with `valid_from`, same "latest valid" rule.

## R4 Inquiries (agent 1)
- R4.1 Staff paste/type free text such as "need 2000 m DON-2 by 10th, rate?" in English, Hindi or Gujarati. The app stores it and extracts quality, meters and needed-by date where present.
- R4.2 The app checks free stock for that quality and drafts a reply stating available meters; for the owner the draft includes a rate when one exists. A supervisor's view contains no rate.
- R4.3 Inquiry status: new → quoted → won / lost. A won inquiry can be converted into an order (party, quality, meters carried over). Converting twice must not create two orders.

## R5 Orders (agent 2)
- R5.1 An order has party, quality, meters (> 0), rate ₹/m, promise date. Status: open → partly_dispatched → dispatched; or cancelled.
- R5.2 Status follows dispatches: some but not all ordered meters dispatched → partly_dispatched; ≥ ordered meters dispatched → dispatched.
- R5.3 An order close to its promise date (few days) with too little allocated produces an alert/suggestion.

## R6 Allocation (agent 4)
- R6.1 Allocating reserves meters of a lot of the **same quality** for an order.
- R6.2 A lot can never have more meters reserved than its balance (no over-allocation across orders).
- R6.3 Auto-allocation prefers the oldest lots and the fewest lots, and never reserves more than the order still needs.
- R6.4 Releasing an allocation makes those meters free again.
- R6.5 A cancelled order's reservations are released.

## R7 Dispatch (agent 5)
- R7.1 A dispatch sends one or more lines (lot, meters) to a party, optionally against an order, with transport details (transporter, LR no, vehicle, packages). It records OUT movements, so lot balances drop by exactly the dispatched meters.
- R7.2 Dispatching more than a lot's balance is refused and nothing is recorded (all-or-nothing).
- R7.3 Dispatch against an order updates the order status (R5.2) and consumes that order's reservations on those lots.

## R8 GST invoices (agent 7) — owner only
- R8.1 An invoice can be made from a dispatch (made here) or recorded from Tally (source = tally).
- R8.2 Taxable value = Σ meters × rate for the lines. GST at the firm's configured GST % (billing settings).
- R8.3 If the party's state code equals the firm's state code → CGST + SGST, each half the GST %; otherwise → IGST at the full GST %. Never both.
- R8.4 Total = taxable + taxes (a round-off of at most ₹0.50 is acceptable).
- R8.5 Invoice numbers made here are unique and consecutive within the Indian financial year (April–March).
- R8.6 Due date = invoice date + the party's credit days.
- R8.7 One dispatch cannot be invoiced twice.
- R8.8 Tally export is available as XML and as Excel (.xlsx). Downloaded files must be valid for their type.

## R9 Payments and credit (agent 9) — owner only
- R9.1 A payment (amount > 0, date, mode, reference) is recorded for a party.
- R9.2 Payments settle that party's **oldest** unpaid invoices first (FIFO). Invoice status: unpaid → part-paid → paid.
- R9.3 Outstanding for a party = invoiced total − payments. Overdue = outstanding on invoices past their due date.
- R9.4 A credit check for (party, new amount) says not-ok / warns when outstanding + amount exceeds the credit limit, and ok when within it or when no limit is set.
- R9.5 A reminder message for an overdue party can be drafted (text mentions the amount due).

## R10 Costing and margin (agent 6) — owner only
- R10.1 Cost ₹/m of a lot = purchase rate (grey) + applicable process costs; shortage (grey m − finished m) raises the cost per finished meter.
- R10.2 Margin = selling value − cost for what was sold; available per party and per order.

## R11 Documents (agent 7)
- R11.1 Challan, packing list, invoice and party statement are downloadable as PDF (`%PDF` header, non-trivial size).
- R11.2 Invoice and statement PDFs contain money and are owner only.

## R12 Reports and inventory (agents 3, 8)
- R12.1 Daily / weekly / monthly summaries report stock in and out meters that match the ledger for that period.
- R12.2 Exportable as Excel (.xlsx).
- R12.3 Inventory flags: low stock for a quality (below the configured threshold), ageing lots (no movement for many days).
- R12.4 Supervisor view has no ₹ values.

## R13 Agent suggestions (all agents)
- R13.1 Agents raise suggestions (title, severity, target, optional one-tap action). Listing suggestions triggers a scan.
- R13.2 Running the scan again does not duplicate an open suggestion for the same thing.
- R13.3 Accept performs the suggested action (e.g. accepting an allocation suggestion creates the reservation). Reject dismisses it; a dismissed suggestion does not reappear for at least 24 hours.
- R13.4 Suggestions that involve money are hidden from the supervisor.
- R13.5 Workers see no suggestions.

## R14 Chat (question answering) — no AI keys are configured on this server
- R14.1 Deterministic questions are answered with numbers matching the data, e.g. "how many workers do I have", "how many supervisors", "open orders", "outstanding amount" (owner).
- R14.2 A supervisor asking a money question gets no ₹ figure.
