// Logistics & Dispatch agent. Order progress (sent meters, "partly dispatched", "dispatched") is worked out only
// from OUT entries linked to the order (stock_movements.order_id). The hook (logistics-hook.ts) links each OUT
// entry as it is saved only when the lot was kept aside for one of the party's orders; this scan catches recent OUT entries that are
// still unlinked while the party has an open order of that quality placed before the dispatch, and asks:
// "151 m of H-2518 went to Mumbai Retailers without an order — count it against order #17?"
import { LedgerError } from '../ledger-error';
import { nameKey } from '../normalize';
import type { AgentModule } from './types';
import { linkMovement, matchSuggestion, orderCandidates } from './logistics-hook';
import { resolveMissing, suggest } from './suggest';

export const agent: AgentModule = {
  async scan(q) {
    const r = await q(
      `SELECT sm.id, sm.lot_id, sm.party, sm.meters, sm.ts FROM stock_movements sm JOIN lots l ON l.lot_id = sm.lot_id
       WHERE sm.direction = 'OUT' AND sm.order_id IS NULL AND sm.party IS NOT NULL AND sm.ts >= NOW() - interval '30 days'
         AND EXISTS (SELECT 1 FROM orders o JOIN parties p ON p.id = o.party_id
                     WHERE p.name_key = regexp_replace(lower(sm.party), '[^a-z0-9]', '', 'g')
                       AND lower(btrim(o.quality)) = lower(btrim(l.quality)) AND o.status IN ('open', 'partly_dispatched')
                       AND o.created_at <= sm.ts + interval '1 day')
       ORDER BY sm.ts DESC LIMIT 200`,
    );
    const keys: string[] = [];
    for (const x of r.rows) {
      const m = { id: Number(x.id), lot_id: String(x.lot_id), party: String(x.party), meters: Number(x.meters), ts: x.ts instanceof Date ? x.ts.toISOString() : String(x.ts) };
      const { candidates } = await orderCandidates(q, m);
      if (!candidates.length) continue;
      const s = matchSuggestion(m, candidates);
      await suggest(q, s);
      keys.push(s.dedupeKey);
    }
    await resolveMissing(q, 'logistics', 'match_dispatch', keys);
  },

  async accept(s, q, _actor, choice) {
    if (s.kind !== 'match_dispatch') throw new LedgerError('Nothing to do for this one — dismiss it instead.');
    const movementId = Number(s.payload?.movement_id);
    const candidates = Array.isArray(s.payload?.candidates) ? (s.payload.candidates as unknown[]).map(Number) : [];
    const orderId = choice != null ? Number(choice) : Number(s.payload?.order_id);
    if (!Number.isInteger(movementId) || !Number.isInteger(orderId)) throw new LedgerError('This card is missing its dispatch or order.');
    if (choice != null && !candidates.includes(orderId)) throw new LedgerError(`Order #${orderId} wasn't one of the choices on this card.`);
    const mv = await q(`SELECT id, party, meters, order_id, direction FROM stock_movements WHERE id = $1 FOR UPDATE`, [movementId]);
    const m = mv.rows[0];
    if (!m || m.direction !== 'OUT') throw new LedgerError('That dispatch no longer exists.', 404);
    if (m.order_id) throw new LedgerError(`That dispatch is already counted against order #${m.order_id}.`);
    const o = await q(`SELECT o.status, p.name_key FROM orders o JOIN parties p ON p.id = o.party_id WHERE o.id = $1`, [orderId]);
    if (!o.rows[0]) throw new LedgerError(`Order #${orderId} no longer exists.`, 404);
    if (o.rows[0].status === 'cancelled') throw new LedgerError(`Order #${orderId} is cancelled.`);
    if (o.rows[0].name_key !== nameKey(String(m.party ?? ''))) throw new LedgerError(`Order #${orderId} is for another party.`);
    await linkMovement(q, movementId, orderId);
    const after = await q(
      `SELECT o.meters, o.status, COALESCE((SELECT SUM(meters) FROM stock_movements WHERE direction = 'OUT' AND order_id = o.id), 0) AS sent FROM orders o WHERE o.id = $1`,
      [orderId],
    );
    const a = after.rows[0];
    const fm = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 1 });
    const left = Math.max(0, Number(a.meters) - Number(a.sent));
    return `Counted ${fm(Number(m.meters))} m against order #${orderId} — ${a.status === 'dispatched' ? 'order fully sent' : `${fm(left)} m still to send`}`;
  },
};
