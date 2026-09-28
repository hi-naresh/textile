// Inquiry Handling agent. Reading + drafting happens on demand in /api/inquiries
// (src/lib/sales/inquiries.ts); the scan only reminds about inquiries nobody has answered.
import type { Q } from '../db';
import type { AgentModule } from './types';
import { resolveMissing, suggest } from './suggest';
import { meters } from '../sales/util';

const WAIT_HOURS = 24;

export async function scanInquiries(q: Q): Promise<string[]> {
  const r = await q(
    `SELECT i.id, COALESCE(p.name, i.party_name) AS party, i.quality, i.meters,
            FLOOR(EXTRACT(EPOCH FROM (NOW() - i.created_at)) / 3600) AS hours
     FROM inquiries i LEFT JOIN parties p ON p.id = i.party_id
     WHERE i.status = 'new' AND i.created_at < NOW() - ($1::int * interval '1 hour')
     ORDER BY i.created_at LIMIT 200`,
    [WAIT_HOURS],
  );
  const keys: string[] = [];
  for (const x of r.rows) {
    const hours = Number(x.hours);
    const age = hours >= 48 ? `${Math.floor(hours / 24)} days` : `${hours} hours`;
    const what = [x.meters != null ? `${meters(Number(x.meters))} m` : null, x.quality].filter(Boolean).join(' ');
    const key = `inquiry_waiting:${x.id}`;
    await suggest(q, {
      agent: 'inquiry',
      kind: 'inquiry_waiting',
      severity: 'info',
      title: `Inquiry${x.party ? ` from ${x.party}` : ` #${x.id}`} waiting for a reply (${age})`,
      detail: what ? `Asked for ${what}. Mark it Quoted, Won or Lost once answered.` : 'Mark it Quoted, Won or Lost once answered.',
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
