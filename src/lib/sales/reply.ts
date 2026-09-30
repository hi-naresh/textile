// Reply drafts for an inquiry, in the inquiry's language. Deterministic templates — a person
// reads, edits and sends them. Drafts for supervisors never contain a rate (₹).
import type { ChatLang } from '../chat/lang';
import { meters as m } from './util';

export interface ReplyInput {
  lang: ChatLang;
  party: string | null;
  quality: string | null;
  design?: string | null;
  meters: number | null;
  free: number; // free stock of the quality (m)
  rate: number | null; // ₹/m the owner typed for this inquiry (never a list rate); ignored when includeRate is false
  promise: string | null; // YYYY-MM-DD dispatch date we can promise, or null
  includeRate: boolean;
}

const MON: Record<ChatLang, string[]> = {
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  hi: ['जनवरी', 'फरवरी', 'मार्च', 'अप्रैल', 'मई', 'जून', 'जुलाई', 'अगस्त', 'सितंबर', 'अक्टूबर', 'नवंबर', 'दिसंबर'],
  gu: ['જાન્યુઆરી', 'ફેબ્રુઆરી', 'માર્ચ', 'એપ્રિલ', 'મે', 'જૂન', 'જુલાઈ', 'ઓગસ્ટ', 'સપ્ટેમ્બર', 'ઓક્ટોબર', 'નવેમ્બર', 'ડિસેમ્બર'],
};

export function shortDate(iso: string, lang: ChatLang = 'en'): string {
  const [, mo, d] = iso.split('-').map(Number);
  return `${d} ${MON[lang][mo - 1]}`;
}

const rateTxt = (r: number) => (Number.isInteger(r) ? String(r) : r.toFixed(2).replace(/0$/, ''));

export function replyDraft(x: ReplyInput): string {
  const L = x.lang;
  const rate = x.includeRate && x.rate != null ? rateTxt(x.rate) : null;
  const q = x.quality ? (x.design ? `${x.quality} (${x.design})` : x.quality) : null;
  const who = x.party?.trim() || null;
  const free = Math.max(0, x.free);
  const need = x.meters;
  const date = x.promise ? shortDate(x.promise, L) : null;

  if (L === 'hi') {
    const hi = who ? `नमस्ते ${who} जी` : 'नमस्ते जी';
    if (!q) return `${hi}, पूछताछ के लिए धन्यवाद। कौन सी क्वालिटी और कितने मीटर चाहिए?`;
    const r = rate ? ` रेट ₹${rate}/मीटर।` : '';
    if (free <= 0) return `${hi}, ${q} अभी स्टॉक में नहीं है। अगली आवक के बाद बताएंगे।`;
    if (need != null && free < need) return `${hi}, ${q}: अभी ${m(free)} मीटर तैयार है (आपको ${m(need)} मीटर चाहिए)। बाकी ${m(need - free)} मीटर अगली आवक के बाद।${r}`;
    return `${hi}, ${q}: ${m(free)} मीटर तैयार है।${r}${date ? ` हम ${date} तक भेज सकते हैं।` : ''}`;
  }
  if (L === 'gu') {
    const hi = who ? `નમસ્તે ${who}` : 'નમસ્તે';
    if (!q) return `${hi}, પૂછપરછ માટે આભાર. કઈ ક્વોલિટી અને કેટલા મીટર જોઈએ છે?`;
    const r = rate ? ` ભાવ ₹${rate}/મીટર.` : '';
    if (free <= 0) return `${hi}, ${q} હાલ સ્ટોકમાં નથી. આગલી આવક પછી જણાવીશું.`;
    if (need != null && free < need) return `${hi}, ${q}: હાલ ${m(free)} મીટર તૈયાર છે (આપને ${m(need)} મીટર જોઈએ છે). બાકી ${m(need - free)} મીટર આગલી આવક પછી.${r}`;
    return `${hi}, ${q}: ${m(free)} મીટર તૈયાર છે.${r}${date ? ` અમે ${date} સુધીમાં મોકલી શકીએ છીએ.` : ''}`;
  }
  const hi = who ? `Namaste ${who}` : 'Namaste';
  if (!q) return `${hi}, thank you for your inquiry. Which quality and how many meters do you need?`;
  const r = rate ? ` Rate ₹${rate}/m.` : '';
  if (free <= 0) return `${hi}, ${q} is not in stock right now. We will update you after the next receipt.`;
  if (need != null && free < need) return `${hi}, ${q}: ${m(free)} m ready now (you need ${m(need)} m). The other ${m(need - free)} m after the next receipt.${r}`;
  return `${hi}, ${q}: ${m(free)} m ready.${r}${date ? ` We can dispatch by ${date}.` : ''}`;
}

/** Remove any sentence with a ₹ amount (for supervisors viewing a draft the owner wrote). */
export function stripRate(text: string | null): string | null {
  if (!text) return text;
  if (!/₹|\brs\.?\s*\d|\d\s*(?:rs|\/-)|rate|ભાવ|रेट|भाव/i.test(text)) return text;
  const parts = text.split(/(?<=[.।!?])\s+/u);
  return parts.filter((p) => !/₹|\brs\.?\s*\d|\d\s*(?:rs\b|\/-)|\brate\b|ભાવ|रेट|भाव/i.test(p)).join(' ').trim();
}
