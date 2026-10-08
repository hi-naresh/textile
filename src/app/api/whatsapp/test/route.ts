import { NextRequest } from 'next/server';
import { requireCap } from '@/lib/apiAuth';
import { respond } from '@/lib/money/http';
import { LedgerError } from '@/lib/ledger-error';
import { sendTest } from '@/lib/whatsapp/flows';

// POST (owner) → send a test message to the owner's own WhatsApp: the summary template, or Meta's hello_world
// while the firm's templates are not approved yet. → { message, template }
export async function POST(req: NextRequest) {
  return respond(async () => {
    const a = await requireCap(req, 'settings.manage');
    const r = await sendTest(a.by);
    if (!r.ok) throw new LedgerError(r.message, r.setup ? 400 : 502); // 502: Meta refused / unreachable
    return r;
  });
}
