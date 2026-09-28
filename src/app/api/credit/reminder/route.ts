import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { requireCap } from '@/lib/apiAuth';
import { buildReminder } from '@/lib/money/reminder';
import { idValue } from '@/lib/money/validate';
import { respond } from '@/lib/money/http';

// GET ?party_id=&lang=en|hi|gu&polish=1 (owner) → { text, whatsapp_url, lang, polished, outstanding, overdue, invoices }
// Deterministic template; polish=1 asks the low AI tier to smooth the wording (only when a key is set; amounts are checked).
export async function GET(req: NextRequest) {
  return respond(async () => {
    const sp = req.nextUrl.searchParams;
    await requireCap(req, 'finance.view');
    return buildReminder(query, idValue(sp.get('party_id'), 'party'), sp.get('lang'), { polish: sp.get('polish') === '1' });
  });
}
