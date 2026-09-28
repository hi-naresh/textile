// Polite payment reminder in English / Hindi / Gujarati. Deterministic template; optional
// low-tier AI polish that must keep every amount and invoice number (else the template is used).
import type { Q } from '../db';
import { readBilling } from '../billing';
import { callGemini, geminiKey } from '../gemini';
import { LedgerError } from '../ledger-error';
import { partyCredit, type OpenInvoice } from './credit';
import { rupees } from './validate';

export type ReminderLang = 'en' | 'hi' | 'gu';
export const REMINDER_LANGS: ReminderLang[] = ['en', 'hi', 'gu'];

const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;

const T = {
  en: {
    hello: (n: string) => `Namaste ${n} ji,`,
    intro: (f: string) => `This is a gentle reminder from ${f}. The following bills are pending:`,
    overdue: (d: number) => `${d} day${d === 1 ? '' : 's'} overdue`,
    due: (d: string) => `due ${d}`,
    more: (n: number) => `+ ${n} more bill${n === 1 ? '' : 's'}`,
    total: (a: string) => `Total pending: ${a}`,
    overdueTotal: (a: string) => `Overdue now: ${a}`,
    ask: 'Kindly arrange the payment at the earliest.',
    bank: 'Bank', ac: 'A/c', ifsc: 'IFSC',
    ignore: 'Please ignore this if already paid. Thank you.',
  },
  hi: {
    hello: (n: string) => `नमस्ते ${n} जी,`,
    intro: (f: string) => `${f} की ओर से विनम्र स्मरण। नीचे दिए बिलों का भुगतान बाकी है:`,
    overdue: (d: number) => `${d} दिन से बकाया`,
    due: (d: string) => `देय तिथि ${d}`,
    more: (n: number) => `+ ${n} और बिल`,
    total: (a: string) => `कुल बकाया: ${a}`,
    overdueTotal: (a: string) => `अभी देय (समय पार): ${a}`,
    ask: 'कृपया जल्द से जल्द भुगतान करने की कृपा करें।',
    bank: 'बैंक', ac: 'खाता', ifsc: 'IFSC',
    ignore: 'यदि भुगतान हो चुका है तो कृपया इस संदेश को अनदेखा करें। धन्यवाद।',
  },
  gu: {
    hello: (n: string) => `નમસ્તે ${n},`,
    intro: (f: string) => `${f} તરફથી નમ્ર યાદી. નીચેના બિલની ચુકવણી બાકી છે:`,
    overdue: (d: number) => `${d} દિવસથી બાકી`,
    due: (d: string) => `ચુકવણી તારીખ ${d}`,
    more: (n: number) => `+ ${n} વધુ બિલ`,
    total: (a: string) => `કુલ બાકી: ${a}`,
    overdueTotal: (a: string) => `મુદત વીતી ગયેલ રકમ: ${a}`,
    ask: 'કૃપા કરીને વહેલી તકે ચુકવણી કરશો.',
    bank: 'બેંક', ac: 'ખાતું', ifsc: 'IFSC',
    ignore: 'જો ચુકવણી થઈ ગઈ હોય તો આ સંદેશ અવગણશો. આભાર.',
  },
} as const;

const MAX_LINES = 8;

export function reminderText(lang: ReminderLang, p: { partyName: string; firm: string; unpaid: OpenInvoice[]; outstanding: number; overdue: number; bank: { name: string | null; account: string | null; ifsc: string | null } }): string {
  const t = T[lang];
  // Overdue bills first (oldest first), then bills not yet due.
  const list = [...p.unpaid].sort((a, b) => b.days_past_due - a.days_past_due);
  const lines = list.slice(0, MAX_LINES).map((i) => `• ${i.invoice_no} — ${rupees(i.unpaid)} (${i.days_past_due > 0 ? t.overdue(i.days_past_due) : t.due(ddmmyyyy(i.due_date))})`);
  if (list.length > MAX_LINES) lines.push(t.more(list.length - MAX_LINES));
  const out = [t.hello(p.partyName), '', t.intro(p.firm), ...lines, '', t.total(rupees(p.outstanding))];
  if (p.overdue > 0 && Math.abs(p.overdue - p.outstanding) >= 0.01) out.push(t.overdueTotal(rupees(p.overdue)));
  out.push(t.ask);
  const bank = [p.bank.name && `${t.bank}: ${p.bank.name}`, p.bank.account && `${t.ac}: ${p.bank.account}`, p.bank.ifsc && `${t.ifsc}: ${p.bank.ifsc}`].filter(Boolean);
  if (bank.length) out.push(bank.join(' · '));
  out.push('', t.ignore, '', `— ${p.firm}`);
  return out.join('\n');
}

export function whatsappUrl(phone: string | null, text: string): string {
  const digits = (phone ?? '').replace(/\D/g, '');
  const to = digits.length === 10 ? `91${digits}` : digits.length === 12 && digits.startsWith('91') ? digits : '';
  return `https://wa.me/${to}?text=${encodeURIComponent(text)}`;
}

export interface Reminder { text: string; whatsapp_url: string; lang: ReminderLang; polished: boolean; party_id: number; party_name: string; phone: string | null; outstanding: number; overdue: number; invoices: string[] }

export async function buildReminder(q: Q, partyId: number, langRaw: unknown, opts: { polish?: boolean } = {}): Promise<Reminder> {
  const lang: ReminderLang = REMINDER_LANGS.includes(langRaw as ReminderLang) ? (langRaw as ReminderLang) : 'en';
  const c = await partyCredit(q, partyId);
  if (!c) throw new LedgerError('Party not found.', 404);
  const unpaid = c.invoices.filter((i) => i.unpaid > 0);
  if (c.outstanding <= 0 || !unpaid.length) throw new LedgerError(`Nothing is pending from ${c.name} right now.`);
  const b = await readBilling(q);
  let text = reminderText(lang, { partyName: c.name, firm: b.legalName, unpaid, outstanding: c.outstanding, overdue: c.overdue, bank: { name: b.bankName, account: b.bankAccount, ifsc: b.bankIfsc } });
  let polished = false;
  if (opts.polish && geminiKey()) {
    const better = await polish(text, lang, [rupees(c.outstanding), ...unpaid.slice(0, MAX_LINES).map((i) => i.invoice_no)], partyId).catch(() => null);
    if (better) { text = better; polished = true; }
  }
  return {
    text, whatsapp_url: whatsappUrl(c.phone, text), lang, polished, party_id: c.party_id, party_name: c.name, phone: c.phone,
    outstanding: c.outstanding, overdue: c.overdue, invoices: unpaid.map((i) => i.invoice_no),
  };
}

/** Low-tier rewrite for warmth; rejected unless every amount / invoice number survives verbatim. */
async function polish(text: string, lang: ReminderLang, mustKeep: string[], partyId: number): Promise<string | null> {
  const langName = lang === 'hi' ? 'Hindi (Devanagari)' : lang === 'gu' ? 'Gujarati (Gujarati script)' : 'English';
  const out = await callGemini({
    tier: 'low', feature: 'agent.credit', ref: `party:${partyId}`, temperature: 0.3, timeoutMs: 12_000,
    parts: [{ text: `Rewrite this WhatsApp payment reminder from an Indian textile trader to a long-standing client so it reads warm, respectful and short. Keep it in ${langName}. Keep every amount, invoice number, date and bank detail exactly as written. No new facts, no threats, no emojis. Reply with the message only.\n\n${text}` }],
  });
  const t = out.trim();
  if (!t || t.length > text.length * 2 || !mustKeep.every((k) => t.includes(k))) return null;
  return t;
}
