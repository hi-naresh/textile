import { NextRequest, NextResponse } from 'next/server';
import { readObject, requireCap, requireRole } from '@/lib/apiAuth';
import { query, withTransaction } from '@/lib/db';
import { errorResponseBody } from '@/lib/ledger';
import { addMarket, invalidateMarketSearch, loadMarkets, updateMarket } from '@/lib/markets';
import { getFirmConfig, invalidateSettings } from '@/lib/settings';

// Markets for lot locations "<CODE> <shop> · Pipe <pipe>" (migration 014). The firm config (GET /api/settings) carries
// the same list; these routes answer with the fresh config so pickers update at once.
// GET   (owner / supervisor) → { markets: [{ id, name, code, active, sort_order, shops: [{ id, shop_no, active, uses }] }] }
export async function GET(request: NextRequest) {
  try {
    await requireRole(request, 'owner', 'supervisor');
    return NextResponse.json({ markets: await loadMarkets((t, p) => query(t, p)) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}

// POST  (owner) { name, code } → add a market. Name and initials (1–6 letters / digits) must not be in use (any case).
export async function POST(request: NextRequest) {
  try {
    const a = await requireCap(request, 'settings.manage');
    const b = await readObject(request);
    const market = await withTransaction((q) => addMarket(q, { name: b.name, code: b.code }, a.by));
    invalidateSettings();
    invalidateMarketSearch();
    return NextResponse.json({ success: true, market, config: await getFirmConfig(true) });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}

// PATCH (owner) { id, name?, code?, active? } → rename, change initials (lots already placed keep their old label),
// switch on / off (an off market is not offered when picking; its lots keep their location).
export async function PATCH(request: NextRequest) {
  try {
    await requireCap(request, 'settings.manage');
    const b = await readObject(request);
    const r = await withTransaction((q) => updateMarket(q, { id: b.id, name: b.name, code: b.code, active: b.active }));
    invalidateSettings();
    invalidateMarketSearch();
    return NextResponse.json({ success: true, market: r.market, old_code: r.oldCode, config: await getFirmConfig(true) });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
