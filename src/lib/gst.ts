// GST maths for invoices (pure functions, no database). Used by the invoice API, the invoice PDF,
// the Tally export and party statements. Money is rounded to 2 decimals per line and per tax;
// the invoice total is rounded to the nearest rupee and the difference shown as "Round off".

export const r2 = (n: number) => Math.round((n + (n >= 0 ? Number.EPSILON : -Number.EPSILON)) * 100) / 100;

/** GST state codes (first two digits of a GSTIN). */
export const GST_STATES: Record<string, string> = {
  '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana',
  '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh',
  '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal',
  '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat', '25': 'Daman & Diu',
  '26': 'Dadra & Nagar Haveli and Daman & Diu', '27': 'Maharashtra', '28': 'Andhra Pradesh (old)', '29': 'Karnataka', '30': 'Goa',
  '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman & Nicobar Islands', '36': 'Telangana',
  '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory',
};

/** "24" → "Gujarat (24)"; unknown → "—". */
export function stateLabel(code: string | null | undefined): string {
  if (!code) return '—';
  return GST_STATES[code] ? `${GST_STATES[code]} (${code})` : code;
}

/** A party's GST state: its state_code, else the first two digits of its GSTIN. */
export function partyState(p: { state_code?: string | null; gstin?: string | null }): string | null {
  if (p.state_code && /^\d{2}$/.test(p.state_code)) return p.state_code;
  if (p.gstin && /^\d{2}/.test(p.gstin)) return p.gstin.slice(0, 2);
  return null;
}

export interface GstLineInput { lot_id: string; quality: string; design?: string | null; meters: number; rate: number }
export interface GstLine { lot_id: string; quality: string; design?: string | null; hsn: string; meters: number; rate: number; amount: number }
export interface GstResult {
  lines: GstLine[];
  taxable: number; cgst: number; sgst: number; igst: number; roundOff: number; total: number;
  intraState: boolean; gstRatePct: number; note: string | null;
}

/**
 * Intra-state (firm state = party state, or party state unknown) → CGST = SGST = rate / 2.
 * Inter-state → IGST at the full rate.
 */
export function computeGst(input: { lines: GstLineInput[]; hsn: string; gstRatePct: number; firmState: string | null; partyState: string | null }): GstResult {
  const lines: GstLine[] = input.lines.map((l) => {
    const meters = r2(l.meters);
    const rate = r2(l.rate);
    return { lot_id: l.lot_id, quality: l.quality, design: l.design ?? null, hsn: input.hsn, meters, rate, amount: r2(meters * rate) };
  });
  const taxable = r2(lines.reduce((s, l) => s + l.amount, 0));
  let note: string | null = null;
  if (!input.partyState) note = "Party's state is not known, so this is taxed as within the state (CGST + SGST). Add the party's state or GSTIN to fix.";
  else if (!input.firmState) note = "Firm's state is not set in Settings → Billing, so this is taxed as within the state (CGST + SGST).";
  const intraState = !input.partyState || !input.firmState || input.partyState === input.firmState;
  const pct = input.gstRatePct;
  let cgst = 0, sgst = 0, igst = 0;
  if (intraState) { cgst = r2((taxable * pct) / 200); sgst = cgst; } else igst = r2((taxable * pct) / 100);
  const gross = r2(taxable + cgst + sgst + igst);
  const total = Math.round(gross);
  return { lines, taxable, cgst, sgst, igst, roundOff: r2(total - gross), total, intraState, gstRatePct: pct, note };
}

/** Round off stored implicitly: total − (taxable + taxes). */
export function roundOffOf(inv: { taxable_amount: number; cgst: number; sgst: number; igst: number; total: number }): number {
  return r2(inv.total - (inv.taxable_amount + inv.cgst + inv.sgst + inv.igst));
}

// ---------- dates ----------
export const isIsoDate = (s: unknown): s is string => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; // rejects 2026-02-30
};

/** "2026-09-28" + 30 → "2026-10-28" (calendar days, UTC-safe). */
export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

