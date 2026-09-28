import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { errorResponseBody } from '@/lib/ledger';
import { requireCap } from '@/lib/apiAuth';
import { readBilling } from '@/lib/billing';
import { getDispatch } from '@/lib/dispatch/dispatches';
import { logDoc } from '@/lib/dispatch/common';
import { packingListPdf } from '@/lib/pdf/docs';
import { pdfResponse } from '@/lib/pdf/response';

// GET ?dispatch_id= (owner / supervisor) → packing list PDF (lots, quality, meters; no rates).
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const a = await requireCap(req, 'dispatch.manage');
    const { dispatch, lines } = await getDispatch(query, Number(sp.get('dispatch_id')), false);
    const bytes = await packingListPdf(await readBilling(query), dispatch, lines);
    await logDoc(query, 'packing_list', String(dispatch.id), a.by);
    return pdfResponse(bytes, `packing-list-${dispatch.challan_no ?? dispatch.id}`);
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
