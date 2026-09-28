// Excel export of a report: one sheet per section. ₹ / AI sheets only exist when the report has them
// (i.e. it was built for the owner).
import type ExcelJS from 'exceljs';
import { newWorkbook } from '../excel';
import type { Report } from './build';

const HEAD_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE9E4D8' } };
const M = '#,##0.00';
const INR = '"₹"#,##0';

type Col = { header: string; key: string; width?: number; numFmt?: string };

function sheet(wb: ExcelJS.Workbook, name: string, cols: Col[], rows: Record<string, unknown>[], note?: string) {
  const ws = wb.addWorksheet(name);
  ws.columns = cols.map((c) => ({ header: c.header, key: c.key, width: c.width ?? Math.max(12, c.header.length + 4), style: c.numFmt ? { numFmt: c.numFmt } : undefined }));
  rows.forEach((r) => ws.addRow(r));
  if (!rows.length) ws.addRow({ [cols[0].key]: note ?? 'No data for this period' });
  const head = ws.getRow(1);
  head.font = { bold: true };
  head.fill = HEAD_FILL;
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  return ws;
}

export function reportWorkbook(r: Report, firmName: string): ExcelJS.Workbook {
  const wb = newWorkbook(firmName);
  const pct = (v: number | null) => (v == null ? '' : v);

  const sum = sheet(wb, 'Summary', [{ header: 'Item', key: 'k', width: 26 }, { header: 'Value', key: 'v', width: 60 }], [
    { k: 'Firm', v: firmName },
    { k: 'Report', v: `${r.period === 'day' ? 'Daily' : r.period === 'week' ? 'Weekly' : 'Monthly'} — ${r.label}` },
    { k: 'Dates', v: `${r.from} to ${r.to}${r.partial ? ' (so far)' : ''}` },
    { k: 'Compared with', v: `${r.prevFrom} to ${r.prevTo}` },
    ...r.narrative.map((line, i) => ({ k: i === 0 ? 'Summary' : '', v: line })),
  ]);
  sum.getColumn('v').alignment = { wrapText: true, vertical: 'top' };

  sheet(wb, 'Key numbers', [
    { header: 'Measure', key: 'label', width: 18 }, { header: 'Unit', key: 'unit', width: 8 },
    { header: 'This period', key: 'value', width: 14, numFmt: '#,##0.####' }, { header: 'Previous', key: 'prev', width: 14, numFmt: '#,##0.####' },
    { header: 'Change %', key: 'chg', width: 11 },
  ], r.kpis.map((x) => ({ label: x.label, unit: x.unit === 'inr' ? '₹' : x.unit === 'usd' ? 'USD' : x.unit, value: x.value, prev: x.prev, chg: x.changePct ?? '' })));

  sheet(wb, 'Stock', [{ header: 'Item', key: 'k', width: 22 }, { header: 'Meters', key: 'm', width: 14, numFmt: M }, { header: 'Challans', key: 'c', width: 10 }], [
    { k: 'Opening stock', m: r.stock.opening }, { k: 'Received (in)', m: r.stock.in, c: r.stock.inChallans },
    { k: 'Dispatched (out)', m: r.stock.out, c: r.stock.outChallans }, { k: 'Closing stock', m: r.stock.closing },
  ]);

  const disp = [
    ...r.dispatch.byParty.map((x) => ({ by: 'Party', name: x.name, m: x.meters, c: x.count })),
    ...r.dispatch.byQuality.map((x) => ({ by: 'Quality', name: x.name, m: x.meters, c: x.count })),
  ];
  sheet(wb, 'Dispatch', [{ header: 'By', key: 'by', width: 9 }, { header: 'Name', key: 'name', width: 28 }, { header: 'Meters', key: 'm', numFmt: M }, { header: 'Challans', key: 'c' }], disp);

  sheet(wb, 'Receipts', [{ header: 'Mill', key: 'name', width: 28 }, { header: 'Meters', key: 'm', numFmt: M }, { header: 'Challans', key: 'c' }, { header: 'Grey→finished loss %', key: 'l', width: 20 }],
    r.receipts.byMill.map((x) => ({ name: x.name, m: x.meters, c: x.count, l: pct(x.lossPct) })));

  const prod = [
    ...r.production.bySection.map((x) => ({ by: 'Section', name: x.name, m: x.meters, c: x.count, s: pct(x.shortagePct) })),
    ...r.production.byWorker.map((x) => ({ by: 'Worker', name: `${x.name}${x.section ? ` (${x.section})` : ''}`, m: x.meters, c: x.count, s: '' })),
  ];
  const pws = sheet(wb, 'Production', [{ header: 'By', key: 'by', width: 9 }, { header: 'Name', key: 'name', width: 30 }, { header: 'Meters done', key: 'm', numFmt: M }, { header: 'Job cards', key: 'c' }, { header: 'Shortage %', key: 's' }], prod);
  if (r.production.flagged.length) {
    pws.addRow({});
    pws.addRow({ by: `Cards over the ${r.production.limitPct}% shortage limit` }).font = { bold: true };
    r.production.flagged.forEach((f) => pws.addRow({ by: `JC-${f.id}`, name: `${f.lot_id} · ${f.process} · ${f.worker}`, m: f.meters_in, s: f.shortagePct }));
  }

  sheet(wb, 'Efficiency', [{ header: 'Section', key: 'name', width: 20 }, { header: 'Efficiency %', key: 'p', width: 14 }], [
    { name: 'All sections', p: pct(r.efficiency.pct) },
    ...r.efficiency.bySection.map((x) => ({ name: x.name, p: pct(x.pct) })),
    { name: `Workers below ${r.efficiency.targetPct}%`, p: r.efficiency.belowTarget },
  ]);

  sheet(wb, 'Orders & inquiries', [{ header: 'Item', key: 'k', width: 30 }, { header: 'Value', key: 'v', width: 14, numFmt: '#,##0.##' }], [
    { k: 'New orders', v: r.orders.created }, { k: 'Meters ordered', v: r.orders.createdM }, { k: 'Meters dispatched on orders', v: r.orders.dispatchedM },
    { k: 'Orders completed', v: r.orders.completed }, { k: 'Open orders now', v: r.orders.open }, { k: 'Meters still to send', v: r.orders.openM },
    { k: 'Orders past promise date', v: r.orders.overdue }, { k: 'Meters overdue', v: r.orders.overdueM },
    { k: 'New inquiries', v: r.inquiries.created }, { k: 'Quoted', v: r.inquiries.quoted }, { k: 'Won', v: r.inquiries.won }, { k: 'Lost', v: r.inquiries.lost },
  ]);

  if (r.money) {
    const ws = sheet(wb, 'Money', [{ header: 'Item', key: 'k', width: 30 }, { header: '₹', key: 'v', width: 16, numFmt: INR }, { header: 'Overdue ₹', key: 'o', width: 16, numFmt: INR }], [
      { k: `Invoiced (${r.money.invoices} invoices)`, v: r.money.invoiced }, { k: `Collected (${r.money.payments} payments)`, v: r.money.collected },
      { k: `Outstanding on ${r.to}`, v: r.money.outstanding, o: r.money.overdue },
      ...r.money.topOutstanding.map((x) => ({ k: x.name, v: x.amount, o: x.overdue })),
    ]);
    ws.getRow(4).font = { bold: true };
  }
  if (r.ai) {
    sheet(wb, 'AI usage', [{ header: 'Feature', key: 'f', width: 24 }, { header: 'Calls', key: 'c' }, { header: 'Cost USD', key: 'u', numFmt: '0.0000' }], [
      ...r.ai.byFeature.map((x) => ({ f: x.feature, c: x.calls, u: x.costUsd })),
      { f: 'Total', c: r.ai.calls, u: r.ai.costUsd },
    ]);
  }
  sheet(wb, 'Time saved', [{ header: 'Item', key: 'k', width: 28 }, { header: 'Value', key: 'v', width: 12 }], [
    { k: 'Photo reads confirmed', v: r.timeSaved.captures }, { k: 'Minutes by hand', v: r.timeSaved.manualMin },
    { k: 'Minutes spent (photo + review)', v: r.timeSaved.actualMin }, { k: 'Minutes saved', v: r.timeSaved.savedMin },
  ]);
  return wb;
}

export const reportFileName = (r: Report) => `report-${r.period}-${r.from}${r.to !== r.from ? `-to-${r.to}` : ''}.xlsx`;
