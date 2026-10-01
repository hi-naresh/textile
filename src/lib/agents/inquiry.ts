// Inquiry Handling agent. Reading + drafting happens on demand in /api/inquiries
// (src/lib/sales/inquiries.ts); the scan only reminds about inquiries nobody has answered for a day,
// and says how much of the asked quality is free right now (so the reply is one look away).
import type { Q } from '../db';
import type { AgentModule } from './types';
import { resolveMissing, suggest } from './suggest';
import { meters } from '../sales/util';

const WAIT_HOURS = 24;

/** Free meters (balance − kept aside) for a few qualities, lower-cased key. */
async function freeFor(q: Q, qualities: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!qualities.length) return out;
  const r = await q(
    `SELECT lower(l.quality) AS k,
            SUM(GREATEST(0, COALESCE(b.bal, 0) - COALESCE(a.res, 0))) AS free
     FROM lots l
     LEFT JOIN LATERAL (SELECT SUM(CASE WHEN sm.direction = 'IN' THEN sm.meters ELSE -sm.meters END) AS bal FROM stock_movements sm WHERE sm.lot_id = l.lot_id) b ON true
     LEFT JOIN LATERAL (SELECT SUM(al.meters - al.dispatched_m) AS res FROM allocations al WHERE al.lot_id = l.lot_id AND al.status = 'reserved') a ON true
     WHERE lower(l.quality) = ANY($1::text[]) GROUP BY 1`,
    [qualities],
  );
  for (const x of r.rows) out.set(String(x.k), Number(x.free));
  return out;
}

export async function scanInquiries(q: Q): Promise<string[]> {
  const r = await q(
    `SELECT i.id, COALESCE(p.name, i.party_name) AS party, i.quality, i.meters,
            FLOOR(EXTRACT(EPOCH FROM (NOW() - i.created_at)) / 3600) AS hours
     FROM inquiries i LEFT JOIN parties p ON p.id = i.party_id
     WHERE i.status = 'new' AND i.created_at < NOW() - ($1::int * interval '1 hour')
     ORDER BY i.created_at LIMIT 200`,
    [WAIT_HOURS],
  );
  const free = await freeFor(q, [...new Set(r.rows.map((x) => String(x.quality ?? '').toLowerCase()).filter(Boolean))]);
  const keys: string[] = [];
  for (const x of r.rows) {
    const hours = Number(x.hours);
    const age = hours >= 48 ? `${Math.floor(hours / 24)} days` : `${hours} hours`;
    const what = [x.meters != null ? `${meters(Number(x.meters))} m` : null, x.quality].filter(Boolean).join(' ');
    const f = x.quality ? free.get(String(x.quality).toLowerCase()) : undefined;
    const stock = x.quality
      ? f == null || f <= 0 ? `No free ${x.quality} in stock right now.` : `You have ${meters(f)} m of ${x.quality} free${x.meters != null && f < Number(x.meters) ? ` — less than asked` : ''}.`
      : '';
    const key = `inquiry_waiting:${x.id}`;
    await suggest(q, {
      agent: 'inquiry',
      kind: 'inquiry_waiting',
      severity: hours >= 72 ? 'warn' : 'info',
      title: `${x.party ?? `Inquiry #${x.id}`}${what ? ` asked for ${what}` : ' sent an inquiry'} ${age} ago — no reply yet`,
      detail: `${stock} A party that waits usually buys elsewhere.`.trim(),
      hint: 'Open it to see the reply draft. Mark it Quoted, Won or Lost once you answer and this card goes away.',
      payload: { inquiry_id: Number(x.id) },
      target: { type: 'inquiry', id: Number(x.id) },
      dedupeKey: key,
    });
    keys.push(key);
  }
  await resolveMissing(q, 'inquiry', 'inquiry_waiting', keys);
  return keys;
}

export const agent: AgentModule = {
  scan: async (q) => { await scanInquiries(q); },
};
