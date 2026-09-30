// Costing & margin (owner only). Deterministic:
//  lot cost ₹/m = purchase (weighted avg Pu.Rate of IN movements, by grey m)
//               + grey→finished shortage at receipt (purchase × lost m ÷ finished m).
//  Process costs are turned off for now (owner's request), so job cards add nothing to cost.
//  margin per OUT movement = (selling rate − lot cost) × meters; selling rate = invoice line → order rate.
//  There is no rate list: every party gets its own rate.
// Everything is loaded in a few set-based queries (no per-row lookups).
import type { Q } from '../db';
import { round2, seq } from './validate';

export interface LotCost {
  lot_id: string; quality: string | null;
  purchase: number | null; // ₹/m
  process: { section: string; cost_per_m: number | null; meters: number }[]; // always empty while process costs are off
  process_total: number; shortage: number; total: number;
  complete: boolean; missing: string[]; // e.g. ['purchase rate']
}

/** Cost ₹/m for the given lots (or every lot). */
export async function lotCosts(q: Q, lotIds?: string[]): Promise<Map<string, LotCost>> {
  const only = lotIds ? [...new Set(lotIds)] : null;
  if (only && !only.length) return new Map();
  const [lots, buy] = await seq([
    () => q(`SELECT lot_id, quality FROM lots WHERE ($1::text[] IS NULL OR lot_id = ANY($1::text[]))`, [only]),
    () => q(`SELECT lot_id, SUM(purchase_rate * COALESCE(grey_meters, meters)) / NULLIF(SUM(COALESCE(grey_meters, meters)), 0) AS rate,
              SUM(COALESCE(grey_meters, meters)) AS grey, SUM(meters) AS fin
       FROM stock_movements WHERE direction = 'IN' AND purchase_rate IS NOT NULL AND ($1::text[] IS NULL OR lot_id = ANY($1::text[]))
       GROUP BY lot_id`, [only])]);
  const buyBy = new Map<string, number>(buy.rows.map((r) => [String(r.lot_id), Number(r.rate)]));
  // Grey → finished loss at receipt: the purchase is paid on grey meters but only finished meters can be sold.
  const recvLoss = new Map<string, number>(buy.rows.map((r) => {
    const grey = Number(r.grey), fin = Number(r.fin);
    return [String(r.lot_id), fin > 0 && grey > fin ? (Number(r.rate) * (grey - fin)) / fin : 0];
  }));
  const out = new Map<string, LotCost>();
  for (const l of lots.rows) {
    const id = String(l.lot_id);
    const purchase = buyBy.has(id) ? round2(buyBy.get(id)!) : null;
    const missing = purchase == null ? ['purchase rate'] : [];
    const shortage = round2(recvLoss.get(id) ?? 0);
    out.set(id, {
      lot_id: id, quality: l.quality ?? null, purchase, process: [], process_total: 0, shortage,
      total: round2((purchase ?? 0) + shortage), complete: missing.length === 0, missing,
    });
  }
  return out;
}

export async function lotCost(q: Q, lotId: string): Promise<LotCost | null> {
  return (await lotCosts(q, [lotId])).get(lotId) ?? null;
}

// ---------- margin ----------
export type MarginBy = 'order' | 'party' | 'quality' | 'lot';
export const MARGIN_BY: MarginBy[] = ['order', 'party', 'quality', 'lot'];

export interface MarginRow {
  key: string; label: string; party_id: number | null;
  meters: number; revenue: number; cost: number; margin: number; margin_pct: number | null;
  complete: boolean; missing: string[]; unpriced_m: number; // meters with no selling rate (left out of ₹)
}

export interface MarginMove {
  id: number; lot_id: string; quality: string; meters: number; date: string; party_id: number | null; party: string;
  order_id: number | null; rate: number | null; rate_source: 'invoice' | 'order' | null; cost: LotCost | null;
}

