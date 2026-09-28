// Optional: reword the deterministic report narrative on the low AI tier. Never adds facts —
// if the answer contains any number that was not in the input, the rule-based text is kept.
// Works (silently falls back) with no GEMINI_API_KEY.
import { callGemini, geminiKey } from '../gemini';
import type { Report } from './build';

const CACHE_MS = 30 * 60 * 1000;
const cache = new Map<string, { at: number; lines: string[] }>();

const numbersIn = (t: string) => (t.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((x) => x.replace(/,/g, ''));

export async function polishNarrative<T extends Report>(r: T): Promise<T> {
  if (!geminiKey() || !r.narrative.length) return r;
  const input = r.narrative.join('\n');
  const hit = cache.get(input);
  if (hit && Date.now() - hit.at < CACHE_MS) return { ...r, narrative: hit.lines, narrativeSource: 'ai' };
  try {
    const text = await callGemini({
      tier: 'low',
      feature: 'agent.reports',
      temperature: 0.2,
      timeoutMs: 12_000,
      ref: `${r.period}:${r.from}`,
      parts: [{
        text: `You write a short business summary for the owner of a textile firm in Surat.
Rewrite these facts as 3 to 5 short, plain-English sentences, one per line, most important first.
Use ONLY the numbers given, exactly as written. Do not add advice, greetings, bullets or new facts.

Facts:
${input}`,
      }],
    });
    const lines = text.split('\n').map((l) => l.replace(/^[-*•\d.)\s]+(?=[A-Za-z₹])/, '').trim()).filter(Boolean).slice(0, 5);
    const allowed = new Set(numbersIn(input));
    const ok = lines.length >= 2 && lines.every((l) => l.length <= 240) && numbersIn(lines.join(' ')).every((x) => allowed.has(x));
    if (!ok) return r;
    cache.set(input, { at: Date.now(), lines });
    if (cache.size > 200) cache.delete(cache.keys().next().value as string);
    return { ...r, narrative: lines, narrativeSource: 'ai' };
  } catch {
    return r; // no key / quota / timeout → keep the rule-based narrative
  }
}
