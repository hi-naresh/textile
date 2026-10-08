import { NextRequest, NextResponse } from 'next/server';
import { readObject, requireCap, requireUser } from '@/lib/apiAuth';
import { withTransaction } from '@/lib/db';
import { LIMITS } from '@/lib/config';
import { errorResponseBody, LedgerError } from '@/lib/ledger';
import { cleanName, getFirmConfig, invalidateSettings, pct } from '@/lib/settings';

// GET (any signed-in user): the firm's configuration (names, sections, supervisors, rules, markets + shops)
export async function GET(request: NextRequest) {
  try {
    await requireUser(request);
    return NextResponse.json({ config: await getFirmConfig(true) });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}

// PUT (owner): update firm profile and rules. Send only the fields you change.
// { firm_name?, firm_city?, shortage_limit_pct?, efficiency_target_pct?, ai_auto_confirm_pct?, manual_challan_min?, manual_job_card_min? }
// Markets and shops have their own routes (/api/markets, /api/markets/shops); fixed places (location_presets) are gone.
export async function PUT(request: NextRequest) {
  try {
    await requireCap(request, 'settings.manage');
    const b = await readObject(request);
    const sets: string[] = [];
    const vals: unknown[] = [];
    const add = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };

    if ('firm_name' in b) add('firm_name', cleanName(b.firm_name, 'Firm name'));
    if ('firm_city' in b) add('firm_city', typeof b.firm_city === 'string' ? b.firm_city.trim().slice(0, 100) : '');
    if ('shortage_limit_pct' in b) add('shortage_limit_pct', pct(b.shortage_limit_pct, 'Shortage limit %', LIMITS.shortageLimitPct));
    if ('efficiency_target_pct' in b) add('efficiency_target_pct', pct(b.efficiency_target_pct, 'Efficiency target %', LIMITS.efficiencyTargetPct));
    if ('ai_auto_confirm_pct' in b) add('ai_auto_confirm_pct', pct(b.ai_auto_confirm_pct, 'AI auto-confirm %', LIMITS.aiAutoConfirmPct));
    if ('manual_challan_min' in b) add('manual_challan_min', pct(b.manual_challan_min, 'Minutes per challan', LIMITS.manualMinutes));
    if ('manual_job_card_min' in b) add('manual_job_card_min', pct(b.manual_job_card_min, 'Minutes per job card', LIMITS.manualMinutes));
    if (!sets.length) throw new LedgerError('Nothing to update.');

    await withTransaction((q) => q(`UPDATE app_settings SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = 1`, vals));
    invalidateSettings();
    return NextResponse.json({ success: true, config: await getFirmConfig(true) });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
