// Fabric Inventory picture: free stock and days of cover per quality, ageing lots, lots with no
// location, and grey→finished loss by mill. Fixed queries only; shared by GET /api/inventory,
// the Inventory agent scan and the Reports screen. Meters only — no ₹ anywhere in here.
import type { Q } from '../db';
import { freeByQuality } from '../stock';
import { readBilling } from '../billing';
import { nameKey } from '../normalize';

export type CoverStatus = 'ok' | 'low' | 'short';

export interface QualityCover {
  quality: string;
  key: string; // nameKey(quality) — stable id for alerts
  balance: number;
  reserved: number;
  free: number;
  out30: number; // meters dispatched in the last 30 days
  avgDaily: number; // out30 ÷ 30
  daysCover: number | null; // free ÷ avgDaily; null when nothing was dispatched
  lastDispatch: string | null; // YYYY-MM-DD
  soldRecently: boolean; // dispatched in the last 60 days
  openOrders: number; // count of open / partly dispatched orders
  openOrderM: number; // meters still to dispatch on those orders
  unreservedM: number; // of which not yet reserved from a lot
  status: CoverStatus;
}

export interface AgeingLot { lot_id: string; quality: string; design: string; balance: number; free: number; location: string | null; last_activity: string | null; days: number }
export interface NoLocationLot { lot_id: string; quality: string; design: string; balance: number; last_activity: string | null }
export interface MillLoss { mill: string; receipts: number; grey: number; finished: number; lossPct: number; gap: number; flagged: boolean }

export interface InventorySnapshot {
  asOf: string;
  thresholds: { lowStockM: number; ageingDays: number; millLossGap: number; millMinReceipts: number };
  totals: { balance: number; reserved: number; free: number; qualities: number; low: number; short: number };
  qualities: QualityCover[];
  ageing: { count: number; meters: number; oldestDays: number | null; lots: AgeingLot[] };
  noLocation: { count: number; meters: number; lots: NoLocationLot[] };
  millLoss: { days: number; overallPct: number | null; receipts: number; mills: MillLoss[] };
}

export const MILL_LOSS_GAP = 5; // points above the overall loss %
export const MILL_MIN_RECEIPTS = 3;
const r2 = (n: number) => Math.round(n * 100) / 100;
const r1 = (n: number) => Math.round(n * 10) / 10;

