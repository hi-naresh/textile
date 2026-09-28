import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { errorResponseBody, LedgerError } from '@/lib/ledger';
import { requireCap } from '@/lib/apiAuth';
import { readBilling } from '@/lib/billing';
import { toBuffer } from '@/lib/excel';
import { buildReport, stripForRole } from '@/lib/reports/build';
import { reportFileName, reportWorkbook } from '@/lib/reports/export';
import { REPORT_PERIODS, isIsoDate, type ReportPeriod } from '@/lib/reports/dates';

// GET /api/reports/export?period=day|week|month&date=YYYY-MM-DD&role=owner|supervisor
//   → .xlsx, one sheet per section. Money / AI usage sheets only for the owner. Workers: 403.
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const role = requireCap(sp.get('role'), 'reports.view');
    const period = (sp.get('period') ?? 'day') as ReportPeriod;
    if (!REPORT_PERIODS.includes(period)) throw new LedgerError('period must be day, week or month.');
    const date = sp.get('date');
    if (date && !isIsoDate(date)) throw new LedgerError('date must be YYYY-MM-DD.');
    const report = stripForRole(await buildReport(query, period, role, date), role);
    const billing = await readBilling(query);
    const buf = await toBuffer(reportWorkbook(report, billing.firmName));
    return new NextResponse(new Uint8Array(buf), {
      headers: { 'Content-Type': XLSX, 'Content-Disposition': `attachment; filename="${reportFileName(report)}"`, 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
