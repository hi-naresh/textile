# HTTP interface (names only — no behaviour; behaviour is in SPEC.md)

JSON in, JSON out unless noted. `role`/`actor` on every call (query for GET, body otherwise).
Response shapes are not documented here: inspect them, but never use them to decide what is *correct*.

## Stock
- `GET /api/stock` → lots and balances
- `POST /api/stock` body `{ direction: "IN"|"OUT", lot_id, quality, design?, grey_meters, finished_meters, mill_name, weaver_name?, purchase_rate?, source_doc?, moved_by }` for IN;
  `{ direction: "OUT", lot_id, meters, party, source_doc?, moved_by }` for OUT
- `GET /api/stock/flow?range=day|week|month|year|all&quality=`
- `GET /api/inventory?role=`

## Master data
- `GET /api/parties?role=&q=&all=` · `POST /api/parties` `{ name, phone?, gstin?, address?, city?, state_code?, credit_limit?, credit_days?, role, actor }` · `PATCH /api/parties/<id>` (same fields)
- `GET /api/rates?role=` · `POST /api/rates` `{ quality, party_id? | party_name?, rate_per_m, valid_from?, role, actor }`
- `GET /api/orders/rate?quality=&party=|party_id=&role=` → rate lookup
- `GET /api/costs?role=` · `POST /api/costs` `{ section, cost_per_m, valid_from?, role, actor }`
- `GET /api/costs/lot?lot_id=&role=`
- `GET /api/settings/billing?role=` · `PUT /api/settings/billing` `{ legal_name, gstin, state_code, address, city, phone, gst_rate_pct, hsn_code, invoice_prefix, next_invoice_no?, bank_name, bank_account, bank_ifsc, low_stock_m?, ageing_days?, role }`

## Sales
- `GET /api/inquiries?status=&role=` · `POST /api/inquiries` `{ raw_text, source?: whatsapp|phone|visit, party_name?, role, actor }`
- `GET /api/inquiries/<id>?role=` · `PATCH /api/inquiries/<id>` `{ status?, party?, quality?, meters?, needed_by?, quoted_rate?, reply_draft?, notes?, role }`
- `POST /api/inquiries/<id>/convert` `{ role, actor, rate_per_m?, promise_date? }`
- `GET /api/orders?status=&party_id=&role=` · `POST /api/orders` `{ party | party_id, quality, design?, meters, rate_per_m, promise_date, notes?, role, actor }`
- `GET /api/orders/<id>?role=` · `PATCH /api/orders/<id>` `{ status?: "cancelled", meters?, rate_per_m?, promise_date?, role }`
- `GET /api/orders/<id>/candidates?role=` · `POST /api/orders/<id>/allocate` `{ auto: true }` or `{ lot_id, meters }` + `{ role, actor }`
- `POST /api/allocations/<id>/release` `{ role }`

## Dispatch & invoices
- `GET /api/dispatches?party_id=&days=&role=` · `GET /api/dispatches/<id>?role=`
- `POST /api/dispatches` `{ party, order_id?, lines: [{ lot_id, meters }], challan_no?, transporter?, lr_no?, vehicle_no?, packages?, create_invoice?, invoice_date?, rates?: { "<lot_id or quality>": rate }, role, actor }`
- `GET /api/invoices?party_id=&status=&source=&from=&to=&role=` · `GET/PATCH /api/invoices/<id>` (`{ status: "cancelled", role }`)
- `POST /api/invoices` — from a dispatch `{ dispatch_id, invoice_date?, rates?, role, actor }`; from Tally `{ source: "tally", invoice_no, party, invoice_date, due_date?, taxable_amount, total, lines?: [{quality, meters, rate}], role, actor }`
- `GET /api/invoices/export?format=xml|xlsx&from=&to=&role=`
- PDFs: `GET /api/docs/challan?dispatch_id=`, `/api/docs/packing-list?dispatch_id=`, `/api/docs/invoice?id=`, `/api/docs/statement?party_id=&from=&to=` (+ `role`, `actor`)

## Money
- `GET /api/payments?party_id=&role=` · `POST /api/payments` `{ party | party_id, amount, paid_on, mode, reference?, invoice_id?, role, actor }`
- `GET /api/credit?party_id=&role=` · `GET /api/credit/check?party=|party_id=&amount=&role=` · `GET /api/credit/reminder?party_id=&lang=en|hi|gu&role=`
- `GET /api/margin?by=party|order&days=&role=`

## Reports, agents, chat
- `GET /api/reports?period=daily|weekly|monthly&date=YYYY-MM-DD&role=` · `GET /api/reports/export?period=&date=&role=`
- `GET /api/agents/suggestions?role=` (also runs a throttled scan) · `POST /api/agents/suggestions` `{ id, action: "accept"|"reject", role, actor }`
- `POST /api/agents/run` `{ role: "owner" }` — force a full scan now
- `POST /api/chat` `{ question, role, user_id }`
- Existing workers: `GET /api/workers`; supervisors are users with role supervisor (`GET /api/status` shows counts).

## UI
- App at `/`. Tabs are chosen from the nav; role is switched in **Settings → Preview as**. Phase 2 tabs: Orders, Dispatch, Money, Reports (owner "Sales" group); supervisor sees Orders and Dispatch.

Note: field names above may be slightly off. A 4xx message will tell you what is expected — fixing
how you *call* the API is fine; changing what you *expect* to match the app's output is not.