export async function inventorySnapshot(q: Q): Promise<InventorySnapshot> {
  const billing = await readBilling(q);
  const { lowStockM, ageingDays } = billing;

  // Sequential on purpose: `q` may be one transaction client (pg refuses parallel queries on it).
  const asOfR = await q(`SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS d`);
  const stock = await freeByQuality(q);
  // Dispatches per quality: last 30 days (rate), last 60 days (is it still selling?), last date.
  const sales = await q(`SELECT l.quality,
              COALESCE(SUM(sm.meters) FILTER (WHERE sm.ts >= CURRENT_DATE - 29), 0) AS out30,
              COUNT(*) FILTER (WHERE sm.ts >= CURRENT_DATE - 59) AS n60,
              to_char(MAX(sm.ts), 'YYYY-MM-DD') AS last_out
       FROM stock_movements sm JOIN lots l ON l.lot_id = sm.lot_id
       WHERE sm.direction = 'OUT'
       GROUP BY l.quality`);
  // Open orders: meters still to go = ordered − dispatched against the order.
  const orders = await q(`SELECT o.quality, COUNT(*) AS n, SUM(GREATEST(o.meters - COALESCE(d.m, 0), 0)) AS remaining,
              SUM(GREATEST(o.meters - COALESCE(d.m, 0) - COALESCE(r.m, 0), 0)) AS unreserved
       FROM orders o
       LEFT JOIN (SELECT order_id, SUM(meters) AS m FROM stock_movements WHERE direction = 'OUT' AND order_id IS NOT NULL GROUP BY order_id) d ON d.order_id = o.id
       LEFT JOIN (SELECT order_id, SUM(meters - dispatched_m) AS m FROM allocations WHERE status = 'reserved' GROUP BY order_id) r ON r.order_id = o.id
       WHERE o.status IN ('open', 'partly_dispatched')
       GROUP BY o.quality`);
  // Lots with stock: last activity = latest stock movement, job card or location change.
  const lots = await q(`SELECT l.lot_id, l.quality, l.design, b.bal AS balance, COALESCE(a.res, 0) AS reserved,
              (SELECT location FROM lot_locations WHERE lot_id = l.lot_id ORDER BY ts DESC, id DESC LIMIT 1) AS location,
              to_char(GREATEST(b.last_move,
                               (SELECT MAX(COALESCE(ts_closed, ts_created)) FROM job_cards WHERE lot_id = l.lot_id),
                               (SELECT MAX(ts) FROM lot_locations WHERE lot_id = l.lot_id)), 'YYYY-MM-DD') AS last_activity,
              (CURRENT_DATE - GREATEST(b.last_move,
                               (SELECT MAX(COALESCE(ts_closed, ts_created)) FROM job_cards WHERE lot_id = l.lot_id),
                               (SELECT MAX(ts) FROM lot_locations WHERE lot_id = l.lot_id))::date) AS idle_days
       FROM lots l
       JOIN (SELECT lot_id, SUM(CASE WHEN direction = 'IN' THEN meters ELSE -meters END) AS bal, MAX(ts) AS last_move FROM stock_movements GROUP BY lot_id) b ON b.lot_id = l.lot_id
       LEFT JOIN (SELECT lot_id, SUM(meters - dispatched_m) AS res FROM allocations WHERE status = 'reserved' GROUP BY lot_id) a ON a.lot_id = l.lot_id
       WHERE b.bal > 0
       ORDER BY l.lot_id`);
  // Grey → finished loss per mill, last 90 days, receipts that carry both figures.
  const mills = await q(`SELECT btrim(mill_name) AS mill, COUNT(*) AS n, SUM(grey_meters) AS grey, SUM(finished_meters) AS fin
       FROM stock_movements
       WHERE direction = 'IN' AND grey_meters IS NOT NULL AND finished_meters IS NOT NULL
         AND mill_name IS NOT NULL AND btrim(mill_name) <> '' AND ts >= CURRENT_DATE - 89
       GROUP BY btrim(mill_name)`);

  // ---- per quality (merge stock, sales and orders case-insensitively) ----
  const byKey = new Map<string, QualityCover>();
  const get = (quality: string) => {
    const key = nameKey(quality);
    let x = byKey.get(key);
    if (!x) {
      x = { quality, key, balance: 0, reserved: 0, free: 0, out30: 0, avgDaily: 0, daysCover: null, lastDispatch: null, soldRecently: false, openOrders: 0, openOrderM: 0, unreservedM: 0, status: 'ok' };
      byKey.set(key, x);
    }
    return x;
  };
  for (const s of stock) { const x = get(s.quality); x.balance += s.balance; x.reserved += s.reserved; x.free += s.free; }
  for (const s of sales.rows) {
    const out30 = Number(s.out30), n60 = Number(s.n60);
    // Qualities with no stock and no sale in 60 days are history — leave them out.
    if (!byKey.has(nameKey(s.quality)) && n60 === 0) continue;
    const x = get(s.quality);
    x.out30 += out30; x.soldRecently ||= n60 > 0;
    if (!x.lastDispatch || (s.last_out && s.last_out > x.lastDispatch)) x.lastDispatch = s.last_out;
  }
  for (const o of orders.rows) { const x = get(o.quality); x.openOrders += Number(o.n); x.openOrderM += Number(o.remaining); x.unreservedM += Number(o.unreserved); }

  const qualities = Array.from(byKey.values()).map((x) => {
    const free = r2(x.free);
    const avgDaily = r1(x.out30 / 30);
    const daysCover = avgDaily > 0 ? r1(Math.max(0, free) / (x.out30 / 30)) : null;
    const openOrderM = r2(x.openOrderM);
    const active = x.soldRecently || x.openOrders > 0;
    // Meters already reserved for an order are that order's own stock: only the unreserved need competes for free stock.
    const unreservedM = r2(x.unreservedM);
    const status: CoverStatus = unreservedM > 0 && unreservedM > free ? 'short' : active && free < lowStockM ? 'low' : 'ok';
    return { ...x, balance: r2(x.balance), reserved: r2(x.reserved), free, out30: r2(x.out30), avgDaily, daysCover, openOrderM, unreservedM, status };
  });
  const rank: Record<CoverStatus, number> = { short: 0, low: 1, ok: 2 };
  qualities.sort((a, b) => rank[a.status] - rank[b.status] || (a.daysCover ?? 1e9) - (b.daysCover ?? 1e9) || b.out30 - a.out30 || a.quality.localeCompare(b.quality));

  // ---- lots ----
  const lotRows = lots.rows.map((r) => ({
    lot_id: String(r.lot_id), quality: String(r.quality), design: String(r.design), balance: r2(Number(r.balance)),
    free: r2(Number(r.balance) - Number(r.reserved)), location: (r.location as string | null) ?? null,
    last_activity: (r.last_activity as string | null) ?? null, days: r.idle_days == null ? 0 : Number(r.idle_days),
  }));
  const ageingLots = lotRows.filter((l) => l.last_activity && l.days > ageingDays).sort((a, b) => b.days - a.days);
  const noLoc = lotRows.filter((l) => !l.location || !l.location.trim()).map(({ lot_id, quality, design, balance, last_activity }) => ({ lot_id, quality, design, balance, last_activity }));

  // ---- mill loss ----
  let greyAll = 0, finAll = 0, nAll = 0;
  for (const m of mills.rows) { greyAll += Number(m.grey); finAll += Number(m.fin); nAll += Number(m.n); }
  const overallPct = greyAll > 0 ? r1(((greyAll - finAll) / greyAll) * 100) : null;
  const millRows: MillLoss[] = mills.rows
    .map((m) => {
      const grey = Number(m.grey), fin = Number(m.fin), receipts = Number(m.n);
      const lossPct = grey > 0 ? r1(((grey - fin) / grey) * 100) : 0;
      const gap = overallPct == null ? 0 : r1(lossPct - overallPct);
      return { mill: String(m.mill), receipts, grey: r2(grey), finished: r2(fin), lossPct, gap, flagged: receipts >= MILL_MIN_RECEIPTS && gap > MILL_LOSS_GAP };
    })
    .sort((a, b) => b.lossPct - a.lossPct || b.receipts - a.receipts);

  const sum = (xs: number[]) => r2(xs.reduce((s, x) => s + x, 0));
  return {
    asOf: String(asOfR.rows[0].d),
    thresholds: { lowStockM, ageingDays, millLossGap: MILL_LOSS_GAP, millMinReceipts: MILL_MIN_RECEIPTS },
    totals: {
      balance: sum(qualities.map((x) => x.balance)), reserved: sum(qualities.map((x) => x.reserved)), free: sum(qualities.map((x) => x.free)),
      qualities: qualities.filter((x) => x.balance > 0).length, low: qualities.filter((x) => x.status === 'low').length, short: qualities.filter((x) => x.status === 'short').length,
    },
    qualities,
    ageing: { count: ageingLots.length, meters: sum(ageingLots.map((l) => l.balance)), oldestDays: ageingLots[0]?.days ?? null, lots: ageingLots },
    noLocation: { count: noLoc.length, meters: sum(noLoc.map((l) => l.balance)), lots: noLoc },
    millLoss: { days: 90, overallPct, receipts: nAll, mills: millRows },
  };
}
