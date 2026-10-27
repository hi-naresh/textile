import { Writable } from 'node:stream';
import { performance } from 'node:perf_hooks';
import type { Billing } from '../../src/lib/billing';
import type { ExportInvoice } from '../../src/lib/dispatch/tally';
import { streamTallyXlsx } from '../../src/lib/dispatch/tally';
import type { LotRow } from '../../src/lib/lots-query';
import { streamLotsWorkbook } from '../../src/lib/excel';

const requestedRows = Number(process.argv.find((arg) => arg.startsWith('--rows='))?.slice('--rows='.length) ?? 1_000_000);
if (!Number.isSafeInteger(requestedRows) || requestedRows < 1 || requestedRows > 1_000_000) {
  throw new Error('Pass --rows between 1 and 1,000,000.');
}

const billing: Billing = {
  firmName: 'Stress test', legalName: 'Stress test', gstin: null, address: null, stateCode: '24', phone: null,
  bankName: null, bankAccount: null, bankIfsc: null, invoicePrefix: 'ST', hsnCode: '5407', gstRatePct: 5, lowStockM: 200, ageingDays: 60,
};

async function measure(name: string, write: (sink: Writable) => Promise<void>, expectedRows: number) {
  let bytes = 0;
  let peakHeap = process.memoryUsage().heapUsed;
  const startHeap = peakHeap;
  const sampleHeap = setInterval(() => { peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed); }, 100);
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback();
    },
  });
  const started = performance.now();
  try {
    await write(sink);
  } finally {
    clearInterval(sampleHeap);
  }
  const elapsedMs = performance.now() - started;
  const result = {
    export: name, rows: expectedRows, bytes, elapsed_ms: Math.round(elapsedMs),
    rows_per_second: Math.round(expectedRows * 1000 / elapsedMs),
    start_heap_bytes: startHeap, peak_heap_bytes: peakHeap, heap_growth_bytes: peakHeap - startHeap,
  };
  console.log(JSON.stringify(result));
  if (!bytes) throw new Error(`${name} produced no output.`);
}

async function* lots(): AsyncGenerator<LotRow> {
  for (let i = 1; i <= requestedRows; i++) {
    yield {
      lot_id: `STRESS-${String(i).padStart(8, '0')}`, quality: 'Synthetic quality', design: 'Synthetic design',
      grade: '', status: 'active', balance: i % 1000, stock_status: 'packed',
      location: 'Local test', location_stage: null, location_ts: null, loc_code: null, reg_lot_no: null, closed_at: null,
    };
  }
}

async function* invoices(): AsyncGenerator<ExportInvoice> {
  for (let i = 1; i <= requestedRows; i++) {
    yield {
      id: i, invoice_no: `ST/${i}`, party_id: 1, party_name: 'Synthetic party', dispatch_id: null, order_id: null,
      invoice_date: '2026-10-01', due_date: '2026-10-31', taxable_amount: 10, cgst: 0.25, sgst: 0.25,
      igst: 0, total: 11,
      lines: [{ lot_id: `LOT-${i}`, quality: 'Synthetic quality', hsn: '5407', meters: 1, rate: 10, amount: 10 }],
      status: 'open', source: 'app', paid: 0, balance: 11,
      party_gstin: null, party_state: '24', challan_no: `CH-${i}`,
    };
  }
}

async function main() {
  await measure('lot-xlsx-writer', (sink) => streamLotsWorkbook('Stress test', sink, lots()), requestedRows);
  await measure('invoice-xlsx-writer', (sink) => streamTallyXlsx(billing, invoices(), sink), requestedRows);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
