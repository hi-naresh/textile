// Extra chat metrics from the Phase 2 agents: orders, inquiries, free stock, and (owner only) ₹ figures.
// Same shape as METRICS in semantic.ts. `ownerOnly: true` hides a metric from supervisors.
// Only fixed SQL here — questions pick a metric / group / filter from this catalog, never write SQL.
// (Type-only import: semantic.ts imports this file, so nothing from it may be used at runtime here.)
import type { MetricDef } from './semantic';

const DAY = (c: string) => `to_char(${c}, 'YYYY-MM-DD')`;
const MONTH = (c: string) => `to_char(${c}, 'YYYY-MM')`;

// Meters still to dispatch per order = ordered − OUT movements linked to the order.
const OPEN_ORDERS = `orders o JOIN parties p ON p.id = o.party_id
  LEFT JOIN (SELECT order_id, SUM(meters) AS m FROM stock_movements WHERE direction = 'OUT' AND order_id IS NOT NULL GROUP BY order_id) od ON od.order_id = o.id`;
const OPEN_WHERE = `o.status IN ('open', 'partly_dispatched')`;
const REMAINING = `GREATEST(o.meters - COALESCE(od.m, 0), 0)`;

// Lot balance − active reservations, with the lot's latest location.
const FREE = `(SELECT l.lot_id, l.quality, l.design,
   COALESCE(b.bal, 0) AS bal, COALESCE(a.res, 0) AS res,
   (SELECT location FROM lot_locations WHERE lot_id = l.lot_id ORDER BY ts DESC, id DESC LIMIT 1) AS location
 FROM lots l
 LEFT JOIN (SELECT lot_id, SUM(CASE WHEN direction = 'IN' THEN meters ELSE -meters END) AS bal FROM stock_movements GROUP BY lot_id) b ON b.lot_id = l.lot_id
 LEFT JOIN (SELECT lot_id, SUM(meters - dispatched_m) AS res FROM allocations WHERE status = 'reserved' GROUP BY lot_id) a ON a.lot_id = l.lot_id) fs`;

// Per party: invoices (not cancelled) − payments, and the part already past its due date
// (payments settle the oldest invoices first, so overdue = past-due invoices − all payments, ≥ 0).
const DUES = `(SELECT p.name,
   COALESCE(inv.t, 0) - COALESCE(pay.t, 0) AS due,
   GREATEST(COALESCE(inv.past, 0) - COALESCE(pay.t, 0), 0) AS overdue
 FROM parties p
 LEFT JOIN (SELECT party_id, SUM(total) AS t, SUM(total) FILTER (WHERE due_date < CURRENT_DATE) AS past FROM invoices WHERE status <> 'cancelled' GROUP BY party_id) inv ON inv.party_id = p.id
 LEFT JOIN (SELECT party_id, SUM(amount) AS t FROM payments GROUP BY party_id) pay ON pay.party_id = p.id
 WHERE inv.party_id IS NOT NULL OR pay.party_id IS NOT NULL) du`;

const INQ_PARTY = `COALESCE(p.name, NULLIF(btrim(i.party_name), ''), '—')`;

