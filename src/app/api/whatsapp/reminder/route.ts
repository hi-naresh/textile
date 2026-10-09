import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { readObject, requireCap } from '@/lib/apiAuth';
import { respond } from '@/lib/money/http';
import { idValue } from '@/lib/money/validate';
import { LedgerError } from '@/lib/ledger-error';
import { sendReminder } from '@/lib/whatsapp/flows';
import { lastForParty } from '@/lib/whatsapp/send';

// POST { party_id, force?: boolean } (owner only — reminders carry ₹) → send the payment reminder template.
// Without force, at most one reminder per party per 7 days: { ok: false, needs_force: true, last_at } so the screen can ask "Send again?".
// → { message, last: { status, at, error } }
export async function POST(req: NextRequest) {
  return respond(async () => {
    const a = await requireCap(req, 'finance.view');
    if (a.role !== 'owner') throw new LedgerError('Only the owner sends payment reminders.', 403);
    const b = await readObject(req);
    const partyId = idValue(b.party_id, 'party');
    const r = await sendReminder(partyId, { force: b.force === true, by: a.by });
    if (r.skipped === 'duplicate' && r.lastAt) return { ok: false, needs_force: true, message: r.message, last_at: r.lastAt, last: await lastForParty(query, partyId, 'reminder') };
    if (!r.ok && !r.id) throw new LedgerError(r.message, r.skipped === 'not_connected' ? 503 : 400);
    return { ok: r.ok, message: r.message, last: await lastForParty(query, partyId, 'reminder') };
  });
}
