import { NextRequest } from 'next/server';
import { query, withTransaction } from '@/lib/db';
import { requireCap } from '@/lib/apiAuth';
import { readBillingSettings, updateBillingSettings } from '@/lib/money/master';
import { jsonBody, respond } from '@/lib/money/http';

// GET ?role=owner → { billing } — firm GST / bank / invoice numbering + agent thresholds.
export async function GET(req: NextRequest) {
  return respond(async () => {
    requireCap(req.nextUrl.searchParams.get('role'), 'master.manage');
    return { billing: await readBillingSettings(query) };
  });
}

// PUT { legal_name?, gstin?, address?, state_code?, phone?, bank_name?, bank_account?, bank_ifsc?, invoice_prefix?,
//       next_invoice_no? (only up), hsn_code?, gst_rate_pct?, low_stock_m?, ageing_days?, role } → { billing }
export async function PUT(req: NextRequest) {
  return respond(async () => {
    const b = await jsonBody(req);
    requireCap(b.role, 'master.manage');
    return { billing: await withTransaction((q) => updateBillingSettings(q, b)) };
  });
}
