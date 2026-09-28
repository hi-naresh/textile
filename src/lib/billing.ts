// Firm billing details (Settings → Billing) used for GST invoices, challans and statements.
import type { Q } from './db';

export interface Billing {
  firmName: string; legalName: string; gstin: string | null; address: string | null; stateCode: string | null; phone: string | null;
  bankName: string | null; bankAccount: string | null; bankIfsc: string | null;
  invoicePrefix: string; hsnCode: string; gstRatePct: number; lowStockM: number; ageingDays: number;
}

export async function readBilling(q: Q): Promise<Billing> {
  const r = await q(`SELECT * FROM app_settings WHERE id = 1`);
  const s = r.rows[0] ?? {};
  return {
    firmName: s.firm_name ?? 'Your firm', legalName: s.legal_name || s.firm_name || 'Your firm', gstin: s.gstin ?? null, address: s.address ?? null,
    stateCode: s.state_code ?? null, phone: s.phone ?? null, bankName: s.bank_name ?? null, bankAccount: s.bank_account ?? null, bankIfsc: s.bank_ifsc ?? null,
    invoicePrefix: s.invoice_prefix ?? 'INV', hsnCode: s.hsn_code ?? '5407', gstRatePct: Number(s.gst_rate_pct ?? 5),
    lowStockM: Number(s.low_stock_m ?? 200), ageingDays: Number(s.ageing_days ?? 60),
  };
}

/** Next invoice number, e.g. INV/2026-27/0042 (Indian financial year). Call inside the invoice's transaction. */
export async function nextInvoiceNo(q: Q, onDate = new Date()): Promise<string> {
  const r = await q(`UPDATE app_settings SET next_invoice_no = next_invoice_no + 1 WHERE id = 1 RETURNING next_invoice_no - 1 AS n, invoice_prefix`);
  const { n, invoice_prefix } = r.rows[0];
  const y = onDate.getMonth() >= 3 ? onDate.getFullYear() : onDate.getFullYear() - 1;
  return `${invoice_prefix}/${y}-${String(y + 1).slice(2)}/${String(n).padStart(4, '0')}`;
}
