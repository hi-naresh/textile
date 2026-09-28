# Phase 2 — cross-team contracts

All APIs take `role` (owner | supervisor | worker) and `actor` (users.id) — query string for GET, JSON body otherwise — until login exists (`src/lib/apiAuth.ts`). Errors: `{ error }` with 4xx. Supervisors never receive ₹ fields.

| Owner | Contract |
|---|---|
| Lead | `refreshOrderStatus(q, orderId)` — `src/lib/orderStatus.ts` |
| Lead | `freeLotsForQuality / lotStock / allLotStock / freeByQuality` — `src/lib/stock.ts` (free = balance − reserved allocations) |
| Lead | `rateFor(q, quality, partyId, date)`, `processCostFor(q, section, date)` — `src/lib/pricing.ts` |
| Lead | `readBilling(q)`, `nextInvoiceNo(q)` — `src/lib/billing.ts`; `partyByName(q, name, create)`, `partyById` — `src/lib/parties.ts` |
| Lead | Suggestions: `suggest / resolve / resolveMissing` — `src/lib/agents/suggest.ts`; `GET/POST /api/agents/suggestions` |
| Money | `GET /api/parties?role=` → `{ parties: Party[] }` (supervisor: no credit fields) |
| Money | `GET /api/credit/check?party=<name>|party_id=<id>&amount=<₹>&role=` → `{ ok: boolean, warn: string \| null, outstanding?: number, limit?: number \| null }` |
| Sales | `GET /api/orders?status=open&party_id=&role=` → `{ orders: Order[] }` ; `GET /api/orders/<id>?role=` → `{ order: Order, allocations: Allocation[] }` |
| Dispatch | `POST /api/dispatches` `{ party, order_id?, lines: [{ lot_id, meters }], challan_no?, transporter?, lr_no?, vehicle_no?, packages?, create_invoice?, role, actor }` → `{ dispatch, invoice? }` |
| Dispatch | `GET /api/invoices?party_id=&status=&role=owner` → `{ invoices: Invoice[] }` |
| Dispatch | PDFs: `/api/docs/challan?dispatch_id=`, `/api/docs/packing-list?dispatch_id=`, `/api/docs/invoice?id=`, `/api/docs/statement?party_id=` |

Screens: `orders` → `Orders.tsx` (Sales) · `dispatch` → `Dispatch.tsx` (Dispatch) · `money` → `Money.tsx` + Settings `MasterData.tsx` (Money) · `reports` → `Reports.tsx` (Insight).
Row types: `src/lib/domain.ts`.
