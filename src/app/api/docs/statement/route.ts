import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { errorResponseBody } from '@/lib/ledger';
import { requireCap } from '@/lib/apiAuth';
import { readBilling } from '@/lib/billing';
import { logDoc } from '@/lib/dispatch/common';
import { partyStatement } from '@/lib/dispatch/statement';
import { statementPdf } from '@/lib/pdf/docs';
import { pdfResponse } from '@/lib/pdf/response';

// GET ?party_id=&from=YYYY-MM-DD&to=YYYY-MM-DD (owner) → party statement PDF
// (default period: start of the financial year → today). Add &format=json for the data.
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const a = await requireCap(req, 'finance.view');
    const s = await partyStatement(query, Number(sp.get('party_id')), sp.get('from'), sp.get('to'));
    if (sp.get('format') === 'json') return NextResponse.json({ statement: s }, { headers: { 'Cache-Control': 'no-store' } });
    const bytes = await statementPdf(await readBilling(query), s);
    await logDoc(query, 'statement', `${s.party.id} ${s.from}..${s.to}`, a.by);
    return pdfResponse(bytes, `statement-${s.party.name}-${s.from}-to-${s.to}`);
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