/** "2026-09-28" → "28-09-2026". */
export const dmy = (iso: string | null | undefined) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}` : '—');

// ---------- money formatting (Indian grouping, no ₹ sign) ----------
/** 1234567.5 → "12,34,567.50". */
export function formatINR(n: number, decimals = 2): string {
  const neg = n < 0;
  const [int, frac] = Math.abs(r2(n)).toFixed(decimals).split('.');
  const last3 = int.slice(-3);
  const rest = int.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return `${neg ? '-' : ''}${grouped}${frac ? `.${frac}` : ''}`;
}

// ---------- amount in words (Indian system: thousand, lakh, crore) ----------
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen',
  'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function below100(n: number): string {
  if (n < 20) return ONES[n];
  return `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`;
}

function below1000(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h ? `${ONES[h]} Hundred` : '', r ? below100(r) : ''].filter(Boolean).join(' ');
}

/** Whole number → words, e.g. 1234567 → "Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven". */
export function numberInWords(n: number): string {
  n = Math.floor(Math.abs(n));
  if (n === 0) return 'Zero';
  const crore = Math.floor(n / 10_000_000);
  const lakh = Math.floor((n % 10_000_000) / 100_000);
  const thousand = Math.floor((n % 100_000) / 1000);
  const rest = n % 1000;
  return [
    crore ? `${numberInWords(crore)} Crore` : '',
    lakh ? `${below100(lakh)} Lakh` : '',
    thousand ? `${below100(thousand)} Thousand` : '',
    rest ? below1000(rest) : '',
  ].filter(Boolean).join(' ');
}

/** 1234567.5 → "Rupees Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven and Fifty Paise Only". */
export function amountInWords(amount: number): string {
  const v = Math.abs(r2(amount));
  let rupees = Math.floor(v);
  let paise = Math.round((v - rupees) * 100);
  if (paise === 100) { rupees += 1; paise = 0; }
  const neg = amount < 0 && (rupees > 0 || paise > 0) ? 'Minus ' : '';
  if (rupees === 0 && paise > 0) return `${neg}${below100(paise)} Paise Only`;
  return `${neg}Rupees ${numberInWords(rupees)}${paise ? ` and ${below100(paise)} Paise` : ''} Only`;
}

// ---------- payments → invoices (FIFO per party) ----------
export interface FifoInvoice { id: number; party_id: number; invoice_date: string; total: number; status: string }

/**
 * Payments are applied per party to the oldest non-cancelled invoices first.
 * Returns paid + balance per invoice id (cancelled invoices: paid 0, balance 0).
 */
export function applyPaymentsFifo(invoices: FifoInvoice[], paidByParty: Map<number, number>): Map<number, { paid: number; balance: number }> {
  const out = new Map<number, { paid: number; balance: number }>();
  const left = new Map(paidByParty);
  const sorted = [...invoices].sort((a, b) => (a.invoice_date < b.invoice_date ? -1 : a.invoice_date > b.invoice_date ? 1 : a.id - b.id));
  for (const inv of sorted) {
    if (inv.status === 'cancelled') { out.set(inv.id, { paid: 0, balance: 0 }); continue; }
    const avail = left.get(inv.party_id) ?? 0;
    const paid = r2(Math.min(inv.total, Math.max(0, avail)));
    left.set(inv.party_id, r2(avail - paid));
    out.set(inv.id, { paid, balance: r2(inv.total - paid) });
  }
  return out;
}

/** Ageing bucket of an unpaid balance by days past due. */
export const AGEING_BUCKETS = ['Not due', '1–30 days', '31–60 days', '61–90 days', 'Over 90 days'] as const;
export function ageingBucket(daysOverdue: number): (typeof AGEING_BUCKETS)[number] {
  if (daysOverdue <= 0) return 'Not due';
  if (daysOverdue <= 30) return '1–30 days';
  if (daysOverdue <= 60) return '31–60 days';
  if (daysOverdue <= 90) return '61–90 days';
  return 'Over 90 days';
}

// ---------- XML ----------
export const xmlEscape = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
