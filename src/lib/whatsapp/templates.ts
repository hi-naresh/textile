// The three WhatsApp message templates the app sends. Business-started messages must use a template that
// Meta has approved (WhatsApp Manager → Message templates). The developer console shows these texts with
// copy buttons so they can be created exactly as written. Shared by the server and the console (no server imports).
//
// Meta rules kept here: category UTILITY, positional variables {{1}}…{{n}} in order, the text does not start
// or end with a variable, and variable values have no new lines / tabs / 4+ spaces (clean() below).
// Amounts are written "Rs. 1,25,000" (no ₹ sign).

export type TemplateKey = 'reminder' | 'dispatch' | 'summary';
export type TemplateLang = 'en' | 'hi';
export const TEMPLATE_LANGS: { code: TemplateLang; label: string }[] = [{ code: 'en', label: 'English (en)' }, { code: 'hi', label: 'Hindi (hi)' }];

export interface TemplateDef {
  key: TemplateKey;
  defaultName: string;
  category: 'UTILITY';
  purpose: string;
  vars: { n: number; meaning: string; example: string }[];
  body: Record<TemplateLang, string>;
}

export const TEMPLATES: TemplateDef[] = [
  {
    key: 'reminder', defaultName: 'payment_reminder', category: 'UTILITY',
    purpose: 'Payment reminder to a party (owner taps "Send on WhatsApp", or the daily job when auto reminders are on).',
    vars: [
      { n: 1, meaning: 'Party name', example: 'Shree Balaji Sarees' },
      { n: 2, meaning: 'Your firm (legal name)', example: 'Narmada Group' },
      { n: 3, meaning: 'Amount pending', example: '1,25,000' },
      { n: 4, meaning: 'Bills pending', example: 'INV-0012 (45 days overdue), INV-0015 (due 05-10-2026)' },
    ],
    body: {
      en: 'Namaste {{1}} ji,\n\nThis is a gentle reminder from {{2}}. Payment of Rs. {{3}} is pending for these bills: {{4}}.\n\nKindly arrange the payment at the earliest. Please ignore this message if already paid.\n\nThank you.',
      hi: 'नमस्ते {{1}} जी,\n\n{{2}} की ओर से विनम्र स्मरण। इन बिलों का Rs. {{3}} का भुगतान बाकी है: {{4}}।\n\nकृपया जल्द से जल्द भुगतान करें। यदि भुगतान हो चुका है तो इस संदेश को अनदेखा करें।\n\nधन्यवाद।',
    },
  },
  {
    key: 'dispatch', defaultName: 'dispatch_update', category: 'UTILITY',
    purpose: 'Sent to the party when a dispatch is recorded (owner switch), or with "Send again" on the dispatch.',
    vars: [
      { n: 1, meaning: 'Party name', example: 'Mumbai Retailers' },
      { n: 2, meaning: 'Your firm (legal name)', example: 'Narmada Group' },
      { n: 3, meaning: 'Challan no.', example: 'DC-0042' },
      { n: 4, meaning: 'Date', example: '02-10-2026' },
      { n: 5, meaning: 'Goods: lots, qualities, meters', example: '2 lots (L-101, L-102) · H-2518 · 1,250.5 m' },
      { n: 6, meaning: 'Transport', example: 'VRL Logistics, LR 5521, GJ05AB1234' },
    ],
    body: {
      en: 'Namaste {{1}} ji,\n\nYour goods have been dispatched by {{2}}.\nChallan no.: {{3}}\nDate: {{4}}\nGoods: {{5}}\nTransport: {{6}}\n\nThank you for your business.',
      hi: 'नमस्ते {{1}} जी,\n\n{{2}} ने आपका माल भेज दिया है।\nचालान नं.: {{3}}\nतारीख: {{4}}\nमाल: {{5}}\nट्रांसपोर्ट: {{6}}\n\nआपके व्यापार के लिए धन्यवाद।',
    },
  },
  {
    key: 'summary', defaultName: 'daily_summary', category: 'UTILITY',
    purpose: 'Morning summary to the owner (and extra numbers the owner adds), sent by the daily job at about 07:00 IST.',
    vars: [
      { n: 1, meaning: 'Firm name', example: 'Narmada Group' },
      { n: 2, meaning: 'Date', example: '02-10-2026' },
      { n: 3, meaning: 'Stock on hand', example: '52,340 m in 118 lots' },
      { n: 4, meaning: 'Yesterday in / out', example: 'In 2,300 m, out 1,850 m' },
      { n: 5, meaning: 'Orders due / late', example: '2 due today, 1 late' },
      { n: 6, meaning: 'Overdue payments', example: 'Rs. 3,45,000 from 4 parties' },
      { n: 7, meaning: 'Needs attention', example: '5 alerts, 3 photo reads to review' },
    ],
    body: {
      en: 'Good morning. Here is the daily business summary of {{1}} for {{2}}.\n\nStock on hand: {{3}}\nYesterday: {{4}}\nOrders: {{5}}\nOverdue payments: {{6}}\nNeeds attention: {{7}}\n\nPlease open the app to see the details. This is an automatic message.',
      hi: 'सुप्रभात। {{1}} का {{2}} का दैनिक सारांश:\n\nस्टॉक: {{3}}\nकल: {{4}}\nऑर्डर: {{5}}\nबकाया भुगतान: {{6}}\nध्यान दें: {{7}}\n\nपूरी जानकारी के लिए ऐप खोलें। यह एक स्वचालित संदेश है।',
    },
  },
];

