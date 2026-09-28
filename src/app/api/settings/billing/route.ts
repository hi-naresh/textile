import { NextRequest } from 'next/server';
import { query, withTransaction } from '@/lib/db';
import { requireCap } from '@/lib/apiAuth';
import { readBillingSettings, updateBillingSettings } from '@/lib/money/master';
import { jsonBody, respond } from '@/lib/money/http';

// GET (owner) → { billing } — firm GST / bank / invoice numbering + agent thresholds.
export async function GET(req: NextRequest) {
  return respond(async () => {
    await requireCap(req, 'master.manage');
    return { billing: await readBillingSettings(query) };
  });
}

// PUT { legal_name?, gstin?, address?, state_code?, phone?, bank_name?, bank_account?, bank_ifsc?, invoice_prefix?,
//       next_invoice_no? (only up), hsn_code?, gst_rate_pct?, low_stock_m?, ageing_days? } → { billing }
export async function PUT(req: NextRequest) {
  return respond(async () => {
    await requireCap(req, 'master.manage');
    const b = await jsonBody(req);
    return { billing: await withTransaction((q) => updateBillingSettings(q, b)) };
  });
}
