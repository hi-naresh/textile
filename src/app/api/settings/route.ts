import { NextRequest, NextResponse } from 'next/server';
import { withTransaction } from '@/lib/db';
import { LIMITS } from '@/lib/config';
import { errorResponseBody, LedgerError } from '@/lib/ledger';
import { cleanName, getFirmConfig, invalidateSettings, pct } from '@/lib/settings';

// GET: the firm's configuration (names, sections, supervisors, rules, location presets)
export async function GET() {
  try {
    return NextResponse.json({ config: await getFirmConfig(true) });
  } catch (error) {
    console.error('Failed to load settings:', error);
    return NextResponse.json({ error: 'Could not load settings.' }, { status: 500 });
  }
}

// PUT: update firm profile, rules and location presets. Send only the fields you change.
// { firm_name?, firm_city?, shortage_limit_pct?, efficiency_target_pct?, ai_auto_confirm_pct?, location_presets? }
export async function PUT(request: NextRequest) {
  try {
    const b = await request.json();
    const sets: string[] = [];
    const vals: unknown[] = [];
    const add = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };

    if ('firm_name' in b) add('firm_name', cleanName(b.firm_name, 'Firm name'));
    if ('firm_city' in b) add('firm_city', typeof b.firm_city === 'string' ? b.firm_city.trim().slice(0, 100) : '');
    if ('shortage_limit_pct' in b) add('shortage_limit_pct', pct(b.shortage_limit_pct, 'Shortage limit %', LIMITS.shortageLimitPct));
    if ('efficiency_target_pct' in b) add('efficiency_target_pct', pct(b.efficiency_target_pct, 'Efficiency target %', LIMITS.efficiencyTargetPct));
    if ('ai_auto_confirm_pct' in b) add('ai_auto_confirm_pct', pct(b.ai_auto_confirm_pct, 'AI auto-confirm %', LIMITS.aiAutoConfirmPct));
    if ('location_presets' in b) {
      if (!Array.isArray(b.location_presets)) throw new LedgerError('location_presets must be a list.');
      const list: string[] = [];
      for (const raw of b.location_presets) {
        const name = cleanName(raw, 'Location', 60);
        if (!list.some((x) => x.toLowerCase() === name.toLowerCase())) list.push(name);
      }
      if (!list.length) throw new LedgerError('Keep at least one location.');
      if (list.length > LIMITS.locationPresetsMax) throw new LedgerError(`Up to ${LIMITS.locationPresetsMax} locations.`);
      add('location_presets', list);
    }
    if (!sets.length) throw new LedgerError('Nothing to update.');

    await withTransaction((q) => q(`UPDATE app_settings SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = 1`, vals));
    invalidateSettings();
    return NextResponse.json({ success: true, config: await getFirmConfig(true) });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
