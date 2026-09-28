// Fabric Inventory agent (docs/AGENTS_PHASE2.md §3). Deterministic: keeps the stock picture honest.
//   low_stock        (warn) free < low-stock level for a quality that sold in 60 days or has open orders
//   short_for_orders (bad)  open orders need more meters than are free
//   ageing_stock     (info) one summary of lots with no activity for longer than the ageing days
//   no_location      (info) one summary of lots with stock but no location
//   mill_loss        (warn) a mill's grey→finished loss is > overall + 5 points over ≥ 3 receipts (90 days)
// Information only (no one-tap action). Alerts resolve themselves when the problem goes away.
import type { Q } from '../db';
import type { AgentModule, SuggestionInput } from './types';
import { resolveMissing, suggest } from './suggest';
import { inventorySnapshot, type InventorySnapshot } from '../reports/inventory';
import { recentlyDecided } from '../reports/dismissed';
import { nameKey } from '../normalize';

const fm = (v: number) => Math.round(v).toLocaleString('en-IN');
const plural = (c: number, one: string, many = `${one}s`) => `${c} ${c === 1 ? one : many}`;

/** Days a dismissed alert stays quiet before a scan may raise it again. */
const QUIET_DAYS: Record<string, number> = { low_stock: 1, short_for_orders: 1, ageing_stock: 7, no_location: 7, mill_loss: 14 };
export const INVENTORY_KINDS = Object.keys(QUIET_DAYS);

export function inventorySuggestions(inv: InventorySnapshot): SuggestionInput[] {
  const out: SuggestionInput[] = [];
  const base = { agent: 'inventory' as const, actionLabel: null, ownerOnly: false };

  for (const x of inv.qualities) {
    const cover = x.avgDaily > 0 ? `, sells ~${fm(x.avgDaily)} m a day` : '';
    if (x.status === 'short') {
      out.push({
        ...base, kind: 'short_for_orders', severity: 'bad',
        title: `${x.quality}: open orders need ${fm(x.unreservedM)} m more, only ${fm(Math.max(0, x.free))} m free`,
        detail: `${plural(x.openOrders, 'open order')} still to dispatch ${fm(x.openOrderM)} m, of which ${fm(x.unreservedM)} m is not reserved yet. Free stock ${fm(Math.max(0, x.free))} m (balance ${fm(x.balance)} m, reserved ${fm(x.reserved)} m). Short by ${fm(x.unreservedM - Math.max(0, x.free))} m.`,
        payload: { quality: x.quality, free: x.free, openOrderM: x.openOrderM, unreservedM: x.unreservedM, openOrders: x.openOrders, shortBy: Math.round((x.unreservedM - Math.max(0, x.free)) * 100) / 100 },
        target: { type: 'quality', id: x.quality }, dedupeKey: `short_for_orders:${x.key}`,
      });
    }
    // Low stock is raised on its own even when the quality is also short for orders — the two need different fixes.
    if ((x.soldRecently || x.openOrders > 0) && x.free < inv.thresholds.lowStockM) {
      out.push({
        ...base, kind: 'low_stock', severity: 'warn',
        title: `${x.quality} is low: ${fm(Math.max(0, x.free))} m free${cover}`,
        detail: `${x.daysCover != null ? `About ${x.daysCover} days of stock left. ` : ''}Low-stock level is ${fm(inv.thresholds.lowStockM)} m.${x.lastDispatch ? ` Last dispatched ${x.lastDispatch}.` : ''}`,
        payload: { quality: x.quality, free: x.free, balance: x.balance, reserved: x.reserved, avgDaily: x.avgDaily, daysCover: x.daysCover, lowStockM: inv.thresholds.lowStockM },
        target: { type: 'quality', id: x.quality }, dedupeKey: `low_stock:${x.key}`,
      });
    }
  }

  if (inv.ageing.count > 0) {
    const oldest = inv.ageing.lots[0];
    out.push({
      ...base, kind: 'ageing_stock', severity: 'info',
      title: `${plural(inv.ageing.count, 'lot')} not moved in over ${inv.thresholds.ageingDays} days: ${fm(inv.ageing.meters)} m`,
      detail: `Oldest: ${oldest.lot_id} (${oldest.quality}, ${fm(oldest.balance)} m, ${oldest.days} days). ${inv.ageing.lots.slice(1, 6).map((l) => `${l.lot_id} ${l.days}d`).join(', ')}`.trim(),
      payload: { count: inv.ageing.count, meters: inv.ageing.meters, oldestDays: inv.ageing.oldestDays, lots: inv.ageing.lots.slice(0, 20).map((l) => ({ lot_id: l.lot_id, quality: l.quality, balance: l.balance, days: l.days })) },
      target: { type: 'lot', id: oldest.lot_id }, dedupeKey: 'ageing_stock',
    });
  }

  if (inv.noLocation.count > 0) {
    out.push({
      ...base, kind: 'no_location', severity: 'info',
      title: `${plural(inv.noLocation.count, 'lot')} with stock but no location (${fm(inv.noLocation.meters)} m)`,
      detail: `Set a location so they can be found: ${inv.noLocation.lots.slice(0, 8).map((l) => l.lot_id).join(', ')}${inv.noLocation.count > 8 ? ' …' : ''}`,
      payload: { count: inv.noLocation.count, meters: inv.noLocation.meters, lots: inv.noLocation.lots.slice(0, 30).map((l) => l.lot_id) },
      target: { type: 'lot', id: inv.noLocation.lots[0].lot_id }, dedupeKey: 'no_location',
    });
  }

  for (const m of inv.millLoss.mills.filter((x) => x.flagged)) {
    out.push({
      ...base, kind: 'mill_loss', severity: 'warn',
      title: `${m.mill} loses ${m.lossPct}% grey→finished, vs ${inv.millLoss.overallPct}% overall`,
      detail: `${plural(m.receipts, 'receipt')} in the last ${inv.millLoss.days} days: ${fm(m.grey)} m grey became ${fm(m.finished)} m finished.`,
      payload: { mill: m.mill, lossPct: m.lossPct, overallPct: inv.millLoss.overallPct, receipts: m.receipts, grey: m.grey, finished: m.finished },
      target: { type: 'mill', id: m.mill }, dedupeKey: `mill_loss:${nameKey(m.mill)}`,
    });
  }
  return out;
}

export async function scanInventory(q: Q): Promise<SuggestionInput[]> {
  const inv = await inventorySnapshot(q);
  const all = inventorySuggestions(inv);
  const raised: SuggestionInput[] = [];
  for (const kind of INVENTORY_KINDS) {
    const mine = all.filter((s) => s.kind === kind);
    const quiet = await recentlyDecided(q, mine.map((s) => s.dedupeKey), QUIET_DAYS[kind]);
    const keep = mine.filter((s) => !quiet.has(s.dedupeKey));
    for (const s of keep) await suggest(q, s);
    await resolveMissing(q, 'inventory', kind, keep.map((s) => s.dedupeKey));
    raised.push(...keep);
  }
  return raised;
}

export const agent: AgentModule = {
  scan: async (q) => { await scanInventory(q); },
};