export const EXTRA_METRICS: Record<string, MetricDef> = {
  // ---------- orders ----------
  orders_open: {
    title: 'Pending on open orders', describe: 'meters still to dispatch on open / partly dispatched orders (as of now)', unit: 'm',
    from: OPEN_ORDERS, where: OPEN_WHERE, agg: `SUM(${REMAINING})`,
    dims: { party: 'p.name', quality: 'o.quality', design: `COALESCE(o.design, '—')` },
    filters: { party: 'p.name', quality: 'o.quality' },
  },
  open_orders: {
    title: 'open orders', describe: 'number of open / partly dispatched orders (as of now)', unit: 'count',
    from: OPEN_ORDERS, where: OPEN_WHERE, agg: 'COUNT(*)',
    dims: { party: 'p.name', quality: 'o.quality' }, filters: { party: 'p.name', quality: 'o.quality' },
    list: `string_agg('#' || o.id || ' ' || p.name || ' ' || o.quality || ' ' || ROUND(${REMAINING})::text || ' m', '; ' ORDER BY o.promise_date NULLS LAST, o.id)`,
  },
  orders_overdue: {
    title: 'orders past promise date', describe: 'open orders whose promise date has passed (as of now)', unit: 'count',
    from: OPEN_ORDERS, where: `${OPEN_WHERE} AND o.promise_date < CURRENT_DATE`, agg: 'COUNT(*)',
    dims: { party: 'p.name', quality: 'o.quality' }, filters: { party: 'p.name', quality: 'o.quality' },
    list: `string_agg('#' || o.id || ' ' || p.name || ' (due ' || to_char(o.promise_date, 'DD Mon') || ')', '; ' ORDER BY o.promise_date)`,
  },
  orders: {
    title: 'orders', describe: 'number of orders received (created), not counting cancelled', unit: 'count',
    from: 'orders o JOIN parties p ON p.id = o.party_id', where: `o.status <> 'cancelled'`, agg: 'COUNT(*)', time: 'o.created_at',
    dims: { party: 'p.name', quality: 'o.quality', day: DAY('o.created_at'), month: MONTH('o.created_at') },
    filters: { party: 'p.name', quality: 'o.quality' },
  },
  ordered: {
    title: 'Ordered', describe: 'meters ordered (orders received), not counting cancelled', unit: 'm',
    from: 'orders o JOIN parties p ON p.id = o.party_id', where: `o.status <> 'cancelled'`, agg: 'SUM(o.meters)', time: 'o.created_at',
    dims: { party: 'p.name', quality: 'o.quality', day: DAY('o.created_at'), month: MONTH('o.created_at') },
    filters: { party: 'p.name', quality: 'o.quality' },
  },
  reserved: {
    title: 'Reserved for orders', describe: 'meters of stock reserved (allocated) for open orders', unit: 'm',
    from: 'allocations a JOIN orders o ON o.id = a.order_id JOIN parties p ON p.id = o.party_id JOIN lots l ON l.lot_id = a.lot_id',
    where: `a.status = 'reserved'`, agg: 'SUM(a.meters - a.dispatched_m)',
    dims: { party: 'p.name', quality: 'l.quality', lot: 'a.lot_id' }, filters: { party: 'p.name', quality: 'l.quality', lot: 'a.lot_id' },
  },

  // ---------- inquiries ----------
  inquiries: {
    title: 'inquiries', describe: 'number of inquiries received', unit: 'count',
    from: 'inquiries i LEFT JOIN parties p ON p.id = i.party_id', agg: 'COUNT(*)', time: 'i.created_at',
    dims: { party: INQ_PARTY, quality: `COALESCE(i.quality, '—')`, day: DAY('i.created_at'), month: MONTH('i.created_at') },
    filters: { party: INQ_PARTY, quality: 'i.quality' },
  },
  inquiries_open: {
    title: 'open inquiries', describe: 'inquiries still waiting (new or quoted, not won or lost), as of now', unit: 'count',
    from: 'inquiries i LEFT JOIN parties p ON p.id = i.party_id', where: `i.status IN ('new', 'quoted')`, agg: 'COUNT(*)',
    dims: { party: INQ_PARTY, quality: `COALESCE(i.quality, '—')` }, filters: { party: INQ_PARTY, quality: 'i.quality' },
    list: `string_agg(${INQ_PARTY} || COALESCE(' ' || i.quality, ''), '; ' ORDER BY i.created_at)`,
  },
  inquiries_won: {
    title: 'inquiries won', describe: 'inquiries marked won (turned into orders)', unit: 'count',
    from: 'inquiries i LEFT JOIN parties p ON p.id = i.party_id', where: `i.status = 'won'`, agg: 'COUNT(*)', time: 'i.updated_at',
    dims: { party: INQ_PARTY, quality: `COALESCE(i.quality, '—')`, month: MONTH('i.updated_at') }, filters: { party: INQ_PARTY, quality: 'i.quality' },
  },
  win_rate: {
    title: 'Inquiry win rate', describe: 'won ÷ (won + lost) inquiries, %', unit: '%',
    from: 'inquiries i LEFT JOIN parties p ON p.id = i.party_id', where: `i.status IN ('won', 'lost')`,
    ratio: { num: `SUM(CASE WHEN i.status = 'won' THEN 1.0 ELSE 0 END)`, den: 'COUNT(*)::numeric' }, time: 'i.updated_at',
    dims: { party: INQ_PARTY, quality: `COALESCE(i.quality, '—')`, month: MONTH('i.updated_at') }, filters: { party: INQ_PARTY, quality: 'i.quality' },
  },

  // ---------- stock ----------
  free_stock: {
    title: 'Free stock', describe: 'meters in stock not reserved for orders (balance − reserved), now', unit: 'm',
    from: FREE, where: 'fs.bal > 0', agg: 'SUM(fs.bal - fs.res)',
    dims: { quality: 'fs.quality', design: 'fs.design', lot: 'fs.lot_id', location: `COALESCE(fs.location, '—')` },
    filters: { quality: 'fs.quality', lot: 'fs.lot_id', location: 'fs.location' },
  },

  // ---------- money (owner only) ----------
  invoiced: {
    title: 'Invoiced', describe: 'invoice value incl. GST (₹), not counting cancelled invoices', unit: 'inr', ownerOnly: true,
    from: 'invoices inv JOIN parties p ON p.id = inv.party_id', where: `inv.status <> 'cancelled'`, agg: 'SUM(inv.total)', time: 'inv.invoice_date',
    dims: { party: 'p.name', day: DAY('inv.invoice_date'), month: MONTH('inv.invoice_date') }, filters: { party: 'p.name' },
  },
  collected: {
    title: 'Collected', describe: 'payments received (₹)', unit: 'inr', ownerOnly: true,
    from: 'payments pay JOIN parties p ON p.id = pay.party_id', agg: 'SUM(pay.amount)', time: 'pay.paid_on',
    dims: { party: 'p.name', day: DAY('pay.paid_on'), month: MONTH('pay.paid_on') }, filters: { party: 'p.name' },
  },
  outstanding: {
    title: 'Outstanding', describe: 'money still to receive per party now (₹ invoiced − ₹ paid)', unit: 'inr', ownerOnly: true,
    from: DUES, where: 'du.due > 0', agg: 'SUM(du.due)',
    dims: { party: 'du.name' }, filters: { party: 'du.name' },
  },
  overdue: {
    title: 'Overdue', describe: 'outstanding money already past its due date (₹), now', unit: 'inr', ownerOnly: true,
    from: DUES, where: 'du.overdue > 0', agg: 'SUM(du.overdue)',
    dims: { party: 'du.name' }, filters: { party: 'du.name' },
  },
};