export const templateDef = (k: TemplateKey) => TEMPLATES.find((t) => t.key === k)!;

/** Meta's own sample template, available on every account — used for the test message until ours are approved. */
export const HELLO_WORLD = { name: 'hello_world', lang: 'en_US' };

/** The body with {{n}} replaced — what the receiver will read (for logs and previews). */
export function fillTemplate(body: string, params: string[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (_, n) => params[Number(n) - 1] ?? `{{${n}}}`);
}

/** A variable value WhatsApp accepts: no new lines / tabs, no 4+ spaces in a row, not empty, not too long. */
export function clean(v: unknown, max = 300): string {
  const s = String(v ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  if (!s) return '-';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ---------- words used inside variable values ----------
const W = {
  en: { overdue: (d: number) => `${d} day${d === 1 ? '' : 's'} overdue`, due: (d: string) => `due ${d}`, more: (n: number) => `+${n} more`,
    lots: (n: number) => `${n} lot${n === 1 ? '' : 's'}`, inLots: (m: string, n: number) => `${m} m in ${n.toLocaleString('en-IN')} lot${n === 1 ? '' : 's'}`,
    inOut: (i: string, o: string) => `In ${i} m, out ${o} m`, dueToday: (n: number) => `${n} due today`, late: (n: number) => `${n} late`,
    noOrders: 'None due today', none: 'None', fromParties: (a: string, n: number) => `Rs. ${a} from ${n} part${n === 1 ? 'y' : 'ies'}`,
    alerts: (n: number) => `${n} alert${n === 1 ? '' : 's'}`, reads: (n: number) => `${n} photo read${n === 1 ? '' : 's'} to review`, allClear: 'Nothing, all clear', notGiven: 'Not given' },
  hi: { overdue: (d: number) => `${d} दिन से बकाया`, due: (d: string) => `देय ${d}`, more: (n: number) => `+${n} और`,
    lots: (n: number) => `${n} लॉट`, inLots: (m: string, n: number) => `${n.toLocaleString('en-IN')} लॉट में ${m} मी.`,
    inOut: (i: string, o: string) => `आया ${i} मी., गया ${o} मी.`, dueToday: (n: number) => `${n} आज देय`, late: (n: number) => `${n} देर से`,
    noOrders: 'आज कोई देय नहीं', none: 'कोई नहीं', fromParties: (a: string, n: number) => `${n} पार्टी से Rs. ${a}`,
    alerts: (n: number) => `${n} अलर्ट`, reads: (n: number) => `${n} फोटो जाँच के लिए`, allClear: 'कुछ नहीं, सब ठीक', notGiven: 'नहीं दिया' },
} as const;
export const words = (lang: string) => (lang.startsWith('hi') ? W.hi : W.en);

/** 125000 → "1,25,000"; 1250.5 → "1,250.5" (Indian grouping, no ₹ sign). */
export function amount(n: number, digits = 2): string {
  return Number(n).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

/** "2026-10-02…" → "02-10-2026" */
export const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;