/** OUT movements in the last `days` days, each with its selling rate and lot cost. */
export async function marginMoves(q: Q, days: number): Promise<MarginMove[]> {
  const mv = await q(
    `SELECT m.id, m.lot_id, m.meters, m.party, to_char(m.ts, 'YYYY-MM-DD') AS d, m.order_id, m.dispatch_id, l.quality,
            o.rate_per_m AS order_rate, COALESCE(o.party_id, dsp.party_id, pn.id) AS party_id, COALESCE(pp.name, m.party) AS party_name
     FROM stock_movements m
     JOIN lots l ON l.lot_id = m.lot_id
     LEFT JOIN orders o ON o.id = m.order_id
     LEFT JOIN dispatches dsp ON dsp.id = m.dispatch_id
     LEFT JOIN parties pn ON m.party IS NOT NULL AND pn.name_key = regexp_replace(lower(m.party), '[^a-z0-9]', '', 'g')
     LEFT JOIN parties pp ON pp.id = COALESCE(o.party_id, dsp.party_id, pn.id)
     WHERE m.direction = 'OUT' AND m.ts >= CURRENT_DATE - ($1::int - 1)
     ORDER BY m.ts, m.id`,
    [days],
  );
  if (!mv.rows.length) return [];
  const dispatchIds = [...new Set(mv.rows.filter((r) => r.dispatch_id != null).map((r) => Number(r.dispatch_id)))];
  const [inv, costs] = await seq([
    () => dispatchIds.length ? q(`SELECT dispatch_id, lines FROM invoices WHERE status <> 'cancelled' AND dispatch_id = ANY($1::int[])`, [dispatchIds]) : Promise.resolve({ rows: [] as Record<string, unknown>[] }),
    () => lotCosts(q, mv.rows.map((r) => String(r.lot_id)))]);
  const lineRate = new Map<string, number>();
  for (const r of inv.rows) {
    const lines = Array.isArray(r.lines) ? (r.lines as { lot_id?: string; rate?: number }[]) : [];
    for (const ln of lines) if (ln?.lot_id && Number(ln.rate) > 0) lineRate.set(`${r.dispatch_id}|${ln.lot_id}`, Number(ln.rate));
  }
  return mv.rows.map((r) => {
    const partyId = r.party_id == null ? null : Number(r.party_id);
    let rate: number | null = null;
    let src: MarginMove['rate_source'] = null;
    const inv1 = r.dispatch_id != null ? lineRate.get(`${r.dispatch_id}|${r.lot_id}`) : undefined;
    if (inv1 != null) { rate = inv1; src = 'invoice'; }
    else if (r.order_rate != null && Number(r.order_rate) > 0) { rate = Number(r.order_rate); src = 'order'; }
    return {
      id: Number(r.id), lot_id: String(r.lot_id), quality: String(r.quality), meters: Number(r.meters), date: r.d,
      party_id: partyId, party: r.party_name ? String(r.party_name) : '—', order_id: r.order_id == null ? null : Number(r.order_id),
      rate, rate_source: src, cost: costs.get(String(r.lot_id)) ?? null,
    };
  });
}

function keyOf(m: MarginMove, by: MarginBy): { key: string; label: string; party_id: number | null } {
  if (by === 'order') return m.order_id ? { key: `order:${m.order_id}`, label: `#${m.order_id} · ${m.party}`, party_id: m.party_id } : { key: 'order:none', label: 'No order', party_id: null };
  if (by === 'party') return { key: m.party_id ? `party:${m.party_id}` : `name:${m.party.toLowerCase()}`, label: m.party, party_id: m.party_id };
  if (by === 'quality') return { key: `quality:${m.quality.toLowerCase()}`, label: m.quality, party_id: null };
  return { key: `lot:${m.lot_id}`, label: `${m.lot_id} · ${m.quality}`, party_id: null };
}

export function groupMargin(moves: MarginMove[], by: MarginBy, opts: { completeOnly?: boolean } = {}): { rows: MarginRow[]; totals: Omit<MarginRow, 'key' | 'label' | 'party_id'> } {
  const acc = new Map<string, MarginRow>();
  const tot: MarginRow = { key: 'total', label: 'Total', party_id: null, meters: 0, revenue: 0, cost: 0, margin: 0, margin_pct: null, complete: true, missing: [], unpriced_m: 0 };
  for (const m of moves) {
    const miss = [...(m.cost?.missing ?? ['lot cost']), ...(m.rate == null ? ['selling rate'] : [])];
    if (opts.completeOnly && miss.length) continue;
    const k = keyOf(m, by);
    const row = acc.get(k.key) ?? { ...k, meters: 0, revenue: 0, cost: 0, margin: 0, margin_pct: null, complete: true, missing: [], unpriced_m: 0 };
    for (const r of [row, tot]) {
      r.meters += m.meters;
      if (m.rate == null) r.unpriced_m += m.meters;
      else { r.revenue += m.rate * m.meters; r.cost += (m.cost?.total ?? 0) * m.meters; }
      if (miss.length) { r.complete = false; for (const x of miss) if (!r.missing.includes(x)) r.missing.push(x); }
    }
    acc.set(k.key, row);
  }
  const fin = (r: MarginRow): MarginRow => {
    const revenue = round2(r.revenue), cost = round2(r.cost), margin = round2(revenue - cost);
    return { ...r, meters: round2(r.meters), unpriced_m: round2(r.unpriced_m), revenue, cost, margin, margin_pct: revenue > 0 ? Math.round((margin / revenue) * 1000) / 10 : null };
  };
  const rows = [...acc.values()].map(fin).sort((a, b) => b.revenue - a.revenue || b.meters - a.meters);
  const t = fin(tot);
  return { rows, totals: { meters: t.meters, revenue: t.revenue, cost: t.cost, margin: t.margin, margin_pct: t.margin_pct, complete: t.complete, missing: t.missing, unpriced_m: t.unpriced_m } };
}

export async function marginReport(q: Q, by: MarginBy, days: number, opts: { completeOnly?: boolean } = {}) {
  return groupMargin(await marginMoves(q, days), by, opts);
}
