// Google Cloud Vision OCR (DOCUMENT_TEXT_DETECTION) — the default, cheapest way to read a challan.
// Returns the text rebuilt into visual lines (table rows stay on one line) + the mean word confidence.
import { logUsage } from './usage';

export function visionKey(): string | null {
  const k = (process.env.GOOGLE_VISION_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
  return k || null;
}

export interface OcrResult {
  lines: string[]; // left-to-right, top-to-bottom
  text: string; // lines joined with \n
  confidence: number; // 0–1, mean word confidence
  words: number;
}

interface Vertex { x?: number; y?: number }
interface Word { confidence?: number; boundingBox?: { vertices?: Vertex[] }; symbols?: { text?: string; property?: { detectedBreak?: { type?: string } } }[] }

/** Group words into rows by their vertical centre, then order each row left to right. */
function toLines(words: { text: string; x: number; y: number; h: number; x2: number }[]): string[] {
  if (!words.length) return [];
  const sorted = [...words].sort((a, b) => a.y - b.y);
  const hs = sorted.map((w) => w.h).sort((a, b) => a - b);
  const medH = hs[Math.floor(hs.length / 2)] || 10;
  const rows: { y: number; items: typeof words }[] = [];
  for (const w of sorted) {
    const row = rows.find((r) => Math.abs(r.y - w.y) < medH * 0.55);
    if (row) { row.items.push(w); row.y = (row.y * (row.items.length - 1) + w.y) / row.items.length; }
    else rows.push({ y: w.y, items: [w] });
  }
  return rows
    .sort((a, b) => a.y - b.y)
    .map((r) => {
      const items = r.items.sort((a, b) => a.x - b.x);
      let line = '';
      items.forEach((w, i) => {
        if (i === 0) { line = w.text; return; }
        const gap = w.x - items[i - 1].x2;
        // Punctuation that OCR splits off (":", ".", "%") joins the previous word.
        const glue = gap < medH * 0.25 && /^[:.,%)\/-]/.test(w.text);
        line += glue ? w.text : gap > medH * 1.5 ? `  ${w.text}` : ` ${w.text}`;
      });
      return line.trim();
    })
    .filter(Boolean);
}

export async function ocrImage(buffer: Buffer, ref?: string | null): Promise<OcrResult> {
  const key = visionKey();
  if (!key) throw new Error('GOOGLE_VISION_API_KEY is not set.');
  const started = Date.now();
  try {
    const res = await fetch('https://vision.googleapis.com/v1/images:annotate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        requests: [{
          image: { content: buffer.toString('base64') },
          features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
          imageContext: { languageHints: ['en', 'hi', 'gu'] },
        }],
      }),
    });
    const latencyMs = Date.now() - started;
    const data = await res.json().catch(() => ({}));
    const r0 = data?.responses?.[0];
    if (!res.ok || r0?.error) {
      const msg = r0?.error?.message || data?.error?.message || `HTTP ${res.status}`;
      await logUsage({ feature: 'capture.ocr', provider: 'google_vision', model: 'DOCUMENT_TEXT_DETECTION', tier: 'ocr', units: 0, latencyMs, success: false, error: msg, ref });
      throw new Error(`Vision OCR failed: ${msg}`);
    }
    await logUsage({ feature: 'capture.ocr', provider: 'google_vision', model: 'DOCUMENT_TEXT_DETECTION', tier: 'ocr', units: 1, latencyMs, success: true, ref });

    const words: { text: string; x: number; y: number; h: number; x2: number }[] = [];
    let confSum = 0;
    for (const page of r0?.fullTextAnnotation?.pages ?? []) {
      for (const block of page.blocks ?? []) {
        for (const para of block.paragraphs ?? []) {
          for (const w of (para.words ?? []) as Word[]) {
            const t = (w.symbols ?? []).map((s) => s.text ?? '').join('');
            const v = w.boundingBox?.vertices ?? [];
            if (!t || v.length < 4) continue;
            const xs = v.map((p) => p.x ?? 0);
            const ys = v.map((p) => p.y ?? 0);
            const top = Math.min(...ys);
            const bottom = Math.max(...ys);
            words.push({ text: t, x: Math.min(...xs), x2: Math.max(...xs), y: (top + bottom) / 2, h: Math.max(1, bottom - top) });
            confSum += typeof w.confidence === 'number' ? w.confidence : 0.9;
          }
        }
      }
    }
    const lines = toLines(words);
    return { lines, text: lines.join('\n'), confidence: words.length ? confSum / words.length : 0, words: words.length };
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('Vision OCR failed')) throw e;
    await logUsage({ feature: 'capture.ocr', provider: 'google_vision', model: 'DOCUMENT_TEXT_DETECTION', tier: 'ocr', latencyMs: Date.now() - started, success: false, error: String(e), ref });
    throw e;
  }
}
