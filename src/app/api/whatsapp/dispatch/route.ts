import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { readObject, requireCap } from '@/lib/apiAuth';
import { respond } from '@/lib/money/http';
import { idValue } from '@/lib/money/validate';
import { LedgerError } from '@/lib/ledger-error';
import { queueDispatch } from '@/lib/whatsapp/flows';
import { deliver, lastForDispatch } from '@/lib/whatsapp/send';

// POST { dispatch_id } (owner, supervisor) → "Send again": the dispatch message to the party now (no ₹ in it).
// → { ok, message, last: { status, at, error } }
export async function POST(req: NextRequest) {
  return respond(async () => {
    const a = await requireCap(req, 'dispatch.manage');
    const b = await readObject(req);
    const id = idValue(b.dispatch_id, 'dispatch');
    const q = await queueDispatch(id, { force: true, by: a.by });
    if (!q.job) throw new LedgerError(q.result.message, q.result.skipped === 'not_connected' ? 503 : 400);
    const r = await deliver(q.job); // explicit button: wait for Meta's answer (10 s at most) and show it
    return { ok: r.ok, message: r.ok ? 'WhatsApp sent to the party.' : `WhatsApp not sent: ${r.error ?? 'unknown error'}`, last: await lastForDispatch(query, id) };
  });
}
