import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { requireCap } from '@/lib/apiAuth';
import { buildReminder } from '@/lib/money/reminder';
import { idValue } from '@/lib/money/validate';
import { respond } from '@/lib/money/http';
import { waConnected, waNumber } from '@/lib/whatsapp/config';
import { lastForParty } from '@/lib/whatsapp/send';

// GET ?party_id=&lang=en|hi|gu&polish=1 (owner) → { text, whatsapp_url, lang, polished, outstanding, overdue, invoices,
//   wa: { connected, has_number, last: { status, at, error } | null } }
// Deterministic template; polish=1 asks the low AI tier to smooth the wording (only when a key is set; amounts are checked).
export async function GET(req: NextRequest) {
  return respond(async () => {
    const sp = req.nextUrl.searchParams;
    await requireCap(req, 'finance.view');
    const pid = idValue(sp.get('party_id'), 'party');
    const r = await buildReminder(query, pid, sp.get('lang'), { polish: sp.get('polish') === '1' });
    // WhatsApp Cloud API: can it be sent from the app, and what happened to the last one?
    const wa = { connected: waConnected(), has_number: !!waNumber(r.phone ?? ''), last: await lastForParty(query, pid, 'reminder') };
    return { ...r, wa };
  });
}
