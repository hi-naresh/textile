import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { errorResponseBody, LedgerError } from '@/lib/ledger';
import { requireCap } from '@/lib/apiAuth';
import { buildReport, stripForRole } from '@/lib/reports/build';
import { polishNarrative } from '@/lib/reports/narrative';
import { REPORT_PERIODS, isIsoDate, type ReportPeriod } from '@/lib/reports/dates';

// GET /api/reports?period=day|week|month&date=YYYY-MM-DD&role=owner|supervisor[&polish=0]
//   → Report (see src/lib/reports/build.ts). date defaults to today; week = Mon–Sun holding the date,
//     month = calendar month (both capped at today). Money + AI usage are owner only; workers get 403.
//   The narrative is rule-based; with GEMINI_API_KEY it is reworded on the low tier (polish=0 turns that off).
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const role = requireCap(sp.get('role'), 'reports.view');
    const period = (sp.get('period') ?? 'day') as ReportPeriod;
    if (!REPORT_PERIODS.includes(period)) throw new LedgerError('period must be day, week or month.');
    const date = sp.get('date');
    if (date && !isIsoDate(date)) throw new LedgerError('date must be YYYY-MM-DD.');
    let report = stripForRole(await buildReport(query, period, role, date), role);
    if (sp.get('polish') !== '0') report = await polishNarrative(report);
    return NextResponse.json(report, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
