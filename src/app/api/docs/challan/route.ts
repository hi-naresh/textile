import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { errorResponseBody } from '@/lib/ledger';
import { actorOf, requireCap } from '@/lib/apiAuth';
import { readBilling } from '@/lib/billing';
import { getDispatch } from '@/lib/dispatch/dispatches';
import { logDoc } from '@/lib/dispatch/common';
import { challanPdf } from '@/lib/pdf/docs';
import { pdfResponse } from '@/lib/pdf/response';

// GET ?dispatch_id=&role=owner|supervisor&actor= → delivery challan PDF (no rates).
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    requireCap(sp.get('role'), 'dispatch.manage');
    const { dispatch, lines } = await getDispatch(query, Number(sp.get('dispatch_id')), false);
    const bytes = await challanPdf(await readBilling(query), dispatch, lines);
    await logDoc(query, 'challan', String(dispatch.id), actorOf(sp.get('actor')));
    return pdfResponse(bytes, `challan-${dispatch.challan_no ?? dispatch.id}`);
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
