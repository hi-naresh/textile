import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import ExcelJS from 'exceljs';
import type { Billing } from '../../src/lib/billing';
import type { Q } from '../../src/lib/db';
import type { ExportInvoice } from '../../src/lib/dispatch/tally';
import { streamTallyXlsx, tallyExportRows, writeTallyXml } from '../../src/lib/dispatch/tally';

const billing: Billing = {
  firmName: 'Stress firm', legalName: 'Stress firm', gstin: null, address: null, stateCode: '24', phone: null,
  bankName: null, bankAccount: null, bankIfsc: null, invoicePrefix: 'ST', hsnCode: '5407', gstRatePct: 5, lowStockM: 200, ageingDays: 60,
};

function row(id: number, date: string): Record<string, unknown> {
  return {
    id, invoice_no: `ST/${id}`, party_id: 1, party_name: '=HYPERLINK("https://example.invalid","party")',
    dispatch_id: null, order_id: null, invoice_date: date, due_date: date, taxable_amount: 10,
    cgst: 0.25, sgst: 0.25, igst: 0, total: 11, lines: [{ lot_id: 'L1', quality: 'आकाश', hsn: '5407', meters: 1, rate: 10, amount: 10 }],
    status: 'open', source: 'app', exported_at: null, created_at: new Date(`${date}T00:00:00Z`),
    party_gstin: null, party_state: '24', challan_no: null,
  };
}

test('invoice exports fetch bounded pages in invoice order without loading all invoices', async () => {
  const source = [row(3, '2026-10-02'), row(1, '2026-10-01'), row(2, '2026-10-01')];
  const requestedLimits: number[] = [];
  const q: Q = async (_text, params = []) => {
    const [highWater, from, to, afterDate, afterId, limit] = params;
    requestedLimits.push(Number(limit));
    const eligible = source
      .filter((r) => Number(r.id) <= Number(highWater) && String(r.invoice_date) >= String(from) && String(r.invoice_date) <= String(to))
      .filter((r) => !afterDate || String(r.invoice_date) > String(afterDate) || (String(r.invoice_date) === String(afterDate) && Number(r.id) > Number(afterId)))
      .sort((a, b) => String(a.invoice_date).localeCompare(String(b.invoice_date)) || Number(a.id) - Number(b.id))
      .slice(0, Number(limit));
    return { rows: eligible, rowCount: eligible.length, command: 'SELECT', oid: 0, fields: [] };
  };
  const invoices: ExportInvoice[] = [];
  for await (const invoice of tallyExportRows(q, '2026-10-01', '2026-10-31', 3, 2)) invoices.push(invoice);
  assert.deepEqual(invoices.map((invoice) => invoice.id), [1, 2, 3]);
  assert.deepEqual(requestedLimits, [3, 3]);
  assert.equal(invoices[0].party_name, '=HYPERLINK("https://example.invalid","party")');
});

test('streamed invoice XLSX preserves formula-like text as string cells', async () => {
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  const finished = new Promise<void>((resolve, reject) => {
    output.once('end', resolve);
    output.once('error', reject);
  });
  const invoices: ExportInvoice[] = [{
    id: 1, invoice_no: 'ST/1', party_id: 1, party_name: '=HYPERLINK("https://example.invalid","party")',
    dispatch_id: null, order_id: null, invoice_date: '2026-10-01', due_date: '2026-10-31',
    taxable_amount: 10, cgst: 0.25, sgst: 0.25, igst: 0, total: 11,
    lines: [{ lot_id: 'L1', quality: 'आकाश', hsn: '5407', meters: 1, rate: 10, amount: 10 }],
    status: 'open', source: 'app', paid: 0, balance: 11,
    party_gstin: null, party_state: '24', challan_no: null,
  }];
  async function* source() { yield* invoices; }
  await streamTallyXlsx(billing, source(), output);
  await finished;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.concat(chunks) as unknown as ArrayBuffer);
  const ws = wb.getWorksheet('Sales vouchers');
  assert.ok(ws);
  assert.equal(ws.getCell('C2').type, ExcelJS.ValueType.String);
  assert.equal(ws.getCell('C2').value, invoices[0].party_name);
  assert.equal(ws.getCell('F2').value, '5407');
  assert.equal(ws.getCell('C3').value, 'Total');
});

test('Tally XML writes escaped invoice data incrementally', async () => {
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  const finished = new Promise<void>((resolve, reject) => {
    output.once('end', resolve);
    output.once('error', reject);
  });
  async function* source() {
    yield {
      id: 1, invoice_no: 'ST&1', party_id: 1, party_name: 'Mill & Co', dispatch_id: null, order_id: null,
      invoice_date: '2026-10-01', due_date: '2026-10-31', taxable_amount: 10, cgst: 0.25, sgst: 0.25, igst: 0,
      total: 11, lines: [], status: 'open', source: 'app', paid: 0, balance: 11,
      party_gstin: null, party_state: '24', challan_no: null,
    } satisfies ExportInvoice;
  }
  await writeTallyXml(billing, source(), output);
  output.end();
  await finished;
  const xml = Buffer.concat(chunks).toString('utf8');
  assert.match(xml, /ST&amp;1/);
  assert.match(xml, /Mill &amp; Co/);
  assert.match(xml, /<\/ENVELOPE>/);
});
