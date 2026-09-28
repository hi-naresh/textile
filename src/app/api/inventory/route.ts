import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { errorResponseBody } from '@/lib/ledger';
import { requireCap } from '@/lib/apiAuth';
import { inventorySnapshot } from '@/lib/reports/inventory';

// GET /api/inventory
//   → InventorySnapshot: per quality balance / reserved / free / avg daily dispatch (30 d) / days of cover /
//     open-order meters / status (ok | low | short); ageing lots; lots without location; mill loss (90 d).
// Meters only (no ₹), so owner and supervisor get the same answer. Workers: 403.
export async function GET(req: NextRequest) {
  try {
    await requireCap(req, 'reports.view');
    const inv = await inventorySnapshot(query);
    return NextResponse.json(inv, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
