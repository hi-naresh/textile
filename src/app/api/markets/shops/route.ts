import { NextRequest, NextResponse } from 'next/server';
import { readObject, requireCap, requireRole } from '@/lib/apiAuth';
import { withTransaction } from '@/lib/db';
import { errorResponseBody } from '@/lib/ledger';
import { addShop, updateShop } from '@/lib/markets';
import { getFirmConfig, invalidateSettings } from '@/lib/settings';

// Shop numbers of a market (digits + optional letter: 245, 12A).
// POST  (owner / supervisor) { market_id, shop_no } → add (or switch back on) a shop. Already there → no change.
export async function POST(request: NextRequest) {
  try {
    const a = await requireRole(request, 'owner', 'supervisor');
    const b = await readObject(request);
    const r = await withTransaction((q) => addShop(q, b.market_id, b.shop_no, a.by));
    invalidateSettings();
    return NextResponse.json({ success: true, shop: r.shop, created: r.created, config: await getFirmConfig(true) });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}

// PATCH (owner) { id, active } → remove a shop from the list (active = false; lots there keep their location) or bring it back.
export async function PATCH(request: NextRequest) {
  try {
    await requireCap(request, 'settings.manage');
    const b = await readObject(request);
    const shop = await withTransaction((q) => updateShop(q, { id: b.id, active: b.active }));
    invalidateSettings();
    return NextResponse.json({ success: true, shop, config: await getFirmConfig(true) });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
