// Language of a question (English / Hindi / Gujarati) and English hints so the fixed
// query templates understand Hindi and Gujarati questions without any AI call.

export type ChatLang = 'en' | 'hi' | 'gu';

// Romanised Hindi / Gujarati as speech recognition often writes it ("aaj kitna maal gaya").
const HI_WORDS = new Set(['hai', 'hain', 'kya', 'kitna', 'kitne', 'kitni', 'aaj', 'kal', 'mein', 'mai', 'ka', 'ki', 'ke', 'ko', 'se', 'bhejo', 'bheja', 'bheje', 'maal', 'batao', 'bataiye', 'dikhao', 'kaun', 'kaunsa', 'hua', 'hue', 'abhi', 'wala', 'wali', 'kitnaa', 'gaya', 'aaya', 'kaha', 'kahan', 'chahiye', 'raha', 'rahi']);
const GU_WORDS = new Set(['che', 'chhe', 'ketlu', 'ketla', 'ketli', 'shu', 'su', 'kem', 'aaje', 'aje', 'mokalyu', 'mokalyo', 'batavo', 'batav', 'kyare', 'nathi', 'hatu', 'hato', 'aavyo', 'aavyu', 'gayo', 'gayu', 'thayu', 'chalu', 'maal', 'ketlo']);

export function detectLang(text: string): ChatLang {
  if (/[઀-૿]/.test(text)) return 'gu';
  if (/[ऀ-ॿ]/.test(text)) return 'hi';
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  let hi = 0;
  let gu = 0;
  for (const w of words) {
    if (GU_WORDS.has(w)) gu++;
    if (HI_WORDS.has(w)) hi++;
  }
  if (gu >= 2 && gu >= hi) return 'gu';
  if (hi >= 2) return 'hi';
  return 'en';
}

// Hindi / Gujarati (script or romanised) → English keywords the rule matcher knows.
// Each pattern is tested against whole words (anchored at the word start), so "कल" doesn't match "निकला".
const HINTS: [RegExp, string][] = [
  [/^(स्टॉक|स्टोक|माल|સ્ટોક|માલ|maal|mal|stok)$/, 'stock'],
  [/^(कुल|કુલ|kul)$/, 'total'],
  [/^(आज|આજે|આજ|aaj|aaje|aje)$/, 'today'],
  [/^(कल|ગઈકાલે|ગઈકાલ|kal|gaikale)$/, 'yesterday'],
  [/^(हफ्त|सप्ताह|અઠવાડિ|hafte|hafta|athvadi)/, 'week'],
  [/^(महीन|મહિન|mahin)/, 'month'],
  [/^(साल|વર્ષ|saal|varsh)/, 'year'],
  [/^(भेज|डिस्पैच|जावक|મોકલ|જાવક|ડિસ્પેચ|bhej|mokal|javak)/, 'dispatch'],
  [/^(आया|आए|आवक|આવ્ય|આવક|aaya|aavak|aavy)/, 'received'],
  [/^(कमी|घट|शॉर्टेज|ઘટ|શોર્ટેજ|kami|ghat)$/, 'shortage'],
  [/^(कार्ड|કાર્ડ)/, 'job cards'],
  [/^(चालू|ચાલુ|chalu)$/, 'open job cards'],
  [/^(दक्षता|કાર્યક્ષમતા)/, 'efficiency'],
  [/^(कारीगर|मजदूर|वर्कर|કારીગર|વર્કર|કામદાર|karigar|kaarigar|mazdoor)/, 'workers'],
  [/^(सुपरवाइजर|सुपरवाइज़र|સુપરવાઇઝર)/, 'supervisors'],
  [/^(कितने|कितना|कितनी|કેટલા|કેટલું|કેટલો|કેટલી|kitne|kitna|kitni|ketla|ketlu|ketlo)$/, 'how many'],
  [/^(फोल्ड|ફોલ્ડ)/, 'folded'],
  [/^(कौन|કોણ|kaun|kon)$/, 'who'],
  [/^(सारांश|हाल|સારાંશ)$/, 'summary'],
  [/^(बाकी|पेंडिंग|બાકી|પેન્ડિંગ|baki|baaki)$/, 'pending review'],
  [/^(चालान|ચલણ|ચલાન|chalan)/, 'challan'],
  [/^(लॉट|લોટ)$/, 'lot'],
  [/^(पार्टी|પાર્ટી)/, 'party'],
  [/^(मिल|મિલ)$/, 'mill'],
  [/^(समय|સમય|samay)$/, 'time saved'],
  [/^(क्वालिटी|ક્વોલિટી)/, 'quality'],
  [/^(नियम|पॉलिसी|નિયમ|પોલિસી|niyam)/, 'policy'],
];

/** The question plus English keywords for any Hindi / Gujarati words it contains. */
export function withEnglishHints(question: string): string {
  // Devanagari / Gujarati digits → ASCII (lot and challan numbers)
  const q = question
    .replace(/[\u0966-\u096F]/g, (c) => String(c.charCodeAt(0) - 0x0966))
    .replace(/[\u0AE6-\u0AEF]/g, (c) => String(c.charCodeAt(0) - 0x0AE6));
  const words = q.toLowerCase().split(/[\s,.?!।|:;()"'-]+/).filter(Boolean);
  const extra = Array.from(new Set(HINTS.filter(([re]) => words.some((w) => re.test(w))).map(([, en]) => en)));
  return extra.length ? `${q} ${extra.join(' ')}` : q;
}

export const LANG_NAME: Record<ChatLang, string> = { en: 'English', hi: 'Hindi (Devanagari script)', gu: 'Gujarati (Gujarati script)' };
